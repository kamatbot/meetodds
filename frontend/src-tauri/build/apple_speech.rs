use std::{env, path::PathBuf, process::Command};

pub fn compile() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let source = manifest.join("src/apple_speech_bridge.swift");
    let intelligence = manifest.join("src/apple_intelligence_bridge.swift");
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("meetodds_apple_speech.o");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", intelligence.display());
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    let target_arch = match env::var("CARGO_CFG_TARGET_ARCH")
        .expect("target architecture")
        .as_str()
    {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("unsupported macOS Swift architecture: {}", other),
    };
    let deployment = env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "14.2".into());
    let target = format!("{}-apple-macosx{}", target_arch, deployment);
    let output = Command::new("xcrun")
        .args([
            "--sdk",
            "macosx",
            "swiftc",
            "-parse-as-library",
            "-wmo",
            "-c",
            "-target",
            &target,
            "-O",
            "-enable-library-evolution",
            "-o",
        ])
        .arg(&object)
        .arg(&source)
        .arg(&intelligence)
        .output()
        .expect("launch xcrun swiftc for Apple Speech bridge");
    if !output.status.success() {
        panic!(
            "Apple Speech bridge compilation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    println!("cargo:rustc-link-arg={}", object.display());
    // Ask Xcode for its current locations at build time. These are link-search
    // inputs only; no developer-machine path is embedded in the application.
    let sdk = String::from_utf8(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .expect("locate macOS SDK")
            .stdout,
    )
    .expect("UTF-8 SDK path");
    let swiftc = String::from_utf8(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "--find", "swiftc"])
            .output()
            .expect("locate swiftc")
            .stdout,
    )
    .expect("UTF-8 swiftc path");
    let sdk_swift = PathBuf::from(sdk.trim()).join("usr/lib/swift");
    let toolchain_swift = PathBuf::from(swiftc.trim())
        .parent()
        .and_then(|path| path.parent())
        .expect("swiftc usr directory")
        .join("lib/swift/macosx");
    println!("cargo:rustc-link-search=native={}", sdk_swift.display());
    println!(
        "cargo:rustc-link-search=native={}",
        toolchain_swift.display()
    );
    // Weak-linking keeps macOS 14/15 launches valid. The bridge performs its own
    // macOS 26 runtime check before touching SpeechAnalyzer APIs.
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,FoundationModels");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=swiftCore");
    println!("cargo:rustc-link-lib=swift_Concurrency");
    // Rust's linker does not add swiftc's runtime search path automatically.
    // Swift concurrency is supplied by macOS, including in the dyld shared
    // cache. Use its system path, not an Xcode/developer-machine directory, so
    // test binaries and the distributed app launch without DYLD overrides.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
