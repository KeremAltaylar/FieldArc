# FieldArc

A field-recording archive keyed to geography. Walk a forest, mark where you stood, trace the
route you took, and attach the recording you made there.

Built as a prototype for a larger idea: **the archive is the product, and any artwork is just
one reader of it.** Recordings can be remade; a walk you did not record is gone.

## Using it

Pick a place from the header — 69 forests, nature reserves and korular across İstanbul. The
map, the boundary and the archive all follow your choice; features belong to a place.

| | |
| --- | --- |
| **Select** | Click a point or route to inspect it. **Mark** centres on your position. |
| **Point** | Click the map to place one, or **Mark** to pin your GPS fix. |
| **Route** | Click to draw vertices, or **Mark** to record a live trace and **Mark** again to finish. |

`Off · Frame · Areas` switches the boundary between nothing, the clean outer frame, and the
frame plus its sub-areas — the enclosed villages, reservoirs and clearings.

Selecting a feature opens a card: name, note, and a player for an attached recording.

## Location needs HTTPS

Geolocation only works in a secure context. The GitHub Pages URL qualifies. Opening the files
over `file://` or a plain LAN address (`http://192.168.…`) will not get a fix — the app says so
rather than failing silently.

## Where things are stored

- **Features** — GeoJSON in `localStorage`, per browser. Export and Import move them.
- **Audio** — IndexedDB, keyed by feature id. Blobs cannot live in `localStorage`.
- Storage is **per origin**: the local dev copy and the deployed copy do not share an archive.
  Export from one, import into the other.

Every coordinate records `position_source` — `manual` when drawn with a mouse, `device_fix`
when it came from GPS — and a GPS fix keeps its `accuracy_m`. A coordinate without its
uncertainty is a guess wearing a costume.

## Running locally

Any static server; it needs one because the app fetches `places.geojson`.

```
npx serve .        # or: python -m http.server
```

`?rafshim` is a test-only flag that routes `requestAnimationFrame` through `setTimeout`, so
automated checks can load the map in a hidden tab. Inert without it.

## Data and attribution

Place boundaries are derived from **OpenStreetMap** (Overpass for the inventory, Nominatim for
assembled geometry), simplified with a tolerance scaled to each place's size.
© OpenStreetMap contributors, **ODbL 1.0**.

Basemaps: OpenStreetMap standard tiles, OpenTopoMap (CC-BY-SA), and Esri World Imagery.
Map rendering by MapLibre GL JS.
