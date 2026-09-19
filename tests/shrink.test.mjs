import { test } from "node:test";
import assert from "node:assert/strict";
import { STORAGE_LIMIT, needsShrink, opusBitrate } from "../src/shrink.mjs";

/* The project's storage limit, read from the Management API on 2026-09-19: fileSizeLimit
   52428800. A Free-plan project cannot raise it. */
test("the limit is the project's 50 MB", () => {
  assert.equal(STORAGE_LIMIT, 52428800);
});

test("only a file over the limit is shrunk; everything else goes up untouched", () => {
  assert.equal(needsShrink(STORAGE_LIMIT), false);
  assert.equal(needsShrink(STORAGE_LIMIT + 1), true);
  assert.equal(needsShrink(16 * 1024 * 1024), false);
});

test("a stereo recording gets 256 kbps when that fits", () => {
  assert.equal(opusBitrate(20 * 60, 2), 256000);   // 20 min at 256k ≈ 38 MB
});

test("mono gets half", () => {
  assert.equal(opusBitrate(20 * 60, 1), 128000);
});

test("a long recording steps down only as far as it must to fit", () => {
  const secs = 60 * 60, b = opusBitrate(secs, 2);
  assert.ok(b < 256000 && b >= 64000, "an hour of stereo cannot stay at 256k: " + b);
  assert.ok(b * secs / 8 <= STORAGE_LIMIT * 0.95, "and the result must fit with headroom");
  assert.equal(b % 1000, 0, "a round number of kbps");
});

test("a recording too long even at the floor is refused rather than mangled", () => {
  assert.equal(opusBitrate(3 * 60 * 60, 2), null, "3 h of stereo cannot fit at 64k");
});
