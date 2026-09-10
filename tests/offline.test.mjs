import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const sw = readFileSync("sw.js", "utf8");

/* A slice bounded by two indexOf() calls is only meaningful if the end marker actually
   occurs after the start marker in the file. If it doesn't — or if either marker is
   missing — indexOf/.slice() silently produce an empty (or wrong) string, and every
   doesNotMatch assertion below would then pass without checking anything. This bit once
   already in this stage: the brief's own "save()" slice used "function uid()" as an end
   marker, but uid() is declared after publish() in index.html, so that slice swallowed
   the whole publish() function — including the literal text "function publish()" — and
   would have failed the doesNotMatch assertion for a reason unrelated to save() actually
   calling publish(). Every slice here is built through this helper so a moved or missing
   marker fails loudly instead of the test quietly proving nothing. */
function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  if (endMarker === undefined) { return html.slice(start); }
  const end = html.indexOf(endMarker);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  assert.ok(end > start,
    `end marker "${endMarker}" occurs at or before start marker "${startMarker}" ` +
    `(start=${start}, end=${end}) — the slice would be empty or backwards and every ` +
    `assertion on it would pass without checking anything`);
  return html.slice(start, end);
}

test("nothing in the capture path awaits the network", () => {
  /* Mark, the trace watcher and the map-click handler must not call sb. If one of them
     does, a setter in a dead zone is a setter who cannot mark a point. */
  const capture = slice("function markPoint", "function updateLive");
  assert.doesNotMatch(capture, /\bsb\./, "markPoint must not touch the client");
});

test("save() writes locally and does not publish", () => {
  /* Bounded by the Setter-session comment rather than "function uid()": uid() is
     declared after publish() in the file, so a slice ending there would include all of
     publish() itself. The Setter-session comment sits immediately after save()'s
     closing brace and before publish(), so it bounds exactly the function under test. */
  const save = slice("function save()", "/* ---------- Setter session");
  assert.match(save, /localStorage\.setItem/);
  assert.doesNotMatch(save, /publish\(/, "saving must never trigger a push");
});

test("the supabase library is cached by the service worker", () => {
  assert.match(sw, /unpkg\.com/, "IS_ASSET must cover the supabase bundle");
});

test("the pending module is in the shell cache", () => {
  assert.match(sw, /pending\.mjs/, "a forest reload must still have the manifest code");
});

test("publish refuses without a session instead of throwing", () => {
  const pub = slice("function publish()");
  assert.match(pub, /if \(!sb \|\| !setter\.signedIn\)/);
});
