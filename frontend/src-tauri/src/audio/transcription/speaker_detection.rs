use crate::audio::DeviceType;
use realfft::RealFftPlanner;
use std::f32::consts::PI;

const MEL_BANDS: usize = 20;
const MFCC_COUNT: usize = 12;
const MAX_REMOTE_SPEAKERS: usize = 6;
const MAX_ANALYSIS_SECONDS: usize = 8;
const MIN_VOICED_FRAMES: usize = 6;

/// Attribution attached to every transcript segment.
///
/// `speaker_id` is stable only inside one recording. This module deliberately
/// does not perform biometric identity recognition or retain a voiceprint after
/// a recording ends.
#[derive(Debug, Clone, PartialEq)]
pub struct SpeakerAssignment {
    pub speaker_id: String,
    pub speaker_label: String,
    pub speaker_source: String,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
struct SpeakerCluster {
    number: usize,
    centroid: Vec<f32>,
    observations: u32,
    last_seen_seconds: f64,
}

#[derive(Debug)]
struct SpeakerClusterer {
    namespace: &'static str,
    clusters: Vec<SpeakerCluster>,
    last_cluster: Option<usize>,
}

impl SpeakerClusterer {
    fn new(namespace: &'static str) -> Self {
        Self {
            namespace,
            clusters: Vec::new(),
            last_cluster: None,
        }
    }

    fn assignment_for(
        &self,
        cluster_index: usize,
        speaker_source: &str,
        confidence: f32,
    ) -> SpeakerAssignment {
        let cluster = &self.clusters[cluster_index];
        SpeakerAssignment {
            speaker_id: format!("{}-{}", self.namespace, cluster.number),
            speaker_label: format!("Speaker {}", cluster.number),
            speaker_source: speaker_source.to_string(),
            confidence: confidence.clamp(0.0, 1.0),
        }
    }

    fn fallback_assignment(&self, speaker_source: &str) -> SpeakerAssignment {
        SpeakerAssignment {
            speaker_id: format!("{}-unknown", self.namespace),
            speaker_label: if self.namespace == "remote" {
                "Other party".to_string()
            } else {
                "Speaker".to_string()
            },
            speaker_source: speaker_source.to_string(),
            confidence: 0.25,
        }
    }

