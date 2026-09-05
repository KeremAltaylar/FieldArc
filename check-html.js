const fs = require("fs");
const file = process.argv[2];
const raw = fs.readFileSync(file, "utf8");
const html = raw.replace(/<!--[\s\S]*?-->/g, "");
const js = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const refs = new Set([...js.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map(m => m[1]));
const missing = [...refs].filter(r => !ids.has(r));

/* A start tag whose ">" never arrives swallows the next element as attributes. That is how
   `<div id="map"` ate `<div id="loading">` and killed the map's load handler. */
const bad = [];
const body = html.replace(/<script[\s\S]*?<\/script>/g, m => " ".repeat(m.length))
                 .replace(/<style[\s\S]*?<\/style>/g, m => " ".repeat(m.length));
const re = /<[a-zA-Z\/][^>]*/g;
let m2;
while ((m2 = re.exec(body))) {
  const tag = m2[0];
  if (tag.indexOf("<", 1) > 0) {
    const line = body.slice(0, m2.index).split("\n").length;
    bad.push(line + ": " + tag.split("\n")[0].trim().slice(0, 60));
  }
}

console.log("ids declared:", ids.size, "| referenced by JS:", refs.size);
console.log("missing ids:", missing.length ? missing.join(", ") : "none");
console.log("unterminated tags:", bad.length ? "\n  " + bad.join("\n  ") : "none");
process.exit(missing.length || bad.length ? 1 : 0);
