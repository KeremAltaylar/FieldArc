// tests/spa-redirect.test.mjs — the deep-link redirect, and the loop it used to allow.
/* Observed 2026-09-21 serving the repo from a local root: a deep link 404s, 404.html rewrites
   it, the rewrite 404s, and each pass appends another p= — a URL with 150 copies of p=%2F. The
   host that production runs on makes pathSegmentsToKeep = 1 correct, so this never bit a real
   visitor; a redirect that can loop at all should not be able to loop twice.

   A first cut of this test only checked that the string "p=" appeared before "location.replace"
   in the file — true of a correct guard, but also true of an inverted one (redirect fires only
   on an already-rewritten URL, never on a real first-time deep link: the exact opposite of
   correct). This version extracts the actual script and runs it against a fake window/location,
   so an inverted or substring-matching guard fails here instead of shipping quietly. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("404.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Runs the extracted 404.html script against a stubbed location and returns what, if
// anything, location.replace was called with — undefined if the guard skipped the redirect.
function runRedirect(pathname, search, hash) {
  var replaceCalls = [];
  var sandbox = {
    window: {
      location: {
        pathname: pathname,
        search: search || "",
        hash: hash || "",
        protocol: "https:",
        hostname: "keremaltaylar.github.io",
        port: "",
        replace: function (url) { replaceCalls.push(url); }
      }
    },
    URLSearchParams: URLSearchParams
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return replaceCalls;
}

test("a first-time deep link redirects, carrying its own path in ?p=", () => {
  const calls = runRedirect("/Fieldscape/W248012830", "");
  assert.equal(calls.length, 1, "a fresh deep link must redirect exactly once");
  assert.match(calls[0], /\?p=/);
  assert.match(calls[0], /W248012830/, "the original path must survive the rewrite, encoded");
});

test("a rewrite that has already happened is not rewritten again", () => {
  const calls = runRedirect("/Fieldscape/", "?p=%2FW248012830");
  assert.equal(calls.length, 0, "a URL that already carries ?p= must not be redirected again — that is the loop");
});

test("a first-party query param that merely contains the text p= still redirects", () => {
  // The regression this guard must not reintroduce: a naive l.search.indexOf("p=") finds the
  // substring "p=" inside "map=1" too (the p immediately before the =), so it would mistake a
  // genuine first-time deep link for an already-rewritten one and silently skip the redirect,
  // leaving a blank page with no error and no visible cause.
  const calls = runRedirect("/Fieldscape/W248012830", "?map=1");
  assert.equal(calls.length, 1, "?map=1 is not a repeat pass and must still redirect");
});

test("a hash-only marker with no '=' at all still redirects", () => {
  const calls = runRedirect("/Fieldscape/W248012830", "?rafshim");
  assert.equal(calls.length, 1);
});

test("the redirect still works for a first-time deep link", () => {
  assert.match(html, /pathSegmentsToKeep = 1/, "production is one segment deep (/Fieldscape)");
  assert.match(html, /encodeURIComponent/);
});
