// tests/spa-redirect.test.mjs — the deep-link redirect, and the loop it used to allow.
/* Observed 2026-09-21 serving the repo from a local root: a deep link 404s, 404.html rewrites
   it, the rewrite 404s, and each pass appends another p= — a URL with 150 copies of p=%2F. The
   host that production runs on makes pathSegmentsToKeep = 1 correct, so this never bit a real
   visitor; a redirect that can loop at all should not be able to loop twice. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("404.html", "utf8");

test("a rewrite that has already happened is not rewritten again", () => {
  assert.match(html, /indexOf\("p="\)|has\("p"\)|searchParams/,
    "404.html must notice its own previous pass");
  const guard = html.indexOf("p=");
  const replace = html.indexOf("location.replace");
  assert.ok(guard !== -1 && guard < replace, "and notice it before redirecting again");
});

test("the redirect still works for a first-time deep link", () => {
  assert.match(html, /pathSegmentsToKeep = 1/, "production is one segment deep (/Fieldscape)");
  assert.match(html, /encodeURIComponent/);
});
