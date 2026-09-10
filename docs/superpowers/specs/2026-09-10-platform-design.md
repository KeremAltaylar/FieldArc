---
project: FieldArc
version: 2.0
status: design agreed 2026-09-10; no implementation plan written yet
baseline: v1.5-the-field
---

# 2.0 — Two sides

FieldArc becomes a platform with two kinds of people in it.

**Listeners** open a link, choose a place or a walk, and hear it. They create nothing.
**Setters** — Kerem and a couple of invited friends — mark the points, draw the routes,
attach the recordings and set the patches. Everything a setter makes lives on a server
rather than only in the browser that made it.

Nothing about how the piece *sounds* changes in 2.0. This is about where the archive lives
and who is allowed to touch it.

## The idea worth protecting

**The forest never waits on a server.** Every sound is synthesised in the listener's own
browser at walk time — the pad, the second voice, the Euclidean hits, the morphs, the
grains, the spectral worklet. There is no audio stream to lose. That is what makes a
server-backed FieldArc possible at all: the server hands over *inputs*, and the inputs are
small.

Measured at the baseline: the app is 416 KB, all 88 place boundaries are 212 KB, and the
entire current archive of 16 points is **7 KB**. A route's patch is a few kilobytes of JSON.
The field recordings are the only thing that scales with the archive, and the only thing a
download has to think about.

## Decisions taken

Agreed 2026-09-10 with Kerem. These are settled; a plan built on them should not reopen them.

1. **Online is the default; offline is prepared.** Open a link and listen immediately.
   "Take this place offline" pre-fetches everything for a walk with no signal.
2. **Offline means every recording in the place.** One download, then nothing can go
   missing mid-walk. The app states the size before the listener commits.
3. **Setters capture locally and publish later.** Marking, tracing and recording work with
   no network, exactly as they do now. A pending queue drains when there is wifi.
4. **Accounts are for setters only, by invite.** Public sign-up is disabled entirely.
   Listening is anonymous.
5. **The app is the front door.** Opening the site lands a listener directly in the map, on
   a place — Validebağ Korusu, Belgrad Ormanı — chosen from the place picker that already
   exists, with that place's routes and points drawn and selectable. There is no separate
   landing page, directory page or admin app to build. A single walk can still be sent to
   someone: `/:place/:route` deep-links into the same app with that route selected.
6. **One artifact, two modes.** `index.html` stays the instrument and gains a Supabase
   client. Setter tools are gated behind a session. No rewrite, no split — the value of
   this project is 8,900 lines of working audio and map code, and this design does not
   touch it.

## Architecture

```
                    ┌──────────────── Supabase ────────────────┐
                    │  Postgres: features, recordings,         │
                    │            setters, audit                │
                    │  Storage:  recording blobs               │
                    │  Auth:     magic link, invite only       │
                    └──────────────────────────────────────────┘
                             ▲ publish            │ read
                             │ (setters)          ▼ (anon, published only)
   ┌─────────────────────────┴────────────────────────────────────┐
   │  index.html — one artifact                                   │
   │                                                              │
   │   engine: Tone graph · morphs · grains · worklet · MapLibre  │
   │   local mirror: localStorage (features) · IndexedDB (audio)  │
   │   service worker: shell · tiles                              │
   │                                                              │
   │   listener mode          │   setter mode (session required)  │
   │   select · start · hear  │   mark · trace · attach · patch   │
   └──────────────────────────────────────────────────────────────┘
```

`places.geojson` stays a static asset. It is 212 KB of OSM boundaries that never change;
making it a table would be work in exchange for nothing.

## Data model

The current shape is already right, so the server mirrors it rather than re-modelling it: a
feature is GeoJSON, a route carries its patch inline at `properties.patch`, audio is a blob
keyed by feature id. Migration is then a copy, and the app keeps speaking the format it
already speaks.

**`features`**
`id` · `place` · `kind` (point | route) · `geometry` (GeoJSON) · `properties` (jsonb —
icon, sound, patch, sensitive, published, position_source, accuracy_m, altitude_m, weather,
created_at) · `created_by` · `updated_at` · `deleted_at` (soft).

**`recordings`**
`id` · `feature_id` · `storage_path` · `mime` · `bytes` · `duration_s` · `peaks` (the ~200
stored waveform peaks B1 already reads as a control curve) · `descriptors` · `created_by`.
The file itself lives in a Storage bucket.