    fn assign(
        &mut self,
        audio: &[f32],
        sample_rate: u32,
        timestamp_seconds: f64,
        speaker_source: &str,
    ) -> SpeakerAssignment {
        let duration_seconds = if sample_rate == 0 {
            0.0
        } else {
            audio.len() as f64 / sample_rate as f64
        };

        let Some(features) = extract_voice_features(audio, sample_rate) else {
            if let Some(last_index) = self.last_cluster {
                let recently_seen =
                    timestamp_seconds - self.clusters[last_index].last_seen_seconds <= 15.0;
                if recently_seen {
                    self.clusters[last_index].last_seen_seconds = timestamp_seconds;
                    return self.assignment_for(last_index, speaker_source, 0.4);
                }
            }
            return self.fallback_assignment(speaker_source);
        };

        if self.clusters.is_empty() {
            self.clusters.push(SpeakerCluster {
                number: 1,
                centroid: features,
                observations: 1,
                last_seen_seconds: timestamp_seconds,
            });
            self.last_cluster = Some(0);
            return self.assignment_for(0, speaker_source, 0.78);
        }

        let similarities: Vec<f32> = self
            .clusters
            .iter()
            .map(|cluster| cosine_similarity(&features, &cluster.centroid))
            .collect();
        let (mut best_index, mut best_similarity) = similarities
            .iter()
            .copied()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .unwrap_or((0, 0.0));

        // Conversation turns are sticky: a short pause should not produce a new
        // speaker merely because the phonetic content changed. Prefer the last
        // cluster when it is nearly as plausible and was seen recently.
        if let Some(last_index) = self.last_cluster {
            let last_similarity = similarities[last_index];
            let gap = timestamp_seconds - self.clusters[last_index].last_seen_seconds;
            if gap <= 8.0 && last_similarity >= 0.74 && last_similarity + 0.045 >= best_similarity {
                best_index = last_index;
                best_similarity = last_similarity;
            }
        }

        // Be conservative about creating identities. Hand-crafted acoustic
        // features are useful for best-effort local clustering, but are not a
        // substitute for a model-backed speaker embedding. A new cluster is
        // created only for a sufficiently long and strongly dissimilar turn.
        let should_create_cluster = duration_seconds >= 1.15
            && best_similarity < 0.67
            && self.clusters.len() < MAX_REMOTE_SPEAKERS;

        if should_create_cluster {
            let cluster_index = self.clusters.len();
            self.clusters.push(SpeakerCluster {
                number: cluster_index + 1,
                centroid: features,
                observations: 1,
                last_seen_seconds: timestamp_seconds,
            });
            self.last_cluster = Some(cluster_index);
            return self.assignment_for(cluster_index, speaker_source, 0.62);
        }

        let confidence = ((best_similarity - 0.55) / 0.4).clamp(0.35, 0.96);
        if best_similarity >= 0.72 {
            update_centroid(&mut self.clusters[best_index], &features);
        }
        self.clusters[best_index].last_seen_seconds = timestamp_seconds;
        self.last_cluster = Some(best_index);
        self.assignment_for(best_index, speaker_source, confidence)
    }
}

/// Session-scoped speaker attribution.
///
/// When microphone and system audio are captured independently, the microphone
/// is deterministic `Me` and only the remote/system channel is clustered. For a
/// microphone-only room recording, the module avoids pretending that every
/// voice is the owner and instead applies the same best-effort local clustering
/// to the room channel.
#[derive(Debug)]
pub struct SpeakerAttributor {
    channel_separated: bool,
    remote_clusterer: SpeakerClusterer,
    room_clusterer: SpeakerClusterer,
}

impl SpeakerAttributor {
    pub fn new(channel_separated: bool) -> Self {
        Self {
            channel_separated,
            remote_clusterer: SpeakerClusterer::new("remote"),
            room_clusterer: SpeakerClusterer::new("room"),
        }
    }

    pub fn assign(
        &mut self,
        device_type: &DeviceType,
        audio: &[f32],
        sample_rate: u32,
        timestamp_seconds: f64,
    ) -> SpeakerAssignment {
        match device_type {
            DeviceType::Microphone if self.channel_separated => SpeakerAssignment {
                speaker_id: "me".to_string(),
                speaker_label: "Me".to_string(),
                speaker_source: "microphone-channel".to_string(),
                confidence: 1.0,
            },
            DeviceType::Microphone => self.room_clusterer.assign(
                audio,
                sample_rate,
                timestamp_seconds,
                "microphone-acoustic",
            ),
            DeviceType::System => self.remote_clusterer.assign(
                audio,
                sample_rate,
                timestamp_seconds,
                "system-acoustic",
            ),
        }
    }
}

fn update_centroid(cluster: &mut SpeakerCluster, features: &[f32]) {
    let effective_observations = cluster.observations.min(20) as f32;
    let old_weight = effective_observations / (effective_observations + 1.0);
    let new_weight = 1.0 - old_weight;

    for (centroid_value, feature_value) in cluster.centroid.iter_mut().zip(features.iter()) {
        *centroid_value = (*centroid_value * old_weight) + (*feature_value * new_weight);
    }
    normalize_vector(&mut cluster.centroid);
    cluster.observations = cluster.observations.saturating_add(1);
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }

    left.iter()
        .zip(right.iter())
        .map(|(a, b)| a * b)
        .sum::<f32>()
        .clamp(-1.0, 1.0)
}

fn normalize_vector(values: &mut [f32]) {
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 1e-8 {
        for value in values {
            *value /= norm;
        }
    }
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10.0f32.powf(mel / 2595.0) - 1.0)
}

