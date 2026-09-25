#!/bin/sh
# Builds the phase-3 Android host from the repo root, no Gradle (Git Bash on Windows):
#   sh android/build.sh && adb install -r build/android/fieldscape.apk
# Debug-signed with the SDK's debug key; minSdk 26 is where AAudio begins.
set -e
SDK="$LOCALAPPDATA/Android/Sdk"
NDK=$(ls -d "$SDK"/ndk/* | tail -1)
BT=$(ls -d "$SDK"/build-tools/* | tail -1)
CXX="$NDK/toolchains/llvm/prebuilt/windows-x86_64/bin/clang++"
OUT=build/android
rm -rf "$OUT" && mkdir -p "$OUT/lib/arm64-v8a" "$OUT/lib/x86_64"
for abi in arm64-v8a:aarch64 x86_64:x86_64; do
  "$CXX" --target=${abi#*:}-linux-android26 -std=c++17 -O2 -shared -fPIC -static-libstdc++ \
    core/core.cpp core/mix.cpp core/devices/*.cpp android/main.cpp -laaudio -llog -landroid \
    -o "$OUT/lib/${abi%%:*}/libfieldscape.so"
done
"$BT/aapt2" link -o "$OUT/unsigned.apk" --manifest android/AndroidManifest.xml -I "$SDK/platforms/android-34/android.jar"
(cd "$OUT" && jar uf unsigned.apk lib)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
KS="$HOME/.android/debug.keystore"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass android -alias androiddebugkey -keypass android \
  -keyalg RSA -validity 10000 -dname "CN=Android Debug"
"$BT/apksigner.bat" sign --ks "$KS" --ks-pass pass:android --out "$OUT/fieldscape.apk" "$OUT/aligned.apk"
