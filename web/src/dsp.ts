/**
 * TypeScript wrapper around the Rust/wasm DSP core (dsp/src/lib.rs).
 *
 * Large, long-lived buffers (spectrogram dB grid, spectral mask) live in wasm
 * memory as `WasmF32` so they can be edited/rendered without copying. Audio
 * channels stay in JS and are copied in/out per operation.
 */
import wasmUrl from "./dsp/dsp.wasm?url";

interface Exports {
  memory: WebAssembly.Memory;
  sv_alloc(bytes: number): number;
  sv_free(ptr: number, bytes: number): void;
  sv_stft_frames(len: number, hop: number): number;
  sv_stft_db(input: number, len: number, nfft: number, hop: number, out: number): void;
  sv_spectral_gain(input: number, len: number, nfft: number, hop: number, mask: number, out: number): void;
  sv_render_spectrogram(
    db: number, mask: number, frames: number, bins: number, view: number,
    floorDb: number, ceilDb: number, tint: number, out: number,
  ): void;
  sv_mask_brush(
    mask: number, frames: number, bins: number, view: number,
    cx: number, cy: number, r: number, targetDb: number, strength: number, hardness: number,
  ): void;
  sv_mask_rect(
    mask: number, frames: number, bins: number, t0: number, t1: number, k0: number, k1: number,
    gainDb: number, featherT: number, featherK: number, invert: number,
  ): void;
  sv_gain(buf: number, len: number, db: number): void;
  sv_fade(buf: number, len: number, fadeIn: number, shape: number): void;
  sv_reverse(buf: number, len: number): void;
  sv_peak_abs(buf: number, len: number): number;
  sv_remove_dc(buf: number, len: number): void;
  sv_envelope(buf: number, len: number, offset: number, points: number, npoints: number): void;
  sv_fx_create(id: number, sampleRate: number): number;
  sv_fx_destroy(handle: number): void;
  sv_fx_set_param(handle: number, index: number, value: number): void;
  sv_fx_reset(handle: number): void;
  sv_fx_process(handle: number, planar: number, channels: number, frames: number): void;
}

/** Mapping between screen pixels and the spectrogram grid (mirrors dsp/src/view.rs). */
export interface SpecView {
  frame0: number;
  frame1: number;
  width: number;
  height: number;
  fmin: number;
  fmax: number;
  log: boolean;
  sampleRate: number;
  nfft: number;
}

export enum FadeShape {
  Linear = 0,
  EqualPower = 1,
  Exponential = 2,
  SCurve = 3,
}

/** A Float32Array owned by wasm linear memory. Call `free()` when done. */
export class WasmF32 {
  constructor(private dsp: Dsp, readonly ptr: number, readonly length: number) {}
  /** Fresh view each time: memory growth detaches old views. */
  get view(): Float32Array {
    return new Float32Array(this.dsp.memory.buffer, this.ptr, this.length);
  }
  free() {
    this.dsp.free(this.ptr, this.length * 4);
  }
}

type Alloc = [ptr: number, bytes: number];

export class Dsp {
  private constructor(private ex: Exports) {}

  static async load(): Promise<Dsp> {
    const res = await fetch(wasmUrl);
    const { instance } = await WebAssembly.instantiateStreaming(res, {});
    return new Dsp(instance.exports as unknown as Exports);
  }

  get memory() {
    return this.ex.memory;
  }

  free(ptr: number, bytes: number) {
    this.ex.sv_free(ptr, bytes);
  }

  allocF32(length: number, init?: Float32Array): WasmF32 {
    const ptr = this.ex.sv_alloc(length * 4);
    const a = new WasmF32(this, ptr, length);
    if (init) a.view.set(init);
    else a.view.fill(0);
    return a;
  }

  /** Run `fn` with scratch allocations that are freed afterwards. */
  private scoped<T>(fn: (s: Scratch) => T): T {
    const allocs: Alloc[] = [];
    const ex = this.ex;
    const s: Scratch = {
      f32(src) {
        const len = typeof src === "number" ? src : src.length;
        const ptr = ex.sv_alloc(len * 4);
        allocs.push([ptr, len * 4]);
        if (typeof src !== "number") new Float32Array(ex.memory.buffer, ptr, len).set(src);
        return ptr;
      },
      f64(src) {
        const ptr = ex.sv_alloc(src.length * 8);
        allocs.push([ptr, src.length * 8]);
        new Float64Array(ex.memory.buffer, ptr, src.length).set(src);
        return ptr;
      },
      bytes(len) {
        const ptr = ex.sv_alloc(len);
        allocs.push([ptr, len]);
        return ptr;
      },
      readF32: (ptr, len, into) => {
        const v = new Float32Array(ex.memory.buffer, ptr, len);
        if (into) {
          into.set(v);
          return into;
        }
        return v.slice();
      },
    };
    try {
      return fn(s);
    } finally {
      for (const [p, b] of allocs) ex.sv_free(p, b);
    }
  }

  private viewPtr(s: Scratch, v: SpecView): number {
    return s.f64([v.frame0, v.frame1, v.width, v.height, v.fmin, v.fmax, v.log ? 1 : 0, v.sampleRate, v.nfft]);
  }

  // ------------------------------------------------------------ spectral

  stftFrames(len: number, hop: number): number {
    return this.ex.sv_stft_frames(len, hop);
  }