fn mel_filter_bins(sample_rate: u32, fft_size: usize, spectrum_len: usize) -> Vec<usize> {
    let low_mel = hz_to_mel(80.0);
    let high_hz = (sample_rate as f32 / 2.0 - 100.0).clamp(1000.0, 7600.0);
    let high_mel = hz_to_mel(high_hz);
    let mut bins = Vec::with_capacity(MEL_BANDS + 2);

    for index in 0..(MEL_BANDS + 2) {
        let ratio = index as f32 / (MEL_BANDS + 1) as f32;
        let hz = mel_to_hz(low_mel + ((high_mel - low_mel) * ratio));
        let bin = (((fft_size + 1) as f32 * hz) / sample_rate as f32)
            .floor()
            .max(0.0) as usize;
        bins.push(bin.min(spectrum_len.saturating_sub(1)));
    }

    // Avoid zero-width filters after frequency-to-bin rounding.
    for index in 1..bins.len() {
        if bins[index] <= bins[index - 1] {
            bins[index] = (bins[index - 1] + 1).min(spectrum_len.saturating_sub(1));
        }
    }
    bins
}

fn estimate_pitch(frame: &[f32], sample_rate: u32) -> (f32, f32) {
    if frame.len() < 128 || sample_rate == 0 {
        return (0.0, 0.0);
    }

    let mean = frame.iter().sum::<f32>() / frame.len() as f32;
    let centered: Vec<f32> = frame.iter().map(|sample| sample - mean).collect();
    let energy = centered.iter().map(|sample| sample * sample).sum::<f32>();
    if energy < 1e-6 {
        return (0.0, 0.0);
    }

    let min_lag = (sample_rate as usize / 350).max(1);
    let max_lag = (sample_rate as usize / 70).min(frame.len().saturating_sub(2));
    if min_lag >= max_lag {
        return (0.0, 0.0);
    }

    let mut best_lag = min_lag;
    let mut best_correlation = 0.0f32;
    for lag in (min_lag..=max_lag).step_by(2) {
        let mut dot = 0.0f32;
        let mut left_energy = 0.0f32;
        let mut right_energy = 0.0f32;
        for index in 0..(centered.len() - lag) {
            let left = centered[index];
            let right = centered[index + lag];
            dot += left * right;
            left_energy += left * left;
            right_energy += right * right;
        }
        let denominator = (left_energy * right_energy).sqrt().max(1e-8);
        let correlation = dot / denominator;
        if correlation > best_correlation {
            best_correlation = correlation;
            best_lag = lag;
        }
    }

    if best_correlation < 0.18 {
        return (0.0, best_correlation.max(0.0));
    }

    (
        sample_rate as f32 / best_lag as f32,
        best_correlation.clamp(0.0, 1.0),
    )
}

