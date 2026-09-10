import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("the page loads supabase-js from a host the service worker already caches", () => {
  assert.match(html, /unpkg\.com\/@supabase\/supabase-js@2/,
    "unpkg is in sw.js's IS_ASSET rule; another CDN would break offline");
});

test("the page carries the project url and the anon key, and neither secret", () => {
  assert.match(html, /FA_CONFIG\s*=\s*\{/);
  assert.match(html, /ujdygmcpqsbyeysggypc\.supabase\.co/);
  assert.doesNotMatch(html, /service_role/, "the service key must never ship to a browser");
  assert.doesNotMatch(html, /postgresql:\/\//, "the database url must never ship to a browser");
});

test("a missing library is survivable, not fatal", () => {
  assert.match(html, /typeof supabase === "undefined"/,
    "offline first load must not throw; __fa.sb becomes null instead");
});
