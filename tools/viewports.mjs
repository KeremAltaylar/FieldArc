/* tools/viewports.mjs — measure the app's layout at real phone viewports.
 *
 * Drives whatever Chrome is already listening on --remote-debugging-port=9223, using
 * Emulation.setDeviceMetricsOverride: the same CDP call the DevTools device toolbar makes, so
 * these are true CSS viewports with touch, not a resized desktop window.
 *
 * The transport (list targets, open a session) is shared with tools/phone.mjs's Android driver
 * via tools/cdp.mjs — this file only adds what's specific to a desktop Chrome: no adb, no
 * device, just a debugging port that's already there.
 *
 * Start Chrome first:
 *   chrome --remote-debugging-port=9223 --user-data-dir=%TEMP%\fs-viewports
 */
import { targets, session } from "./cdp.mjs";

const PORT = 9223;
const URL_UNDER_TEST = process.argv[2] || "http://127.0.0.1:8080/";

/* width x height, and why each one is here. */
const VIEWPORTS = [
  { w: 360, h: 800, why: "the narrow end — a budget Android, where things overlap first" },
  { w: 390, h: 844, why: "iPhone 14/15" },
  { w: 412, h: 915, why: "Pixel" },
  { w: 430, h: 932, why: "iPhone Pro Max" },
  { w: 900, h: 600, why: "the max-width: 900px edge, still mobile layout" },
  { w: 1024, h: 620, why: "the max-height: 620px edge — a laptop in a short window" }
];

const list = await targets(PORT);
if (!list.length) { console.error("no page target on port " + PORT); process.exit(1); }
const s = session(list[0]);
await s.ready;
await s.send("Page.enable");

let worst = 0;
for (const v of VIEWPORTS) {
  await s.send("Emulation.setDeviceMetricsOverride", {
    width: v.w, height: v.h, deviceScaleFactor: 3, mobile: true
  });
  await s.send("Page.navigate", { url: URL_UNDER_TEST });
  await new Promise((r) => setTimeout(r, 6000));       /* the map and the archive have to land */
  const r = await s.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      vScroll: document.documentElement.scrollHeight - innerHeight,
      hScroll: document.documentElement.scrollWidth - innerWidth,
      offscreen: [...document.querySelectorAll('button, input, select')]
        .filter(function (e) { var b = e.getBoundingClientRect();
          return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1); }).length
    })`
  });
  const m = r.result.value;
  worst = Math.max(worst, m.vScroll, m.hScroll, m.offscreen);
  const bad = m.vScroll > 0 || m.hScroll > 0 || m.offscreen > 0;
  console.log(`${String(v.w).padStart(4)}x${v.h}  vScroll ${String(m.vScroll).padStart(4)}  ` +
              `hScroll ${String(m.hScroll).padStart(4)}  offscreen controls ${m.offscreen}  ` +
              `${bad ? "FAIL" : "ok"}   ${v.why}`);
}
await s.send("Emulation.clearDeviceMetricsOverride");
s.close();
process.exit(worst > 0 ? 1 : 0);
