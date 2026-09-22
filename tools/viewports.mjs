/* tools/viewports.mjs — measure the app's layout at real phone viewports.
 *
 * Launches its own throwaway Chrome and drives it over CDP with Emulation.setDeviceMetricsOverride
 * and Emulation.setTouchEmulationEnabled: the same calls the DevTools device toolbar makes, so
 * these are true CSS viewports with a coarse pointer, not a resized desktop window with a mouse.
 *
 * Chrome is this tool's own responsibility, start to finish. Fix round 1 (2026-09-22) found that
 * leaving a human to hand-start Chrome and clean it up afterwards is exactly what leads to a
 * blunt `taskkill /F /IM chrome.exe` — which kills every Chrome on the machine, not just this
 * tool's. So this file launches Chrome on a throwaway profile, remembers its pid, and on the way
 * out — success, a bad viewport, or a thrown error — kills only that pid's process tree. Never
 * kill by image name, here or anywhere else touching this tool.
 *
 * setDeviceMetricsOverride alone is NOT enough to measure a phone layout. Verified against real
 * hardware in review: with only the metrics override, matchMedia("(pointer: coarse)").matches is
 * false and navigator.maxTouchPoints is 0 — Chrome still reports a desktop mouse pointer at a
 * phone-sized window. index.html gates real layout on that media feature (the tap-target minimum
 * on the Open world switch and route rows, the 16px input rule that stops iOS zooming into
 * cards, smallDevice()), so a run without setTouchEmulationEnabled is quietly measuring an easier
 * claim — "does the desktop-pointer layout fit at this width" — and would call rows shorter than
 * a real phone renders them. This file calls setTouchEmulationEnabled for every viewport and
 * refuses to report a result if the media feature didn't actually flip.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targets, session } from "./cdp.mjs";

const PORT = 9223;
const URL_UNDER_TEST = process.argv[2] || "http://127.0.0.1:8080/";

/* Generous on purpose: a cold cache or a slower machine must make this wait longer, not report a
   false pass from reading an unbuilt page. See waitForLoad — this is a ceiling on a real
   condition, not a delay stood in for one. */
const LOAD_TIMEOUT_MS = 20000;

/* width x height, and why each one is here. */
const VIEWPORTS = [
  { w: 360, h: 800, why: "the narrow end — a budget Android, where things overlap first" },
  { w: 390, h: 844, why: "iPhone 14/15" },
  { w: 412, h: 915, why: "Pixel" },
  { w: 430, h: 932, why: "iPhone Pro Max" },
  { w: 900, h: 600, why: "the max-width: 900px edge, still mobile layout" },
  { w: 1024, h: 620, why: "the max-height: 620px edge — a laptop in a short window" }
];

/* Chrome's install path isn't on PATH by default on Windows; check the usual spots before
   falling back to a bare command name, which at least fails with a clear ENOENT rather than
   silently trying the wrong binary. */
