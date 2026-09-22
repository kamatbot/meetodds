#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
artifacts="$root/.artifacts/apple-speech"
mkdir -p "$artifacts"
out="$artifacts/meetodds-apple-speech-harness"
tmp=$(mktemp -d "$artifacts/harness.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
/usr/bin/say -v Samantha -o "$tmp/fixture.aiff" 'This is a fixed public English phrase for local speech bridge validation. Progressive transcription must arrive before a final result after this audio finishes.'
ffmpeg -hide_banner -loglevel error -y -i "$tmp/fixture.aiff" -ac 1 -ar 48000 -f f32le "$tmp/fixture.f32le"
xcrun --sdk macosx swiftc -parse-as-library -c -target arm64-apple-macosx14.2 -O -enable-library-evolution -o "$out.o" "$root/src/apple_speech_bridge.swift"
xcrun --sdk macosx swiftc "$out.o" "$root/tools/apple-speech/bridge_harness.c" -o "$out" -Xlinker -weak_framework -Xlinker Speech -framework AVFoundation -framework CoreMedia
nm -gU "$out" | grep -E '_md_speech_(capabilities|prepare|start|push|finish|cancel)$'
otool -L "$out" | grep 'Speech.framework.*weak'
APPLE_SPEECH_RAW="$tmp/fixture.f32le" "$out"
