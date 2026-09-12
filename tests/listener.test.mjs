import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("mergeRemote adds a feature the archive does not already have", () => {
  const src = html.slice(html.indexOf("function mergeRemote("),
                         html.indexOf("function fetchPublished("));
  assert.ok(src.length > 0, "mergeRemote exists");
  assert.match(src, /_remote\s*:\s*true/, "a merged feature is marked remote, not local");
});

test("save() never writes a remote feature to localStorage", () => {
  const src = html.slice(html.indexOf("function save() {"), html.indexOf("function save() {") + 600);
  assert.match(src, /_remote/, "save() must filter remote features before persisting");
});

test("fetchPublished queries public_features scoped to a place", () => {
  const src = html.slice(html.indexOf("function fetchPublished("),
                         html.indexOf("function fetchPublished(") + 500);
  assert.match(src, /public_features/);
  assert.match(src, /\.eq\(\s*["']place["']/);
});

test("applyModeGating hides exactly the setter-only elements, and never the sign-in block", () => {
  const src = html.slice(html.indexOf("function applyModeGating("),
                         html.indexOf("function applyModeGating(") + 2000);
  const mustHide = [".modes", "#mode-icons", "#f-name", "#f-note", "#g-type", "#f-tags",
    ".recmode", "#rec-add", "#rec-remove", ".chips", "#f-delete", "#f-patch", "#f-rhythm",
    "#offline", "#undo", "#publishbar", "#markbar"];
  mustHide.forEach((sel) => {
    assert.ok(src.includes(JSON.stringify(sel)) || src.includes("'" + sel + "'"),
      sel + " is not in the gated list");
  });
  assert.doesNotMatch(src, /["']#setter["']/,
    "the sign-in block must never be hidden — it is how a listener becomes a setter");
  assert.doesNotMatch(src, /["']#f-walk["']/, "Walk stays — it is how a listener hears a route");
  assert.doesNotMatch(src, /["']#f-zoom["']/, "Zoom to stays — it is not an authoring tool");
});

/* The bug this closes: a listener can reach show===true (sign in) while a feature is already
   selected — Supabase syncs auth across tabs via storage events, so a magic link followed in
   one tab fires onAuthStateChange in another tab that may already have a Route open. The
   SETTER_ONLY forEach above unhides #g-type/#card-icons/#f-patch/.recmode/#rec-add/#f-rhythm
   unconditionally, even though their real visibility depends on the selected feature's kind
   and audio state (owned by renderDetail()/renderAudioMode()), and unhides #mode-icons even
   though its real visibility depends on `mode` (owned by setMode()). This is a source
   assertion of the fix's control flow — it proves the reconciliation is wired to run, gated
   correctly, in the right order. A real DOM/runtime measurement (seeding a Route feature,
   selecting it, flipping setter.signedIn, and reading document.querySelector("#g-type").hidden
   before and after applyModeGating() — plus a negative-control run against the pre-fix source,
   which does show #g-type/.recmode/#f-rhythm going wrongly visible) was performed by hand in a
   live browser and is recorded in the Task 3 fix report; it is not repeated here because this
   suite has no DOM. */
test("applyModeGating reconciles feature- and mode-scoped visibility only after unhiding, and only for a signed-in setter", () => {
  const src = html.slice(html.indexOf("function applyModeGating("),
                          html.indexOf("function applySession("));
  const forEachIdx = src.indexOf("SETTER_ONLY.forEach(");
  const reconcileIdx = src.indexOf("if (show) {");
  const staleModeIdx = src.indexOf('if (!show && mode && mode !== "select")');
  assert.ok(forEachIdx !== -1 && reconcileIdx !== -1 && staleModeIdx !== -1,
    "all three phases of applyModeGating must be present");
  assert.ok(forEachIdx < reconcileIdx,
    "the blanket unhide must run before the reconciliation reasserts the true state on top of it");
  assert.ok(reconcileIdx < staleModeIdx,
    "reconciliation is a signed-in concern and must not be folded into the sign-out stale-mode guard");

  const reconcile = src.slice(reconcileIdx, staleModeIdx);
  assert.match(reconcile, /if \(selected\) \{ renderDetail\(\); \}/,
    "renderDetail() must be gated on a feature actually being selected — calling it with " +
    "nothing selected would just re-hide the card, which the forEach already did correctly");
  assert.match(reconcile, /\$\("#mode-icons"\)\.hidden = mode !== "point"/,
    "#mode-icons is owned by `mode`, not by the selected feature, so renderDetail() alone " +
    "cannot reassert it — it needs its own line");
  assert.match(reconcile, /if \(mode\) \{ \$\("#mode-icons"\)\.hidden/,
    "the #mode-icons line must not run before `mode` exists — same guard shape as the " +
    "existing stale-mode-on-sign-out fix, for the same offline-init reason");
});