function chromePath() {
  if (process.platform === "win32") {
    const candidates = [
      join(process.env["ProgramFiles"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["LOCALAPPDATA"] || "", "Google", "Chrome", "Application", "chrome.exe")
    ];
    for (const c of candidates) { if (existsSync(c)) { return c; } }
    return "chrome.exe";
  }
  if (process.platform === "darwin") { return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; }
  return "google-chrome";
}

/* The DevTools HTTP endpoint takes a moment to come up after the process starts; polling it is
   the actual readiness signal, not a guess at how long that takes. */
async function waitForDevtools(port, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { return; }
    } catch { /* not listening yet */ }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Chrome's DevTools port ${port} never came up within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* Only ever kills the one pid's own tree, by pid — never by image name. A `taskkill /IM
 * chrome.exe` (what fix round 1's manual cleanup used) takes down every Chrome on the machine,
 * including whatever the person at the keyboard had open. Review confirmed `/F /T /PID` kills a
 * launched Chrome's full process tree (13 children in that run) without touching siblings. */
function killTree(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch { /* already gone */ }
}

/* Waits on the actual signs the page is usable, not a fixed delay: readyState past "loading",
   the MapLibre canvas actually in the DOM, and the archive tab's title actually rewritten by
   renderStats() (it starts as "" in markup — set to anything, even "0 points…", only once a
   fetch has resolved and rendered — so this can't be fooled by the static "0" already in the
   archive count badge's markup). A fixed sleep would report a clean pass from reading a page
   that hadn't finished loading yet, which is a worse failure mode than running slow. */
async function waitForLoad(s, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const r = await s.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `({
        ready: document.readyState === "complete",
        canvas: !!document.querySelector("#map .maplibregl-canvas"),
        archive: !!(document.querySelector("#tab-list") && document.querySelector("#tab-list").title)
      })`
    });
    const st = r.result.value;
    if (st.ready && st.canvas && st.archive) { return; }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`page did not finish loading within ${timeoutMs}ms (readyState complete: ` +
                       `${st.ready}, map canvas present: ${st.canvas}, archive rendered: ${st.archive})`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const profileDir = mkdtempSync(join(tmpdir(), "fs-viewports-"));
const chrome = spawn(chromePath(), [
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + profileDir,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank"
], { stdio: "ignore" });

let exitCode = 0;
try {
  await waitForDevtools(PORT, 15000);
  const list = await targets(PORT);
  if (!list.length) { throw new Error("Chrome came up but has no page target on port " + PORT); }
  const s = session(list[0]);
  await s.ready;
  await s.send("Page.enable");

  let worst = 0;
  for (const v of VIEWPORTS) {
    await s.send("Emulation.setDeviceMetricsOverride", {
      width: v.w, height: v.h, deviceScaleFactor: 3, mobile: true
    });
    await s.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await s.send("Page.navigate", { url: URL_UNDER_TEST });
    await waitForLoad(s, LOAD_TIMEOUT_MS);

    const r = await s.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `({
        pointerCoarse: window.matchMedia("(pointer: coarse)").matches,
        vScroll: document.documentElement.scrollHeight - innerHeight,
        hScroll: document.documentElement.scrollWidth - innerWidth,
        offscreen: [...document.querySelectorAll('button, input, select')]
          .filter(function (e) { var b = e.getBoundingClientRect();
            return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1); }).length
      })`
    });
    const m = r.result.value;
    /* Fail loud rather than report a green line from the wrong layout: a false here means every
       coarse-pointer-gated rule in index.html rendered as its desktop shape, so vScroll/hScroll/
       offscreen below are not measuring what this tool exists to measure. */
    if (!m.pointerCoarse) {
      throw new Error(`touch emulation did not take at ${v.w}x${v.h}: matchMedia("(pointer: ` +
                       `coarse)") was false after Emulation.setTouchEmulationEnabled — the ` +
                       "layout below this point would be the desktop shape, not the phone one");
    }
    worst = Math.max(worst, m.vScroll, m.hScroll, m.offscreen);
    const bad = m.vScroll > 0 || m.hScroll > 0 || m.offscreen > 0;
    console.log(`${String(v.w).padStart(4)}x${v.h}  vScroll ${String(m.vScroll).padStart(4)}  ` +
                `hScroll ${String(m.hScroll).padStart(4)}  offscreen controls ${m.offscreen}  ` +
                `${bad ? "FAIL" : "ok"}   ${v.why}`);
  }
  await s.send("Emulation.clearDeviceMetricsOverride");
  s.close();
  exitCode = worst > 0 ? 1 : 0;
} catch (e) {
  console.error("viewports.mjs: " + e.message);
  exitCode = 1;
} finally {
  killTree(chrome.pid);
  /* Chrome's crash-reporter process can hold a file in the profile dir open for a moment after
     the rest of the tree is gone, so the first rmSync right after kill can fail; a couple of
     short retries clear that without making a real failure here fail the whole run. */
  for (let attempt = 0; attempt < 3; attempt++) {
    try { rmSync(profileDir, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
}
process.exit(exitCode);
