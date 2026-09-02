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

pnpm exec tauri build -- --features metal,coreml
