// Exercises the raw wasm FFI exactly as web/src/dsp.ts uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bytes = await readFile(new URL("../web/src/dsp/dsp.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;

function put(arr) {
  const ptr = ex.sv_alloc(arr.length * 4);
  new Float32Array(ex.memory.buffer, ptr, arr.length).set(arr);
  return ptr;
}
const read = (ptr, len) => new Float32Array(ex.memory.buffer, ptr, len).slice();

function noise(n, seed = 1) {
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x / 2 ** 32 - 0.5;
  }
  return out;
}

test("spectral gain with a unity mask reconstructs the input", () => {
  const nfft = 1024, hop = 256, len = 12345;
  const x = noise(len);
  const frames = ex.sv_stft_frames(len, hop);
  const bins = nfft / 2 + 1;
  const mask = new Float32Array(frames * bins).fill(1e-7); // forces the FFT path
  const pIn = put(x), pMask = put(mask), pOut = ex.sv_alloc(len * 4);
  ex.sv_spectral_gain(pIn, len, nfft, hop, pMask, pOut);
  const y = read(pOut, len);
  let err = 0;
  for (let i = 0; i < len; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
  assert.ok(err < 1e-4, `max error ${err}`);
});

test("rect cut removes a tone in its band only", () => {
  const sr = 48000, nfft = 2048, hop = 512, len = sr;
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr) + 0.5 * Math.sin((2 * Math.PI * 5000 * i) / sr);
  const frames = ex.sv_stft_frames(len, hop);
  const bins = nfft / 2 + 1;
  const pMask = put(new Float32Array(frames * bins));
  const binHz = sr / nfft;
  ex.sv_mask_rect(pMask, frames, bins, 0, frames, 4000 / binHz, 6000 / binHz, -120, 0, 0, 0);
  const pIn = put(x), pOut = ex.sv_alloc(len * 4);
  ex.sv_spectral_gain(pIn, len, nfft, hop, pMask, pOut);
  const pDb = ex.sv_alloc(frames * bins * 4);
  ex.sv_stft_db(pOut, len, nfft, hop, pDb);
  const db = read(pDb, frames * bins);
  const mid = Math.floor(frames / 2) * bins;
  assert.ok(db[mid + Math.round(1000 / binHz)] > -10, "1 kHz kept (0.5 amplitude ~ -6 dB)");
  assert.ok(db[mid + Math.round(5000 / binHz)] < -80, "5 kHz removed");
});

test("effect host: utility inverts polarity", () => {
  const h = ex.sv_fx_create(1, 48000);
  assert.ok(h > 0);
  ex.sv_fx_set_param(h, 1, 1);
  ex.sv_fx_reset(h);
  const x = noise(256);
  const p = put(new Float32Array([...x, ...x])); // 2 planar channels
  ex.sv_fx_process(h, p, 2, 256);
  const y = read(p, 512);
  assert.ok(Math.abs(y[10] + x[10]) < 1e-6 && Math.abs(y[266] + x[10]) < 1e-6);
  ex.sv_fx_destroy(h);
  assert.equal(ex.sv_fx_create(999, 48000), 0);
});