**`setters`**
One profile row per invited account, keyed to `auth.users`: display name, invited_at.

**`audit`**
Append-only: `at` · `setter_id` · `action` (sign_in | create | update | delete | publish |
unpublish) · `target_id` · `detail` (jsonb). This is the record of who did what, and it
costs one insert per action.

## Authority

Supabase Auth with email magic link. **Public sign-up disabled** — there is no registration
page to secure and no password to leak. Setters are added by invitation.

Row-level security:

- **Anonymous** may read features where `published = true` and `deleted_at is null`, and may
  read a recording only if its feature is published. Nothing else.
- **Setters** read and write all features and recordings, and may write to `audit`. `audit`
  is insert-only for everyone — no update, no delete, including for setters.

### Sensitive positions must be fuzzed server-side

Today `sensitive` fuzzes a position "when the archive is published" — a promise the client
makes to itself. On a platform that is not good enough. If the true coordinate reaches the
browser, the flag is decoration and a nest or a den is one devtools panel away.

**The anonymous read path must be a view or RPC that returns the fuzzed geometry**, so the
exact position never leaves the database. Setters select from the underlying table and see
the truth. This is the one place where 2.0 changes a rule rather than moving it, and it is
not optional: the flag exists to protect animals.

Fuzz radius defaults to **200 m** and is a per-feature property, because what needs hiding
differs between a nest and a den. The offset must be **stable per feature and not derivable
by the reader**: a deterministic offset from the feature id *plus a server-side secret salt*.
Stable, because re-randomising per request lets repeated reads average out to the true point.
Salted, because an offset derived from the id alone can be recomputed by anyone who has the
id — which every anonymous reader does.

## Offline and sync

The two directions are not symmetric and should not be.

### Down, to a listener

Online is the normal case and needs no preparation: geometry and patch are kilobytes, so a
walk is ready almost at once, and recordings are fetched as the piece needs them.

"Take this place offline" pre-fetches the rest — every feature, every patch, every recording,
and the map tiles the existing Download Map button already caches — into IndexedDB and the
service worker cache, stating the total size first. After that the walk needs no network.
Virtual mode on a downloaded place is a session with the network switched off entirely, which
is already true at the baseline.

A downloaded place records the server version it came from. Opening it online when the server
has moved on says so and offers a refresh; it never auto-overwrites a device that might be
halfway through a walk.

### Up, from a setter

Every capture writes to the local mirror first. Mark, trace and attach-audio work with no
signal, unchanged from today. The device keeps a pending queue — what is new, what changed,
what has not uploaded — and shows the count, so nothing is ever silently stuck.

Publish drains the queue. Audio uploads are the slow part, so they are resumable and the
queue survives a reload: a walk's worth of recordings will not finish in one go on a phone.

**Authority:** the server is authoritative for anything published; the device is
authoritative for anything not yet pushed. With two or three setters, real conflicts are
rare, so the rule is **last-write-wins per feature**, with the audit log recording both
sides. A merge interface would cost more than the conflicts it resolves.

**Deletes are soft**, reusing the trash that already exists, so a sync cannot erase somebody's
morning.

## The listener surface

**Arrival.** They open the site and they are already in it: the map, on a place, with its
routes and points drawn. No splash, no index, no "browse places" step — the place picker in
the header is the directory, and it already remembers the last place chosen, so a returning
listener lands where they left off. A deep link to one walk opens the same app on that
place with that route selected, so a link sent in a message and a link opened from the
picker arrive at the same screen by the same path.

There is one app and one URL. Signing in does not go anywhere else — the setter tools
appear in place, on the same map, over the same archive.

Sees: the place picker, the map with all four basemaps and the Off/Frame boundary, routes
drawn with their progression, zone circles, points with their icons, the info card for the
selected feature, and the archive list. Selecting is all the map does for them.

Two ways to hear, and they are genuinely different:

- **Start a route** — the piece. The walker appears, `Sound` starts the engine, zones fire
  as they are crossed. The **GPS/Virtual toggle is the listener's primary control**: GPS
  drives the walker from their own position; Virtual hands them the draggable marker. For a
  listener that toggle is the difference between walking Belgrad and sitting at a desk, so
  it is presented as a mode, not as a small button in the patch strip.
