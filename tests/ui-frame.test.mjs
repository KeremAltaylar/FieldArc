// tests/ui-frame.test.mjs — the map's frame, Fit in open world, and the phone's typography.
/* Kerem, 2026-09-21: "you can do the mobile ui scaling (sometimes it is zoom in to cards)",
   "when in open world mode we can zoom out in map to all routes centered so all of them fits",
   and "adding a frame that is good in ui to the map in browser (bottom and right of the map in
   proportion with upper frame)". */
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
function rule(selector) {
  const at = html.indexOf(selector + " {");
  assert.ok(at !== -1, "no rule for " + selector);
  return html.slice(at, html.indexOf("}", at) + 1);
}

/* iOS zooms into any field under 16 px and stays there, which is what made tapping a card's name
   or note feel like the card lunged. The fix must not be a viewport lock: pinch-zoom on the map
   is the one gesture this app cannot lose. */
test("a thumb gets 16px fields, so the phone never zooms itself into a card", () => {
  const at = html.indexOf('input[type="text"], input[type="email"], input[type="search"], textarea, select');
  assert.ok(at !== -1, "the coarse-pointer typography rule is missing");
  const before = html.slice(0, at);
  assert.match(before.slice(before.lastIndexOf("@media")), /@media \(pointer: coarse\)/,
    "and it applies only where the pointer is a thumb, so the desk keeps its typography");
  assert.match(html.slice(at, at + 200), /font-size: 1rem;/);
  /* The viewport tag itself, not the file: the comment beside the rule names `maximum-scale` in
     order to say why it is the wrong cure. */
  const viewport = html.slice(html.indexOf('<meta name="viewport"'), html.indexOf(">", html.indexOf('<meta name="viewport"')) + 1);
  assert.doesNotMatch(viewport, /maximum-scale|user-scalable=no/,
    "never at the cost of pinch-zoom on the map");
});

test("Fit frames everything shown in open world, and the forest otherwise", () => {
  const handler = html.slice(html.indexOf('$("#fit-forest").addEventListener'));
  const body = handler.slice(0, handler.indexOf("\n  });") + 6);
  assert.match(body, /if \(worldOn\(\)\)/, "open world has more to frame than one park");
  assert.match(body, /shownBounds\(\)/);
  assert.match(body, /map\.fitBounds\(all, \{ padding: 40, duration: 700 \}\); return;/);
  assert.match(body, /forestBounds/, "and the park's own outline is still the fallback");
});

test("shownBounds covers points and route lines, and nothing else", () => {
  const fn = src("shownBounds");
  assert.match(fn, /visible\(\)\.forEach/, "what is framed is what is shown");
  assert.match(fn, /g\.type === "Point"/);
  assert.match(fn, /g\.type === "LineString"/);
  assert.match(fn, /new maplibregl\.LngLatBounds\(\)/);
});

test("the map is framed on all four sides on a desktop, and on none on a phone", () => {
  const app = rule("#app");
  assert.match(app, /padding: 0 var\(--s-2\) var\(--s-2\) 0;/,
    "the right and bottom bands, in the same ground the header and panel are drawn in");
  assert.match(app, /background: var\(--ground\);/);
  const map = rule("#map");
  assert.match(map, /border-right: 1px solid var\(--bdr\)/);
  assert.match(map, /border-bottom: 1px solid var\(--bdr\)/);
  /* On a phone the map meets the sheet and the window edges: every pixel of height is the walk. */
  const phone = html.slice(html.indexOf("#app { padding: 0; }"));
  assert.ok(phone.startsWith("#app { padding: 0; }"), "the phone layout drops the bands");
  assert.match(phone.slice(0, 200), /#map \{ grid-row: 2; grid-column: 1; border-right: 0; border-bottom: 0; \}/);
});

/* Kerem, 2026-09-21: "there is white something in the right bottom corner behind locate and right
   top corner in mobile". MapLibre's own controls ship white: the zoom pair, the attribution "i",
   and — the one actually behind Locate — the scale bar at 75 % white. */
test("no MapLibre control is left in its packaged white", () => {
  for (const sel of [".maplibregl-ctrl-attrib", ".maplibregl-ctrl-attrib-button",
                     ".maplibregl-ctrl-group", ".maplibregl-ctrl-scale"]) {
    const at = html.indexOf(sel + " {");
    assert.ok(at !== -1, "no rule dressing " + sel);
    const body = html.slice(at, html.indexOf("}", at));
    assert.match(body, /var\(--sunk\)|var\(--bdr\)|invert\(1\)/,
      sel + " must be drawn in the app's own ground");
  }
  /* The attribution itself stays: it is a condition of the OSM and Esri tiles. */
  assert.ok(!/\.maplibregl-ctrl-attrib \{[^}]*display: none/.test(html),
    "the attribution is never hidden, only dressed");
});

test("a phone drops the zoom buttons and the scale bar, and centres the two map bars", () => {
  /* Several blocks share that media condition, so each rule is found on its own and checked
     against the @media that actually governs it — the nearest one above it. */
  const governedByMobile = (needle, why) => {
    const at = html.indexOf(needle);
    assert.ok(at !== -1, "missing rule: " + needle);
    const openedBy = html.lastIndexOf("@media", at);
    const condition = html.slice(openedBy, html.indexOf("{", openedBy));
    assert.match(condition, /max-width: 900px|max-height: 620px/, why);
  };
  governedByMobile(".maplibregl-ctrl-top-right .maplibregl-ctrl-group { display: none; }",
    "pinch is the zoom on a phone");
  governedByMobile(".maplibregl-ctrl-scale { display: none; }",
    "it lands under the Locate button, where it can only read as a smudge");
  governedByMobile("#pacerbar, #patchbar {",
    "the same air on both sides, instead of hugging the left edge");
  governedByMobile("#pacerbar { text-align: center; }", "the readout is centred on a phone");
  governedByMobile("#patchbar { justify-content: center;", "and so are the sound toggles");
  const bars = html.slice(html.indexOf("#pacerbar, #patchbar {"));
  assert.match(bars.slice(0, 120), /left: var\(--s-3\); right: var\(--s-3\);/,
    "equal margins, which is what centring them means here");
});
