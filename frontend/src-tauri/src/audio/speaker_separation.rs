//! Conservative, local voice-group suggestions for an already saved recording.
//!
//! This is an acoustic comparison heuristic, not a trained diarization model or
//! identity recognition. It never infers a name, uses transcript text, or claims
//! that a capture channel identifies a person. Similar voices, unmarked overlap,
//! codecs and microphone changes can defeat these descriptors. A caller must
//! retain the suggestion status until a person reviews it.
//!
//! The caller supplies decoded mono audio and runs this CPU work off the async
//! executor. Memory for audio analysis is bounded independently of the recording
//! length. Input/output metadata is linear in the supplied transcript count.

use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::f64::consts::PI;
use std::sync::Arc;

const MAX_GROUPS: usize = 6;
const MAX_ANALYZED_TURNS: usize = 2_000;
const MAX_TURN_SECONDS: f64 = 18.0;
const MIN_TURN_SECONDS: f64 = 1.2;
const REGIONS: usize = 3;
const FRAMES_PER_REGION: usize = 16;
const MEL_BANDS: usize = 20;
const COEFFICIENTS: usize = 8;
const MATCH_DISTANCE: f64 = 0.52;
const DISTINCT_DISTANCE: f64 = 0.95;
const AMBIGUITY_MARGIN: f64 = 0.18;
const MAX_ANCHOR_DISTANCE: f64 = 0.72;

#[derive(Debug, Clone)]
pub struct SeparationTurn {
    pub id: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    /// Capture provenance, not an existing manually assigned speaker ID.
    pub channel: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpeakerEstimate {
    pub transcript_id: String,
    /// Zero-based suggestion group. This does not identify a named person.
    pub cluster: Option<usize>,
    /// Heuristic match strength, deliberately capped; not a probability.
    pub confidence: Option<f64>,
    pub reason: String,
}

#[derive(Clone)]
struct Signature {
    cepstrum: [f64; COEFFICIENTS],
    log_pitch: f64,
}

struct Candidate {
    output_index: usize,
    signature: Signature,
    quality: f64,
}

struct Group {
    center: Signature,
    // A bounded sample of members prevents centroid drift from chaining voices.
    anchors: Vec<Signature>,
    count: usize,
}

fn microphone(turn: &SeparationTurn) -> bool {
    matches!(turn.channel.as_deref(), Some("microphone" | "microphone-channel"))
}

fn interval(turn: &SeparationTurn) -> Option<(f64, f64)> {
    let (start, end) = (turn.start?, turn.end?);
    (start.is_finite() && end.is_finite() && start >= 0.0 && end > start)
        .then_some((start, end))
}

/// Suggest recurring acoustic groups. Microphone turns are excluded from the
/// result, but must be included in `turns` so mixed-audio overlap is excluded.
/// Every other input turn has one result, in input order, including abstentions.
/// The caller must preserve existing manual assignments and microphone labels.
pub fn separate_speakers(
    samples: &[f32],
    sample_rate: u32,
    turns: &[SeparationTurn],
) -> Vec<SpeakerEstimate> {
    let mut estimates = Vec::new();
    let mut output_indices = vec![None; turns.len()];
    for (index, turn) in turns.iter().enumerate() {
        if !microphone(turn) {
            output_indices[index] = Some(estimates.len());
            estimates.push(SpeakerEstimate {
                transcript_id: turn.id.clone(),
                cluster: None,
                confidence: None,
                reason: "Not enough clear voiced audio to compare.".into(),
            });
        }
    }
    // This also bounds FFT sizes for malformed decoder metadata.
    if !(8_000..=192_000).contains(&sample_rate) || samples.is_empty() {
        for estimate in &mut estimates {
            estimate.reason = "Saved audio is unavailable or its sample rate is unsupported.".into();
        }
        return estimates;
    }

    let duration = samples.len() as f64 / f64::from(sample_rate);
    let mut ordered: Vec<(usize, f64, f64)> = turns
        .iter()
        .enumerate()
        .filter_map(|(index, turn)| interval(turn).map(|(start, end)| (index, start, end)))
        .collect();
    ordered.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));

    // A sweep marks all overlapping intervals, including nested intervals, in
    // O(n log n) rather than comparing every turn with every other turn.
    let mut overlaps = vec![false; turns.len()];
    let mut furthest: Option<(usize, f64)> = None;
    for &(index, start, end) in &ordered {
        if let Some((previous, previous_end)) = furthest {
            if start < previous_end {
                overlaps[index] = true;
                overlaps[previous] = true;
            }
            if end > previous_end {
                furthest = Some((index, end));
            }
        } else {
            furthest = Some((index, end));
        }
    }
    for (index, turn) in turns.iter().enumerate() {
        if interval(turn).is_none() {
            if let Some(output_index) = output_indices[index] {
                estimates[output_index].reason = "This turn has missing or invalid audio times.".into();
            }
        }
    }

    let mut analyzer = Analyzer::new(sample_rate);
    let mut candidates = Vec::new();
    let mut analyzed = 0;
    for (index, start, end) in ordered {
        let Some(output_index) = output_indices[index] else { continue };
        let reason = if end > duration {
            Some("This turn falls outside the saved recording.")
        } else if overlaps[index] {
            Some("This turn overlaps another transcript turn in the mixed recording.")
        } else if end - start < MIN_TURN_SECONDS {
            Some("This turn is too short for a useful voice comparison.")
        } else if end - start > MAX_TURN_SECONDS {
            Some("This turn is too long to attribute safely without splitting it.")
        } else if analyzed >= MAX_ANALYZED_TURNS {
            Some("The local analysis limit was reached; review this turn manually.")
        } else {
            None
        };
        if let Some(reason) = reason {
            estimates[output_index].reason = reason.into();
            continue;
        }
        analyzed += 1;
        let begin = (start * f64::from(sample_rate)).ceil() as usize;
        let finish = (end * f64::from(sample_rate)).floor() as usize;
        let Some(audio) = samples.get(begin..finish) else {
            estimates[output_index].reason = "This turn falls outside the saved recording.".into();
            continue;
        };
        match analyzer.signature(audio) {
            Ok((signature, quality)) => candidates.push(Candidate {
                output_index, signature, quality,
            }),
            Err(reason) => estimates[output_index].reason = reason.into(),
        }
    }
    assign_groups(&candidates, &mut estimates);
    estimates
}

