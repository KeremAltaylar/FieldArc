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
  const fn = html.slice(html.indexOf("function renderAudit"), html.indexOf("$(\"#audit-refresh\")"));
  for (const field of ["action", "at", "setter_id"]) {
    assert.ok(fn.includes(field), `the rendered row must carry ${field}`);
  }
});
