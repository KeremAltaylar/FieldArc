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

/* A merged (_remote) feature's deletion can never reach Publish — authoredFeatures()
   excludes _remote features from the pending manifest on purpose (see the
   "merged remote features cannot enter the publish-pending manifest" test below), so a
   deleted server row is never told to go away. The local 30-day trash (deleteFeature,
   TRASH_DAYS) is the only record of "this device asked for this id to be gone" — mergeRemote
   MUST consult it, or the very next load (fetchPublished or the offline getPlaceSnapshot
   fallback, both of which funnel through mergeRemote) silently un-deletes it. This is
   real: deleting an already-published point in the setter and reloading brought it right
   back, with nothing in the UI suggesting the delete had failed. */
test("mergeRemote skips any row still sitting in the local trash, so a deleted point or route does not reappear on the next load", () => {
  const src = html.slice(html.indexOf("function mergeRemote("),
                         html.indexOf("function fetchPublished("));
  const trashIdx = src.search(/trash\(\)\.forEach/);
  const rowsForEachIdx = src.indexOf("rows.forEach(");
  assert.ok(trashIdx !== -1,
    "mergeRemote must consult the local trash before deciding which rows to re-add");
  assert.ok(rowsForEachIdx !== -1 && trashIdx < rowsForEachIdx,
    "the trash check must seed the skip-set BEFORE rows are walked, not after");
  assert.match(src,
    /trash\(\)\.forEach\(function \(e\) \{ have\[e\.feature\.properties\.id\] = true; \}\);/,
    "each trashed entry's own feature id must join the same skip-set fc.features already seeds");
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
  /* Bounded by the next function rather than by a character count: the comment above
     SETTER_ONLY has grown twice, and a fixed-length slice that stops short of the array would
     fail for a reason that has nothing to do with the gating list. */
  const src = html.slice(html.indexOf("function applyModeGating("),
                         html.indexOf("function applySession("));
  const mustHide = ["#mode-section", ".modes", "#mode-icons", "#f-name", "#f-note", "#g-type", "#f-tags",
    ".recmode", "#rec-add", "#rec-remove", ".chips", "#f-delete", "#f-patch", "#f-rhythm",
    "#hitgrid", "#undo", "#publishbar", "#audit"];
  mustHide.forEach((sel) => {
    assert.ok(src.includes(JSON.stringify(sel)) || src.includes("'" + sel + "'"),
      sel + " is not in the gated list");
  });
  assert.doesNotMatch(src, /["']#setter["']/,
    "the sign-in block must never be hidden — it is how a listener becomes a setter");
  assert.doesNotMatch(src, /["']#f-walk["']/, "Walk stays — it is how a listener hears a route");
  assert.doesNotMatch(src, /["']#f-zoom["']/, "Zoom to stays — it is not an authoring tool");
  /* Reversed on this branch: Mark changes job rather than disappearing (spec, "The listener
     surface"), and GPS — the thing it was said to be redundant with — only exists once a route
     walk is already running, so hiding Mark left a listener with no way to see where they are. */
  assert.doesNotMatch(src, /["']#markbar["']/,
    "Mark stays — it is relabelled to Locate, not hidden");
  /* Never gated, and it never should have been: the spec's Gone list does not mention the
     offline tile download, and "nothing that works offline today may start requiring a network"
     points the other way. A listener walking a route with no signal needs it as much as a setter. */
  assert.doesNotMatch(src, /["']#offline["']/,
    "Download map stays — it is the one control that makes the offline constraint keepable");
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
  /* setterTools(), not setter.signedIn: see the predicate's own comment — on a cold offline
     load gating declines to guess at sign-in, and this block reading the raw boolean would
     strip a setter's card controls the moment they selected anything. */
  const guardIdx = src.indexOf("if (!setterTools()) {");
  assert.ok(loadPlayerIdx !== -1 && audioModeIdx !== -1 && gTypeIdx !== -1 && guardIdx !== -1,
    "all four landmarks (loadPlayer, renderAudioMode, the #g-type kind line, and the " +
    "reassertion guard) must be present in renderDetail()");

  assert.ok(loadPlayerIdx < guardIdx && audioModeIdx < guardIdx && gTypeIdx < guardIdx,
    "the reassertion must run after loadPlayer()/clearPlayer(), renderAudioMode(), and the " +
    "#g-type kind line — it exists specifically to override what they just set");

  const guardBlock = src.slice(guardIdx, src.indexOf("}", src.lastIndexOf("hidden = true;", src.length)) + 1);
  ["#g-type", "#f-patch", "#f-rhythm", "#rec-add", "#hitgrid"].forEach((sel) => {
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

/* The bug this closes: renderAudioMode() derived #hitgrid's visibility from the selected
   feature's audio_mode alone, and audio_mode: "hits" rides down to a listener verbatim inside
   public_features.properties. A signed-out visitor selecting such a published Point was handed
   four hit-slot rows, each carrying a live button that deleted the hit or opened a file picker.
   Gating the build, not just the reveal, is what keeps those buttons from existing at all. */
test("a listener is never built a hit grid", () => {
  const fnAt = html.indexOf("function renderAudioMode(f)");
  assert.ok(fnAt > 0, "renderAudioMode must be found");
  const fn = html.slice(fnAt, html.indexOf("\n  var pendingHit", fnAt));
  assert.match(fn, /grid\.hidden = !\(isPoint && mode === "hits"\) \|\| !setterTools\(\);/,
    "#hitgrid must only ever be unhidden for a device allowed to author");
  const guardAt = fn.indexOf("!setterTools()");
  const buildAt = fn.indexOf("if (grid.hidden) { grid.textContent = \"\"; return; }");
  assert.ok(guardAt !== -1 && buildAt > guardAt,
    "the guard must precede the early return, so a listener's rows are never constructed");
});

/* The bug this closes: when the supabase library never arrives, sb is null and the else branch
   calls renderSetter() synchronously — which now calls applyModeGating() with setter.signedIn
   still false, because without a client there is no session to read and applySession() is
   unreachable. Nothing re-runs it for the rest of the session, so a signed-in setter who opens
   the app with no signal got the full listener surface (no Mark, no mode bar, no attach-audio)
   for the whole session. The plan names this exact path in its offline-capture constraint. */
test("a cold offline load does not gate a device that has been a setter's", () => {
  assert.match(html, /var WASSETTER_KEY = "fieldarc\.wassetter";/,
    "the flag needs a key in the file's existing fieldarc.* naming");

  const apply = html.slice(html.indexOf("function applySession("),
                           html.indexOf("function signIn("));
  assert.match(apply, /setWasSetter\(setter\.signedIn\);/,
    "the flag is written at the one place sign-in state is established, and cleared there too");

  const gate = html.slice(html.indexOf("function applyModeGating("),
                          html.indexOf("function applySession("));
  assert.match(gate, /^\s*function applyModeGating\(\) \{\s*\n\s*if \(gatingDeclined\) \{ return; \}/,
    "the decline must be the first thing applyModeGating does, before anything is hidden");

  /* Bounded forwards on purpose: $("#setter-send") also appears inside renderSetter(), which
     is defined earlier, so an unanchored end marker would slice backwards to nothing and every
     assertion below would pass without checking anything. */
  const elseAt = html.indexOf("  } else {", html.indexOf("function logSignIn("));
  const endAt = html.indexOf('$("#setter-send").addEventListener', elseAt);
  assert.ok(elseAt !== -1 && endAt > elseAt, "the no-library branch slice is bounded and forwards");
  const offline = html.slice(elseAt, endAt);
  assert.match(offline, /gatingDeclined = wasSetter\(\);/,
    "the no-library branch must decline gating on a setter's device, not guess at sign-in");
  assert.match(offline, /renderSetter\(\);/, "and must still render the setter block");
  assert.ok(offline.indexOf("gatingDeclined") < offline.indexOf("renderSetter()"),
    "the decision must be made before renderSetter() calls applyModeGating()");
  assert.doesNotMatch(offline, /setter\.signedIn = true/,
    "no fake signed-in state: Publish must stay disabled and nothing may reach for a server");

  /* The decline is worthless if the gates that live outside applyModeGating() still read the
     raw boolean — renderDetail()'s reassertion, renderAudioMode()'s hit grid, setMode()'s icon
     picker, renderTrash()'s Undo and the keyboard handler all run on a cold offline load, and
     each one reading setter.signedIn would take back in the field what the decline preserved. */
  assert.match(html, /function setterTools\(\) \{ return setter\.signedIn \|\| gatingDeclined; \}/,
    "one predicate must answer 'may this device author?' for every gate");
  for (const fn of ["function renderDetail()", "function renderAudioMode(f)",
                    "function setMode(next)", "function renderTrash()"]) {
    const at = html.indexOf(fn);
    assert.ok(at > 0, "function not found: " + fn);
    /* Comments are prose and name the boolean they replaced on purpose — strip them before
       asserting on the code. */
    const body = html.slice(at, html.indexOf("\n  }", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /setterTools\(\)/, fn + " must gate through setterTools()");
    assert.doesNotMatch(body, /setter\.signedIn/,
      fn + " must not read the raw boolean — it is wrong on a cold offline load");
  }
});

/* The bug this closes: pendingDiff() hashed every feature in fc, merged remote ones included.
   Their ids were never in the last-publish manifest (they were never authored on this device),
   so every one read as "added" — and publishing an "added" row stamps created_by and upserts
   the feature's geometry, which for anything fetched through public_features is the VIEW's
   geometry: fuzzed if the feature is sensitive, with `sensitive`/`fuzz_m` already stripped. One
   click from a setter on a second device, or on any device with a cleared cache, would have
   written a fuzzed point over the true coordinate (irreversibly — the 0014 trigger re-fuzzes it)
   and reassigned authorship of the whole archive. */
test("merged remote features cannot enter the publish-pending manifest", () => {
  assert.match(html, /function authoredFeatures\(\) \{\s*\n\s*return fc\.features\.filter\(function \(f\) \{ return !f\.properties\._remote; \}\);/,
    "there must be one predicate for 'authored on this device'");

  const diff = html.slice(html.indexOf("function pendingDiff()"),
                          html.indexOf("function pendingCount()"));
  assert.match(diff, /manifestOf\(authoredFeatures\(\)\)/,
    "the current manifest must exclude merged features");
  assert.doesNotMatch(diff, /manifestOf\(fc\.features\)/, "…and must not hash the raw list");

  /* Both arguments must agree. Recording merged ids at publish time while the diff leaves them
     out would make every one of them read as REMOVED on the next diff — and `removed` is the
     branch that soft-deletes rows on the server. */
  const pub = html.slice(html.indexOf("function publish()"),
                         html.indexOf('addEventListener("click", publish)'));
  assert.match(pub, /var snapshot = window\.FA_PENDING\.manifestOf\(authoredFeatures\(\)\);/,
    "the recorded manifest must use the same predicate, or a merge becomes a mass unpublish");
  assert.match(pub, /saveManifest\(window\.FA_PENDING\.recordPublished\(loadManifest\(\), snapshot,/,
    "and what is saved is built from that snapshot, not from some other list");
  assert.doesNotMatch(pub, /manifestOf\(fc\.features\)/,
    "one inconsistent argument here turns a read-only merge into a mass unpublish");

  /* A setter who edits a merged feature owns that edit: it must persist (save() drops anything
     still tagged _remote) and it must become publishable. */
  assert.match(html, /function claimEdit\(f\) \{\s*\n\s*if \(f && f\.properties && f\.properties\._remote\) \{ delete f\.properties\._remote; \}/,
    "an edited merged feature must stop being treated as remote");
  for (const site of ['f.properties.name = this.value', 'f.properties.note = this.value',
                      'function commitPatch(f, patch)']) {
    const at = html.indexOf(site);
    assert.ok(at > 0, "edit site not found: " + site);
    assert.ok(html.lastIndexOf("claimEdit(f)", at) > html.lastIndexOf("addEventListener", at - 400) ||
              html.slice(at - 200, at + 200).includes("claimEdit(f)"),
      site + " must claim the edit before saving");
  }
  assert.ok(html.split("claimEdit(f)").length - 1 >= 15,
    "every user-facing editing site must claim the edit — the panels included");

  /* rowFor keeps its own strip, unchanged: the flag must never travel to the server. */
  assert.match(pub, /delete p\.id; delete p\.place; delete p\.kind; delete p\._remote;/);
});

/* Even a deliberate edit must not publish a SENSITIVE merged point: `fuzzed: true` is written
   by public_features and by nothing else, so the local copy's geometry is the fuzzed position
   and `sensitive`/`fuzz_m` are already gone. Upserting it writes the fuzz over the truth and the
   0014 trigger then fuzzes that again. */
test("a fuzzed view copy is refused by publish rather than upserted", () => {
  const pub = html.slice(html.indexOf("function publish()"),
                         html.indexOf('addEventListener("click", publish)'));
  const guardAt = pub.indexOf("var viewCopies =");
  const rowsAt = pub.indexOf("var newRows =");
  assert.ok(guardAt > 0, "the fuzzed-copy guard must exist");
  assert.ok(rowsAt > guardAt, "it must run before any row is built");
  assert.match(pub, /return !!\(f && f\.properties && f\.properties\.fuzzed\);/,
    "the marker is properties.fuzzed, which only the view ever writes");
  assert.match(pub.slice(guardAt, rowsAt), /return Promise\.resolve\(\{ pushed: 0/,
    "the publish must abort, not silently skip the row and report success");
});

/* The bug this closes: gating hid the mode bar and the Delete button and left the keyboard wide
   open. A signed-out visitor pressing 2 or 3 went straight into Point or Route mode and could
   draw on the map — with setMode() re-showing the icon picker on the way — and Delete removed
   whatever was selected, renderTrash() then putting the Undo button back into Storage to prove
   it. Visibility-only gating is what let that cascade; the entry point is closed first, and the
   two downstream .hidden writes are guarded behind it. */
test("the keyboard cannot author for a listener, and neither can its fallout", () => {
  const at = html.indexOf("document.addEventListener(\"keydown\"", html.indexOf("function removeSelected"));
  const handlerAt = html.lastIndexOf("var AUTHOR_KEYS", at);
  assert.ok(handlerAt > 0 && handlerAt < at, "the authoring-key set must sit with its handler");
  const handler = html.slice(handlerAt, html.indexOf("\n  });", at));
  for (const key of ['"2"', '"3"', '"Delete"', '"Enter"', '"Backspace"']) {
    assert.ok(handler.includes(key + ": 1"), key + " must be in the authoring-key set");
  }
  assert.match(handler, /if \(AUTHOR_KEYS\[e\.key\] && !setterTools\(\)\) \{ return; \}/,
    "the guard must be an early return, before any branch runs");
  const guardAt = handler.indexOf("AUTHOR_KEYS[e.key] && !setterTools()");
  assert.ok(guardAt < handler.indexOf('e.key === "Escape"'),
    "it must precede the branches, not sit among them");
  assert.ok(!handler.includes('AUTHOR_KEYS["1"]') && !handler.includes('"1": 1'),
    "1 (Select mode) and Escape (deselect) author nothing and stay open to everyone");

  const setModeBody = html.slice(html.indexOf("function setMode(next)"),
                                 html.indexOf("\n  }", html.indexOf("function setMode(next)")));
  assert.match(setModeBody, /\$\("#mode-icons"\)\.hidden = next !== "point" \|\| !setterTools\(\);/,
    "#mode-icons may hide unconditionally but must only unhide for a device allowed to author");

  const trashBody = html.slice(html.indexOf("function renderTrash()"),
                               html.indexOf("\n  }", html.indexOf("function renderTrash()")));
  assert.match(trashBody, /\$\("#undo"\)\.hidden = !n \|\| !setterTools\(\);/,
    "#undo may hide unconditionally but must only unhide for a device allowed to author");
});

/* The bug this closes: .modes and #mode-icons were gated but their section and its <h2>Mode</h2>
   were not, so a listener got a heading with one sentence under it and no mode controls. And
   sizePeek() measures that section's height to size the mobile peek, so the heading's space
   stayed reserved over nothing — the spec's "one mode means no bar, which also buys back the
   mobile peek" never actually happened. */
test("the Mode heading goes with its controls, and the peek is re-measured when it does", () => {
  assert.match(html, /<div class="section" id="mode-section">\s*\n\s*<h2>Mode<\/h2>/,
    "the Mode section needs a stable id of its own, on the div that carries the heading");

  const gate = html.slice(html.indexOf("function applyModeGating("),
                          html.indexOf("function applySession("));
  const forEachAt = gate.indexOf("SETTER_ONLY.forEach(");
  const peekAt = gate.indexOf("sizePeek();");
  assert.ok(peekAt > forEachAt,
    "sizePeek() must run after the gating pass, so it measures the new height, not the old one");

  const peek = html.slice(html.indexOf("function sizePeek()"),
                          html.indexOf("function openSheet("));
  assert.match(peek, /\$\("#mode-section"\)\.offsetHeight/,
    "sizePeek must name the section it measures, not find it by position in #panel");
});

/* The decision this records: an earlier pass on this branch hid #markbar outright, arguing that
   GPS/Virtual covered "use my own position". It does not — GPS only exists once a route walk is
   already running, so a listener had no way to see where they were before starting one — and the
   spec says the opposite in as many words: "The Mark button changes job rather than
   disappearing... For listeners it keeps the button and loses the marking." */
test("Mark stays for a listener and reads Locate", () => {
  assert.match(html, /function markLabel\(\) \{\s*\n\s*return setterTools\(\)\s*\n\s*\? \{ text: "Mark", aria: "Mark current location" \}\s*\n\s*: \{ text: "Locate", aria: "Centre on your position" \};/,
    "the idle label must be derived from whether this device may author");

  /* setMarkState is the only writer of this label, so it is where the derivation has to land —
     otherwise a listener's button reverts to "Mark" the first time their own Locate finishes. */
  const sms = html.slice(html.indexOf("function setMarkState(state)"),
                         html.indexOf("function geoMessage(err)"));
  assert.match(sms, /var b = \$\("#mark"\), idle = markLabel\(\);/);
  assert.match(sms, /: idle\.text;/, "the idle text comes from markLabel()");
  assert.match(sms, /: idle\.aria\);/, "and so does the idle aria-label");
  assert.doesNotMatch(sms, /"Mark current location"/,
    "the setter wording must live in markLabel() only, or the two can drift apart");

  const gate = html.slice(html.indexOf("function applyModeGating("),
                          html.indexOf("function applySession("));
  assert.match(gate, /setMarkState\(\$\("#mark"\)\.dataset\.state \|\| "idle"\);/,
    "gating must re-label Mark through setMarkState, preserving a mid-trace Finish");

  /* The click handler needs no change, and this pins the reason: a listener's `mode` can never
     become point or route (the buttons are gone and the keyboard shortcuts are guarded), and
     `track` is only ever set by startTrack(), which Route mode is the only way to reach. So the
     fall-through branch — geolocate, centre, create nothing — is the only one they can hit. */
  const click = html.slice(html.indexOf('$("#mark").addEventListener("click"'),
                           html.indexOf("/* ---------- Weather ----------"));
  assert.match(click, /if \(track\) \{ stopTrack\(\); return; \}/);
  assert.match(click, /if \(mode === "route"\) \{ startTrack\(\); return; \}/);
  assert.match(click, /if \(mode === "point"\) \{ markPoint\(\); return; \}/);
  assert.match(click, /map\.easeTo\(\{ center: c/,
    "the fall-through branch centres the map and creates nothing — the listener's whole need");
});

/* The bug this closes: two pieces of copy named controls the reader does not have. #empty told a
   listener to "Choose Point or Route and click the map" with neither button on screen, and
   setMode("select") — which runs at init — wrote a #hint pointing at "Mark", a button that for a
   listener is either hidden (before this wave) or called Locate (after it). */
test("no copy names a control the reader does not have", () => {
  const gate = html.slice(html.indexOf("function applyModeGating("),
                          html.indexOf("function applySession("));
  assert.match(gate, /\$\("#empty"\)\.innerHTML = show/,
    "the empty state must be written where the surface is decided");
  assert.match(gate, /Nothing published here yet\./,
    "a listener's empty state must not mention an authoring action");
  const listenerCopy = gate.slice(gate.indexOf(": \"Nothing published here yet"));
  assert.doesNotMatch(listenerCopy, /<b>Point<\/b>|<b>Route<\/b>|click the map/,
    "…and must not name Point, Route, or clicking the map to create something");

  const setModeBody = html.slice(html.indexOf("function setMode(next)"),
                                 html.indexOf("\n  }", html.indexOf("function setMode(next)")));
  assert.match(setModeBody, /"Click a feature to inspect it\. <b>" \+ markLabel\(\)\.text \+ "<\/b> centres on your position\."/,
    "the Select-mode hint must name the button by its current label, not by the setter's word");
});

/* Defence in depth, and the reason is this review's own finding: every setter-only action was
   gated by whether its trigger was visible, and three separate places wrote .hidden with no
   awareness of sign-in (clearPlayer on #rec-add, renderDetail on #g-type and friends,
   renderAudioMode on #hitgrid), each handing a control straight back. A handler that refuses to
   run turns the next missed .hidden line from exploitable into cosmetic. This changes nothing for
   a signed-in setter: setterTools() is true whenever they reach one of these. */
test("every setter-only handler refuses to run for a listener, not just its button to appear", () => {
  const guarded = [
    ['$("#f-delete").addEventListener("click"', "Delete"],
    ['$("#f-patch").addEventListener("click"', "Patch"],
    ['$("#export").addEventListener("click"', "Export"],
    ['$("#import").addEventListener("change"', "Import — the hidden input, not only its button"],
    ['$("#import-btn").addEventListener("click"', "the Import button"],
    ['$("#undo").addEventListener("click"', "Undo delete"],
    ['$("#rec-add").addEventListener("click"', "Attach audio"],
    ['$("#rec-file").addEventListener("change"', "the attach-audio input"],
    ['$("#rec-remove").addEventListener("click"', "Remove recording"],
    ['$("#hit-file").addEventListener("change"', "the hit-slot input"]
  ];
  for (const [marker, what] of guarded) {
    const at = html.indexOf(marker);
    assert.ok(at > 0, "handler not found: " + marker);
    const head = html.slice(at, at + 400);
    assert.match(head, /if \(!setterTools\(\)\) \{ return; \}/,
      what + "'s handler must refuse to run, not merely be hard to click");
  }

  /* The hit grid's per-slot buttons are built at render time, so the guard lives in the row
     builder rather than on a static id. */
  const audio = html.slice(html.indexOf("function renderAudioMode(f)"),
                           html.indexOf("\n  var pendingHit"));
  assert.match(audio, /btn\.addEventListener\("click", function \(\) \{\s*\n\s*if \(!setterTools\(\)\) \{ return; \}/,
    "each hit slot's delete/attach button must refuse to run too");

  /* The soundscape/hits/grains switch is the same class of control. */
  const recmode = html.slice(html.indexOf('document.querySelectorAll(".recmode button")'),
                             html.indexOf('document.querySelectorAll(".recmode button")') + 400);
  assert.match(recmode, /if \(!setterTools\(\)\) \{ return; \}/,
    "the recording-type switch must refuse to run for a listener");
});

test("GPS is promoted out of the ghost-button row for a listener", () => {
  const idx = html.indexOf('id="gps-btn"');
  const tag = html.slice(html.lastIndexOf("<button", idx), idx + 30);
  assert.doesNotMatch(tag, /class="ghost"/,
    "gps-btn must not stay styled as a small ghost button once promoted");
});