fn distance(a: &Signature, b: &Signature) -> f64 {
    let spectral = a.cepstrum.iter().zip(&b.cepstrum)
        .map(|(a, b)| (a - b).powi(2)).sum::<f64>() / COEFFICIENTS as f64;
    // Pitch is supportive evidence only; prosody varies within the same voice.
    (spectral + 0.35 * (a.log_pitch - b.log_pitch).powi(2)).sqrt()
}

fn average(signatures: &[Signature]) -> Signature {
    let mut result = Signature { cepstrum: [0.0; COEFFICIENTS], log_pitch: 0.0 };
    for signature in signatures {
        for (sum, value) in result.cepstrum.iter_mut().zip(signature.cepstrum) {
            *sum += value / signatures.len() as f64;
        }
        result.log_pitch += signature.log_pitch / signatures.len() as f64;
    }
    result
}

fn ranked_groups(signature: &Signature, groups: &[Group]) -> Vec<(usize, f64)> {
    let mut ranked: Vec<_> = groups.iter().enumerate()
        .map(|(index, group)| (index, distance(signature, &group.center))).collect();
    ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
    ranked
}

fn fits_anchors(signature: &Signature, group: &Group) -> bool {
    group.anchors.iter().all(|anchor| distance(signature, anchor) <= MAX_ANCHOR_DISTANCE)
}

