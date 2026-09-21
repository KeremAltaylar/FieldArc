/* tools/phone.mjs — drive Chrome on an Android phone or emulator from this machine.
 *
 * Why this exists: Fieldscape's hard problems are mobile ones — audio glitching on Android
 * Chrome, layout at phone widths, GPS behaviour on a real walk — and every round of them so far
 * has been diagnosed by relaying numbers back and forth by hand. Android exposes Chrome's
 * DevTools over USB; `adb forward` puts that endpoint on localhost, and Node has had a global
 * WebSocket since 22, so the whole protocol is reachable with no dependencies at all.
 *
 * This is emphatically NOT an emulator substitute for audio judgement. An emulator runs x86 on
 * the host CPU and its audio path is a host-side shim, so its glitching behaviour says nothing
 * about a real phone's. Use it for layout, for plumbing, and for catching exceptions; trust a
 * real device over USB for anything about load or sound.
 *
 * Setup once:
 *   - phone: Settings > Developer options > USB debugging, plug in, accept the RSA prompt
 *   - emulator: just boot it
 *   - both: Chrome must be open on a page (its DevTools socket only exists while it runs)
 *
 * Usage:
 *   node tools/phone.mjs devices
 *   node tools/phone.mjs targets
 *   node tools/phone.mjs open https://keremaltaylar.github.io/Fieldscape/diag.html
 *   node tools/phone.mjs eval "document.title"
 *   node tools/phone.mjs eval-file scratch/probe.js
 *   node tools/phone.mjs console 15        # watch console output for 15 seconds
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = 9222;

/* adb is wherever the SDK put it; PATH is checked first so a system install wins. */
function adbPath() {
  const local = join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools",
                     process.platform === "win32" ? "adb.exe" : "adb");
  if (existsSync(local)) { return local; }
  return "adb";
}

function adb(...args) {
  return execFileSync(adbPath(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function devices() {
  const out = adb("devices", "-l").trim().split("\n").slice(1).filter(Boolean);
  if (!out.length) {
    throw new Error("no device. Plug in with USB debugging on, or boot an emulator, then " +
                    "accept the RSA prompt on the phone.");
  }
  return out;
}

/* The socket name Chrome for Android publishes. A WebView-based app would use a different one
   (<package>_devtools_remote); this project only ever needs Chrome. */
function forward() {
  adb("forward", "tcp:" + PORT, "localabstract:chrome_devtools_remote");
}

async function targets() {
  forward();
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!r.ok) { throw new Error("DevTools endpoint said " + r.status + " — is Chrome open on the device?"); }
  return (await r.json()).filter((t) => t.type === "page");
}

async function firstPage() {
  const list = await targets();
  if (!list.length) {
    throw new Error("Chrome is running but has no page open. Open any tab on the device first.");
  }
  return list[0];
}

/* One request/response over the target's WebSocket, plus any events that arrive while it is
   open — which is how `console` below listens without a second connection. */
function session(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("could not open the DevTools socket")));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) { reject(new Error(msg.error.message)); } else { resolve(msg.result); }
      return;
    }
    listeners.forEach((fn) => fn(msg));
  });
  return {
    ready,
    on: (fn) => listeners.push(fn),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close()
  };
}

async function evaluate(expression) {
  const s = session(await firstPage());
  await s.ready;
  /* awaitPromise so a probe can `await` on the device; returnByValue so what comes back is data
     rather than a remote object handle this script would then have to walk. */
  const r = await s.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  s.close();
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

async function watchConsole(seconds) {
  const s = session(await firstPage());
  await s.ready;
  s.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
      console.log(`[${msg.params.type}] ${text}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      console.log(`[exception] ${d.exception?.description || d.text}`);
    }
    if (msg.method === "Log.entryAdded") {
      console.log(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
    }
  });
  await s.send("Runtime.enable");
  await s.send("Log.enable");
  console.log(`listening for ${seconds}s…`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  s.close();
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "devices") {
    console.log(devices().join("\n"));
  } else if (cmd === "targets") {
    console.log((await targets()).map((t) => `${t.title}\n  ${t.url}`).join("\n") || "no pages open");
  } else if (cmd === "open") {
    const s = session(await firstPage());
    await s.ready;
    await s.send("Page.navigate", { url: rest[0] });
    s.close();
    console.log("navigated to " + rest[0]);
  } else if (cmd === "eval") {
    console.log(JSON.stringify(await evaluate(rest.join(" ")), null, 1));
  } else if (cmd === "eval-file") {
    console.log(JSON.stringify(await evaluate(readFileSync(rest[0], "utf8")), null, 1));
  } else if (cmd === "console") {
    await watchConsole(Number(rest[0]) || 10);
  } else {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0]);
  }
} catch (e) {
  console.error("phone.mjs: " + e.message);
  process.exit(1);
}
