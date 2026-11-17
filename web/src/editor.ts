/**
 * Editor state: the open document, view, selection, tools, pending
 * (non-destructive) spectral mask + gain envelope, and undo history.
 *
 * Audio edits are copy-on-write: a channel array that has been handed to the
 * history is never mutated again, so snapshots can share arrays.
 */
import { Dsp, SpecView, WasmF32 } from "./dsp";
import { OPS, Op, OpContext, ParamValue } from "./ops";
import { SampleFormat } from "./wav";

export type Tool = "select" | "envelope" | "pencil" | "brush" | "rect";
export type BrushMode = "cut" | "boost" | "restore";

export interface Doc {
  name: string;
  /** Storage key when the file came from / was saved to R2. */
  key: string | null;
  sampleRate: number;
  channels: Float32Array[];
  format: SampleFormat;
}

export interface Range {
  start: number;
  end: number;
}

export interface EnvPoint {
  /** Absolute position in samples. */
  t: number;
  db: number;
}

/** Time-frequency rectangle for the rect tool (samples, Hz). */
export interface TfRect {
  s0: number;
  s1: number;
  f0: number;
  f1: number;
}

interface Snapshot {
  label: string;
  channels: Float32Array[];
  mask: Float32Array | null;
  envelope: EnvPoint[] | null;
  selection: Range | null;
}

interface Analysis {
  db: WasmF32;
  frames: number;
  bins: number;
  nfft: number;
  hop: number;
  version: number;
}

export const ENV_MIN_DB = -60;
export const ENV_MAX_DB = 12;
export const SILENT_DB = -120;
const HISTORY_LIMIT = 60;
/** Above this many grid cells, fall back to a larger hop to bound memory. */
const MAX_CELLS = 24_000_000;

export class Editor {
  doc: Doc | null = null;
  /** Bumped on every audio change. */
  version = 0;
  dirty = false;

  view = { start: 0, spp: 1 };
  /** Width of the time-aligned views in CSS px. */
  width = 800;
  selection: Range | null = null;
  cursor = 0;
  playhead: number | null = null;
  hover: { sample: number; freq: number | null; level?: number | null } | null = null;

  tool: Tool = "select";
  spec = { nfft: 2048, log: true, floorDb: -100, ceilDb: 0, tint: true };
  brush = { size: 24, mode: "cut" as BrushMode, depth: 30, strength: 0.35, hardness: 0.3 };
  rectGainDb = 30;
  rect: TfRect | null = null;
  /** A/B: play the unprocessed audio even when edits are pending. */
  bypassPreview = false;

  envelope: EnvPoint[] | null = null;
  envVersion = 0;

  mask: WasmF32 | null = null;
  maskVersion = 0;
  private analysis: Analysis | null = null;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private maskCopy: { version: number; data: Float32Array } | null = null;
  private previewCache: { key: string; channels: Float32Array[] } | null = null;
  private listeners = new Set<() => void>();

  constructor(readonly dsp: Dsp) {}

  // ------------------------------------------------------------ events

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------ document

  get length() {
    return this.doc?.channels[0]?.length ?? 0;
  }

  get sampleRate() {
    return this.doc?.sampleRate ?? 48000;
  }

  load(doc: Doc) {
    this.discardMask();
    this.envelope = null;
    this.rect = null;
    this.doc = doc;
    this.version++;
    this.dirty = false;
    this.selection = null;
    this.cursor = 0;
    this.playhead = null;
    this.undoStack = [];
    this.redoStack = [];
    this.fit();
    this.changed();
  }

  private setChannels(channels: Float32Array[]) {
    if (!this.doc) return;
    this.doc.channels = channels;
    this.version++;
    this.dirty = true;
    this.clampView();
    if (this.selection) {
      const len = this.length;
      const s = Math.min(this.selection.start, len);
      const e = Math.min(this.selection.end, len);
      this.selection = e - s > 0 ? { start: s, end: e } : null;
    }
    this.cursor = Math.min(this.cursor, this.length);
  }

  // ------------------------------------------------------------ history

