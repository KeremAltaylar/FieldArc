// tests/server-authority.test.mjs
// Once a device has published a feature, the server decides whether it still exists. A phone
// that authored a point kept showing it after a setter removed it elsewhere, and would have
// written it back with deleted_at: null on its next publish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

function body(name) {
  const start = html.indexOf("function " + name + "(");
  assert.ok(start !== -1, `function not found: ${name}`);
  let i = html.indexOf("{", html.indexOf(")", start)), depth = 0;
  const from = i;
  for (; i < html.length; i++) {
    if (html[i] === "{") { depth++; }
    else if (html[i] === "}") { depth--; if (depth === 0) { break; } }
  }
  return { params: html.slice(start + name.length + 10, html.indexOf(")", start)), src: html.slice(from + 1, i) };
}
function extractFn(name) { const b = body(name); return new Function(b.params, b.src); }

test("goneFromServer: a row that is soft-deleted, or absent altogether, is gone; a live row stays", () => {
  const goneFromServer = extractFn("goneFromServer");
  const rows = [
    { id: "a", deleted_at: null },
    { id: "b", deleted_at: "2026-09-18T10:00:00Z" },
    { id: "d" }                                    // public_features rows carry no deleted_at
  ];
  assert.deepEqual(goneFromServer(["a", "b", "c", "d"], rows), ["b", "c"]);
});

test("reconcile only ever considers features this device has published — a draft never is", () => {
  const src = body("reconcileWithServer").src;
  assert.match(src, /loadManifest\(\)/);
  assert.match(src, /authoredFeatures\(\)/);
  assert.match(src, /in man/, "candidates must be filtered to ids present in the publish manifest");
});

test("a setter asks the features table, including deleted_at; a listener asks the public view", () => {
  const src = body("reconcileWithServer").src;
  assert.match(src, /from\("features"\)\.select\("id, deleted_at"\)/);
  assert.match(src, /from\("public_features"\)\.select\("id"\)/);
  assert.match(src, /setter\.signedIn/);
});

test("ids are queried in chunks, so a large archive never builds an over-long request URL", () => {
  const src = body("reconcileWithServer").src;
  assert.match(src, /\.slice\(\s*i\s*,\s*i\s*\+\s*RECONCILE_CHUNK\s*\)/);
});

test("any failed or offline query retires nothing", () => {
  const src = body("reconcileWithServer").src;
  assert.match(src, /r\.error/);
  assert.match(src, /\.catch\(/);
});

test("retired features go to the local trash and leave the manifest, so nothing reads as pending", () => {
  const src = body("retireFromServer").src;
  assert.match(src, /trash\(\)/);
  assert.match(src, /setTrash\(/);
  assert.match(src, /delete man\[/);
  assert.match(src, /saveManifest\(man\)/);
  assert.match(src, /commit\(\)/);
});

function runVisible({ signedIn, manifest, features, placeId = "P", worldOn = false }) {
  const b = body("visible");
  const fn = new Function("fc", "place", "setterTools", "loadManifest", "shownTo", "worldOn", b.src);
  return fn({ features }, { properties: { id: placeId } }, () => signedIn, () => manifest,
            extractFn("shownTo"), () => worldOn)
    .map((f) => f.properties.name);
}

test("a listener never sees a draft this device did not publish; a setter sees everything", () => {
  const f = (name, extra = {}) => ({ properties: Object.assign({ id: name, place: "P", name }, extra) });
  const features = [
    f("server", { _remote: true }),
    f("published-here"),
    f("draft"),
    f("elsewhere", { place: "Q" })
  ];
  const manifest = { "published-here": "h" };
  assert.deepEqual(runVisible({ signedIn: false, manifest, features }), ["server", "published-here"]);
  assert.deepEqual(runVisible({ signedIn: true, manifest, features }), ["server", "published-here", "draft"]);
});

test("open world does not weaken the listener/setter boundary", () => {
  /* worldOn() only ever widens `here` (the place filter). It must never reach shownTo(), which
     is the actual listener/setter gate — a park being open to everyone is not the same thing as
     a draft being published. Every feature below sits in "P" (the open park), "Q" (a park that
     is not open) or no park at all (place: null, a free point), crossed with published
     (id in manifest) vs. an unpublished draft (not remote, not in the manifest). */
  const f = (name, extra = {}) => ({ properties: Object.assign({ id: name, name }, extra) });
  const features = [
    f("published-here", { place: "P" }),
    f("published-elsewhere", { place: "Q" }),        // the new behaviour: open world must show this
    f("draft-elsewhere", { place: "Q" }),             // unpublished, another park — must stay hidden
    f("free-draft", { place: null })                  // unpublished, no park at all — must stay hidden
  ];
  const manifest = { "published-here": "h", "published-elsewhere": "h2" };

  var listener = runVisible({ signedIn: false, manifest, features, worldOn: true }).sort();
  assert.deepEqual(listener, ["published-elsewhere", "published-here"],
    "a listener in open world sees every published feature, cross-park included, " +
    "but neither unpublished draft — not the one in another park, not the free one");

  var setter = runVisible({ signedIn: true, manifest, features, worldOn: true }).sort();
  assert.deepEqual(setter,
    ["draft-elsewhere", "free-draft", "published-elsewhere", "published-here"],
    "a setter still sees their own unpublished work in open world, cross-park and free alike");
});

test("the place picker's counts follow the same rule as the map", () => {
  const src = body("renderPlaceList").src;
  assert.match(src, /shownTo\(/);
  assert.match(body("visible").src, /shownTo\(/);
});

test("a change of sign-in state redraws the map and list, so drafts appear and disappear with it", () => {
  const apply = body("applySession").src;
  assert.match(apply, /refreshFeatures\(\)/);
  const src = body("refreshFeatures").src;
  assert.match(src, /setData\(\{\s*type:\s*"FeatureCollection",\s*features:\s*visible\(\)\s*\}\)/);
  assert.doesNotMatch(src, /save\(\)/, "a redraw is not an edit and must not count as a change");
});

test("reconcile waits for both a known session and a ready map, and runs once per sign-in state", () => {
  const src = body("maybeReconcile").src;
  assert.match(src, /sessionKnown/);
  assert.match(src, /map\.getSource\("features"\)/);
  assert.match(src, /reconciledAs\s*===\s*setter\.signedIn/);
  const apply = body("applySession").src;
  assert.match(apply, /sessionKnown\s*=\s*true/);
  assert.match(apply, /maybeReconcile\(\)/);
  const fetchSrc = body("fetchPublished").src;
  assert.match(fetchSrc, /maybeReconcile\(\)/);
});
