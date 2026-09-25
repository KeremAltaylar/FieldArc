/* The web's own route sound, rendered offline in headless Chrome with Tone.js, to hold the C++ piece
   to. index.html's functions (buildVoice, the synths, harmonyBar, voiceStep, sectorStep, thirdStep,
   zoneFire, the morphs, applyPatchToVoice, patchOf) are extracted and run as they are, inside
   Tone.Offline; only the world around them is stubbed (no DOM, no GPS: the walk goes from the start
   of the route to the end, synth level 1, a zone every 20 s). Math.random is a fixed list of draws
   while the step functions run, the same list the C++ reads (core/tests/piece_compare.py).

     node core/tests/piece_ref.mjs <patch.json|-> <seconds> <out-prefix> [rhythm.json source.wav hits|grains]

   With a rhythm point: one point of that rhythm, every slot (hits) or the recording (grains) read
   from source.wav, at gain 0.6 x its own; its hits and grains are listed with the notes (roles 10-13
   one per slot: rate, volume dB, time; role 20 per grain: rate, offset, time).

   Writes <out-prefix>.web.wav (the synth bus, before the limiter), <out-prefix>.draws (the random
   list) and <out-prefix>.notes.txt (every note the steps played). The room is Freeverb, as in the
   port (makeRoom's cheap branch), with the delay and chorus of the rich one. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { targets, session } from "../../tools/cdp.mjs";

const [patchArg, secArg, prefix] = process.argv.slice(2);
const seconds = +secArg;
const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

/* a statement starting at i, to its closing ; at depth 0 (or the end of a function body) */
function stmt(i) {
  let d = 0, q = null;
  for (let k = i; k < html.length; k++) {
    const c = html[k];
    if (q) { if (c === "\\") { k++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "/" && html[k + 1] === "*") { k = html.indexOf("*/", k) + 1; continue; }
    if (c === "/" && html[k + 1] === "/") { k = html.indexOf("\n", k); continue; }
    if ("{[(".includes(c)) d++;
    else if ("}])".includes(c)) { d--; if (d === 0 && c === "}" && html.startsWith("function", i)) return html.slice(i, k + 1); }
    else if (c === ";" && d === 0) return html.slice(i, k + 1);
  }
  throw new Error("unterminated at " + i);
}
function fn(name) { const i = html.indexOf("  function " + name + "("); if (i < 0) throw new Error("missing function " + name); return stmt(i + 2); }
function v(name) { const i = html.indexOf("  var " + name + " = "); if (i < 0) throw new Error("missing var " + name); return stmt(i + 2); }
function protos(cls) {
  const out = []; const re = new RegExp("\\n  " + cls + "\\.prototype\\.\\w+ = ", "g"); let m;
  while ((m = re.exec(html))) out.push(stmt(m.index + 3));
  return out.join("\n");
}

const code = [
  v("WAVE_TABLES"), v("WAVE_GAIN"), fn("WavetableVoice"), protos("WavetableVoice"),
  fn("CombVoice"), protos("CombVoice"), v("FORMANTS"), fn("FormantVoice"), protos("FormantVoice"),
  v("SYNTH_TYPES"), v("SYNTH_LABEL"), v("PERCUSSIVE"), v("SELF_VOICED"), v("SYNTH_TRIM"), fn("makeSynth"), v("SYNTH_PARAMS"),
  fn("paramsFor"), fn("setParam"), fn("applyTimbre"), fn("swapSynth"), fn("makeBlend"), fn("roomSize"), fn("makeWarp"),
  fn("buildFxChain"), fn("buildVoice"), fn("harmonyBar"), fn("voiceStep"), v("counter"), fn("keyCollection"),
  v("SECT_GRID"), v("SECT_STRIDE"), fn("sectorStep"), v("third"), fn("thirdStep"), fn("zoneFire"),
  v("CHORDS"), v("MODES"), fn("defaultSectors"), v("DOM_Q"), v("MORPH_SHAPES"), v("MORPH_DESTS"),
  fn("hash01"), fn("morphShape"), fn("morphPhase"), fn("morphSeed"), fn("morphValue"), fn("morphList"), fn("morphFor"),
  v("ZONE_TIMBRE"), fn("defaultMorph"), fn("defaultProgression"), fn("defaultPatch"), fn("patchOf"),
  fn("midiToFreq"), v("harmony"), fn("chordIndexFor"), fn("chordRoot"), fn("chordQuality"), fn("chordTones"), fn("leadTo"),
  v("MAX_DELAY_S"), fn("delaySeconds"), fn("divSeconds"),
  fn("applyPatchToVoice"), fn("applySynths"), fn("applyDecayTo"), fn("applyRevDecay"), fn("applySectRhythm"),
  v("HIT_SLOTS"), fn("euclid"), fn("rotated"), fn("metricWeight"), fn("defaultRhythm"), fn("defaultGrains"), fn("rhythmOf"),
  fn("gcd"), v("RHYTHM_BAND"), v("SENTENCE_VARIATIONS"), fn("oneComboSet"), fn("buildSentenceSet"), fn("advanceSentence"),
  fn("buildRhythmFx"), fn("applyRhythmFx"), fn("buildHitFx"), fn("applyHitFx"), v("MAX_STRETCH_HIT_S"), v("STRETCH_STOP_FADE_S"),
  fn("applyHitStretch"), fn("stretchParams"), fn("applyStretch"), fn("ensureRhythm"), fn("variedGrains"), fn("grainEnvelope"),
  fn("fireGrains"), fn("rhythmStep"),
].join("\n");

/* the draws: a plain LCG, written out so the C++ reads the very same doubles */
const N = 400000;
const draws = new Float64Array(N);
let seed = 20260925;
for (let i = 0; i < N; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; draws[i] = seed / 4294967296; }
mkdirSync(dirname(resolve(prefix)), { recursive: true });
writeFileSync(prefix + ".draws", Buffer.from(draws.buffer));

const patch = patchArg === "-" ? {} : JSON.parse(readFileSync(patchArg, "utf8"));
const [rhythmArg, wavArg, modeArg] = process.argv.slice(5);
const rhythm = rhythmArg ? JSON.parse(readFileSync(rhythmArg, "utf8")) : null;
const wav64 = wavArg ? readFileSync(wavArg).toString("base64") : "";
const tone = resolve("build/piece/Tone.js");
if (!existsSync(tone)) throw new Error("build/piece/Tone.js missing (tone 15.5.42 build/Tone.js)");

const page = `<!doctype html><meta charset="utf-8"><pre id="out">running</pre>
<script src="Tone.js"></script>
<script>
(async function () {
  const DRAWS = new Float64Array(await (await fetch("data:application/octet-stream;base64,${Buffer.from(draws.buffer).toString("base64")}")).arrayBuffer());
  let di = 0; const det = () => DRAWS[di++];
  const realRandom = Math.random;
  const NOTES = [];
  const SECONDS = ${seconds};
  const out = document.getElementById("out");
  try {
    const ctx = new Tone.OfflineContext(2, SECONDS, 48000);
    Tone.setContext(ctx);
    const transport = ctx.transport;
    {
      /* the world index.html's sound code expects */
      var pacer, bed, sect = { idx: null };
      var makeRoom;
      var $ = () => ({ hidden: true, textContent: "", setAttribute() {}, classList: { toggle() {} } });
      var richAudio = () => true, drawProgSegments = () => {}, markProgression = () => {}, save = () => {}, visible = () => [];
      var localCharacter = () => ({ centroid: 2000, flatness: 0.3, onsets: 1, n: 0 });
      var setInterval = (f, ms) => transport.scheduleRepeat(() => f(), ms / 1000);
      var setTimeout0 = window.setTimeout.bind(window);
      var setTimeout = () => 0;           /* offline renders faster than the wall clock: keep the one-shots */
      var clearInterval = () => {};
      const RHYTHM = ${JSON.stringify(rhythm)}, MODE = ${JSON.stringify(modeArg || "")};
      const FEATURE = RHYTHM && { properties: { id: "r", rhythm: RHYTHM, audio_mode: MODE, sound: { radius: 140, gain: 0.9 } } };
      var feature = (id) => (id === "r" ? FEATURE : null);
      var remotePath = () => "x", remoteHitPath = () => "x";
      const WAV = "${wav64}";
      var audioBlob = () => fetch("data:audio/wav;base64," + WAV).then((r) => r.blob());
      ${code}
      /* the port's room: Freeverb (see makeRoom's cheap branch) with the rich chain around it */
      makeRoom = function (Tone, decay) { return new Tone.Freeverb({ roomSize: roomSize(decay), dampening: 3000, wet: 0 }); };
      applyDecayTo = function (rv, want) { try { rv.roomSize.value = roomSize(want); } catch (e) {} };
      /* Noise's pink buffer is built on first use with Math.random: build it now, outside the steps */
      { const n = new Tone.Noise("pink"); n.start(0); n.stop(0.01); }
      const synthBus = new Tone.Gain(1).toDestination();
      bed = { on: true, voices: {}, rhythms: {}, oneShots: [], synth: synthBus, master: synthBus, Tone: Tone };
      const P = patchOf({ properties: { patch: ${JSON.stringify(patch)} } });
      pacer = { patch: patchOf({ properties: {} }), t: 0, world: true, zones: [] };
      transport.bpm.value = pacer.patch.tempo;
      bed.voice = buildVoice(Tone, pacer.patch);
      bed.rfx = buildRhythmFx(Tone, pacer.patch); applyRhythmFx(pacer.patch);
      /* the first route arrives at once (worldSwap with nothing running): take() */
      pacer.patch = P; applyPatchToVoice(P);
      harmony.idx = null; harmony.chord = null; harmony.tones = null; sect.idx = null;
      /* record the notes */
      let inNote = 0;
      const wrap = (holder, key, role) => {
        const sy = holder[key];
        for (const m of ["triggerAttack", "triggerAttackRelease"]) {
          const f = sy[m].bind(sy);
          sy[m] = function (freq, a, b, c) {
            if (!inNote) NOTES.push([role, freq, m === "triggerAttack" ? -1 : a, m === "triggerAttack" ? a : b, m === "triggerAttack" ? b : c]);
            inNote++; try { return f(freq, a, b, c); } finally { inNote--; }
          };
        }
      };
      wrap(bed.voice.synth.bass, "synth", 0); wrap(bed.voice.synth.top, "synth", 1);
      wrap(bed.voice.sect, "synth", 2); wrap(bed.voice.v3.holder, "synth", 3);
      const det_ = (f) => (time) => { pacer.t = Math.min(1, time / SECONDS); Math.random = det; try { f(time); } finally { Math.random = realRandom; } };
      transport.scheduleRepeat(det_(voiceStep), "8n");
      transport.scheduleRepeat(det_(harmonyBar), "1m");
      transport.scheduleRepeat(det_(sectorStep), SECT_GRID);
      if (FEATURE) {
        const R = ensureRhythm({ id: "r", mode: MODE });
        const want = MODE === "grains" ? 1 : 4;
        for (let i = 0; i < 400 && R.ready < want; i++) await new Promise((r) => setTimeout0(r, 25));
        if (R.ready < want) throw new Error("rhythm buffers did not load: " + R.ready);
        R.gain.gain.value = 0.6 * (rhythmOf(FEATURE).gain);
        HIT_SLOTS.forEach((slot, k) => {
          const pl = R.players[slot]; if (!pl) return;
          const f = pl.start.bind(pl);
          pl.start = function (t) { NOTES.push([10 + k, pl.playbackRate, pl.volume.value, t, 0]); return f(t); };
        });
        if (MODE === "grains") {
          const f = Tone.ToneBufferSource.prototype.start;
          /* offline, Tone runs every timer before any audio renders, so fireGrains' onended dispose
             would disconnect each grain before it sounds; live it runs after playback */
          Tone.ToneBufferSource.prototype.dispose = function () { return this; };
          Tone.ToneBufferSource.prototype.start = function (at, off, dur) { NOTES.push([20, this.playbackRate.value, off, at, 0]); return f.call(this, at, off, dur); };
        }
      }
      transport.scheduleRepeat(det_(rhythmStep), SECT_GRID);
      transport.scheduleRepeat(det_(thirdStep), SECT_GRID);
      for (let t = 5.1; t < SECONDS; t += 20) {
        const icon = Math.floor(t / 20) % 2 ? "water" : "flower";
        transport.schedule(det_(() => pacer.patch.zones.on && zoneFire({ id: "z", icon, has_audio: false, has_hits: false, mode: "soundscape" })), t);
      }
      transport.start(0);
    }
    const buf = await ctx.render();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const pcm = new Int16Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))); pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))); }
    let s = ""; const u8 = new Uint8Array(pcm.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    window.__pcm = btoa(s);
    window.__notes = JSON.stringify(NOTES);
    window.__draws = di;
    out.textContent = "done";
  } catch (e) { out.textContent = "error " + e.stack; }
})();
</script>`;
const pagePath = resolve(dirname(tone), "ref.html");
writeFileSync(pagePath, page);

const dir = mkdtempSync(join(tmpdir(), "fs-ref-"));
const ch = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new", "--remote-debugging-port=9233", "--allow-file-access-from-files", "--user-data-dir=" + dir, "about:blank"]);
try {
  let t; for (let i = 0; i < 50 && !t; i++) { try { t = (await targets(9233))[0]; } catch { await new Promise(r => setTimeout(r, 200)); } }
  const s = session(t); await s.ready;
  s.on((m) => { if (m.method === "Runtime.exceptionThrown") console.log("exception:", JSON.stringify(m.params.exceptionDetails).slice(0, 600)); if (m.method === "Runtime.consoleAPICalled") console.log("console:", m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 400)); });
  await s.send("Runtime.enable");
  await s.send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
  let status = "";
  for (let i = 0; i < (+process.env.POLLS || 1500); i++) {
    const r = await s.send("Runtime.evaluate", { expression: "document.getElementById('out')?.textContent" });
    status = r.result.value;
    if (status && status !== "running") break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (status !== "done") throw new Error("page: " + status);
  const get = async (e) => (await s.send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
  const pcm = Buffer.from(await get("window.__pcm"), "base64");
  const notes = JSON.parse(await get("window.__notes"));
  console.log("draws used", await get("window.__draws"), "notes", notes.length);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(48000, 24); head.writeUInt32LE(48000 * 4, 28);
  head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  writeFileSync(prefix + ".web.wav", Buffer.concat([head, pcm]));
  writeFileSync(prefix + ".notes.txt", notes.map(n => n.map(x => typeof x === "number" ? x.toPrecision(12) : x).join(" ")).join("\n") + "\n");
  s.close();
} finally { process.kill(ch.pid); await new Promise(r => setTimeout(r, 500)); try { rmSync(dir, { recursive: true, force: true }); } catch {} }