fn assign_groups(candidates: &[Candidate], estimates: &mut [SpeakerEstimate]) {
    let mut groups: Vec<Group> = Vec::new();
    for candidate in candidates {
        let ranked = ranked_groups(&candidate.signature, &groups);
        if let Some(&(index, best)) = ranked.first() {
            let margin = ranked.get(1).map_or(f64::INFINITY, |entry| entry.1 - best);
            if best <= MATCH_DISTANCE && margin >= AMBIGUITY_MARGIN
                && fits_anchors(&candidate.signature, &groups[index])
            {
                let group = &mut groups[index];
                group.count += 1;
                // Keep the initial anchor and a deterministic spread of later
                // examples, using at most eight signatures per group.
                if group.anchors.len() < 8 {
                    group.anchors.push(candidate.signature.clone());
                } else {
                    let slot = 1 + (group.count % 7);
                    group.anchors[slot] = candidate.signature.clone();
                }
                group.center = average(&group.anchors);
                continue;
            }
            if best < DISTINCT_DISTANCE {
                continue;
            }
        }
        if groups.len() < MAX_GROUPS {
            groups.push(Group {
                center: candidate.signature.clone(),
                anchors: vec![candidate.signature.clone()],
                count: 1,
            });
        }
    }

    // Re-evaluate against the final groups; a seed or an ambiguous match never
    // becomes a supported voice merely because it was encountered first.
    let mut assignments = Vec::with_capacity(candidates.len());
    let mut support = vec![0usize; groups.len()];
    for candidate in candidates {
        let ranked = ranked_groups(&candidate.signature, &groups);
        let assignment = ranked.first().and_then(|&(index, best)| {
            let margin = ranked.get(1).map_or(f64::INFINITY, |entry| entry.1 - best);
            (best <= MATCH_DISTANCE && margin >= AMBIGUITY_MARGIN
                && fits_anchors(&candidate.signature, &groups[index]))
                .then_some((index, best, margin))
        });
        if let Some((index, _, _)) = assignment {
            support[index] += 1;
        }
        assignments.push(assignment);
    }
    let mut labels = vec![None; groups.len()];
    let mut next_label = 0;
    for (index, count) in support.iter().enumerate() {
        if *count >= 2 {
            labels[index] = Some(next_label);
            next_label += 1;
        }
    }
    for (candidate, assignment) in candidates.iter().zip(assignments) {
        let estimate = &mut estimates[candidate.output_index];
        let Some((index, best, margin)) = assignment else {
            estimate.reason = "No distinct, consistent acoustic match; review this turn.".into();
            continue;
        };
        let Some(label) = labels[index] else {
            estimate.reason = "No repeated matching voice found; review this turn.".into();
            continue;
        };
        estimate.cluster = Some(label);
        // These weights are an explainable heuristic, not calibrated accuracy.
        estimate.confidence = Some((0.40 + 0.16 * (1.0 - best / MATCH_DISTANCE)
            + 0.10 * (margin / DISTINCT_DISTANCE).min(1.0)
            + 0.09 * candidate.quality).clamp(0.40, 0.75));
        estimate.reason = "Tentative acoustic match across repeated turns; confirm by listening.".into();
    }
}

struct Analyzer {
    sample_rate: u32,
    frame_length: usize,
    forward: Arc<dyn RealToComplex<f64>>,
    inverse: Arc<dyn ComplexToReal<f64>>,
    input: Vec<f64>,
    spectrum: Vec<Complex<f64>>,
    autocorrelation: Vec<f64>,
    forward_scratch: Vec<Complex<f64>>,
    inverse_scratch: Vec<Complex<f64>>,
    window: Vec<f64>,
    window_correlation: Vec<f64>,
    filters: Vec<Vec<(usize, f64)>>,
    cosine: [[f64; MEL_BANDS]; COEFFICIENTS],
}

