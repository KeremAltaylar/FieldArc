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
   every reload. Tried comparing last_sign_in_at against the last one seen, kept in
   localStorage.

   Round 2 finding: last_sign_in_at taken from the verifyOtp/session payload is stale by
   construction — it reflects the record from BEFORE the sign-in it is completing. Tried
   reading it from sb.auth.getUser() instead, at decision time.

   Round 3 finding: getUser() measured no better — the server's write to last_sign_in_at is
   not visible to the very next read from EITHER source; it settles a moment later, which is
   why reload 1 (not the sign-in itself) was the one logging twice. last_sign_in_at cannot
   answer this question at the instant it's asked, from any source. The fix instead decodes
   the `session_id` claim out of the access token's own JWT payload (session.access_token,
   split on ".", index 1, base64url -> base64, atob, JSON.parse) — present the instant the
   session exists, constant across reloads and token refreshes of the same session, different
   on every genuine sign-in, and requires no network round trip at all.

   These tests pin logSignIn()'s body down specifically — a refactor back to trusting the
   event name, or back to reading last_sign_in_at from any source instead of decoding
   session_id from the access token, fails here without needing a live reload. */
const logSignInBody = html.match(/function logSignIn\(session\)\s*\{[\s\S]*?\n  \}\r?\n/);

test("logSignIn(session) exists and is scoped to the JWT decode this round introduced", () => {
  assert.ok(logSignInBody, "logSignIn(session) not found — the sign-in log path was restructured");
});

test("the sign-in decision decodes session_id from the access token's JWT, not last_sign_in_at from any source", () => {
  assert.match(logSignInBody[0], /session\.access_token/, "the JWT is read off the session argument");
  assert.match(logSignInBody[0], /\.split\("\."\)\[1\]/, "the payload segment of the JWT (index 1) is decoded");
  assert.match(logSignInBody[0], /replace\(\/-\/g,\s*"\+"\)/, "base64url is converted to base64 before decoding");
  assert.match(logSignInBody[0], /atob\(/);
  assert.match(logSignInBody[0], /claims\.session_id|\.session_id/, "session_id is the claim compared, not last_sign_in_at");
  assert.doesNotMatch(logSignInBody[0], /last_sign_in_at/,
    "last_sign_in_at was measured unreliable at decision time in rounds 1 and 2 — it must not return here");
  assert.doesNotMatch(logSignInBody[0], /sb\.auth\.getUser\(\)/,
    "getUser() cost a round trip and did not answer the question — round 3 drops it entirely");
});

test("a malformed or missing token declines to log rather than throwing", () => {
  assert.match(logSignInBody[0], /try\s*\{[\s\S]*?atob/, "the decode is inside a try block");
  assert.match(logSignInBody[0], /catch\s*\(e\)\s*\{\s*return;\s*\}/, "a decode failure returns rather than propagating");
});

/* Round 4 finding: even with session_id as the key, storing it only inside the insert's
   .then left a window — a reload, navigation, or close during that in-flight network round
   trip means the store never happens, so the next load sees no stored key and logs again.
   That turns a lost round trip into a permanent duplicate, the opposite of the stated
   preference (a gap beats a duplicate in a table nothing can remove a row from). The fix
   moves the store to before the insert is issued, so the same lost round trip now produces a
   missing row instead. This test asserts the ORDER, not just that both calls exist — a
   reorder back to storing inside the insert's .then is the exact regression this round
   fixed, and it must fail this test even though setItem still appears somewhere in the body. */
test("the last logged session_id is remembered locally so a reload does not re-log it", () => {
  assert.match(html, /fieldarc\.lastauth/, "a dedicated key, alongside the app's other fieldarc.* keys — same key as prior rounds");
  assert.match(logSignInBody[0], /localStorage\.getItem\(LASTAUTH_KEY\)/, "reads the stored session_id before deciding to log");
  assert.match(logSignInBody[0], /localStorage\.setItem\(LASTAUTH_KEY/, "records the session_id once the log succeeds");
});

test("the session_id is stored BEFORE the audit insert is issued, not after it resolves", () => {
  const setItemAt = logSignInBody[0].search(/localStorage\.setItem\(LASTAUTH_KEY/);
  const insertAt = logSignInBody[0].search(/sb\.from\("audit"\)\.insert\(/);
  assert.notEqual(setItemAt, -1, "setItem(LASTAUTH_KEY, ...) not found");
  assert.notEqual(insertAt, -1, 'sb.from("audit").insert(...) not found');
  assert.ok(setItemAt < insertAt,
    "storing after the insert's .then leaves a window where a reload during the network " +
    "round trip loses the store and the next load logs a permanent duplicate — the key must " +
    "be stored before the insert is issued, so a lost round trip produces a missing row " +
    "instead of a duplicate one");
  assert.doesNotMatch(logSignInBody[0], /\.then\(function \(ins\)[\s\S]*?setItem/,
    "setItem must not be inside the insert's .then callback");
});
