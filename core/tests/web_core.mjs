/* The web app on the shared core (?core), in headless Chrome against a local server: presses Sound,
   walks the Koşuyolu route and back through __fa.walkTo, and reads what the engine reports
   (__fa.core) and what actually leaves it (an analyser after the output gain).

     python -m http.server 8765    (repo root, in another shell)
     node core/tests/web_core.mjs [seconds]                                          */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targets, session } from "../../tools/cdp.mjs";

const seconds = +(process.argv[2] || 60);
const dir = mkdtempSync(join(tmpdir(), "fs-webcore-"));
const ch = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new", "--remote-debugging-port=9235", "--autoplay-policy=no-user-gesture-required", "--user-data-dir=" + dir, "about:blank"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let t; for (let i = 0; i < 50 && !t; i++) { try { t = (await targets(9235))[0]; } catch { await sleep(200); } }
  const s = session(t); await s.ready;
  const errors = [];
  s.on((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && /core|error/i.test(JSON.stringify(m.params.args))) console.log("console:", m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
  });
  await s.send("Runtime.enable");
  await s.send("Page.navigate", { url: process.env.FS_URL || "http://localhost:8765/?core" });
  const ev = async (e) => (await s.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  for (let i = 0; i < 100 && !(await ev("!!(window.__fa && __fa.walkTo && document.body.classList.contains('world'))")); i++) await sleep(300);
  await sleep(3000);                                      /* the published features */
  await ev("document.getElementById('patch-play').click()");
  for (let i = 0; i < 50 && !(await ev("!!(window.__fa && __fa.core)")); i++) {
    await ev("__fa.walkTo(29.038879, 41.00771)"); await sleep(300);
  }
  const lon0 = 29.038879, lat0 = 41.00771, lon1 = 29.0412, lat1 = 41.0102;
  const rows = [];
  for (let k = 0; k <= seconds; k++) {
    const u = k / seconds < 0.5 ? (2 * k) / seconds : 2 - (2 * k) / seconds;
    await ev(`__fa.walkTo(${lon0 + (lon1 - lon0) * u}, ${lat0 + (lat1 - lat0) * u})`);
    await sleep(1000);
    if (k % 5 === 0) {
      const st = await ev("JSON.stringify({ c: __fa.core, lvl: __fa.coreLevel ? __fa.coreLevel() : null })");
      rows.push(st); const j = JSON.parse(st); console.log(`t=${k}s level ${j.lvl === null ? "-" : j.lvl.toFixed(1)} dB · route ${j.c && j.c.route} · ${j.c ? j.c.rows.map((r) => r.name + (r.loaded ? "" : " (loading)")).join(", ") : ""} · rhythm ${j.c ? j.c.rhythms.join(", ") : ""}`);
    }
  }
  console.log("errors:", errors.length ? errors : "none");
  s.close();
} finally { process.kill(ch.pid); await sleep(500); try { rmSync(dir, { recursive: true, force: true }); } catch {} }
