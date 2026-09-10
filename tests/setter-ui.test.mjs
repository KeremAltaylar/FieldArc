/* The setter block and the publish bar — the two blocks the audit log's four design rounds
   never looked at. Everything here is a source assertion, which is the honest description of
   what it proves: that the rules and the calls exist. Whether the panel then LOOKS designed,
   and whether the count actually moves when a note is typed, is a browser measurement and is
   recorded as such in the ledger rather than claimed here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Newlines normalised: index.html is stored with CRLF, so a marker written with "\n" in a
   test never matches and the slice fails for a reason that has nothing to do with the code
   under test. */
const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

/* Same helper, same reason, as tests/offline.test.mjs: a slice whose end marker precedes its
   start silently proves nothing while looking like a pass. It has bitten this stage twice. */
function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `end marker not found after start: ${endMarker}`);
  return html.slice(start, end);
}

test("every save refreshes the pending count, not only commit()", () => {
  /* The failure this closes: twelve of the mutation sites — commitPatch, the note and tag
     fields, the sound, rhythm and grain controls — call save() bare. With the refresh hung
     off commit(), a setter could edit a route's key, tempo, four chords and progression and
     the panel would still read "nothing pending" with Publish greyed out. */
  const save = slice("function save()", "/* ---------- Setter session");
  assert.match(save, /renderPending\(\)/,
    "save() is the funnel every mutation already goes through; the count belongs there");
});

test("the deferred pending module refreshes the panel once it exists", () => {
  /* Offline, sb is null and renderSetter() runs synchronously — before this module script,
     which is deferred, has defined FA_PENDING. pendingDiff() then returns an empty diff and
     the panel says "nothing pending" over a full queue until the next commit(). */
  assert.match(html,
    /window\.FA_PENDING = \{[^}]*\};\s*\n\s*if \(window\.__fa && window\.__fa\.publish\) \{ window\.__fa\.publish\.refresh\(\); \}/,
    "the module must tell the page it has arrived");
  assert.match(html, /refresh: renderPending/,
    "and the classic script must publish the hook it calls");
});

test("a manifest that cannot be written says so instead of being swallowed", () => {
  /* Publish succeeds, the manifest write fails, the count never drops: the setter republishes
     the same twelve forever with a toast congratulating them each time. */
  const fn = slice("function saveManifest(m)", "\n  }\n");
  assert.doesNotMatch(fn, /catch \(e\) \{ \/\* full \*\/ \}/, "a silent catch is the defect");
  assert.match(fn, /catch \(e\) \{[\s\S]*toast\(/, "the catch must reach the setter");
  assert.match(fn, /return false;/,
    "and must report the failure, or publish()'s success toast overwrites the warning");
  const pub = slice("function publish()", 'addEventListener("click", publish)');
  assert.match(pub, /if \(recorded\) \{ toast\("Published "/,
    "the success line is conditional on the manifest actually persisting");
});

test("the setter block and publish bar are designed, not left on browser defaults", () => {
  for (const sel of ["#setter ", "#setter-who ", "#publishbar ", "#pending-count "]) {
    assert.ok(html.includes(sel + "{"), `no CSS rule for ${sel.trim()}`);
  }
  const count = slice("#pending-count {", "}");
  assert.match(count, /var\(--font-mono\)/, "a live count is a readout, like .pmeta");
  assert.match(count, /var\(--t-xs\)/);
  assert.match(count, /tabular-nums/, "a changing number must not shuffle the words after it");
  assert.match(count, /var\(--faint\)/);
  /* Tokens only: no hex or rgb() colour, and no px sizing. A 1px hairline border is exempt —
     it is what every other border in this file is, and there is no token for it. */
  const block = slice("/* ---- Setter, and what is waiting", "/* ---- Audit log ---- */")
    .replace(/\/\*[\s\S]*?\*\//g, "");                        /* comments are prose, not CSS */
  assert.doesNotMatch(block, /:\s*#[0-9a-fA-F]{3,8}\b/, "colours come from the oklch tokens");
  assert.doesNotMatch(block, /\brgba?\(/, "colours come from the oklch tokens");
  assert.doesNotMatch(block.replace(/1px solid/g, ""), /\b\d+px\b/,
    "spacing and type come from the --s- and --t- ladders");
});

test("the email field is styled like every other input in the app", () => {
  assert.match(html, /input\[type="text"\], input\[type="email"\], textarea \{/);
  assert.match(html, /input\[type="email"\]:focus-visible/);
});

test("Storage carries one h2, and Setter sits under it as an h3", () => {
  const section = slice('<div class="section" id="storage">', "</div>\n  </div>");
  const h2s = section.match(/<h2\b/g) || [];
  assert.equal(h2s.length, 1, "a second h2 inside one section is a broken outline, not a style");
  assert.match(section, /<h3>Setter<\/h3>/);
  assert.match(html, /\.section h3 \{/, "and the h3 is styled rather than left at 1.17em bold");
});
