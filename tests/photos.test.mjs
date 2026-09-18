// tests/photos.test.mjs — photos on a point's card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

function body(name) {
  const start = html.indexOf("function " + name + "(");
  assert.ok(start !== -1, `function not found: ${name}`);
  let i = html.indexOf("{", html.indexOf(")", start)), depth = 0;
  const from = i;
  for (; i < html.length; i++) {
    if (html[i] === "{") { depth++; }
    else if (html[i] === "}") { depth--; if (depth === 0) { break; } }
  }
  return { params: html.slice(start + name.length + 10, html.indexOf(")", start)), src: html.slice(from + 1, i) };
}
const fn = (name) => { const b = body(name); return new Function(b.params, b.src); };

test("fitWithin caps the long edge, keeps the aspect ratio, and never upscales", () => {
  const fitWithin = fn("fitWithin");
  assert.deepEqual(fitWithin(4032, 3024, 1600), { w: 1600, h: 1200 });
  assert.deepEqual(fitWithin(3024, 4032, 1600), { w: 1200, h: 1600 });
  assert.deepEqual(fitWithin(800, 600, 1600), { w: 800, h: 600 });
});

test("a photo's storage path lives under the feature id, so the bucket's per-feature read policy covers it", () => {
  const photoPath = fn("photoPath");
  const p = photoPath("abc-123", "k1");
  assert.equal(p, "abc-123/images/k1.jpg");
  assert.doesNotMatch(p, /#/, "a fragment delimiter would truncate a signed URL");
});

test("a photo's local key cannot collide with the recording or a hit slot", () => {
  const photoKey = fn("photoKey");
  const k = photoKey("abc", "k1");
  assert.notEqual(k, "abc");
  assert.doesNotMatch(k, /#/);
});

test("encoding re-draws through a canvas as JPEG, which drops EXIF — GPS included", () => {
  const src = body("encodePhoto").src;
  assert.match(src, /createImageBitmap\(\s*file\s*,\s*\{\s*imageOrientation:\s*"from-image"\s*\}\)/);
  assert.match(src, /toBlob\([\s\S]*"image\/jpeg"/);
  assert.match(src, /PHOTO_EDGE/);
});

test("the card has a photo group; adding and removing are setter-only in markup and in handlers", () => {
  assert.match(html, /id="g-photos"/);
  assert.match(html, /<input type="file" id="photo-file" accept="image\/\*" multiple hidden>/);
  const gating = body("applyModeGating").src;
  assert.match(gating, /"#photo-add"/);
  const add = html.slice(html.indexOf('$("#photo-add").addEventListener'), html.indexOf('$("#photo-add").addEventListener') + 200);
  assert.match(add, /if \(!setterTools\(\)\) \{ return; \}/);
  assert.match(body("removePhoto").src, /if \(!setterTools\(\)\) \{ return; \}/);
});

test("a newly rendered card starts at its first photo", () => {
  /* Measured: after swiping to photo 3 and resizing, the next card opened on 2 / 3. */
  assert.match(body("renderPhotos").src, /strip\.scrollLeft = 0/);
});

test("no more than MAX_PHOTOS are kept", () => {
  assert.match(html, /var MAX_PHOTOS = 6/);
  assert.match(body("addPhotos").src, /MAX_PHOTOS/);
});

test("publish uploads every photo before the row, and records each path on a copy, not the live feature", () => {
  const pub = body("publish").src;
  assert.match(pub, /photoKey\(r\.id, img\.key\)/);
  assert.match(pub, /photoPath\(r\.id, img\.key\)/);
  assert.match(pub, /img\.storage_path = path/);
  assert.match(body("publish").src, /p\.images = p\.images\.map\(/, "rowFor must clone the images array");
});

test("offline download and its size estimate include photos", () => {
  assert.match(body("offlineBytes").src, /images/);
  assert.match(html, /photoKey\(row\.id, img\.key\)/);
});

test("purging a feature from the trash drops its photo blobs too", () => {
  assert.match(body("purgeTrash").src, /photoKey\(/);
});
