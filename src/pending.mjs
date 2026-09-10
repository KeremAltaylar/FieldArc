/* What has changed since the last successful publish, computed from the archive itself.
   The app mutates its FeatureCollection from a dozen places — Mark, map clicks, the patch
   panel, the icon picker, import, the trash. A dirty flag would need every one of them to
   remember, and a forgotten one is work that silently never leaves the device. A manifest of
   content hashes needs none of them to remember anything. */

/* Stable across key order, because JSON.stringify follows insertion order and a feature
   re-saved by a different code path would otherwise read as changed when it is not. */
function canonical(value) {
  if (value === null || typeof value !== "object") { return JSON.stringify(value) ?? "null"; }
  if (Array.isArray(value)) { return "[" + value.map(canonical).join(",") + "]"; }
  return "{" + Object.keys(value).sort()
    .map(function (k) { return JSON.stringify(k) + ":" + canonical(value[k]); })
    .join(",") + "}";
}

/* djb2. This detects change; it defends against nothing, so a cryptographic hash would buy
   only slowness. Returned as unsigned hex so it never carries a minus sign into JSON. */
export function hashFeature(feature) {
  const s = canonical(feature);
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; }
  return h.toString(16);
}

export function manifestOf(features) {
  const out = {};
  for (const f of features) {
    const id = f && f.properties && f.properties.id;
    if (id) { out[id] = hashFeature(f); }
  }
  return out;
}

export function diffManifest(previous, current) {
  const added = [], changed = [], removed = [];
  for (const id of Object.keys(current)) {
    if (!(id in previous)) { added.push(id); }
    else if (previous[id] !== current[id]) { changed.push(id); }
  }
  for (const id of Object.keys(previous)) {
    if (!(id in current)) { removed.push(id); }
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}
