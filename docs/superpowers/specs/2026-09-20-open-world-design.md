---
project: Fieldscape
version: open-world
status: design agreed 2026-09-20 with Kerem (all six questions answered below)
baseline: main @ 1096ec8
---

# Open world: every route at once, and points that belong to nothing

Kerem, 2026-09-20: *"for park selecting menu should have a switch shows all routes name of it
is Openworld (all routes)"*, *"I want also a system for points that can be placed without
attaching to a park"*, *"when you toggle this mode, all routes start to play like you toggled
walk"*, *"default opening will be the open world mode"*.

Today the app is one park and one route at a time: `setPlace` loads a boundary, `startWalk`
builds a pacer from one route's line, and everything heard comes from that route's patch and
its points. Open world keeps that engine and changes what feeds it: the walker's own position,
whichever route is nearest, and every point in reach — including points that belong to no park
and no route.

## Decisions (asked and answered)

| Question | Answer |
| --- | --- |
| What plays at once | The nearest route's patch, crossfaded when a nearer one takes over. Not every route's voices simultaneously — one synth engine, as now |
| What moves the walker | GPS, with marker-drag as a fallback for a desktop |
| Sections in Open world | The park you are standing inside governs them; outside any park the sector voice rests |
| Listener's menu | Routes only, plus the Open world switch — no park list |
| Marking in Open world | Always a free point; if it falls inside a park the card offers "attach to this park" |
| Picking a route while in Open world | Centres and selects it, and **stays** in Open world. Turning the switch off is what gives the exclusive one-route view |

The last one contradicts the request's own wording (*"if I select that route again other routes
and points disappear"*); Kerem chose focus-only when asked directly, and was told the wording
differed.

## The two modes

**Place mode** is today's behaviour, unchanged: one park, its boundary, its routes and points,
`startWalk` on a chosen route.

**Open world** is the new default on a first visit, remembered per device afterwards
(`fieldarc.world`, keeping the existing lowercase key family — see the note in `index.html`
about why those keys never get renamed). The switch lives at the top of the park menu, above
the search box, for setters and listeners alike.

| | Place mode | Open world |
| --- | --- | --- |
| Map shows | one park, its routes and points | every published route, its park, its points, and all free points |
| Walker | marker dragged along one route, or GPS | GPS, or a dragged marker not bound to any line |
| Harmony from | the selected route's patch | the nearest route's patch, crossfaded |
| Sections from | the selected park | the park the walker is inside, if any |
| Points heard | the route's zones | every point within reach of the walker, free or not |

## Free points

A feature may have no `place` and no route.

- **Database:** one migration makes `features.place` nullable. Nothing else changes — the
  public view already selects `place` as-is, the fuzz trigger keys on `sensitive`, the audit
  trail and RLS do not mention `place`.
- **Client:** `place` may be `null` wherever a feature is read; `byId(null)` already returns
  undefined, so every consumer needs a guard rather than a rewrite.
- **Publishing:** unchanged. `rowFor` sends whatever `place` the feature holds, now including
  `null`.
- **Offline:** a park's offline download is defined by that park, so free points are not part of
  one. Stated in the download copy rather than silently omitted.
- **Sections:** a free point is not inside any park by definition of its data; if it physically
  falls inside one, the park's sections still govern the walker standing there, because
  sections follow the walker's position, never the point.

## What is heard in Open world

One engine, as now. The pieces that change:

**The nearest route.** Every published route's line is measured once (`routeMetrics`), and on each
position update the walker is projected onto each of them. The nearest route's patch governs
harmony, and the projection's `t` along it is the position in that route's progression — the
same value GPS mode already feeds `pacerSet`. When a different route becomes nearest, the synth
stage fades out and back in over ~1.5 s while the patch is swapped, so a change of key is heard
as a transition rather than a jump cut.

**Distance to that route** drives the existing fade curve (`walkLevel`, 60 m → 120 m). In Open
world it is applied to the **synth stage** (`bed.synth`) rather than to the whole walk
(`bed.walk`), because points near you must still sound when no route is anywhere near. In Place
mode the existing behaviour is untouched.

