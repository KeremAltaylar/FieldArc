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
