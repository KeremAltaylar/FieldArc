/* The Fieldscape core in an AudioWorklet. The main thread fetches core.wasm and passes its bytes
   in processorOptions: { wasm, device, params: [[index, value], ...] }. Params can also arrive
   later on the port as [index, value]. Same C interface as iOS and Android (core/fieldscape.h). */
class FieldscapeCore extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    let mem;
    const inst = new WebAssembly.Instance(new WebAssembly.Module(o.wasm), {
      /* views are re-created on every call, so memory growth needs no notice */
      env: new Proxy({}, { get: () => () => 0 }),
      wasi_snapshot_preview1: new Proxy({
        /* the core's timing stats; the audio thread has only Date.now(), so on the web these
           are millisecond-coarse - phone timing comes from the native hosts */
        clock_time_get: (id, prec, ptr) => { new BigInt64Array(mem.buffer, ptr, 1)[0] = BigInt(Date.now()) * 1000000n; return 0; }
      }, { get: (t, k) => t[k] || (() => 0) })
    });
    const x = this.x = inst.exports;
    mem = x.memory;
    if (x._initialize) { x._initialize(); }
    /* No TextEncoder in AudioWorkletGlobalScope; device ids are ASCII. */
    const name = Uint8Array.from(o.device + "\0", (ch) => ch.charCodeAt(0));
    const p = x.malloc(name.length);
    new Uint8Array(x.memory.buffer, p, name.length).set(name);
    this.dev = x.fs_create(p);
    x.free(p);
    x.fs_prepare(this.dev, sampleRate, 128);
    for (const [i, v] of o.params || []) { x.fs_set_param(this.dev, i, v); }
    this.stats = x.malloc(32);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (Array.isArray(m)) { x.fs_set_param(this.dev, m[0], m[1]); }
      else if (m.type === "source") {
        try { this.setSource(m.channels); this.port.postMessage({ type: "source", frames: m.channels[0].length }); }
        catch (err) { this.port.postMessage({ type: "error", where: "source", message: String(err) }); }
      }
      else if (m.type === "stats") {
        x.fs_stats(this.dev, this.stats);
        const v = new DataView(x.memory.buffer, this.stats, 32);
        this.port.postMessage({ type: "stats", late: v.getInt32(0, true), underruns: v.getInt32(4, true),
          maxMs: v.getFloat32(8, true), frames: Number(v.getBigInt64(16, true)), wraps: v.getInt32(24, true) });
      }
    };
  }
  /* Copies the recording into wasm memory once; the device reads it from there (host-owned). */
  setSource(channels) {
    const x = this.x, n = channels[0].length, ptrs = x.malloc(4 * channels.length);
    if (this.src) { x.fs_set_source(this.dev, 0, 0, 0); this.src.forEach((p) => x.free(p)); x.free(this.srcPtrs); }
    this.src = channels.map((c) => { const p = x.malloc(4 * n); new Float32Array(x.memory.buffer, p, n).set(c); return p; });
    new Uint32Array(x.memory.buffer, ptrs, channels.length).set(this.src);
    this.srcPtrs = ptrs;
    x.fs_set_source(this.dev, channels.length, n, ptrs);
  }
  process(inputs, outputs) {
    const x = this.x, out = outputs[0], inp = inputs[0], n = out[0].length;
    for (let c = 0; c < 2; c++) {
      if (inp && inp[c]) { new Float32Array(x.memory.buffer, x.fs_in(this.dev, c), n).set(inp[c]); }
    }
    x.fs_process(this.dev, n);
    for (let c = 0; c < out.length; c++) {
      out[c].set(new Float32Array(x.memory.buffer, x.fs_out(this.dev, Math.min(c, 1)), n));
    }
    return true;
  }
}
registerProcessor("fieldscape-core", FieldscapeCore);
