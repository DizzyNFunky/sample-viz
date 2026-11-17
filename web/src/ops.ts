/**
 * Registry of destructive audio operations.
 *
 * Each op declares its parameters; the Process panel builds its UI from the
 * declarations, and the editor wraps every run in an undo step. Effects plug
 * in the same way: add an entry whose `apply` calls `ctx.dsp.runEffect(...)`
 * with an id registered in dsp/src/effects.rs (see the "utility" op).
 */
import { Dsp, FadeShape } from "./dsp";

export type ParamValue = number | boolean | string;

export type ParamSpec =
  | { id: string; label: string; kind: "number"; default: number; min: number; max: number; step: number; unit?: string }
  | { id: string; label: string; kind: "bool"; default: boolean }
  | { id: string; label: string; kind: "select"; default: string; options: { value: string; label: string }[] };

export interface OpContext {
  dsp: Dsp;
  sampleRate: number;
  /** Working copies of every channel (safe to mutate or replace). */
  channels: Float32Array[];
  /** Target range in samples, [start, end). Whole file when nothing is selected. */
  start: number;
  end: number;
  hasSelection: boolean;
}

export interface OpResult {
  channels?: Float32Array[];
  /** New selection after the op (null clears it, undefined keeps it). */
  selection?: { start: number; end: number } | null;
}

export interface Op {
  id: string;
  label: string;
  group: "Edit" | "Amplitude" | "Effects";
  description?: string;
  params?: ParamSpec[];
  requiresSelection?: boolean;
  apply(ctx: OpContext, params: Record<string, ParamValue>): OpResult | void;
}

const region = (ctx: OpContext, c: Float32Array) => c.subarray(ctx.start, ctx.end);

const fadeShapes = [
  { value: String(FadeShape.Linear), label: "Linear" },
  { value: String(FadeShape.EqualPower), label: "Equal power" },
  { value: String(FadeShape.Exponential), label: "Exponential" },
  { value: String(FadeShape.SCurve), label: "S-curve" },
];

export const OPS: Op[] = [
  {
    id: "gain",
    label: "Gain",
    group: "Amplitude",
    params: [{ id: "db", label: "Gain", kind: "number", default: -3, min: -60, max: 24, step: 0.5, unit: "dB" }],
    apply(ctx, p) {
      for (const c of ctx.channels) ctx.dsp.gain(region(ctx, c), p.db as number);
    },
  },
  {
    id: "normalize",
    label: "Normalize",
    group: "Amplitude",
    params: [{ id: "peak", label: "Peak", kind: "number", default: -1, min: -40, max: 0, step: 0.1, unit: "dBFS" }],
    apply(ctx, p) {
      const peak = Math.max(...ctx.channels.map((c) => ctx.dsp.peakAbs(region(ctx, c))));
      if (peak <= 0) return;
      const db = (p.peak as number) - 20 * Math.log10(peak);
      for (const c of ctx.channels) ctx.dsp.gain(region(ctx, c), db);
    },
  },
  {
    id: "fade-in",
    label: "Fade in",
    group: "Amplitude",
    requiresSelection: true,
    params: [{ id: "shape", label: "Shape", kind: "select", default: String(FadeShape.SCurve), options: fadeShapes }],
    apply(ctx, p) {
      for (const c of ctx.channels) ctx.dsp.fade(region(ctx, c), true, Number(p.shape));
    },
  },
  {
    id: "fade-out",
    label: "Fade out",
    group: "Amplitude",
    requiresSelection: true,
    params: [{ id: "shape", label: "Shape", kind: "select", default: String(FadeShape.SCurve), options: fadeShapes }],
    apply(ctx, p) {
      for (const c of ctx.channels) ctx.dsp.fade(region(ctx, c), false, Number(p.shape));
    },
  },
  {
    id: "silence",
    label: "Silence",
    group: "Amplitude",
    requiresSelection: true,
    apply(ctx) {
      for (const c of ctx.channels) region(ctx, c).fill(0);
    },
  },
  {
    id: "dc",
    label: "Remove DC",
    group: "Amplitude",
    apply(ctx) {
      for (const c of ctx.channels) ctx.dsp.removeDc(region(ctx, c));
    },
  },
  {
    id: "reverse",
    label: "Reverse",
    group: "Edit",
    apply(ctx) {
      for (const c of ctx.channels) ctx.dsp.reverse(region(ctx, c));
    },
  },
  {
    id: "crop",
    label: "Crop to selection",
    group: "Edit",
    requiresSelection: true,
    apply(ctx) {
      return {
        channels: ctx.channels.map((c) => c.slice(ctx.start, ctx.end)),
        selection: null,
      };
    },
  },
  {
    id: "delete",
    label: "Delete selection",
    group: "Edit",
    requiresSelection: true,
    apply(ctx) {
      return {
        channels: ctx.channels.map((c) => {
          const out = new Float32Array(c.length - (ctx.end - ctx.start));
          out.set(c.subarray(0, ctx.start));
          out.set(c.subarray(ctx.end), ctx.start);
          return out;
        }),
        selection: null,
      };
    },
  },
  {
    id: "mono",
    label: "Mix to mono",
    group: "Edit",
    apply(ctx) {
      if (ctx.channels.length < 2) return;
      const len = ctx.channels[0].length;
      const out = new Float32Array(len);
      for (const c of ctx.channels) for (let i = 0; i < len; i++) out[i] += c[i] / ctx.channels.length;
      return { channels: [out] };
    },
  },
  // ---- effects (processed by dsp/src/effects.rs) --------------------------
  {
    id: "utility",
    label: "Utility",
    group: "Effects",
    description: "Reference effect: gain + polarity, run through the wasm effect host.",
    params: [
      { id: "gain", label: "Gain", kind: "number", default: 0, min: -60, max: 24, step: 0.5, unit: "dB" },
      { id: "invert", label: "Invert polarity", kind: "bool", default: false },
    ],
    apply(ctx, p) {
      const views = ctx.channels.map((c) => region(ctx, c));
      ctx.dsp.runEffect(1, ctx.sampleRate, [p.gain as number, p.invert ? 1 : 0], views);
    },
  },
];
