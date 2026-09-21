// tests/listener-open-world.test.mjs — open world is how you listen; a park is how you author.
/* Kerem, 2026-09-21: "I think it will be best structural mode. How can we manage it inbetween
   setters and listeners? Should we leave totaly the park view of listeners?" — and then chose
   to. The reason is not performance: both modes were measured at the same cost (2 voices, 2
   stretch worklets, 16.7ms median frame, in both). It is that a listener walking a city does
   not know where a park boundary is, and place mode snaps them onto a route line they are not
   standing on. Open world's model — nearest route lends its patch, distance sets the level — is
   the truthful one for someone outdoors.

   A listener already gets routes instead of parks in the picker (renderPlaceList), so the only
   thing that could drop them into a park view was the switch itself. */
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

test("a listener is in open world whatever the stored preference says", () => {
  const fn = src("worldOn");
  /* WORLD_KEY must be declared in the sandbox: without it the read throws a ReferenceError,
     worldOn's own catch swallows it, and every case returns the offline default of true —
     which would pass three of the five assertions below for entirely the wrong reason. */
  const run = new Function("setterTools", "localStorage",
    'var WORLD_KEY = "fieldarc.world";' + fn + "; return worldOn();");
  const store = (v) => ({ getItem: () => v });

  assert.equal(run(() => false, store("0")), true,
    "a listener whose device once switched open world off still gets open world");
  assert.equal(run(() => false, store(null)), true, "and so does a fresh listener");
  assert.equal(run(() => true, store("0")), false,
    "a setter's own choice to leave open world is still theirs to make");
  assert.equal(run(() => true, store("1")), true);
  assert.equal(run(() => true, store(null)), true, "a setter's default is still open world");
});

test("the stored preference survives a listener session rather than being overwritten", () => {
  /* worldOn() must not WRITE. A setter who signs out, walks as a listener and signs back in
     should find the switch where they left it, not reset by the listener session. */
  const fn = src("worldOn");
  assert.ok(!/setItem/.test(fn), "worldOn only reads; setWorld is the only writer");
});

test("a listener is not shown a switch they cannot use", () => {
  const gate = src("applyModeGating");
  assert.match(gate, /"\.worldrow"/,
    "the Open world row is setter-only — a control with one possible value is not a control");
  /* The switch itself stays in the markup: a setter signing in on the same device gets it back
     without a reload, which is what applyModeGating() exists to do. */
  assert.ok(html.includes('id="world-switch"'), "the switch is hidden for a listener, not deleted");
});

test("signing out moves the walk into open world instead of stranding it in a park", () => {
  const gate = src("applyModeGating");
  assert.match(gate,
    /if \(worldApplied && worldOn\(\) !== document\.body\.classList\.contains\("world"\)\) \{ applyWorld\(\); \}/,
    "a sign-out mid-walk in a park must flip to open world, and a sign-in must hand the " +
    "setter back whatever they had");
  /* Against what the app is SHOWING, not against a second worldOn() call: setter.signedIn has
     already changed by the time gating runs, so worldOn() answers the new question on both
     sides of the gate and could never disagree with itself. */
  assert.ok(!/var wasWorld = worldOn\(\)/.test(gate),
    "comparing worldOn() against itself would make this reconciliation a no-op");
  assert.match(src("applyWorld"), /worldApplied = true;/,
    "applyWorld is what records that a mode has ever been applied");
  /* applyModeGating runs during startup, before the map's sources and the first place exist;
     calling applyWorld() then would throw in map.getSource("features").setData. */
  assert.match(html, /var worldApplied = false;/, "and it starts false, so boot is not disturbed");
});

test("the Walk button is a setter's tool now, not a disabled button a listener stares at", () => {
  const at = html.indexOf('$("#f-walk").hidden =');
  assert.ok(at !== -1, "renderDetail must decide #f-walk's visibility");
  const line = html.slice(at, html.indexOf("\n", at));
  assert.match(line, /!setterTools\(\)/,
    "a listener has no park view to walk into, so the button goes rather than greys out");
  assert.match(line, /kind !== "route"/, "and it is still only ever shown on a route");
});

test("the header says where the listener is, not which park a deep link happened to set", () => {
  const fn = src("worldMove");
  assert.match(fn, /if \(!setterTools\(\)\) \{\s*\$\("#place-name"\)\.textContent = here \? here\.properties\.name : "Open world";/,
    "a picker that lists routes must not label itself with one park while showing every park");
  /* Inside the place-change block, so it costs nothing on an ordinary tick — worldMove runs at
     pointer-move rate, and crossing a boundary is rare. */
  const block = fn.slice(fn.indexOf("if (hereId !== pacer.placeId)"));
  assert.ok(block.indexOf("#place-name") !== -1 &&
            block.indexOf("#place-name") < block.indexOf("pacerCheckZones"),
    "written only when the park underfoot actually changes");
  /* A setter picked their park deliberately; moving the label under them mid-walk is worse
     than letting it be stale. */
  assert.ok(!/\$\("#place-name"\)\.textContent = here/.test(fn.replace(/if \(!setterTools\(\)\) \{[\s\S]*?\}/, "")),
    "and only for a listener");
});

/* What a listener does instead of walking a route: pick it, and open world focuses it. That
   path already exists (route rows in the picker) and must keep working — it is now the only
   way in. */
test("picking a route still focuses it without leaving open world", () => {
  const at = html.indexOf('$("#route-list")');
  assert.ok(at !== -1, "the route list a listener browses must still be there");
  assert.ok(html.includes("setSelected(link.route, true)"),
    "picking a route still selects it rather than starting a place-mode walk");
});