/// Extract a compact, content-tolerant voice signature from one VAD segment.
/// The signature combines normalized MFCC-like coefficients, spectral shape,
/// zero-crossing behavior, and a coarse pitch estimate. It is used only for
/// session-local clustering and is never persisted.
fn extract_voice_features(audio: &[f32], sample_rate: u32) -> Option<Vec<f32>> {
    if sample_rate < 8_000 || audio.len() < sample_rate as usize / 3 {
        return None;
    }

    let max_samples = (sample_rate as usize * MAX_ANALYSIS_SECONDS).min(audio.len());
    let samples = &audio[..max_samples];
    let frame_len = ((sample_rate as f32 * 0.025).round() as usize).clamp(160, 2_048);
    let hop_len = ((sample_rate as f32 * 0.010).round() as usize).max(80);
    if samples.len() < frame_len {
        return None;
    }

    let fft_size = frame_len.next_power_of_two();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);
    let mut fft_input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mel_bins = mel_filter_bins(sample_rate, fft_size, spectrum.len());
    let mut frame_features: Vec<Vec<f32>> = Vec::new();
    let mut last_pitch = (0.0f32, 0.0f32);

    for (frame_number, frame_start) in (0..=(samples.len() - frame_len))
        .step_by(hop_len)
        .enumerate()
    {
        let frame = &samples[frame_start..frame_start + frame_len];
        let mean = frame.iter().sum::<f32>() / frame_len as f32;
        let rms = (frame
            .iter()
            .map(|sample| {
                let centered = sample - mean;
                centered * centered
            })
            .sum::<f32>()
            / frame_len as f32)
            .sqrt();
        if rms < 0.0015 {
            continue;
        }

        fft_input.fill(0.0);
        let mut previous = 0.0f32;
        for (index, sample) in frame.iter().enumerate() {
            let centered = sample - mean;
            let emphasized = centered - (0.97 * previous);
            previous = centered;
            let window = 0.5
                - (0.5
                    * ((2.0 * PI * index as f32) / (frame_len.saturating_sub(1).max(1) as f32))
                        .cos());
            fft_input[index] = emphasized * window;
        }

        if fft.process(&mut fft_input, &mut spectrum).is_err() {
            return None;
        }
        let power: Vec<f32> = spectrum
            .iter()
            .map(|value| value.norm_sqr().max(1e-12))
            .collect();
        let total_power = power.iter().sum::<f32>().max(1e-12);

        let mut log_mel = Vec::with_capacity(MEL_BANDS);
        for band in 0..MEL_BANDS {
            let left = mel_bins[band];
            let center = mel_bins[band + 1];
            let right = mel_bins[band + 2];
            let mut energy = 0.0f32;

            if center > left {
                for bin in left..center {
                    let weight = (bin - left) as f32 / (center - left) as f32;
                    energy += power[bin] * weight;
                }
            }
            if right > center {
                for bin in center..=right.min(power.len().saturating_sub(1)) {
                    let weight = (right - bin) as f32 / (right - center) as f32;
                    energy += power[bin] * weight;
                }
            }
            log_mel.push((energy + 1e-10).ln());
        }

        let mut mfcc = Vec::with_capacity(MFCC_COUNT);
        for coefficient in 1..=MFCC_COUNT {
            let value = log_mel
                .iter()
                .enumerate()
                .map(|(band, energy)| {
                    energy
                        * (PI * coefficient as f32 * (band as f32 + 0.5) / MEL_BANDS as f32).cos()
                })
                .sum::<f32>()
                / MEL_BANDS as f32;
            mfcc.push(value);
        }
        normalize_vector(&mut mfcc);

        let centroid = power
            .iter()
            .enumerate()
            .map(|(bin, value)| bin as f32 * value)
            .sum::<f32>()
            / total_power
            / power.len().saturating_sub(1).max(1) as f32;
        let arithmetic_mean = total_power / power.len() as f32;
        let geometric_mean =
            (power.iter().map(|value| value.ln()).sum::<f32>() / power.len() as f32).exp();
        let flatness = (geometric_mean / arithmetic_mean.max(1e-12)).clamp(0.0, 1.0);
        let zero_crossing_rate = frame
            .windows(2)
            .filter(|pair| (pair[0] >= mean) != (pair[1] >= mean))
            .count() as f32
            / frame_len.saturating_sub(1).max(1) as f32;

        // Pitch autocorrelation is the most expensive frame feature. Sample it
        // every fourth frame, then carry the latest observation through the
        // intervening frames so the segment-level mean remains discriminative.
        if frame_number % 4 == 0 {
            last_pitch = estimate_pitch(frame, sample_rate);
        }
        let (pitch_hz, pitch_strength) = last_pitch;
        let normalized_pitch = if pitch_hz > 0.0 {
            (pitch_hz / 160.0).ln().clamp(-1.5, 1.5)
        } else {
            0.0
        };

        mfcc.extend([
            centroid.clamp(0.0, 1.0),
            flatness,
            zero_crossing_rate.clamp(0.0, 1.0),
            normalized_pitch * 1.75,
            pitch_strength,
        ]);
        frame_features.push(mfcc);
    }

    if frame_features.len() < MIN_VOICED_FRAMES {
        return None;
    }

    let dimensions = frame_features[0].len();
    let mut means = vec![0.0f32; dimensions];
    for frame in &frame_features {
        for (index, value) in frame.iter().enumerate() {
            means[index] += *value;
        }
    }
    for value in &mut means {
        *value /= frame_features.len() as f32;
    }

    let mut deviations = vec![0.0f32; dimensions];
    for frame in &frame_features {
        for (index, value) in frame.iter().enumerate() {
            let delta = value - means[index];
            deviations[index] += delta * delta;
        }
    }
    for value in &mut deviations {
        *value = (*value / frame_features.len() as f32).sqrt();
    }

    means.extend(deviations);
    if means.iter().any(|value| !value.is_finite()) {
        return None;
    }
    normalize_vector(&mut means);
    Some(means)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_voice(fundamental_hz: f32, formant_hz: f32, seconds: f32) -> Vec<f32> {
        let sample_rate = 16_000.0f32;
        let sample_count = (sample_rate * seconds) as usize;
        (0..sample_count)
            .map(|index| {
                let time = index as f32 / sample_rate;
                let envelope = ((time * 3.1).sin().abs() * 0.35) + 0.65;
                envelope
                    * ((2.0 * PI * fundamental_hz * time).sin() * 0.55
                        + (2.0 * PI * fundamental_hz * 2.0 * time).sin() * 0.22
                        + (2.0 * PI * formant_hz * time).sin() * 0.14)
            })
            .collect()
    }

    #[test]
    fn separated_microphone_is_deterministically_me() {
        let mut attributor = SpeakerAttributor::new(true);
        let assignment = attributor.assign(
            &DeviceType::Microphone,
            &synthetic_voice(120.0, 700.0, 1.5),
            16_000,
            1.0,
        );

        assert_eq!(assignment.speaker_id, "me");
        assert_eq!(assignment.speaker_label, "Me");
        assert_eq!(assignment.confidence, 1.0);
    }

    #[test]
    fn similar_remote_turns_keep_the_same_session_speaker() {
        let mut attributor = SpeakerAttributor::new(true);
        let first = attributor.assign(
            &DeviceType::System,
            &synthetic_voice(120.0, 700.0, 1.8),
            16_000,
            2.0,
        );
        let second = attributor.assign(
            &DeviceType::System,
            &synthetic_voice(123.0, 730.0, 1.6),
            16_000,
            5.0,
        );

        assert_eq!(first.speaker_id, second.speaker_id);
        assert_eq!(first.speaker_label, "Speaker 1");
    }

    #[test]
    fn strongly_different_remote_voices_can_create_a_second_cluster() {
        let mut attributor = SpeakerAttributor::new(true);
        let first = attributor.assign(
            &DeviceType::System,
            &synthetic_voice(95.0, 550.0, 2.0),
            16_000,
            1.0,
        );
        let second = attributor.assign(
            &DeviceType::System,
            &synthetic_voice(285.0, 2_800.0, 2.0),
            16_000,
            20.0,
        );

        assert_eq!(first.speaker_label, "Speaker 1");
        assert_eq!(second.speaker_label, "Speaker 2");
    }

    #[test]
    fn microphone_only_mode_does_not_claim_every_voice_is_me() {
        let mut attributor = SpeakerAttributor::new(false);
        let assignment = attributor.assign(
            &DeviceType::Microphone,
            &synthetic_voice(150.0, 900.0, 1.5),
            16_000,
            1.0,
        );

        assert_ne!(assignment.speaker_id, "me");
        assert_eq!(assignment.speaker_label, "Speaker 1");
    }
}