impl Analyzer {
    fn new(sample_rate: u32) -> Self {
        let frame_length = sample_rate as usize / 25; // 40 ms
        let fft_length = (frame_length * 2).next_power_of_two();
        let mut planner = RealFftPlanner::<f64>::new();
        let forward = planner.plan_fft_forward(fft_length);
        let inverse = planner.plan_fft_inverse(fft_length);
        let window: Vec<_> = (0..frame_length)
            .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f64 / (frame_length - 1) as f64).cos())
            .collect();
        let max_lag = sample_rate as usize / 70;
        let window_correlation = (0..=max_lag).map(|lag| {
            window[..frame_length - lag].iter().zip(&window[lag..])
                .map(|(a, b)| a * b).sum::<f64>()
        }).collect();
        let to_mel = |hz: f64| 2595.0 * (1.0 + hz / 700.0).log10();
        let low = to_mel(100.0);
        let high = to_mel(3_800.0_f64.min(f64::from(sample_rate) * 0.45));
        let edges: Vec<_> = (0..MEL_BANDS + 2).map(|index| {
            let mel = low + (high - low) * index as f64 / (MEL_BANDS + 1) as f64;
            700.0 * (10.0_f64.powf(mel / 2595.0) - 1.0)
        }).collect();
        let filters = (0..MEL_BANDS).map(|band| {
            let mut weights = Vec::new();
            for bin in 1..=fft_length / 2 {
                let hz = bin as f64 * f64::from(sample_rate) / fft_length as f64;
                if hz > edges[band] && hz < edges[band + 2] {
                    let weight = if hz <= edges[band + 1] {
                        (hz - edges[band]) / (edges[band + 1] - edges[band])
                    } else {
                        (edges[band + 2] - hz) / (edges[band + 2] - edges[band + 1])
                    };
                    weights.push((bin, weight));
                }
            }
            let total = weights.iter().map(|entry| entry.1).sum::<f64>();
            for entry in &mut weights { entry.1 /= total.max(f64::EPSILON); }
            weights
        }).collect();
        let mut cosine = [[0.0; MEL_BANDS]; COEFFICIENTS];
        for (coefficient, row) in cosine.iter_mut().enumerate() {
            for (band, value) in row.iter_mut().enumerate() {
                *value = (PI * (coefficient + 1) as f64 * (band as f64 + 0.5)
                    / MEL_BANDS as f64).cos() / MEL_BANDS as f64;
            }
        }
        Self {
            sample_rate, frame_length,
            input: forward.make_input_vec(), spectrum: forward.make_output_vec(),
            autocorrelation: inverse.make_output_vec(),
            forward_scratch: forward.make_scratch_vec(), inverse_scratch: inverse.make_scratch_vec(),
            forward, inverse, window, window_correlation, filters, cosine,
        }
    }

    fn signature(&mut self, audio: &[f32]) -> Result<(Signature, f64), &'static str> {
        if audio.iter().any(|sample| !sample.is_finite()) {
            return Err("This audio interval contains invalid samples.");
        }
        let mut regions = Vec::with_capacity(REGIONS);
        let mut voiced = 0;
        for region in 0..REGIONS {
            let begin = audio.len() * region / REGIONS;
            let end = audio.len() * (region + 1) / REGIONS;
            let available = end.saturating_sub(begin + self.frame_length);
            let mut frames = Vec::with_capacity(FRAMES_PER_REGION);
            // Sample across the whole interval, not only its opening voice.
            // This is still sparse evidence; long ASR intervals are declined.
            for frame in 0..FRAMES_PER_REGION {
                let offset = begin + available * frame / (FRAMES_PER_REGION - 1);
                if let Some(signature) = self.frame(&audio[offset..offset + self.frame_length]) {
                    frames.push(signature);
                }
            }
            if frames.len() < 5 {
                return Err("Not enough clear voiced audio throughout this turn to compare.");
            }
            voiced += frames.len();
            // Median coefficients reduce individual-phoneme and pitch outliers.
            let mut signature = Signature { cepstrum: [0.0; COEFFICIENTS], log_pitch: 0.0 };
            for coefficient in 0..COEFFICIENTS {
                signature.cepstrum[coefficient] = median(frames.iter()
                    .map(|frame| frame.cepstrum[coefficient]).collect());
            }
            signature.log_pitch = median(frames.iter().map(|frame| frame.log_pitch).collect());
            // Three equal medians can conceal frequent speaker changes. Also
            // decline a region when many voiced frames disagree with its own
            // representative; phoneme variation is allowed a wider tolerance.
            let inconsistent = frames.iter().filter(|frame| {
                distance(frame, &signature) > 1.10
                    || (frame.log_pitch - signature.log_pitch).abs() > 0.85
            }).count();
            if inconsistent * 3 > frames.len() {
                return Err("The voice is inconsistent within this turn; review or split it.");
            }
            regions.push(signature);
        }
        if voiced < 20 {
            return Err("Not enough clear voiced audio to compare.");
        }
        for left in 0..regions.len() {
            for right in left + 1..regions.len() {
                if distance(&regions[left], &regions[right]) > 0.72
                    || (regions[left].log_pitch - regions[right].log_pitch).abs() > 0.70
                {
                    return Err("The voice changes within this turn; review or split it.");
                }
            }
        }
        Ok((average(&regions), voiced as f64 / (REGIONS * FRAMES_PER_REGION) as f64))
    }

    fn frame(&mut self, audio: &[f32]) -> Option<Signature> {
        let mean = audio.iter().map(|sample| f64::from(*sample)).sum::<f64>() / audio.len() as f64;
        let energy = audio.iter().map(|sample| (f64::from(*sample) - mean).powi(2))
            .sum::<f64>() / audio.len() as f64;
        if energy < 0.003_f64.powi(2) { return None; }
        self.input.fill(0.0);
        for (index, sample) in audio.iter().enumerate() {
            self.input[index] = (f64::from(*sample) - mean) * self.window[index];
        }
        self.forward.process_with_scratch(&mut self.input, &mut self.spectrum,
            &mut self.forward_scratch).ok()?;
        let mut bands = [0.0_f64; MEL_BANDS];
        for (band, filter) in self.filters.iter().enumerate() {
            bands[band] = filter.iter().map(|(bin, weight)| self.spectrum[*bin].norm_sqr() * weight)
                .sum::<f64>();
        }
        let band_peak = bands.iter().copied().fold(0.0_f64, f64::max);
        // Exclude narrow-band tones and frames dominated by a single resonance.
        if bands.iter().filter(|value| **value > band_peak * 0.01).count() < 5 {
            return None;
        }
        let floor = (band_peak * 1e-6).max(f64::EPSILON);
        for band in &mut bands { *band = band.max(floor).ln(); }
        let mut cepstrum = [0.0; COEFFICIENTS];
        for (index, coefficient) in cepstrum.iter_mut().enumerate() {
            *coefficient = self.cosine[index].iter().zip(bands).map(|(weight, band)| weight * band)
                .sum();
        }
        // Inverse power spectrum yields linear autocorrelation because the
        // 40 ms frame was zero-padded to at least twice its length.
        for value in &mut self.spectrum { *value = Complex::new(value.norm_sqr(), 0.0); }
        self.inverse.process_with_scratch(&mut self.spectrum, &mut self.autocorrelation,
            &mut self.inverse_scratch).ok()?;
        let zero = self.autocorrelation[0];
        if !zero.is_finite() || zero <= 0.0 { return None; }
        let min_lag = self.sample_rate as usize / 350;
        let max_lag = self.sample_rate as usize / 70;
        let correlation = |lag: usize| {
            (self.autocorrelation[lag] / zero * self.window_correlation[0]
                / self.window_correlation[lag]).clamp(-1.0, 1.0)
        };
        let peak = (min_lag..max_lag).map(|lag| correlation(lag)).fold(0.0_f64, f64::max);
        if peak < 0.60 { return None; }
        // Prefer the first strong local maximum over an octave/subharmonic.
        let lag = (min_lag..max_lag).find(|&lag| {
            let value = correlation(lag);
            value >= peak * 0.92 && value >= correlation(lag - 1)
                && value > correlation(lag + 1)
        })?;
        let log_pitch = (f64::from(self.sample_rate) / lag as f64).log2();
        Some(Signature { cepstrum, log_pitch })
    }
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 { (values[middle - 1] + values[middle]) * 0.5 }
    else { values[middle] }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: &str, start: f64, end: f64, channel: Option<&str>) -> SeparationTurn {
        SeparationTurn { id: id.into(), start: Some(start), end: Some(end),
            channel: channel.map(str::to_owned) }
    }

    #[test]
    fn overlap_with_microphone_abstains_and_never_returns_microphone_identity() {
        let estimates = separate_speakers(&vec![0.1; 64_000], 16_000, &[
            turn("remote", 0.0, 3.0, Some("system")),
            turn("mic", 1.0, 2.0, Some("microphone-channel")),
            turn("nested", 2.5, 3.5, None),
        ]);
        assert_eq!(estimates.len(), 2);
        assert!(estimates.iter().all(|estimate| estimate.cluster.is_none()
            && estimate.confidence.is_none() && estimate.reason.contains("overlaps")));
    }

    #[test]
    fn missing_nonfinite_and_out_of_bounds_times_never_select_audio() {
        let mut missing = turn("missing", 0.0, 2.0, None);
        missing.start = None;
        let estimates = separate_speakers(&vec![0.1; 32_000], 16_000, &[
            missing, turn("nan", f64::NAN, 2.0, None),
            turn("infinite", 0.0, f64::INFINITY, None),
            turn("outside", 3.0, 4.0, None),
        ]);
        assert_eq!(estimates.len(), 4);
        assert!(estimates.iter().all(|estimate| estimate.cluster.is_none()));
        assert!(estimates[0].reason.contains("invalid"));
        assert!(estimates[3].reason.contains("outside"));
    }

    #[test]
    fn silence_and_very_long_asr_turns_are_not_a_new_voice() {
        let estimates = separate_speakers(&vec![0.0; 352_000], 16_000, &[
            turn("silence", 0.0, 2.0, None), turn("long", 2.0, 22.0, None),
        ]);
        assert!(estimates.iter().all(|estimate| estimate.cluster.is_none()));
        assert!(estimates[0].reason.contains("voiced"));
        assert!(estimates[1].reason.contains("splitting"));
    }

    #[test]
    fn one_acoustic_example_does_not_establish_an_identity() {
        let candidate = Candidate { output_index: 0, quality: 1.0,
            signature: Signature { cepstrum: [0.0; COEFFICIENTS], log_pitch: 7.5 } };
        let mut estimates = vec![SpeakerEstimate { transcript_id: "only".into(),
            cluster: None, confidence: None, reason: String::new() }];
        assign_groups(&[candidate], &mut estimates);
        assert!(estimates[0].cluster.is_none());
        assert!(estimates[0].confidence.is_none());
        assert!(estimates[0].reason.contains("repeated"));
    }
}
