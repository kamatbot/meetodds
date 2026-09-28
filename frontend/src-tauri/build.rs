#[path = "build/ffmpeg.rs"]
mod ffmpeg;
#[path = "build/apple_speech.rs"]
mod apple_speech;

fn main() {
    #[cfg(target_os = "macos")]
    {
        apple_speech::compile();
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=EventKit");
        compile_calendar_bridge();

        // Let the enhanced_macos crate handle its own Swift compilation
        // The swift-rs crate build will be handled in the enhanced_macos crate's build.rs
    }

    // Download and bundle FFmpeg binary at build-time
    ffmpeg::ensure_ffmpeg_binary();

    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn compile_calendar_bridge() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let source = manifest.join("src/calendar_bridge.m");
    let object = out_dir.join("meetodds_calendar_bridge.o");
    println!("cargo:rerun-if-changed={}", source.display());

    let output = Command::new("xcrun")
        .args(["clang", "-fobjc-arc", "-fblocks", "-c"])
        .arg(&source)
        .arg("-o")
        .arg(&object)
        .output()
        .expect("failed to launch xcrun clang for EventKit bridge");
    if !output.status.success() {
        panic!(
            "failed to compile EventKit bridge: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    // Directly include the Objective-C object in the final Rust link. The framework
    // declarations above provide Foundation/EventKit and macOS supplies BlocksRuntime.
    println!("cargo:rustc-link-arg={}", object.display());
}
