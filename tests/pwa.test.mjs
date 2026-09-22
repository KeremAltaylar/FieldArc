// tests/pwa.test.mjs — installable, and recognisably itself once installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf8"));
const head = html.slice(0, html.indexOf("</head>"));

test("the manifest offers raster icons, because iOS ignores SVG on the home screen", () => {
  const raster = manifest.icons.filter((i) => i.type === "image/png");
  assert.ok(raster.length >= 2, "an SVG-only manifest gets a screenshot as the icon on iOS");
  for (const size of ["192x192", "512x512"]) {
    assert.ok(raster.some((i) => i.sizes === size), "missing " + size);
  }
  assert.ok(manifest.icons.some((i) => (i.purpose || "").includes("maskable")),
    "Android crops a non-maskable icon into a circle badly");
});

test("an iPhone home-screen launch runs standalone and knows its own icon", () => {
  assert.match(head, /<link rel="apple-touch-icon" href="\.\/icon-180\.png">/);
  assert.match(head, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(head, /apple-mobile-web-app-status-bar-style/);
  assert.match(head, /<meta name="apple-mobile-web-app-title" content="Fieldscape">/);
});

test("the icons are real files of a plausible size", () => {
  for (const f of ["icon-180.png", "icon-192.png", "icon-512.png"]) {
    const bytes = statSync(f).size;
    assert.ok(bytes > 500, f + " is " + bytes + " bytes — that is not a rendered icon");
  }
});

test("the service worker caches them, so an installed app works offline from first launch", () => {
  const sw = readFileSync("sw.js", "utf8");
  for (const f of ["icon-180.png", "icon-192.png", "icon-512.png"]) {
    assert.ok(sw.includes(f), "not in SHELL_FILES: " + f);
  }
});
