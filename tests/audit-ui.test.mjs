import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("the page can show the audit trail", () => {
  assert.match(html, /id="audit-list"/);
  assert.match(html, /id="audit-refresh"/);
});

test("the trail is only fetched for a signed-in setter", () => {
  const fn = html.slice(html.indexOf("function renderAudit"));
  assert.match(fn.slice(0, 400), /setter\.signedIn/,
    "an anonymous fetch would just 401 and print an error where a list belongs");
});

test("the list shows who, what and when — a bare action is not a record", () => {
  /* End marker must be unique and must actually follow renderAudit's closing brace.
     $("#audit-refresh") no longer qualifies as of the audit popover: openAudit() (defined
     directly after renderAudit) reads $("#audit-refresh") to set aria-expanded before the
     click-listener line this test was originally written against, so that marker now
     matches early — still after renderAudit's own close, so the slice still happens to
     contain "action", "at" and "setter_id", but it no longer bounds what this test means
     to check. "function openAudit" is the next unique thing in the file and sits exactly
     at renderAudit's end. */
  const start = html.indexOf("function renderAudit");
  const end = html.indexOf("function openAudit");
  assert.ok(start !== -1, "renderAudit not found");
  assert.ok(end !== -1, "openAudit not found");
  assert.ok(end > start,
    `end marker occurs at or before start marker (start=${start}, end=${end}) — the slice ` +
    `would be empty or backwards and every assertion on it would pass without checking anything`);
  const fn = html.slice(start, end);
  for (const field of ["action", "at", "setter_id"]) {
    assert.ok(fn.includes(field), `the rendered row must carry ${field}`);
  }
});
