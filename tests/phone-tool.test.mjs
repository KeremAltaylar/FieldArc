// tests/phone-tool.test.mjs — the shape of the phone driver, without a phone.
/* This cannot connect to a device in CI, so it tests the two things that are still worth
   pinning: that the tool exists with the commands later tasks call, and that it fails with a
   sentence a human can act on rather than a stack trace when nothing is plugged in.

   The CDP transport (the WebSocket, no dependency) lives in tools/cdp.mjs, shared with Task 2's
   desktop driver — see the ruling in task-1-brief.md. So the transport is asserted there; the
   things specific to driving a phone (adb's forward socket, the Runtime.evaluate call an eval
   probe makes) are asserted against tools/phone.mjs, which is where they actually live. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
  let out = "";
  try {
    out = execFileSync(process.execPath, ["tools/phone.mjs", "devices"],
                       { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  assert.match(out, /USB debugging|no device|adb/i,
    "a bare stack trace is not an instruction: " + out.slice(0, 200));
});
