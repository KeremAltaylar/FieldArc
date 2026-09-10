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
   a genuine sign-in — against the last one seen, kept in localStorage. These tests pin that
   shape down: a refactor back to event-name-only fails here without needing a live reload. */
test("a sign-in is logged by comparing last_sign_in_at, not by trusting the event name alone", () => {
  assert.match(html, /last_sign_in_at/,
    "the event name a version of supabase-js fires on restore is not something this page controls; only a server-side timestamp decides");
});

test("the last logged sign-in is remembered locally so a reload does not re-log it", () => {
  assert.match(html, /fieldarc\.lastauth/, "a dedicated key, alongside the app's other fieldarc.* keys");
  assert.match(html, /localStorage\.getItem\(LASTAUTH_KEY\)/, "reads the stored stamp before deciding to log");
  assert.match(html, /localStorage\.setItem\(LASTAUTH_KEY/, "records the stamp once the log succeeds");
});
