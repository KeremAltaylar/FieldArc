/* tools/emulator.mjs — create and boot the Android emulator used for layout checks.
 *
 * NOT for audio judgement. The emulator runs x86 on the host CPU and its audio output is a
 * host-side shim, so its glitching behaviour says nothing about a real phone's. Layout,
 * plumbing and exceptions only — trust a real device over USB for load and sound.
 */
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

const SDK = join(process.env.LOCALAPPDATA, "Android", "Sdk");
const AVD = "fieldscape-pixel";
const IMAGE = "system-images;android-34;google_apis;x86_64";

/* avdmanager ships as a .bat on Windows, and Windows will not exec a .bat directly the way it
   execs a .exe — node's spawnSync throws EINVAL unless told to go through a shell. .exe targets
   (emulator itself, below) don't need this, so it's opt-in per call rather than global. */
const win = process.platform === "win32";
function sh(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], shell: win });
}

const avdmanager = join(SDK, "cmdline-tools", "latest", "bin", win ? "avdmanager.bat" : "avdmanager");
const emulator = join(SDK, "emulator", win ? "emulator.exe" : "emulator");
if (!existsSync(emulator)) {
  console.error("emulator not installed. Run:\n  sdkmanager emulator " + IMAGE);
  process.exit(1);
}

const have = sh(avdmanager, ["list", "avd"]).includes(AVD);
if (!have) {
  console.log("creating AVD " + AVD + "…");
  execFileSync(avdmanager, ["create", "avd", "-n", AVD, "-k", IMAGE, "-d", "pixel_6"],
               { input: "no\n", encoding: "utf8", shell: win });
}
console.log("booting " + AVD + " — this takes a minute on first run");
/* Audio stays ON: a silent emulator cannot run an AudioContext at all, and Task 3 needs one. */
const child = spawn(emulator, ["-avd", AVD, "-no-boot-anim", "-gpu", "swiftshader_indirect"],
                    { detached: true, stdio: "ignore" });
child.unref();
console.log("booted in the background. Check with: npm run phone -- devices");
