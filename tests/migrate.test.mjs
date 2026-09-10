import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLegacyId, toRow, UUID } from "../tools/migrate-archive.mjs";

test("deriving a row id from a legacy (non-UUID) id is deterministic", () => {
  const a = deriveLegacyId("f-1725450000000-abc123");
  const b = deriveLegacyId("f-1725450000000-abc123");
  assert.equal(a, b, "the same legacy id must derive the same row id on every run");
  assert.match(a, UUID, "a derived id must still be a well-formed UUID");
});

test("deriving a row id from a different legacy id gives a different result", () => {
  const a = deriveLegacyId("f-1725450000000-abc123");
  const b = deriveLegacyId("f-1725450000001-xyz789");
  assert.notEqual(a, b);
});

test("toRow preserves a well-formed UUID id as-is, with no legacy_id", () => {
  const id = "1e587abf-2d2a-43a4-8de6-4dc4c601d96b";
  const row = toRow({
    properties: { id, place: "R14372445", kind: "point", name: "" },
    geometry: { type: "Point", coordinates: [0, 0] }
  });
  assert.equal(row.id, id);
  assert.equal("legacy_id" in row.properties, false);
});

test("toRow derives a stable id for a non-UUID legacy id and keeps the original", () => {
  const legacyId = "f-1725450000000-abc123";
  const feature = {
    properties: { id: legacyId, place: "R8845862", kind: "point", name: "old point" },
    geometry: { type: "Point", coordinates: [28.9, 41.2] }
  };
  const first = toRow(feature);
  const second = toRow(feature);
  assert.equal(first.id, second.id, "re-running the tool must produce the same row id");
  assert.match(first.id, UUID);
  assert.equal(first.properties.legacy_id, legacyId);
  assert.equal("id" in first.properties, false, "id is a column, not a properties key");
});
