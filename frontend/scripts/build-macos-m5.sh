#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "tauri:build:m5 must run on an Apple Silicon Mac." >&2
  exit 1
fi

logical_cores="$(sysctl -n hw.logicalcpu_max 2>/dev/null || sysctl -n hw.ncpu)"
build_jobs="$logical_cores"
if (( logical_cores > 4 )); then
  build_jobs=$((logical_cores - 2))
fi

chip_name="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
echo "Building Notes for ${chip_name:-Apple Silicon} with ${build_jobs} parallel jobs"

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$build_jobs}"
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-$build_jobs}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-cpu=native"

workspace_root="$(cd "$(dirname "$0")/../.." && pwd)"
target_triple="$(rustc -vV | awk '/^host:/{print $2}')"
sidecar_path="src-tauri/binaries/llama-helper-${target_triple}"

echo "Building llama-helper sidecar for ${target_triple}"
cargo build --manifest-path "$workspace_root/llama-helper/Cargo.toml" --release --features metal
mkdir -p "$(dirname "$sidecar_path")"
install -m 755 "$workspace_root/target/release/llama-helper" "$sidecar_path"

# Auto-detect or allow override of macOS codesigning identity
signing_identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$signing_identity" ]]; then
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    signing_identity="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  elif security find-identity -v -p codesigning 2>/dev/null | grep -q "Apple Development"; then
    signing_identity="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/{print $2; exit}')"
  else
    signing_identity="-"
  fi
fi

echo "Signing with identity: $signing_identity"

if [[ "${APP_ONLY:-0}" == "1" ]]; then
  echo "Packaging a fast release app only (no DMG or updater artifact)"
  pnpm exec tauri build --config "{\"bundle\":{\"createUpdaterArtifacts\":false,\"macOS\":{\"signingIdentity\":\"$signing_identity\"}}}" --bundles app -- --features metal,coreml
else
  echo "Packaging full distributable release: App bundle and signed DMG installer"
  pnpm exec tauri build --config "{\"bundle\":{\"createUpdaterArtifacts\":false,\"macOS\":{\"signingIdentity\":\"$signing_identity\"}}}" --bundles app,dmg -- --features metal,coreml
fi
