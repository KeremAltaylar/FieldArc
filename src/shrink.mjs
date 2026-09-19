/* Recordings over the server's per-file limit, shrunk to Opus so they can be published.

   The project's storage accepts nothing over 50 MB (fileSizeLimit 52428800, read from the
   Management API on 2026-09-19), and a Free-plan project cannot raise it. A 400 from storage
   after a minute of uploading was the only sign: one long WAV blocked the whole publish.

   Kerem's decision (2026-09-19): shrink to high-bitrate Opus on publish. The original is not
   touched: it stays in IndexedDB and in every export, and only what listeners download is
   Opus. A file under the limit goes up exactly as it is. */
export const STORAGE_LIMIT = 52428800;

export function needsShrink(bytes) { return bytes > STORAGE_LIMIT; }

/* 128 kbps per channel is the Opus bitrate at which a music encode is generally treated as
   transparent. Stepped down only when a long recording would not fit otherwise, with 5%
   headroom for the container, and refused below 32 kbps per channel rather than published as
   something audibly worse than what was recorded. */
const PER_CHANNEL = 128000, FLOOR_PER_CHANNEL = 32000;

export function opusBitrate(durationS, channels) {
  const ch = Math.min(2, Math.max(1, channels || 1));
  const fits = Math.floor(STORAGE_LIMIT * 0.95 * 8 / Math.max(1, durationS) / 1000) * 1000;
  const b = Math.min(PER_CHANNEL * ch, fits);
  return b >= FLOOR_PER_CHANNEL * ch ? b : null;
}

/* Browser only. Mediabunny encodes through WebCodecs and muxes WebM, the same container the
   app's own MediaRecorder takes already use, so listeners decode it through the same path.
   Loaded on demand: most publishes never need it, and it is 680 KB. */
const MEDIABUNNY = "https://unpkg.com/mediabunny@1.58.0/dist/bundles/mediabunny.min.mjs";
const RATE = 48000;    // Opus runs at 48 kHz; decoding straight to it avoids a second resample

export async function shrinkToOpus(blob, onProgress) {
  const mb = await import(MEDIABUNNY);
  /* Decoded by the browser, so anything this device can play can be shrunk, and the decode
     lands at 48 kHz directly. OfflineAudioContext needs no user gesture. */
  const decoded = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
  const channels = Math.min(2, decoded.numberOfChannels);
  const bitrate = opusBitrate(decoded.duration, channels);
  if (!bitrate) {
    throw new Error("the recording is " + Math.round(decoded.duration / 60) + " min long — too " +
                    "long to fit the server's 50 MB limit even compressed; trim it and attach again");
  }
  if (!(await mb.canEncodeAudio("opus", { numberOfChannels: channels, sampleRate: RATE, bitrate }))) {
    throw new Error("it is over the server's 50 MB limit, and this browser cannot compress it " +
                    "— publish it from desktop Chrome");
  }
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.WebMOutputFormat(), target });
  const source = new mb.AudioBufferSource({ codec: "opus", bitrate });
  output.addAudioTrack(source);
  await output.start();

  /* One second at a time, so the encoder sees a stream rather than one huge buffer. More than
     two channels fold onto two by parity (odd to left, even to right); Opus in WebCodecs is
     only guaranteed stereo. */
  const n = decoded.length, inCh = decoded.numberOfChannels;
  const src = [];
  for (let c = 0; c < inCh; c++) { src.push(decoded.getChannelData(c)); }
  for (let at = 0; at < n; at += RATE) {
    const len = Math.min(RATE, n - at);
    const chunk = new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate: RATE });
    for (let o = 0; o < channels; o++) {
      const out = new Float32Array(len);
      let fed = 0;
      for (let c = o; c < inCh; c += channels) {
        const s = src[c];
        for (let i = 0; i < len; i++) { out[i] += s[at + i]; }
        fed++;
      }
      if (fed > 1) { for (let i = 0; i < len; i++) { out[i] /= fed; } }
      chunk.copyToChannel(out, o);
    }
    await source.add(chunk);
    if (onProgress) { onProgress(Math.min(1, (at + len) / n)); }
  }
  source.close();
  await output.finalize();
  const out = new Blob([target.buffer], { type: "audio/webm" });
  return { blob: out, codec: "opus", bitrate, channels, duration_s: +decoded.duration.toFixed(2),
           bytes: out.size, source_bytes: blob.size };
}
