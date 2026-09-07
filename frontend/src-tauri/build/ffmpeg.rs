// ============================================================================
// FFmpeg Binary Bundling
// ============================================================================
// MeetOdds does not download executable binaries from an upstream project at
// build time. Release/dev environments must provide FFmpeg explicitly through
// MEETODDS_FFMPEG_BINARY or install `ffmpeg` on PATH. The build then copies and
// verifies that binary in the Tauri sidecar location for the active target.

/// Provision and bundle FFmpeg for the current target platform.
pub fn ensure_ffmpeg_binary() {
    let target = std::env::var("TARGET")
        .or_else(|_| std::env::var("HOST"))
        .expect("Neither TARGET nor HOST environment variable set");

    println!("cargo:rerun-if-env-changed=MEETODDS_FFMPEG_BINARY");
    println!("cargo:warning=🎬 Checking FFmpeg binary for target: {}", target);

    let binary_name = if target.contains("windows") {
        format!("ffmpeg-{}.exe", target)
    } else {
        format!("ffmpeg-{}", target)
    };

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR environment variable not set");
    let binaries_dir = std::path::PathBuf::from(&manifest_dir).join("binaries");
    let binary_path = binaries_dir.join(&binary_name);

    if binary_path.exists() && verify_ffmpeg_binary(&binary_path) {
        println!(
            "cargo:warning=✅ FFmpeg binary already provisioned and verified: {}",
            binary_name
        );
        return;
    }

    if binary_path.exists() {
        println!(
            "cargo:warning=⚠️  Removing invalid provisioned FFmpeg binary: {}",
            binary_path.display()
        );
        let _ = std::fs::remove_file(&binary_path);
    }

    std::fs::create_dir_all(&binaries_dir).expect("Failed to create binaries directory");

    let source = explicit_ffmpeg_binary()
        .or_else(|| which::which("ffmpeg").ok())
        .unwrap_or_else(|| {
            panic!(
                "FFmpeg is required to build MeetOdds. Set MEETODDS_FFMPEG_BINARY to a trusted FFmpeg executable or install ffmpeg on PATH. MeetOdds intentionally does not download executable binaries from an upstream project."
            )
        });

    if !source.is_file() {
        panic!(
            "Configured FFmpeg binary does not exist or is not a file: {}",
            source.display()
        );
    }
    if !verify_ffmpeg_binary(&source) {
        panic!("Configured FFmpeg binary failed verification: {}", source.display());
    }

    if source != binary_path {
        std::fs::copy(&source, &binary_path).unwrap_or_else(|error| {
            panic!(
                "Failed to copy FFmpeg from {} to {}: {}",
                source.display(),
                binary_path.display(),
                error
            )
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&binary_path)
            .expect("Failed to read bundled FFmpeg metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary_path, permissions)
            .expect("Failed to make bundled FFmpeg executable");
    }

    if !verify_ffmpeg_binary(&binary_path) {
        panic!(
            "Bundled FFmpeg binary failed verification after copy: {}",
            binary_path.display()
        );
    }

    println!(
        "cargo:warning=✅ Bundled trusted FFmpeg from {} as {}",
        source.display(),
        binary_name
    );
}

fn explicit_ffmpeg_binary() -> Option<std::path::PathBuf> {
    std::env::var_os("MEETODDS_FFMPEG_BINARY")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
}

/// Verify FFmpeg is functional before it can be bundled.
fn verify_ffmpeg_binary(path: &std::path::Path) -> bool {
    match std::process::Command::new(path).arg("-version").output() {
        Ok(output) if output.status.success() => {
            if let Some(version_line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                println!("cargo:warning=✅ FFmpeg verification passed: {}", version_line);
            }
            true
        }
        _ => false,
    }
}
