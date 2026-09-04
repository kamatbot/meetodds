use log::info;
use std::path::Path;
use std::sync::OnceLock;
use sysinfo::System;

/// Hardware capabilities for audio processing optimization.
#[derive(Debug, Clone, PartialEq)]
pub struct HardwareProfile {
    pub cpu_cores: u8,
    pub has_gpu_acceleration: bool,
    pub gpu_type: GpuType,
    pub memory_gb: u8,
    pub performance_tier: PerformanceTier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuType {
    None,
    Metal,
    Cuda,
    Vulkan,
    OpenCL,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerformanceTier {
    Low,
    Medium,
    High,
    Ultra,
}

/// Adaptive Whisper configuration based on hardware.
#[derive(Debug, Clone)]
pub struct AdaptiveWhisperConfig {
    pub beam_size: usize,
    pub temperature: f32,
    pub use_gpu: bool,
    pub max_threads: Option<usize>,
    pub chunk_size_preference: ChunkSizePreference,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChunkSizePreference {
    Fast,
    Balanced,
    Quality,
}

static HARDWARE_PROFILE: OnceLock<HardwareProfile> = OnceLock::new();

impl HardwareProfile {
    /// Get the detected hardware profile (cached after first call).
    pub fn detect() -> &'static HardwareProfile {
        HARDWARE_PROFILE.get_or_init(|| {
            let profile = Self::detect_hardware();
            info!("Detected hardware profile: {:?}", profile);
            profile
        })
    }

    fn detect_hardware() -> HardwareProfile {
        let cpu_cores = Self::detect_cpu_cores();
        let (has_gpu_acceleration, gpu_type) = Self::detect_gpu();
        let memory_gb = Self::detect_memory_gb();
        let performance_tier = Self::calculate_performance_tier(cpu_cores, &gpu_type, memory_gb);

        HardwareProfile {
            cpu_cores,
            has_gpu_acceleration,
            gpu_type,
            memory_gb,
            performance_tier,
        }
    }

    fn detect_cpu_cores() -> u8 {
        std::thread::available_parallelism()
            .map(|cores| cores.get().min(255) as u8)
            .unwrap_or(4)
    }

    fn detect_gpu() -> (bool, GpuType) {
        #[cfg(target_os = "macos")]
        {
            if Self::has_metal_support() {
                return (true, GpuType::Metal);
            }
        }

        if Self::has_cuda_support() {
            return (true, GpuType::Cuda);
        }

        if Self::has_vulkan_support() {
            return (true, GpuType::Vulkan);
        }

        (false, GpuType::None)
    }

    /// Detect physical/unified memory instead of assuming every machine has 8 GB.
    /// `MEMORY_GB` remains available as an explicit override for constrained test
    /// environments and containers.
    fn detect_memory_gb() -> u8 {
        if let Ok(value) = std::env::var("MEMORY_GB") {
            if let Ok(memory_gb) = value.parse::<u16>() {
                if memory_gb > 0 {
                    return memory_gb.min(u8::MAX as u16) as u8;
                }
            }
        }

        let mut system = System::new();
        system.refresh_memory();
        Self::bytes_to_gib_rounded_up(system.total_memory())
    }

    fn bytes_to_gib_rounded_up(bytes: u64) -> u8 {
        const GIB: u64 = 1024 * 1024 * 1024;
        if bytes == 0 {
            return 8;
        }

        let gib = bytes.saturating_add(GIB - 1) / GIB;
        gib.clamp(1, u8::MAX as u64) as u8
    }

    fn calculate_performance_tier(
        cpu_cores: u8,
        gpu_type: &GpuType,
        memory_gb: u8,
    ) -> PerformanceTier {
        match gpu_type {
            GpuType::Metal | GpuType::Cuda => {
                if memory_gb >= 16 && cpu_cores >= 8 {
                    PerformanceTier::Ultra
                } else {
                    PerformanceTier::High
                }
            }
            GpuType::Vulkan | GpuType::OpenCL => {
                if memory_gb >= 12 && cpu_cores >= 6 {
                    PerformanceTier::High
                } else {
                    PerformanceTier::Medium
                }
            }
            GpuType::None => {
                if cpu_cores >= 8 && memory_gb >= 16 {
                    PerformanceTier::Medium
                } else {
                    PerformanceTier::Low
                }
            }
        }
    }

    fn is_apple_silicon() -> bool {
        cfg!(target_os = "macos") && std::env::consts::ARCH == "aarch64"
    }

    fn recommended_decoder_threads(cpu_cores: u8, reserve_for_ui: u8, cap: u8) -> usize {
        cpu_cores.saturating_sub(reserve_for_ui).clamp(2, cap) as usize
    }

    pub(crate) fn recommended_meeting_threads(cpu_cores: u8) -> usize {
        Self::recommended_decoder_threads(cpu_cores, 4, 6)
    }

    #[cfg(target_os = "macos")]
    fn has_metal_support() -> bool {
        std::env::consts::ARCH == "aarch64"
    }

    fn has_cuda_support() -> bool {
        std::env::var("CUDA_PATH").is_ok()
            || std::env::var("CUDA_HOME").is_ok()
            || Path::new("/usr/local/cuda").exists()
    }

    fn has_vulkan_support() -> bool {
        if std::env::var("VULKAN_SDK").is_ok()
            || Path::new("/usr/lib/x86_64-linux-gnu/libvulkan.so").exists()
            || Path::new("/usr/lib/libvulkan.so").exists()
        {
            return true;
        }

        #[cfg(target_os = "windows")]
        {
            return Self::has_windows_vulkan_runtime();
        }

        #[cfg(not(target_os = "windows"))]
        {
            false
        }
    }

    #[cfg(target_os = "windows")]
    fn has_windows_vulkan_runtime() -> bool {
        for env_var in ["SystemRoot", "WINDIR"] {
            if let Ok(system_root) = std::env::var(env_var) {
                if Self::has_windows_vulkan_loader(Path::new(&system_root)) {
                    return true;
                }
            }
        }

        Self::has_windows_vulkan_loader(Path::new(r"C:\Windows"))
    }

    fn has_windows_vulkan_loader(system_root: &Path) -> bool {
        system_root.join("System32").join("vulkan-1.dll").is_file()
    }

    pub fn get_whisper_config(&self) -> AdaptiveWhisperConfig {
        self.whisper_config_for_platform(Self::is_apple_silicon())
    }

    fn whisper_config_for_platform(&self, apple_silicon: bool) -> AdaptiveWhisperConfig {
        #[cfg(target_os = "windows")]
        {
            let _ = apple_silicon;
            return AdaptiveWhisperConfig {
                beam_size: 2,
                temperature: 0.2,
                use_gpu: self.has_gpu_acceleration,
                max_threads: Some(Self::recommended_decoder_threads(self.cpu_cores, 1, 8)),
                chunk_size_preference: ChunkSizePreference::Balanced,
            };
        }

        #[cfg(not(target_os = "windows"))]
        {
            // Keep local transcription thermally safe during a meeting. Metal and
            // Core ML handle acceleration, while two CPU decoder threads and beam
            // search two leave enough headroom for capture, rendering, and the OS.
            if apple_silicon && self.gpu_type == GpuType::Metal {
                return AdaptiveWhisperConfig {
                    beam_size: 2,
                    temperature: 0.2,
                    use_gpu: true,
                    max_threads: Some(2),
                    chunk_size_preference: ChunkSizePreference::Balanced,
                };
            }

            match self.performance_tier {
                PerformanceTier::Ultra => AdaptiveWhisperConfig {
                    beam_size: 5,
                    temperature: 0.1,
                    use_gpu: self.has_gpu_acceleration,
                    max_threads: Some(Self::recommended_decoder_threads(self.cpu_cores, 1, 8)),
                    chunk_size_preference: ChunkSizePreference::Quality,
                },
                PerformanceTier::High => AdaptiveWhisperConfig {
                    beam_size: 3,
                    temperature: 0.2,
                    use_gpu: self.has_gpu_acceleration,
                    max_threads: Some(Self::recommended_decoder_threads(self.cpu_cores, 1, 6)),
                    chunk_size_preference: ChunkSizePreference::Balanced,
                },
                PerformanceTier::Medium => AdaptiveWhisperConfig {
                    beam_size: 2,
                    temperature: 0.3,
                    use_gpu: self.has_gpu_acceleration,
                    max_threads: Some(Self::recommended_decoder_threads(self.cpu_cores, 1, 4)),
                    chunk_size_preference: ChunkSizePreference::Balanced,
                },
                PerformanceTier::Low => AdaptiveWhisperConfig {
                    beam_size: 1,
                    temperature: 0.4,
                    use_gpu: false,
                    max_threads: Some(2),
                    chunk_size_preference: ChunkSizePreference::Fast,
                },
            }
        }
    }

    pub fn get_recommended_chunk_duration_ms(&self) -> u32 {
        if Self::is_apple_silicon() && self.gpu_type == GpuType::Metal {
            return 18_000;
        }

        match self.performance_tier {
            PerformanceTier::Ultra => 25_000,
            PerformanceTier::High => 20_000,
            PerformanceTier::Medium => 15_000,
            PerformanceTier::Low => 10_000,
        }
    }

    pub fn can_handle_realtime(&self, sample_rate: u32, channels: u16) -> bool {
        let data_rate = sample_rate * channels as u32;

        match self.performance_tier {
            PerformanceTier::Ultra => data_rate <= 192_000,
            PerformanceTier::High => data_rate <= 96_000,
            PerformanceTier::Medium => data_rate <= 48_000,
            PerformanceTier::Low => data_rate <= 22_050,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(
        cpu_cores: u8,
        memory_gb: u8,
        gpu_type: GpuType,
        performance_tier: PerformanceTier,
    ) -> HardwareProfile {
        HardwareProfile {
            cpu_cores,
            has_gpu_acceleration: gpu_type != GpuType::None,
            gpu_type,
            memory_gb,
            performance_tier,
        }
    }

    #[test]
    fn test_hardware_detection() {
        let detected = HardwareProfile::detect();
        assert!(detected.cpu_cores > 0);
        assert!(detected.memory_gb > 0);
    }

    #[test]
    fn test_whisper_config_generation() {
        let detected = HardwareProfile::detect();
        let config = detected.get_whisper_config();

        assert!((1..=5).contains(&config.beam_size));
        assert!((0.0..=1.0).contains(&config.temperature));
        assert!(config.max_threads.is_some_and(|threads| threads >= 1));
    }

    #[test]
    fn test_performance_tier_logic() {
        assert_eq!(
            HardwareProfile::calculate_performance_tier(2, &GpuType::None, 4),
            PerformanceTier::Low
        );
        assert_eq!(
            HardwareProfile::calculate_performance_tier(8, &GpuType::Metal, 16),
            PerformanceTier::Ultra
        );
    }

    #[test]
    fn memory_bytes_are_rounded_up_without_defaulting_to_eight_gb() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(HardwareProfile::bytes_to_gib_rounded_up(16 * GIB), 16);
        assert_eq!(HardwareProfile::bytes_to_gib_rounded_up(18 * GIB - 1), 18);
        assert_eq!(HardwareProfile::bytes_to_gib_rounded_up(0), 8);
    }

    #[test]
    fn apple_silicon_profile_caps_decoder_work_for_thermal_headroom() {
        let m_series = profile(12, 24, GpuType::Metal, PerformanceTier::Ultra);
        let config = m_series.whisper_config_for_platform(true);

        assert_eq!(config.beam_size, 2);
        assert_eq!(config.max_threads, Some(2));
        assert!(config.use_gpu);
        assert_eq!(config.chunk_size_preference, ChunkSizePreference::Balanced);

        for cpu_cores in [8, 10, 12] {
            let m_series = profile(cpu_cores, 24, GpuType::Metal, PerformanceTier::Ultra);
            assert_eq!(
                m_series.whisper_config_for_platform(true).max_threads,
                Some(2)
            );
        }
    }

    #[test]
    fn decoder_threads_keep_headroom() {
        assert_eq!(HardwareProfile::recommended_meeting_threads(8), 4);
        assert_eq!(HardwareProfile::recommended_meeting_threads(10), 6);
        assert_eq!(HardwareProfile::recommended_meeting_threads(12), 6);
        assert_eq!(HardwareProfile::recommended_meeting_threads(2), 2);
    }

    #[test]
    fn hardware_detector_finds_windows_vulkan_loader_in_system32() {
        let temp_dir = tempfile::tempdir().unwrap();
        let system32 = temp_dir.path().join("System32");
        std::fs::create_dir(&system32).unwrap();
        std::fs::write(system32.join("vulkan-1.dll"), []).unwrap();

        assert!(HardwareProfile::has_windows_vulkan_loader(temp_dir.path()));
    }

    #[test]
    fn hardware_detector_rejects_missing_windows_vulkan_loader() {
        let temp_dir = tempfile::tempdir().unwrap();
        assert!(!HardwareProfile::has_windows_vulkan_loader(temp_dir.path()));
    }
}
