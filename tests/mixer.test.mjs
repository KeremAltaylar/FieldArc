// tests/mixer.test.mjs — mute and solo on the info cards.
/* Kerem, 2026-09-20: "I want route and point sound sources soloable and muteable / on info
   cards". A live listening tool: never saved to a feature, never published, gone on reload. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}
const mixLevel = new Function(src("mixLevel") + "; return mixLevel;")();
const none = { mute: {}, solo: {} };

test("with nothing muted or soloed, everything plays", () => {
  for (const id of ["a", "b", "route"]) { assert.equal(mixLevel(none, id), 1, id); }
});

test("a muted source is silent and the others are untouched", () => {
  const m = { mute: { a: true }, solo: {} };
  assert.equal(mixLevel(m, "a"), 0);
  assert.equal(mixLevel(m, "b"), 1);
  assert.equal(mixLevel(m, "route"), 1);
});

test("a solo silences everything not soloed, including the route", () => {
  const m = { mute: {}, solo: { a: true } };
  assert.equal(mixLevel(m, "a"), 1);
  assert.equal(mixLevel(m, "b"), 0);
  assert.equal(mixLevel(m, "route"), 0);
});

test("several sources can be soloed at once", () => {
  const m = { mute: {}, solo: { a: true, route: true } };
  assert.equal(mixLevel(m, "a"), 1);
  assert.equal(mixLevel(m, "route"), 1);
  assert.equal(mixLevel(m, "b"), 0);
});

/* Otherwise a solo would switch a point back on that was deliberately silenced, and the mute
   button would read as broken. */
test("mute wins over solo on the same source", () => {
  assert.equal(mixLevel({ mute: { a: true }, solo: { a: true } }, "a"), 0);
});

test("clearing the last solo brings everything back", () => {
  const m = { mute: {}, solo: { a: true } };
  delete m.solo.a;
  assert.equal(mixLevel(m, "b"), 1);
});

test("the mixer scales what distance earned, and every change is ramped", () => {
  const apply = src("applyMixer");
  assert.match(apply, /bed\.synth\.gain\.rampTo\(mixLevel\(mixer, MIX_ROUTE\), BED\.fade\)/,
    "the route's synths are one source");
  assert.match(apply, /v\.gain\.gain\.rampTo\(v\.base \* mixLevel\(mixer, id\), BED\.fade\)/);
  assert.match(apply, /R\.gain\.gain\.rampTo\(R\.base \* mixLevel\(mixer, id\), BED\.fade\)/);
  /* The proximity paths must keep the mixer applied, or the next tick would undo a mute. */
  assert.match(html, /v\.gain\.gain\.rampTo\(g \* mixLevel\(mixer, z\.id\), BED\.fade\)/);
  assert.match(html, /R\.gain\.gain\.rampTo\(g \* mixLevel\(mixer, x\.z\.id\), BED\.fade\)/);
  assert.match(html, /var fx = buildFxChain\(Tone, patch\.fx, patch\.tempo, bed\.synth\)/,
    "the route's voices run through the synth stage, not straight to the master");
});

test("a route mixes as one source, a point as itself", () => {
  assert.match(src("mixIdOf"), /kind === "route" \? MIX_ROUTE : f\.properties\.id/);
});

/* The whole point of "not saved": a mute must not reach the archive or the server. */
test("the mixer never edits, saves or publishes", () => {
  const toggle = src("mixToggle");
  for (const forbidden of ["claimEdit", "save(", "commit(", "properties"]) {
    assert.ok(!toggle.includes(forbidden), "mixToggle must not " + forbidden);
  }
  assert.match(toggle, /applyMixer\(\);/);
  assert.match(html, /var mixer = \{ mute: \{\}, solo: \{\} \};/, "plain state, not persisted");
  assert.ok(!/localStorage[^\n]*mixer|mixer[^\n]*localStorage/.test(html), "never stored");
});

/* A listener explores the piece with these, so they are not part of the setter surface. */
test("the mixer row is not gated, and says why a source is silent under someone else's solo", () => {
  const gate = html.slice(html.indexOf("function applyModeGating()"), html.indexOf("sizePeek();"));
  assert.ok(!gate.includes(".mixrow") && !gate.includes("#f-mute"),
    "mute and solo belong to listening, not authoring");
  assert.match(html, /<div class="chips mixrow">/);
  assert.match(src("renderMix"), /\$\("#f-mixnote"\)\.hidden = !!mixer\.mute\[id\] \|\| mixLevel\(mixer, id\) === 1/);
});
