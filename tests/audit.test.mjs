import { test, after } from "node:test";
import assert from "node:assert/strict";
import { service } from "./clients.mjs";

const db = service();
after(async () => { await db.from("audit").delete().eq("target_id", "probe"); });

test("an audit row records an action against a target", async () => {
  const { error } = await db.from("audit")
    .insert({ action: "publish", target_id: "probe", detail: { note: "probe" } });
  assert.equal(error, null, error?.message);

  const { data } = await db.from("audit").select("*").eq("target_id", "probe");
  assert.equal(data.length, 1);
  assert.ok(data[0].at, "every audit row is stamped");
});

test("an unknown action is refused", async () => {
  const { error } = await db.from("audit")
    .insert({ action: "vandalise", target_id: "probe" });
  assert.ok(error, "the set of actions is closed");
});
