import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { service } from "./clients.mjs";

const html = readFileSync("index.html", "utf8");

test("the page has a sign-in control and it is not a password field", () => {
  assert.match(html, /id="setter-email"/);
  assert.match(html, /id="setter-send"/);
  assert.match(html, /id="setter-out"/);
  assert.doesNotMatch(html, /type="password"/,
    "magic link only — a password field here would be a second credential to leak");
});

test("sign-in asks for a magic link, not a password grant", () => {
  assert.match(html, /signInWithOtp/);
  assert.doesNotMatch(html, /signInWithPassword/);
});

test("the redirect returns to this page, not to a bare origin", () => {
  assert.match(html, /emailRedirectTo/);
  assert.match(html, /location\.origin \+ location\.pathname/);
});

/* A stranger who signs in is authenticated but is not a setter. The database decides that,
   not the page — this asserts the row that grants it does not exist by accident. */
test("being authenticated is not the same as being a setter", async () => {
  const db = service();
  const { data } = await db.from("setters").select("id");
  assert.ok(Array.isArray(data), "setters table is readable by the service role");
});

/* Round 1 finding: the pinned supabase-js "@2" fires SIGNED_IN on session restore, not only
   on a real authentication, so switching on the event name double-logs a sign_in row on
   every reload. The fix compares last_sign_in_at — a server-side stamp that only changes on
   a genuine sign-in — against the last one seen, kept in localStorage.

   Round 2 finding: last_sign_in_at taken from the verifyOtp/session payload is itself stale —
   it reflects the record from BEFORE the sign-in it is completing, so the first reload's
   getSession() sees a refreshed value, reads it as a change, and logs a second time. The fix
   reads the stamp from sb.auth.getUser() at the moment it decides, not from the event/session
   payload, so it agrees with itself at sign-in time and at every reload after.

   These tests pin logSignIn()'s body down specifically — a refactor back to trusting the
   event name, or back to reading last_sign_in_at off the session/event payload instead of
   asking getUser() for the current record, fails here without needing a live reload. */
const logSignInBody = html.match(/function logSignIn\(\)\s*\{[\s\S]*?\n  \}\r?\n/);

test("logSignIn() exists as its own function, called with no session argument", () => {
  assert.ok(logSignInBody, "logSignIn() not found — the sign-in log path was restructured");
});

test("the sign-in decision asks the server for the current user, not the event payload, before logging", () => {
  assert.match(logSignInBody[0], /sb\.auth\.getUser\(\)/,
    "last_sign_in_at must come from getUser() at decision time — the verifyOtp/session payload carries the value from BEFORE the sign-in it is completing");
  assert.match(logSignInBody[0], /last_sign_in_at/);
});

test("a getUser() failure (offline, unreachable) declines to log rather than guessing", () => {
  assert.match(logSignInBody[0], /r\.error/, "checks the getUser() result for an error before trusting it");
  assert.match(logSignInBody[0], /\.catch\(/, "getUser() is a network call and can reject outright, not just resolve with .error");
});

test("the last logged sign-in is remembered locally so a reload does not re-log it", () => {
  assert.match(html, /fieldarc\.lastauth/, "a dedicated key, alongside the app's other fieldarc.* keys");
  assert.match(logSignInBody[0], /localStorage\.getItem\(LASTAUTH_KEY\)/, "reads the stored stamp before deciding to log");
  assert.match(logSignInBody[0], /localStorage\.setItem\(LASTAUTH_KEY/, "records the stamp once the log succeeds");
});
