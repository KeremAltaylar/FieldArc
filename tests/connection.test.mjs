import { test } from "node:test";
import assert from "node:assert/strict";
import { anon } from "./clients.mjs";

test("the three keys are present", () => {
  for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"]) {
    assert.ok(process.env[k], `${k} missing from .env.local`);
  }
});

/* The whole point of stage 1 in one assertion: a listener never touches the table. This
   fails now because there is no table, and it must still fail-to-be-readable once there
   is one — Task 5 is what makes it pass for the right reason. */
test("anon cannot select the features table", async () => {
  const { error } = await anon().from("features").select("id").limit(1);
  assert.ok(error, "anon must not be able to select features at all");
});
