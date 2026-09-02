# Apple Silicon and M5 performance

Notes already compiles Whisper with Metal and Core ML on macOS. This milestone fixes the runtime and release-path gaps that prevented newer Apple Silicon machines from using that capacity effectively.

## Runtime changes

- Detects actual physical/unified memory through `sysinfo` instead of treating every machine as 8 GB unless `MEMORY_GB` was manually set.
- Uses an Apple-Silicon-specific balanced decoder profile: beam 3 on 16 GB or larger machines, beam 2 below 16 GB, Metal enabled, and two CPU cores reserved for audio capture, UI rendering, and macOS.
- Applies the computed decoder thread count to both Whisper transcription paths. Previously the value was calculated and logged but discarded, leaving whisper.cpp at its four-thread default.
- Avoids beam 5 for the high-memory Apple Silicon tier; that setting favored marginal search quality over meeting-transcription latency.
- Removes an unconditional 200 ms sleep while the resource monitor held its write lock. Monitoring now refreshes only memory and CPU data and relies on the existing sample interval.
- Uses available memory and actual headroom below the configured memory limit when calculating safe parallel workers.

## M5-native build

On an M5 Mac from `frontend/`:

```bash
pnpm tauri:build:m5
```

The script verifies an arm64 macOS host, preserves two logical cores for the system during compilation, enables Metal and Core ML, and adds `-C target-cpu=native` so the local release binary can use the exact CPU features exposed by that Mac. Normal release builds remain portable across supported Apple Silicon Macs.

The Cargo release profile now uses optimization level 3, thin LTO, one codegen unit, symbol stripping, and abort-on-panic. This improves shipped runtime performance and binary size at the cost of a slower release compile.

## Validation boundary

Deterministic configuration and resource-accounting tests run on CI. The native build script is syntax-checked there. A real-time-factor benchmark still needs to be run on the target M5 hardware because an x86/Linux CI runner cannot measure Metal, Core ML, thermals, or Apple unified-memory bandwidth.