- **Select a point** — the archive as an archive. Its recording plays and nothing generative
  happens: no route, no zone, no chord. The document, as it was made.

Gone: Point and Route modes, and with them the whole mode bar — one mode means no bar, which
also buys back the mobile peek. No attach-audio, no note or tags, no sensitive/published
flags, no Delete, no patch editing, no Export/Import. The patch still runs; it is not theirs
to change.

**The Mark button changes job rather than disappearing.** It already has a third behaviour —
in Select mode it centres the map on your position — and that is exactly what a walker wants.
For listeners it keeps the button and loses the marking.

**Cells stays.** It shows what the piece is doing rather than letting anyone change it, and
it is one of the better arguments that something is happening. The patch *panel* stays gated.

## The setter surface

Everything the app does today, plus:

- a sign-in (magic link) and a visible signed-in state;
- a **pending count** and a Publish action;
- `created_by` shown on a feature, so two setters can tell their work apart;
- the audit trail readable in-app, at least as a plain list.

Nothing that works offline today may start requiring a network.

## Migration

One-time, run once by Kerem: read the existing archive from `localStorage`, pull its audio
from IndexedDB, push both to the server as his account, keeping ids, timestamps and
`position_source` intact. Take a fresh `Export .geojson` first — it is the safety net, and
the audio is not in it, so the export alone is not a complete backup.

## Verification

Measured, not assumed, and per [[verify-by-measuring]]:

- **Anonymous cannot see what it must not see.** Query as an anonymous client, not through
  the UI: an unpublished feature must not appear, and a sensitive feature's true coordinate
  must not appear in any response. Repeated reads of the same sensitive feature must return
  the *same* fuzzed point.
- **Audit is insert-only.** An authenticated setter attempting to update or delete an audit
  row must be refused by the database, not by the client.
- **Offline holds.** Take a place offline, drop the network mid-walk, and the piece
  continues — zones, chords, morphs, recordings.
- **Sync drains.** Capture points and a trace with the device offline, restore the network,
  and assert the queue reaches zero with matching audit rows and audio present in Storage.
- **Nothing regressed in the field.** The A-1 timing check and the A-2/A-3/A-4 click checks
  still pass with the platform code loaded.
- **Fit.** `scrollHeight - innerHeight === 0` on both surfaces, and the listener surface at
  390 px wide with its mode bar gone.

## Order of work

This is more than one implementation plan should carry, so it decomposes into four stages.
Each one leaves the app working and is worth having on its own.

1. **The server, read-only.** Tables, RLS, the fuzzed anonymous view, and the migration of
   the existing archive. The app still runs entirely on its local mirror; the only new
   behaviour is that the data now also exists on a server and can be proved unreadable by
   the wrong people. Verification here is the security verification, done before anything
   depends on it.
2. **Setters sign in and publish.** Magic-link auth, the pending queue, the Publish action,
   the audit trail, `created_by`. The setter side becomes real. Offline capture must be
   untouched by this stage — that is its main risk and its main test.
3. **The listener surface.** Mode gating, the two ways to hear, the GPS/Virtual switch
   promoted to a mode, the mode bar removed, Mark demoted to Locate.
4. **Deep links and taking a place offline.** `/:place/:route` resolving into the running
   app, and "take this place offline" with its size statement and staleness check. No
   directory to build — the place picker is it.

Stage 1 before stage 2 is deliberate: the authority rules must be proved correct while the
app can still be thrown away and reloaded from local storage, not after people depend on them.

## Out of scope for 2.0

Listener accounts. Comments or contributions from listeners. Moderation. Multi-tenant places
owned by different setters. A merge UI for conflicts. Compressed proxy encodes of recordings —
worth revisiting when the download gets large, not before.

## Risks

- **The iPhone defect is unresolved at this baseline.** Mark and map taps do not respond in
  iOS Safari and the cause is not yet found; `diag.html` exists to find it. A platform whose
  setter side cannot capture on a phone is not usable in the field, so this should be closed
  before, or early in, 2.0.
- **Audio storage cost** is the only thing here that grows without bound. Decision 2 (every
  recording in the place) is right for tens of points and should be re-examined at hundreds.
- **The single file keeps growing.** 416 KB at the baseline. Approach A accepts this
  deliberately; splitting into engine + shells stays available for when it actually hurts.

See [[audio-quality-bar]], [[gui-quality-bar]], [[studio-toolchain-plan]].
