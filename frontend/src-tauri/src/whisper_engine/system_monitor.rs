use anyhow::Result;
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use sysinfo::System;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemResources {
    pub memory_used_percent: f32,
    pub cpu_usage_percent: f32,
    pub cpu_temperature_celsius: Option<f32>,
    pub available_memory_mb: u64,
    pub total_memory_mb: u64,
    pub cpu_cores: usize,
}

#[derive(Debug, Clone)]
pub struct ResourceLimits {
    pub max_memory_percent: f32,
    pub max_cpu_percent: f32,
    pub max_cpu_temperature: f32,
    pub worker_memory_budget_mb: u64,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_memory_percent: 70.0,
            max_cpu_percent: 80.0,
            max_cpu_temperature: 85.0,
            worker_memory_budget_mb: 512,
        }
    }
}

pub struct SystemMonitor {
    system: Arc<RwLock<System>>,
    limits: ResourceLimits,
    monitoring_enabled: bool,
}

impl SystemMonitor {
    pub fn new() -> Self {
        info!("Initializing system monitor");
        let mut system = System::new_all();
        system.refresh_memory();
        system.refresh_cpu_all();

        Self {
            system: Arc::new(RwLock::new(system)),
            limits: ResourceLimits::default(),
            monitoring_enabled: true,
        }
    }

    pub fn with_limits(limits: ResourceLimits) -> Self {
        let mut monitor = Self::new();
        monitor.limits = limits;
        monitor
    }

    pub async fn refresh_system_info(&self) -> Result<()> {
        if !self.monitoring_enabled {
            return Ok(());
        }

        // Resource monitoring runs repeatedly while transcription is active.
        // Refresh only the values used here and never sleep while holding the
        // write lock; the previous unconditional 200 ms pause stalled every
        // reader even though normal monitoring intervals already provide the
        // differential sample required for CPU usage.
        let mut system = self.system.write().await;
        system.refresh_memory();
        system.refresh_cpu_all();
        Ok(())
    }

    pub async fn get_current_resources(&self) -> Result<SystemResources> {
        let system = self.system.read().await;

        let total_memory = system.total_memory();
        let available_memory = system.available_memory().min(total_memory);
        let used_memory = total_memory.saturating_sub(available_memory);
        let memory_used_percent = if total_memory == 0 {
            0.0
        } else {
            (used_memory as f32 / total_memory as f32) * 100.0
        };

        let cpu_usage_percent = if system.cpus().is_empty() {
            0.0
        } else {
            system.cpus().iter().map(|cpu| cpu.cpu_usage()).sum::<f32>()
                / system.cpus().len() as f32
        };

        let cpu_temperature_celsius = Self::get_cpu_temperature(&system);

        let resources = SystemResources {
            memory_used_percent,
            cpu_usage_percent,
            cpu_temperature_celsius,
            available_memory_mb: available_memory / 1024 / 1024,
            total_memory_mb: total_memory / 1024 / 1024,
            cpu_cores: system.cpus().len().max(1),
        };

        debug!(
            "Current resources: Memory: {:.1}%, CPU: {:.1}%, Temp: {:?}°C",
            resources.memory_used_percent,
            resources.cpu_usage_percent,
            resources.cpu_temperature_celsius
        );

        Ok(resources)
    }

    fn get_cpu_temperature(_system: &System) -> Option<f32> {
        // Temperature monitoring is optional and varies by platform.
        None
    }

    pub async fn check_resource_constraints(&self) -> Result<ResourceStatus> {
        self.refresh_system_info().await?;
        let resources = self.get_current_resources().await?;

        let mut status = ResourceStatus {
            can_proceed: true,
            memory_ok: true,
            cpu_ok: true,
            temperature_ok: true,
            warnings: Vec::new(),
        };

        if resources.memory_used_percent > self.limits.max_memory_percent {
            status.can_proceed = false;
            status.memory_ok = false;
            status.warnings.push(format!(
                "Memory usage too high: {:.1}% > {:.1}%",
                resources.memory_used_percent, self.limits.max_memory_percent
            ));
            warn!(
                "Memory constraint violated: {:.1}%",
                resources.memory_used_percent
            );
        }

        if resources.cpu_usage_percent > self.limits.max_cpu_percent {
            status.can_proceed = false;
            status.cpu_ok = false;
            status.warnings.push(format!(
                "CPU usage too high: {:.1}% > {:.1}%",
                resources.cpu_usage_percent, self.limits.max_cpu_percent
            ));
            warn!(
                "CPU constraint violated: {:.1}%",
                resources.cpu_usage_percent
            );
        }

        if let Some(temp) = resources.cpu_temperature_celsius {
            if temp > self.limits.max_cpu_temperature {
                status.can_proceed = false;
                status.temperature_ok = false;
                status.warnings.push(format!(
                    "CPU temperature too high: {:.1}°C > {:.1}°C",
                    temp, self.limits.max_cpu_temperature
                ));
                warn!("Temperature constraint violated: {:.1}°C", temp);
            }
        }

        Ok(status)
    }