  /** Magnitude spectrogram (dBFS), frame-major `frames * (nfft/2+1)`. */
  stftDb(samples: Float32Array, nfft: number, hop: number): { db: WasmF32; frames: number; bins: number } {
    const frames = this.stftFrames(samples.length, hop);
    const bins = nfft / 2 + 1;
    const db = this.allocF32(frames * bins);
    this.scoped((s) => {
      const inp = s.f32(samples);
      this.ex.sv_stft_db(inp, samples.length, nfft, hop, db.ptr);
    });
    return { db, frames, bins };
  }

  /** Apply a dB mask in the STFT domain and resynthesise (phase preserved). */
  spectralGain(samples: Float32Array, nfft: number, hop: number, mask: WasmF32): Float32Array {
    return this.scoped((s) => {
      const inp = s.f32(samples);
      const out = s.f32(samples.length);
      this.ex.sv_spectral_gain(inp, samples.length, nfft, hop, mask.ptr, out);
      return s.readF32(out, samples.length);
    });
  }

  renderSpectrogram(
    db: WasmF32, mask: WasmF32 | null, frames: number, bins: number,
    view: SpecView, floorDb: number, ceilDb: number, tint: boolean,
  ): ImageData {
    const w = view.width | 0;
    const h = view.height | 0;
    return this.scoped((s) => {
      const out = s.bytes(w * h * 4);
      this.ex.sv_render_spectrogram(
        db.ptr, mask ? mask.ptr : 0, frames, bins, this.viewPtr(s, view), floorDb, ceilDb, tint ? 1 : 0, out,
      );
      const px = new Uint8ClampedArray(this.memory.buffer, out, w * h * 4).slice();
      return new ImageData(px, w, h);
    });
  }

  maskBrush(
    mask: WasmF32, frames: number, bins: number, view: SpecView,
    cx: number, cy: number, radius: number, targetDb: number, strength: number, hardness: number,
  ) {
    this.scoped((s) => {
      this.ex.sv_mask_brush(mask.ptr, frames, bins, this.viewPtr(s, view), cx, cy, radius, targetDb, strength, hardness);
    });
  }

  maskRect(
    mask: WasmF32, frames: number, bins: number,
    t0: number, t1: number, k0: number, k1: number,
    gainDb: number, featherT: number, featherK: number, invert: boolean,
  ) {
    this.ex.sv_mask_rect(mask.ptr, frames, bins, t0, t1, k0, k1, gainDb, featherT, featherK, invert ? 1 : 0);
  }

  // ------------------------------------------------------------ time domain (in place)

  private inPlace(buf: Float32Array, fn: (ptr: number) => void) {
    this.scoped((s) => {
      const p = s.f32(buf);
      fn(p);
      s.readF32(p, buf.length, buf);
    });
  }

  gain(buf: Float32Array, db: number) {
    this.inPlace(buf, (p) => this.ex.sv_gain(p, buf.length, db));
  }

  fade(buf: Float32Array, fadeIn: boolean, shape: FadeShape) {
    this.inPlace(buf, (p) => this.ex.sv_fade(p, buf.length, fadeIn ? 1 : 0, shape));
  }

  reverse(buf: Float32Array) {
    this.inPlace(buf, (p) => this.ex.sv_reverse(p, buf.length));
  }

  removeDc(buf: Float32Array) {
    this.inPlace(buf, (p) => this.ex.sv_remove_dc(p, buf.length));
  }

  peakAbs(buf: Float32Array): number {
    return this.scoped((s) => this.ex.sv_peak_abs(s.f32(buf), buf.length));
  }

  /** `points`: sorted [time (samples, absolute), dB] pairs; `offset` = absolute position of buf[0]. */
  envelope(buf: Float32Array, offset: number, points: [number, number][]) {
    if (!points.length) return;
    this.scoped((s) => {
      const p = s.f32(buf);
      const pts = s.f64(points.flat());
      this.ex.sv_envelope(p, buf.length, offset, pts, points.length);
      s.readF32(p, buf.length, buf);
    });
  }

  // ------------------------------------------------------------ effects

  /** Run effect `id` over planar channels in place. Returns false if the id is unknown. */
  runEffect(id: number, sampleRate: number, params: number[], channels: Float32Array[]): boolean {
    const h = this.ex.sv_fx_create(id, sampleRate);
    if (!h) return false;
    try {
      params.forEach((v, i) => this.ex.sv_fx_set_param(h, i, v));
      this.ex.sv_fx_reset(h);
      const frames = channels[0]?.length ?? 0;
      const block = 65536;
      this.scoped((s) => {
        const ptr = s.f32(channels.length * block);
        for (let off = 0; off < frames; off += block) {
          const n = Math.min(block, frames - off);
          const mem = new Float32Array(this.memory.buffer, ptr, channels.length * n);
          channels.forEach((c, i) => mem.set(c.subarray(off, off + n), i * n));
          this.ex.sv_fx_process(h, ptr, channels.length, n);
          const out = new Float32Array(this.memory.buffer, ptr, channels.length * n);
          channels.forEach((c, i) => c.set(out.subarray(i * n, (i + 1) * n), off));
        }
      });
      return true;
    } finally {
      this.ex.sv_fx_destroy(h);
    }
  }
}

interface Scratch {
  f32(src: Float32Array | number): number;
  f64(src: number[]): number;
  bytes(len: number): number;
  readF32(ptr: number, len: number, into?: Float32Array): Float32Array;
}
