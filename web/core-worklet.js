/* The Fieldscape core in an AudioWorklet. The main thread fetches core.wasm and passes its bytes
   in processorOptions: { wasm, device, params: [[index, value], ...] }. Params can also arrive
   later on the port as [index, value]. Same C interface as iOS and Android (core/fieldscape.h). */
class FieldscapeCore extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    const inst = new WebAssembly.Instance(new WebAssembly.Module(o.wasm), {
      /* standalone wasm may import WASI stubs; the core never does I/O, so they are no-ops */
      wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 })
    });
    const x = this.x = inst.exports;
    if (x._initialize) { x._initialize(); }
    /* No TextEncoder in AudioWorkletGlobalScope; device ids are ASCII. */
    const name = Uint8Array.from(o.device + "\0", (ch) => ch.charCodeAt(0));
    const p = x.malloc(name.length);
    new Uint8Array(x.memory.buffer, p, name.length).set(name);
    this.dev = x.fs_create(p);
    x.free(p);
    x.fs_prepare(this.dev, sampleRate, 128);
    for (const [i, v] of o.params || []) { x.fs_set_param(this.dev, i, v); }
    this.port.onmessage = (e) => x.fs_set_param(this.dev, e.data[0], e.data[1]);
  }
  process(inputs, outputs) {
    const x = this.x, out = outputs[0], inp = inputs[0], n = out[0].length;
    for (let c = 0; c < 2; c++) {
      if (inp[c]) { new Float32Array(x.memory.buffer, x.fs_in(this.dev, c), n).set(inp[c]); }
    }
    x.fs_process(this.dev, n);
    for (let c = 0; c < out.length; c++) {
      out[c].set(new Float32Array(x.memory.buffer, x.fs_out(this.dev, Math.min(c, 1)), n));
    }
    return true;
  }
}
registerProcessor("fieldscape-core", FieldscapeCore);
