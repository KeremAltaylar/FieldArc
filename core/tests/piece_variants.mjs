/* Per-instrument variants of the default patch (dry, one layer on, each synth type at its own
   defaults) for core/tests/piece_ref.mjs + piece_compare: node core/tests/piece_variants.mjs */
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function grab(name) { const s = html.indexOf("  function " + name + "("); let i = html.indexOf("{", s), d = 0; for (; ; i++) { if (html[i] === "{") d++; else if (html[i] === "}" && !--d) break; } return html.slice(s, i + 1); }
const defaultPatch = new Function(grab("defaultMorph") + grab("defaultProgression") + grab("defaultSectors") + grab("defaultPatch") + "; return defaultPatch;")();
const DEF = { fm: [1, 4], am: [1.5, 3], duo: [1.5, 0.2], mono: [2, 3], simple: [0, 1.6], pluck: [3200, 0.92], metal: [4.1, 1.2], membrane: [0.12, 3.2], wavetable: [0.35, 0.5], comb: [0.4, 0.5], formant: [0.5, 0.5] };
const types = ["fm", "am", "duo", "mono", "simple", "pluck", "metal", "membrane", "wavetable", "comb", "formant"];
const dry = (p) => { for (const k of ["fx", "fx2", "fx3"]) { p[k].revWet = 0; p[k].delayWet = 0; } p.zones.on = false; p.morph.on = false; return p; };
const out = [];
for (const t of types) {
  let p = dry(defaultPatch()); p.sect.on = false; p.v3.on = false; p.voice.drive = 0; p.voice.warp = 0; p.voice.synth = t; [p.voice.harm, p.voice.index] = DEF[t];
  writeFileSync(`build/piece/v-pad-${t}.json`, JSON.stringify(p)); out.push(`pad-${t}`);
  p = dry(defaultPatch()); p.voice.on = false; p.v3.on = false; p.sect.drive = 0; p.sect.warp = 0; p.sect.synth = t; [p.sect.harm, p.sect.index] = DEF[t];
  writeFileSync(`build/piece/v-sect-${t}.json`, JSON.stringify(p)); out.push(`sect-${t}`);
}
let p = dry(defaultPatch()); p.sect.on = false; p.v3.on = false;  /* pad fm with drive and warp at the patch's */
writeFileSync(`build/piece/v-pad-fm-dw.json`, JSON.stringify(p)); out.push("pad-fm-dw");
p = defaultPatch(); p.sect.on = false; p.v3.on = false; p.zones.on = false; p.morph.on = false; p.voice.drive = 0; p.voice.warp = 0;
writeFileSync(`build/piece/v-pad-fm-fx.json`, JSON.stringify(p)); out.push("pad-fm-fx");
p = dry(defaultPatch()); p.sect.on = false; p.v3.on = false; p.voice.drive = 0; p.voice.warp = 0; p.zones.on = true;
p.voice.gain = 0; writeFileSync(`build/piece/v-zones.json`, JSON.stringify(p)); out.push("zones");
console.log(out.join(" "));
