#!/bin/sh
# Builds the phase-3 iOS host for the simulator from the repo root, no Xcode project:
#   sh ios/build.sh && xcrun simctl install booted build/ios/Fieldscape.app
set -e
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
export SDKROOT="$SDK"
T=arm64-apple-ios16.0-simulator
OUT=build/ios/Fieldscape.app
mkdir -p "$OUT" build/ios/obj
for f in core/core.cpp core/mix.cpp core/devices/*.cpp; do
  xcrun --sdk iphonesimulator clang++ -std=c++17 -O2 -target $T -c "$f" -o "build/ios/obj/$(basename "$f" .cpp).o"
done
xcrun swiftc -O -target $T -sdk "$SDK" -import-objc-header core/fieldscape.h \
  ios/App.swift build/ios/obj/*.o -lc++ -parse-as-library -o "$OUT/Fieldscape"
cp ios/Info.plist "$OUT/"
[ -f build/ab/stretch.wav ] && cp build/ab/stretch.wav "$OUT/"
codesign -s - "$OUT"