    fn safe_worker_count_for(resources: &SystemResources, limits: &ResourceLimits) -> usize {
        let max_allowed_used_mb =
            (resources.total_memory_mb as f32 * (limits.max_memory_percent / 100.0)) as u64;
        let currently_used_mb = resources
            .total_memory_mb
            .saturating_sub(resources.available_memory_mb);
        let memory_headroom_mb = max_allowed_used_mb.saturating_sub(currently_used_mb);
        let memory_based_workers = if limits.worker_memory_budget_mb == 0 {
            1
        } else {
            (memory_headroom_mb / limits.worker_memory_budget_mb) as usize
        };

        memory_based_workers.min(resources.cpu_cores).min(4).max(1)
    }

    pub async fn calculate_safe_worker_count(&self) -> Result<usize> {
        self.refresh_system_info().await?;
        let resources = self.get_current_resources().await?;
        let safe_workers = Self::safe_worker_count_for(&resources, &self.limits);

        info!(
            "Calculated safe worker count: {} ({} MB available, {} cores)",
            safe_workers, resources.available_memory_mb, resources.cpu_cores
        );

        Ok(safe_workers)
    }

    pub fn set_monitoring_enabled(&mut self, enabled: bool) {
        self.monitoring_enabled = enabled;
        if enabled {
            info!("System monitoring enabled");
        } else {
            info!("System monitoring disabled");
        }
    }

    pub fn get_limits(&self) -> &ResourceLimits {
        &self.limits
    }

    pub fn update_limits(&mut self, limits: ResourceLimits) {
        info!(
            "Updating resource limits: memory: {:.1}%, cpu: {:.1}%, temp: {:.1}°C",
            limits.max_memory_percent, limits.max_cpu_percent, limits.max_cpu_temperature
        );
        self.limits = limits;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceStatus {
    pub can_proceed: bool,
    pub memory_ok: bool,
    pub cpu_ok: bool,
    pub temperature_ok: bool,
    pub warnings: Vec<String>,
}

impl ResourceStatus {
    pub fn is_healthy(&self) -> bool {
        self.memory_ok && self.cpu_ok && self.temperature_ok
    }

    pub fn get_primary_constraint(&self) -> Option<String> {
        if !self.memory_ok {
            Some("Memory usage too high".to_string())
        } else if !self.temperature_ok {
            Some("CPU temperature too high".to_string())
        } else if !self.cpu_ok {
            Some("CPU usage too high".to_string())
        } else {
            None
        }
    }
}

pub fn create_system_monitor() -> SystemMonitor {
    SystemMonitor::new()
}

pub fn create_system_monitor_with_limits(
    max_memory_percent: f32,
    max_cpu_percent: f32,
    max_cpu_temperature: f32,
) -> SystemMonitor {
    let limits = ResourceLimits {
        max_memory_percent,
        max_cpu_percent,
        max_cpu_temperature,
        worker_memory_budget_mb: 512,
    };
    SystemMonitor::with_limits(limits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_system_monitor_creation() {
        let monitor = SystemMonitor::new();
        assert!(monitor.monitoring_enabled);
    }

    #[tokio::test]
    async fn test_get_current_resources() {
        let monitor = SystemMonitor::new();
        let resources = monitor.get_current_resources().await.unwrap();

        assert!((0.0..=100.0).contains(&resources.memory_used_percent));
        assert!(resources.cpu_usage_percent >= 0.0);
        assert!(resources.total_memory_mb > 0);
        assert!(resources.cpu_cores > 0);
    }

    #[tokio::test]
    async fn test_safe_worker_count() {
        let monitor = SystemMonitor::new();
        let worker_count = monitor.calculate_safe_worker_count().await.unwrap();
        assert!((1..=4).contains(&worker_count));
    }

    #[test]
    fn worker_count_uses_memory_headroom_below_the_limit() {
        let resources = SystemResources {
            memory_used_percent: 50.0,
            cpu_usage_percent: 20.0,
            cpu_temperature_celsius: None,
            available_memory_mb: 8 * 1024,
            total_memory_mb: 16 * 1024,
            cpu_cores: 10,
        };
        let limits = ResourceLimits::default();
        assert_eq!(SystemMonitor::safe_worker_count_for(&resources, &limits), 4);

        let constrained = SystemResources {
            available_memory_mb: 5_500,
            ..resources
        };
        assert_eq!(
            SystemMonitor::safe_worker_count_for(&constrained, &limits),
            1
        );
    }
}
