#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
if [[ "$(node --version)" != v24.* ]]; then
  echo "MeetOdds builds require Node.js 24.x." >&2
  exit 1
fi

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
echo "Building MeetOdds for Apple Silicon (${chip_name:-unknown host}) with ${build_jobs} parallel jobs"

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$build_jobs}"
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-$build_jobs}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
# Distributed apps must also run on the user's other Apple Silicon Mac. Native
# instruction tuning is an explicit host-only experiment, never the release default.
if [[ "${LOCAL_CPU_NATIVE:-0}" == "1" ]]; then
  export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-cpu=native"
elif [[ "${RUSTFLAGS:-}" == *target-cpu=native* ]]; then
  echo "Refusing host-specific RUSTFLAGS for a portable release. Unset them or explicitly opt into LOCAL_CPU_NATIVE=1." >&2
  exit 1
fi

workspace_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$workspace_root/frontend"

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
  pnpm exec tauri build --config "{\"bundle\":{\"createUpdaterArtifacts\":false,\"macOS\":{\"signingIdentity\":\"$signing_identity\"}}}" --bundles app
else
  echo "Packaging full distributable release: App bundle and signed DMG installer"
  pnpm exec tauri build --config "{\"bundle\":{\"createUpdaterArtifacts\":false,\"macOS\":{\"signingIdentity\":\"$signing_identity\"}}}" --bundles app,dmg
fi
