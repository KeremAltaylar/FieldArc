// tests/phone-tool.test.mjs — the shape of the phone driver, without a phone.
/* This cannot connect to a device in CI, so most of it tests things that are still worth pinning
   without hardware: that the tool exists with the commands later tasks call, that it fails with
   a sentence a human can act on rather than a stack trace when adb can't be found, and — this is
   the part worth most, per fix-round-1 review — that tools/cdp.mjs's session() actually behaves
   correctly under concurrency and disconnection. That last part needs no device either: it's
   pure id-multiplexing and event dispatch over a WebSocket, so a fake WebSocket exercises it
   directly, in-process, with no adb, no emulator, no network.

   The CDP transport (the WebSocket, no dependency) lives in tools/cdp.mjs, shared with Task 2's
   desktop driver — see the ruling in task-1-brief.md. So the transport is asserted there; the
   things specific to driving a phone (adb's forward socket, the Runtime.evaluate call an eval
   probe makes) are asserted against tools/phone.mjs, which is where they actually live. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { session } from "../tools/cdp.mjs";

const cdp = readFileSync("tools/cdp.mjs", "utf8");
const phone = readFileSync("tools/phone.mjs", "utf8");

test("the transport is dependency-free", () => {
  assert.match(cdp, /new WebSocket\(/, "Node 24 has a global WebSocket — nothing to install");
  assert.ok(!/require\(|from "ws"|from 'ws'/.test(cdp), "no websocket library");
  assert.match(phone, /localabstract:chrome_devtools_remote/,
    "the socket Chrome for Android publishes");
});

test("an eval probe awaits on the device and gets data back, not a handle", () => {
  assert.match(phone, /Runtime\.evaluate/);
  assert.match(phone, /awaitPromise: true/, "a probe must be able to await on the device");
  assert.match(phone, /returnByValue: true/, "and get data back, not a remote handle");
});

test("every command later tasks depend on is implemented", () => {
  for (const cmd of ["devices", "targets", "open", "eval", "eval-file", "console"]) {
    assert.ok(phone.includes(`"${cmd}"`), "missing command: " + cmd);
  }
});

test("with no device attached it says what to do about it", () => {
  /* Deterministic regardless of what's actually plugged into this machine (fix-round-1, finding
     3): a later task in this plan runs the suite WITH a phone connected, and the original
     version of this test — spawning the real adb — went red the moment that phone was actually
     there, at exactly the moment we're measuring it. So instead of hoping nothing is attached,
     starve the child's own adb resolution: point LOCALAPPDATA at a directory with no SDK in it
     (adbPath()'s preferred path won't exist) and clear PATH (the "adb" fallback that command
     resolves to can't be found either). Node then fails to spawn adb at all — ENOENT — the same
     failure shape with or without a real device or emulator sitting on the other end of adb. */
  const emptyDir = mkdtempSync(join(tmpdir(), "phone-tool-test-"));
  let out = "";
  try {
    out = execFileSync(process.execPath, ["tools/phone.mjs", "devices"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LOCALAPPDATA: emptyDir, PATH: "" }
    });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  assert.match(out, /USB debugging|no device|adb/i,
    "a bare stack trace is not an instruction: " + out.slice(0, 200));
});

/* ---- session() behaviour, driven by a fake WebSocket (fix-round-1, finding 4) ----
   cdp.mjs reads the global `WebSocket` at call time, not at import time, so overwriting
   globalThis.WebSocket before calling session() is enough to redirect it — no mocking library,
   same "no dependency" rule the transport itself follows. */

class FakeSocket {
  constructor() {
    FakeSocket.instances.push(this);
    this.sent = [];
    this.listeners = new Map();
    // real sockets open asynchronously; a synchronous "open" would hide ordering bugs .ready
    // depends on, so this one waits a tick too.
    queueMicrotask(() => this._fire("open", {}));
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) { this.listeners.set(type, []); }
    this.listeners.get(type).push(fn);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this._fire("close", {}); }
  reply(msg) { this._fire("message", { data: JSON.stringify(msg) }); }
  _fire(type, ev) { (this.listeners.get(type) || []).forEach((fn) => fn(ev)); }
}
FakeSocket.instances = [];
// Set once, at load time: session() reads the global `WebSocket` when it's called, not when
// cdp.mjs was imported, so this is enough to redirect every session() call below to the fake.
globalThis.WebSocket = FakeSocket;

function fakeSession() {
  const before = FakeSocket.instances.length;
  const s = session({ webSocketDebuggerUrl: "ws://fake" });
  return { s, ws: FakeSocket.instances[before] };
}

test("two concurrent sends resolve to the right ids, not FIFO order", async () => {
  const { s, ws } = fakeSession();
  await s.ready;
  const pA = s.send("A");
  const pB = s.send("B");
  const idA = ws.sent.find((m) => m.method === "A").id;
  const idB = ws.sent.find((m) => m.method === "B").id;
  assert.notEqual(idA, idB, "two in-flight sends must get distinct ids");
  // reply out of order — B's answer first — to prove dispatch is by id, not by send order
  ws.reply({ id: idB, result: { value: "B-result" } });
  ws.reply({ id: idA, result: { value: "A-result" } });
  assert.deepEqual(await pA, { value: "A-result" });
  assert.deepEqual(await pB, { value: "B-result" });
});

test("an error reply rejects only its own send", async () => {
  const { s, ws } = fakeSession();
  await s.ready;
  const pOk = s.send("Fine");
  const pBad = s.send("Broken");
  const idBad = ws.sent.find((m) => m.method === "Broken").id;
  const idOk = ws.sent.find((m) => m.method === "Fine").id;
  ws.reply({ id: idBad, error: { message: "boom" } });
  ws.reply({ id: idOk, result: { value: "ok" } });
  await assert.rejects(pBad, /boom/);
  assert.deepEqual(await pOk, { value: "ok" });
});

test("a socket close rejects an in-flight send rather than hanging", async () => {
  // fix-round-1 finding 1: before this fix, a send() in flight when the socket closed — device
  // unplugged, Chrome killed — never settled at all. This is the regression test for that.
  const { s, ws } = fakeSession();
  await s.ready;
  const pending = s.send("Runtime.evaluate");
  ws.close();
  await assert.rejects(pending, /closed/i);
});

test("an event arriving before on() registers still reaches the listener", async () => {
  // fix-round-1 finding 2: a caller isn't guaranteed to register on() before the socket starts
  // delivering (Page.navigate, a device mid-load); before this fix such an event was just
  // dropped, silently, with nothing to say it happened.
  const { s, ws } = fakeSession();
  await s.ready;
  ws.reply({ method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ value: "early" }] } });
  const seen = [];
  s.on((msg) => seen.push(msg));
  assert.equal(seen.length, 1, "the pre-registration event must still arrive");
  assert.equal(seen[0].method, "Runtime.consoleAPICalled");
  // and a second, ordinary post-registration event reaches the same listener directly
  ws.reply({ method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ value: "late" }] } });
  assert.equal(seen.length, 2);
});
