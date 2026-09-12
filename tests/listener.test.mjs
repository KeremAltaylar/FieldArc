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
    "#offline", "#undo", "#publishbar", "#markbar", "#audit"];
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

/* The bug this closes: renderDetail()'s kind/audio-state logic (renderAudioMode()/
   clearPlayer()/loadPlayer() and the #g-type/#f-patch/#f-rhythm lines) predates setter-only
   gating and has no awareness of it. clearPlayer() unconditionally sets #rec-add.hidden =
   false whenever the selected feature has no point-style audio (true for every Route, and
   for a Point with nothing attached yet) — so a listener who signed out (or never signed in)
   gets an authoring control back the instant they select such a feature, even though
   applyModeGating() correctly hid it moments earlier. Confirmed live in a browser: after a
   signed-out visitor selected a Route, document.getElementById("rec-add").hidden read false
   while setter-who still read "Not signed in". This is a source assertion of the fix's control
   flow (this suite has no DOM) — it proves the reassertion block exists, runs after the
   kind-based lines it must override, and is scoped to a listener only. */
test("renderDetail reasserts setter-only visibility after its kind/audio-state logic runs", () => {
  const startIdx = html.indexOf("function renderDetail() {");
  const endIdx = html.indexOf("\n  function render() {", startIdx);
  assert.ok(startIdx !== -1 && endIdx !== -1, "renderDetail() must be found");
  const src = html.slice(startIdx, endIdx);

  const loadPlayerIdx = src.indexOf("loadPlayer(f);");
  const audioModeIdx = src.indexOf("renderAudioMode(f);");
  const gTypeIdx = src.indexOf('$("#g-type").hidden = f.properties.kind');
  const guardIdx = src.indexOf("if (!setter.signedIn) {");
  assert.ok(loadPlayerIdx !== -1 && audioModeIdx !== -1 && gTypeIdx !== -1 && guardIdx !== -1,
    "all four landmarks (loadPlayer, renderAudioMode, the #g-type kind line, and the " +
    "reassertion guard) must be present in renderDetail()");

  assert.ok(loadPlayerIdx < guardIdx && audioModeIdx < guardIdx && gTypeIdx < guardIdx,
    "the reassertion must run after loadPlayer()/clearPlayer(), renderAudioMode(), and the " +
    "#g-type kind line — it exists specifically to override what they just set");

  const guardBlock = src.slice(guardIdx, src.indexOf("}", src.lastIndexOf("hidden = true;", src.length)) + 1);
  ["#g-type", "#f-patch", "#f-rhythm", "#rec-add"].forEach((sel) => {
    const re = new RegExp("\\$\\(\"" + sel.replace("#", "#") + "\"\\)\\.hidden = true");
    assert.match(guardBlock, re, sel + " must be forced hidden for a listener");
  });
  assert.match(guardBlock, /\.recmode/, ".recmode elements must be forced hidden for a listener");
  assert.match(guardBlock, /querySelectorAll\(".recmode"\)/,
    ".recmode is a class used by multiple elements — it must be reasserted via querySelectorAll, " +
    "not $() which only ever returns the first match");
});

/* The bug this closes: stage 3 gave anon a storage read policy and never gave the client a
   download. index.html held exactly one sb.storage call — the upload inside publish() — so
   every playback path read IndexedDB only. A listener's IndexedDB is empty by definition
   (audio lands there through attach-audio, a setter's act), so a published point with
   has_audio: true drew its audio lamp, resolved undefined, and loadPlayer() returned with
   #player still hidden: nothing played and nothing said why. */
test("a listener's playback falls back to the bucket and caches what it downloads", () => {
  const fnAt = html.indexOf("function audioBlob(key, path)");
  assert.ok(fnAt > 0, "audioBlob() — the IndexedDB-then-bucket read — must exist");
  const fn = html.slice(fnAt, html.indexOf("\n  }", fnAt));
  assert.match(fn, /sb\.storage\.from\("recordings"\)\s*\.download\(path\)/,
    "the miss path must download from the recordings bucket");
  assert.match(fn, /putAudio\(key, r\.data\)/,
    "a downloaded blob must be cached, or a listener's second offline walk is silent again");
  assert.match(fn, /if \(blob \|\| !sb \|\| !path\) \{ return blob; \}/,
    "a local hit must short-circuit — this must never become a network read for a setter");
  assert.match(fn, /catch\(function \(\) \{ return null; \}\)/,
    "a failed download is silent: no client, no policy and no signal are all normal here");
});

test("every playback path reads through audioBlob, and the publish upload does not", () => {
  /* loadPlayer is the card's player; the two zone reads are the walk engine. All three were
     IndexedDB-only before this fix. */
  const loadAt = html.indexOf("function loadPlayer(f)");
  assert.ok(loadAt > 0, "loadPlayer must be found");
  assert.match(html.slice(loadAt, loadAt + 400),
    /audioBlob\(f\.properties\.id, f\.properties\.storage_path\)/,
    "loadPlayer must use the fallback, keyed on the storage_path the view already carries");
  assert.match(html, /audioBlob\(z\.id, remotePath\(z\.id\)\)/,
    "a zone's soundscape/grain source must use the fallback");
  assert.match(html, /audioBlob\(z\.id \+ "#" \+ slot, remoteHitPath\(z\.id, slot\)\)/,
    "a rhythm point's four hits must use the fallback");

  /* publish()'s uploadAudio deliberately keeps the raw read: a missing local blob must abort
     the publish, and re-downloading the server's own copy to upload it back would turn that
     guard into a no-op. */
  const upAt = html.indexOf("function uploadAudio(key, pathFor, missing)");
  assert.ok(upAt > 0, "uploadAudio must be found");
  const up = html.slice(upAt, html.indexOf("\n    }", upAt));
  assert.match(up, /return getAudio\(key\)/,
    "uploadAudio must read IndexedDB directly — the missing-blob rejection is the point");
  assert.doesNotMatch(up, /audioBlob\(/, "the publish path must not fall back to the server");
});

test("GPS is promoted out of the ghost-button row for a listener", () => {
  const idx = html.indexOf('id="gps-btn"');
  const tag = html.slice(html.lastIndexOf("<button", idx), idx + 30);
  assert.doesNotMatch(tag, /class="ghost"/,
    "gps-btn must not stay styled as a small ghost button once promoted");
});