**Points.** `buildZones(m)` today keeps the points lying within `ZONE_NEAR` (60 m) of one
route's *line*, because on a route that is what "near the walk" means. Open world has no line,
so the test becomes the point's own reach: a point is in the list when the walker is within its
`carries` radius times `ZONE_MARGIN` — the same radius its level already fades across, so a
point is admitted exactly when it would be audible and dropped once it is not. The list is
rebuilt as the walker moves and `updateBed` still picks the nearest `BED.maxVoices` of it.
A free point beside you therefore sounds with nothing else playing.

**Sections.** The park containing the walker is found by point-in-polygon over the catalogue
(90 polygons, cheap, recomputed only when the walker moves more than a few metres). Entering a
park loads its boundary and cuts its sections; leaving one rests the sector voice.

**Mute and solo** keep their meaning: the route source is the synth stage, each point is itself.

## Starting the sound

Toggling the switch is a gesture, so it may start audio. A cold load into Open world cannot —
browsers require a touch — so the map bar shows Sound exactly as it does today, and the state is
honest until then.

## The map frame

Unrelated and small, folded in because it is one rule: on a desktop the map has no border on its
right and bottom edges, so the frame reads as unfinished. Add them; the mobile layout, where the
map meets the sheet, stays as it is.

## What could go wrong

- **Cost.** Every route's line is measured and projected on every position update. With four
  routes this is nothing; the measurement is cached per route and the projection is O(vertices).
  If the catalogue grows to hundreds of routes, the projection set is pre-filtered by a bounding
  box before the exact pass. Verified by measurement, not assumption.
- **A crossfade on every step.** Two routes that cross leave the walker flipping between them.
  The nearest-route choice takes the same hysteresis the sections already use: the challenger
  must be clearly nearer (by the same 8–40 m margin) before it takes over.
- **A listener with no GPS** sees the map and hears nothing until they drag the marker. The
  walker's readout says so.

## Verification

Per `verify.md`, measured and recorded, not reasoned:

| Claim | Method | Pass |
| --- | --- | --- |
| Nearest-route choice and hysteresis | unit test over synthetic lines | picks the nearer line; no flip inside the margin |
| Mode state and its default | unit test | Open world when the key is unset; remembered after a toggle |
| Free point round-trip | live Supabase test | publishes with `place: null`, comes back from `public_features` |
| Crossfade | browser: drive positions across two routes, read `bed.synth.gain` | fades out and in, no step |
| Points with no route near | browser: park the walker by a free point, read voice gains | the point sounds, the synth stage is silent |
| Fit and frame | `scrollHeight - innerHeight` plus a screenshot at desktop and phone sizes | 0, and four borders |
| Nothing regressed in Place mode | the existing suite | all green |

## Measured (2026-09-21, branch `open-world` @ 06f2881)

Taken in desktop Chrome against a harness carrying two synthetic routes 1.5 km apart and a free
point 1.8 km from either, because the live archive has no free point yet. 386 unit tests pass.

| Claim | Measured |
| --- | --- |
| Opens in Open world when the key was never set | switch `aria-pressed=true`, `body.world`, walker running with `world: true`, both routes loaded |
| The transport is reachable in a world walk | `#pacerbar` and `#patchbar` both visible; Sound started audio (meter −28 dB) |
| Fit | `scrollHeight − innerHeight` = 0 at 1428×729, 501×729 and 832×390 |
| Map frame | desktop border right/bottom present (0.8 px at this DPR); 0 px on the phone layout, as intended |
| Handover crossfade | on A: 1.000 → 0.390 → 0.000, held ≈1.5 s, patch swaps to B, 0.069 → 0.724 → 1.000 |
| Continuous motion does not starve the swap | moved every 250 ms for 2.5 s: route became B, synth returned to 1.000 |
| A free point with no route near | 1835 m from either route: synth 0.000, free point voice 0.900, meter −11 dB, walk gain 1.000 |

Not measured: a real GPS walk (Kerem's phone), and the free-point path against the live server —
the harness proves the client, the migration test proves the server, nothing yet proves them together.
