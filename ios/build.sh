#!/bin/sh
# Builds the iOS app for the simulator from the repo root, on the Mac:
#   sh ios/build.sh && xcrun simctl install booted build/ios/dd/Build/Products/Debug-iphonesimulator/Fieldscape.app
# Uses XcodeGen (ios/project.yml) and xcodebuild, since the app now depends on the MapLibre Swift
# package. Real-device installs go through Xcode's Run (iOS 16 phones cannot be reached over SSH).
set -e
XCODEGEN=${XCODEGEN:-$HOME/xcodegen/bin/xcodegen}
(cd ios && "$XCODEGEN" -q)
xcodebuild -project ios/Fieldscape.xcodeproj -scheme Fieldscape -destination "generic/platform=iOS Simulator" \
  -derivedDataPath build/ios/dd -quiet build