  private snapshot(label: string): Snapshot {
    return {
      label,
      channels: this.doc!.channels,
      mask: this.maskSnapshot(),
      envelope: this.envelope ? this.envelope.map((p) => ({ ...p })) : null,
      selection: this.selection ? { ...this.selection } : null,
    };
  }

  private maskSnapshot(): Float32Array | null {
    if (!this.mask) return null;
    if (this.maskCopy?.version !== this.maskVersion) {
      this.maskCopy = { version: this.maskVersion, data: this.mask.view.slice() };
    }
    return this.maskCopy.data;
  }

  /** Record the current state as an undo step before changing it. */
  checkpoint(label: string) {
    if (!this.doc) return;
    this.undoStack.push(this.snapshot(label));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoLabel() {
    return this.undoStack.at(-1)?.label ?? null;
  }
  get redoLabel() {
    return this.redoStack.at(-1)?.label ?? null;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot(s.label));
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot(s.label));
    this.restore(s);
  }

  private restore(s: Snapshot) {
    if (!this.doc) return;
    if (s.channels !== this.doc.channels) this.setChannels(s.channels);
    this.envelope = s.envelope ? s.envelope.map((p) => ({ ...p })) : null;
    this.envVersion++;
    this.selection = s.selection ? { ...s.selection } : null;
    if (!s.mask) {
      this.discardMask();
    } else {
      const a = this.getAnalysis();
      if (a && a.frames * a.bins === s.mask.length) {
        this.ensureMask().view.set(s.mask);
        this.maskVersion++;
        this.maskCopy = { version: this.maskVersion, data: s.mask };
      } else {
        this.discardMask();
      }
    }
    this.dirty = true;
    this.changed();
  }

  // ------------------------------------------------------------ view

  xToSample(x: number) {
    return this.view.start + x * this.view.spp;
  }

  sampleToX(s: number) {
    return (s - this.view.start) / this.view.spp;
  }

  private maxSpp() {
    return Math.max(this.length / Math.max(this.width, 1), 1 / 64);
  }

  clampView() {
    const v = this.view;
    v.spp = Math.min(Math.max(v.spp, 1 / 64), this.maxSpp());
    const maxStart = Math.max(0, this.length - this.width * v.spp);
    v.start = Math.min(Math.max(v.start, 0), maxStart);
  }

  fit() {
    this.view.spp = this.maxSpp();
    this.view.start = 0;
    this.clampView();
    this.changed();
  }

  zoom(factor: number, anchorX = this.width / 2) {
    const anchor = this.xToSample(anchorX);
    this.view.spp *= factor;
    this.clampView();
    this.view.start = anchor - anchorX * this.view.spp;
    this.clampView();
    this.changed();
  }

  zoomTo(r: Range) {
    const span = Math.max(r.end - r.start, 16);
    this.view.spp = (span * 1.1) / this.width;
    this.clampView();
    this.view.start = (r.start + r.end) / 2 - (this.width * this.view.spp) / 2;
    this.clampView();
    this.changed();
  }

  scrollBy(px: number) {
    this.view.start += px * this.view.spp;
    this.clampView();
    this.changed();
  }

  /** Keep `sample` on screen (used while following the playhead). */
  reveal(sample: number) {
    const end = this.view.start + this.width * this.view.spp;
    if (sample < this.view.start || sample > end) {
      this.view.start = sample - this.width * this.view.spp * 0.1;
      this.clampView();
    }
  }

  setSelection(r: Range | null) {
    if (r) {
      const start = Math.max(0, Math.min(r.start, r.end));
      const end = Math.min(this.length, Math.max(r.start, r.end));
      this.selection = end - start >= 1 ? { start: Math.round(start), end: Math.round(end) } : null;
    } else this.selection = null;
    this.changed();
  }

  // ------------------------------------------------------------ spectral analysis

  get hop() {
    return this.getAnalysis()?.hop ?? this.spec.nfft / 4;
  }

  private chooseHop(nfft: number): number {
    const bins = nfft / 2 + 1;
    for (const div of [4, 2, 1]) {
      const hop = nfft / div;
      if (this.dsp.stftFrames(this.length, hop) * bins <= MAX_CELLS) return hop;
    }
    return nfft;
  }

  /** Spectrogram of the mono mixdown, recomputed lazily when audio or FFT size changes. */
  getAnalysis(): Analysis | null {
    if (!this.doc || this.length === 0) return null;
    const a = this.analysis;
    if (a && a.version === this.version && a.nfft === this.spec.nfft) return a;
    a?.db.free();
    const nfft = this.spec.nfft;
    const hop = this.chooseHop(nfft);
    const chs = this.doc.channels;
    let mono = chs[0];
    if (chs.length > 1) {
      mono = new Float32Array(this.length);
      for (const c of chs) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / chs.length;
    }
    const { db, frames, bins } = this.dsp.stftDb(mono, nfft, hop);
    this.analysis = { db, frames, bins, nfft, hop, version: this.version };
    if (this.mask && this.mask.length !== frames * bins) this.discardMask();
    return this.analysis;
  }

  specView(width: number, height: number): SpecView {
    const hop = this.hop;
    const sr = this.sampleRate;
    return {
      frame0: this.view.start / hop,
      frame1: (this.view.start + this.width * this.view.spp) / hop,
      width,
      height,
      fmin: this.spec.log ? 20 : 0,
      fmax: sr / 2,
      log: this.spec.log,
      sampleRate: sr,
      nfft: this.spec.nfft,
    };
  }

  setFftSize(nfft: number) {
    if (nfft === this.spec.nfft) return;
    // The mask lives on the analysis grid; bake it in before changing the grid.
    if (this.maskActive) this.applySpectral();
    else this.discardMask();
    this.spec.nfft = nfft;
    this.changed();
  }

  // ------------------------------------------------------------ spectral mask

  get maskActive() {
    return this.mask !== null;
  }

  private ensureMask(): WasmF32 {
    const a = this.getAnalysis()!;
    if (!this.mask) this.mask = this.dsp.allocF32(a.frames * a.bins);
    return this.mask;
  }

  /** Call before a stroke / rect action: records undo and makes sure the mask exists. */
  beginMaskEdit(label: string) {
    if (!this.getAnalysis()) return false;
    this.checkpoint(label);
    this.ensureMask();
    return true;
  }

  brushStamp(view: SpecView, x: number, y: number) {
    const a = this.getAnalysis();
    if (!a || !this.mask) return;
    const b = this.brush;
    const target = b.mode === "cut" ? -b.depth : b.mode === "boost" ? Math.min(b.depth, 24) : 0;
    this.dsp.maskBrush(this.mask, a.frames, a.bins, view, x, y, b.size / 2, target, b.strength, b.hardness);
    this.maskVersion++;
  }

  /** Apply the rect tool's region to the mask. mode: cut/boost the inside, or isolate (cut the outside). */
  rectAction(mode: "cut" | "boost" | "isolate") {
    const a = this.getAnalysis();
    if (!a || !this.rect) return;
    this.beginMaskEdit(mode === "isolate" ? "Isolate region" : mode === "cut" ? "Cut region" : "Boost region");
    const r = this.rect;
    const binHz = this.sampleRate / a.nfft;
    const gain = mode === "boost" ? Math.min(this.rectGainDb, 24) : -this.rectGainDb;
    this.dsp.maskRect(
      this.mask!, a.frames, a.bins,
      r.s0 / a.hop, r.s1 / a.hop, r.f0 / binHz, r.f1 / binHz,
      gain, 1.5, 1.5, mode === "isolate",
    );
    this.maskVersion++;
    this.changed();
  }

  discardMask() {
    this.mask?.free();
    this.mask = null;
    this.maskCopy = null;
    this.maskVersion++;
  }

  /** Bake the pending mask into the audio. */
  applySpectral() {
    const a = this.getAnalysis();
    if (!this.doc || !a || !this.mask) return;
    this.checkpoint("Spectral edit");
    const out = this.doc.channels.map((c) => this.dsp.spectralGain(c, a.nfft, a.hop, this.mask!));
    this.discardMask();
    this.setChannels(out);
    this.changed();
  }

  // ------------------------------------------------------------ envelope

  get envelopeActive() {
    return this.envelope !== null && this.envelope.length > 0;
  }

  setEnvelope(points: EnvPoint[] | null) {
    this.envelope = points ? [...points].sort((p, q) => p.t - q.t) : null;
    this.envVersion++;
    this.changed();
  }

  /** Envelope gain (dB) at a sample position, for drawing. */
  envelopeDbAt(t: number): number {
    const pts = this.envelope;
    if (!pts || !pts.length) return 0;
    if (t <= pts[0].t) return pts[0].db;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const p = pts[i - 1];
        const q = pts[i];
        const u = (t - p.t) / Math.max(q.t - p.t, 1e-9);
        return p.db + (q.db - p.db) * u;
      }
    }
    return pts[pts.length - 1].db;
  }

  applyEnvelope() {
    if (!this.doc || !this.envelopeActive) return;
    this.checkpoint("Envelope");
    const pts = this.envelope!.map((p) => [p.t, p.db] as [number, number]);
    const out = this.doc.channels.map((c) => {
      const copy = c.slice();
      this.dsp.envelope(copy, 0, pts);
      return copy;
    });
    this.envelope = null;
    this.envVersion++;
    this.setChannels(out);
    this.changed();
  }

  // ------------------------------------------------------------ pending edits

  get hasPending() {
    return this.maskActive || this.envelopeActive;
  }

  applyPending() {
    if (this.maskActive) this.applySpectral();
    if (this.envelopeActive) this.applyEnvelope();
  }

  discardPending() {
    if (!this.hasPending) return;
    this.checkpoint("Discard pending edits");
    this.discardMask();
    this.envelope = null;
    this.envVersion++;
    this.changed();
  }

  /** What playback should hear: the document with pending edits rendered in. */
  playbackChannels(): Float32Array[] {
    const doc = this.doc!;
    if (!this.hasPending || this.bypassPreview) return doc.channels;
    const key = `${this.version}:${this.maskVersion}:${this.envVersion}`;
    if (this.previewCache?.key === key) return this.previewCache.channels;
    const a = this.getAnalysis()!;
    let chs = doc.channels;
    if (this.mask) chs = chs.map((c) => this.dsp.spectralGain(c, a.nfft, a.hop, this.mask!));
    if (this.envelopeActive) {
      const pts = this.envelope!.map((p) => [p.t, p.db] as [number, number]);
      const fresh = chs !== doc.channels; // spectral pass already produced new arrays
      chs = chs.map((c) => {
        const copy = fresh ? c : c.slice();
        this.dsp.envelope(copy, 0, pts);
        return copy;
      });
    }
    this.previewCache = { key, channels: chs };
    return chs;
  }

  get playbackKey() {
    const pending = this.hasPending && !this.bypassPreview;
    return pending ? `${this.version}:${this.maskVersion}:${this.envVersion}` : `${this.version}`;
  }

  // ------------------------------------------------------------ pencil

  beginPencil() {
    if (!this.doc) return;
    this.checkpoint("Draw samples");
    // fresh copies so the snapshot stays intact while we draw in place
    this.doc.channels = this.doc.channels.map((c) => c.slice());
  }

  endPencil() {
    this.version++;
    this.dirty = true;
    this.changed();
  }

  // ------------------------------------------------------------ ops

  get ops(): Op[] {
    return OPS;
  }

  runOp(op: Op, params: Record<string, ParamValue>) {
    if (!this.doc) return;
    if (op.requiresSelection && !this.selection) throw new Error(`${op.label} needs a selection`);
    this.applyPending();
    const sel = this.selection;
    const ctx: OpContext = {
      dsp: this.dsp,
      sampleRate: this.doc.sampleRate,
      channels: this.doc.channels.map((c) => c.slice()),
      start: sel ? sel.start : 0,
      end: sel ? sel.end : this.length,
      hasSelection: !!sel,
    };
    this.checkpoint(op.label);
    const res = op.apply(ctx, params) ?? {};
    this.setChannels(res.channels ?? ctx.channels);
    if (res.selection !== undefined) this.selection = res.selection;
    if (res.channels && this.length !== this.undoStack.at(-1)!.channels[0].length) this.fit();
    this.changed();
  }
}
