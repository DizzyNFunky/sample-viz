/**
 * Frequency-domain view. The image is rasterised in wasm at CSS resolution
 * (showing the audio *with* the pending mask applied); selection, rect,
 * brush cursor and axis labels go on a crisp overlay canvas.
 */
import { Editor, TfRect } from "../editor";
import { SpecView } from "../dsp";
import { clamp, fitCanvas, formatHz } from "../util";
import { attachPointer, attachWheel, TimeSelect } from "./interaction";

const LOG_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

export class SpectrogramView {
  private img: CanvasRenderingContext2D;
  private ovl: CanvasRenderingContext2D;
  private sel: TimeSelect;
  private renderKey = "";
  private size = { w: 1, h: 1 };
  private hover: { x: number; y: number } | null = null;
  private stroke: { x: number; y: number } | null = null;
  private rectDrag: { s: number; f: number } | null = null;

  constructor(private imgCanvas: HTMLCanvasElement, private ovlCanvas: HTMLCanvasElement, private ed: Editor) {
    this.img = imgCanvas.getContext("2d")!;
    this.ovl = ovlCanvas.getContext("2d")!;
    this.sel = new TimeSelect(ed);
    attachWheel(ovlCanvas, ed, (e) => {
      // Alt+wheel resizes the brush
      if (e.altKey && ed.tool === "brush") {
        e.preventDefault();
        ed.brush.size = clamp(Math.round(ed.brush.size * Math.exp(-e.deltaY * 0.002)), 2, 400);
        ed.changed();
        return true;
      }
      return false;
    });
    attachPointer(ovlCanvas, {
      down: (x, y, e) => this.down(x, y, e),
      move: (x, y) => this.move(x, y),
      up: (x, y) => this.up(x, y),
      hover: (x, y) => {
        this.hover = { x, y };
        if (ed.doc) ed.hover = { sample: ed.xToSample(x), freq: this.yToFreq(y), level: this.levelAt(x, y) };
        ed.changed();
      },
      leave: () => {
        this.hover = null;
        ed.hover = null;
        ed.changed();
      },
    });
  }

  private view(): SpecView {
    return this.ed.specView(this.size.w, this.size.h);
  }

  yToFreq(y: number) {
    const v = this.view();
    const u = 1 - y / v.height;
    return v.log ? v.fmin * Math.pow(v.fmax / v.fmin, u) : v.fmin + u * (v.fmax - v.fmin);
  }

  freqToY(f: number) {
    const v = this.view();
    const u = v.log ? Math.log(Math.max(f, 1e-3) / v.fmin) / Math.log(v.fmax / v.fmin) : (f - v.fmin) / (v.fmax - v.fmin);
    return (1 - u) * v.height;
  }

  /** Level (dB, with pending mask) of the analysis cell under a point. */
  levelAt(x: number, y: number): number | null {
    const a = this.ed.getAnalysis();
    if (!a) return null;
    const v = this.view();
    const t = Math.round(v.frame0 + (x / v.width) * (v.frame1 - v.frame0));
    const k = Math.round(this.yToFreq(y) / (v.sampleRate / v.nfft));
    if (t < 0 || t >= a.frames || k < 0 || k >= a.bins) return null;
    const i = t * a.bins + k;
    return a.db.view[i] + (this.ed.mask ? this.ed.mask.view[i] : 0);
  }

  // ------------------------------------------------------------ interaction

  private down(x: number, y: number, e: PointerEvent): boolean {
    const ed = this.ed;
    if (!ed.doc) return false;
    switch (ed.tool) {
      case "brush":
        if (!ed.beginMaskEdit("Brush stroke")) return false;
        this.stroke = { x, y };
        ed.brushStamp(this.view(), x, y);
        ed.changed();
        return true;
      case "rect":
        this.rectDrag = { s: ed.xToSample(x), f: this.yToFreq(y) };
        ed.rect = null;
        ed.changed();
        return true;
      default:
        this.sel.down(x, e.shiftKey);
        return true;
    }
  }

  private move(x: number, y: number) {
    const ed = this.ed;
    if (ed.tool === "brush" && this.stroke) {
      // stamp along the segment so fast strokes stay continuous
      const v = this.view();
      const { x: x0, y: y0 } = this.stroke;
      const dist = Math.hypot(x - x0, y - y0);
      const spacing = Math.max(1, ed.brush.size * 0.15);
      const steps = Math.floor(dist / spacing);
      for (let i = 1; i <= steps; i++) {
        const u = (i * spacing) / dist;
        ed.brushStamp(v, x0 + (x - x0) * u, y0 + (y - y0) * u);
      }
      if (steps > 0) {
        const u = (steps * spacing) / dist;
        this.stroke = { x: x0 + (x - x0) * u, y: y0 + (y - y0) * u };
        ed.changed();
      }
    } else if (ed.tool === "rect" && this.rectDrag) {
      ed.rect = this.normRect(this.rectDrag.s, ed.xToSample(x), this.rectDrag.f, this.yToFreq(clamp(y, 0, this.size.h)));
      ed.changed();
    } else if (ed.tool !== "rect") {
      this.sel.move(x);
    }
  }

  private up(x: number, y: number) {
    const ed = this.ed;
    if (ed.tool === "brush") {
      this.stroke = null;
    } else if (ed.tool === "rect" && this.rectDrag) {
      const r = this.normRect(this.rectDrag.s, ed.xToSample(x), this.rectDrag.f, this.yToFreq(clamp(y, 0, this.size.h)));
      const wpx = Math.abs(ed.sampleToX(r.s1) - ed.sampleToX(r.s0));
      const hpx = Math.abs(this.freqToY(r.f0) - this.freqToY(r.f1));
      ed.rect = wpx < 3 || hpx < 3 ? null : r;
      this.rectDrag = null;
      ed.changed();
    } else if (ed.tool !== "rect") {
      this.sel.up(x);
    }
  }

  private normRect(sa: number, sb: number, fa: number, fb: number): TfRect {
    const len = this.ed.length;
    const nyq = this.ed.sampleRate / 2;
    return {
      s0: clamp(Math.min(sa, sb), 0, len),
      s1: clamp(Math.max(sa, sb), 0, len),
      f0: clamp(Math.min(fa, fb), 0, nyq),
      f1: clamp(Math.max(fa, fb), 0, nyq),
    };
  }

  // ------------------------------------------------------------ drawing

  draw() {
    const ed = this.ed;
    const { w, h } = fitCanvas(this.imgCanvas, 1);
    this.size = { w, h };
    const { scale } = fitCanvas(this.ovlCanvas);
    const a = ed.getAnalysis();

    if (!a) {
      this.img.fillStyle = "#0a0a0e";
      this.img.fillRect(0, 0, w, h);
      this.renderKey = "";
    } else {
      const v = this.view();
      const s = ed.spec;
      const key = [a.version, a.nfft, ed.maskVersion, v.frame0, v.frame1, w, h, s.log, s.floorDb, s.ceilDb, s.tint].join(":");
      if (key !== this.renderKey) {
        const img = ed.dsp.renderSpectrogram(a.db, ed.mask, a.frames, a.bins, v, s.floorDb, s.ceilDb, s.tint);
        this.img.putImageData(img, 0, 0);
        this.renderKey = key;
      }
    }

    const g = this.ovl;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!ed.doc) return;

    this.drawFreqAxis(g, w);

    const sel = ed.selection;
    if (sel) {
      const x0 = ed.sampleToX(sel.start);
      const x1 = ed.sampleToX(sel.end);
      g.fillStyle = "rgba(122, 162, 255, 0.12)";
      g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = "rgba(122, 162, 255, 0.7)";
      g.fillRect(Math.round(x0), 0, 1, h);
      g.fillRect(Math.round(x1), 0, 1, h);
    }

    if (ed.rect) {
      const r = ed.rect;
      const x0 = ed.sampleToX(r.s0);
      const x1 = ed.sampleToX(r.s1);
      const y0 = this.freqToY(r.f1);
      const y1 = this.freqToY(r.f0);
      g.fillStyle = "rgba(255, 255, 255, 0.08)";
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = "#ffffff";
      g.setLineDash([5, 4]);
      g.lineWidth = 1;
      g.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
      g.setLineDash([]);
      g.font = "10px ui-monospace, Menlo, monospace";
      g.fillStyle = "rgba(0,0,0,0.65)";
      const label = `${formatHz(r.f0)} – ${formatHz(r.f1)}`;
      const tw = g.measureText(label).width;
      g.fillRect(x0, y0 - 16 < 0 ? y1 + 2 : y0 - 16, tw + 8, 14);
      g.fillStyle = "#fff";
      g.fillText(label, x0 + 4, (y0 - 16 < 0 ? y1 + 2 : y0 - 16) + 10);
    }

    g.fillStyle = "rgba(255,255,255,0.55)";
    g.fillRect(Math.round(ed.sampleToX(ed.cursor)), 0, 1, h);
    if (ed.playhead !== null) {
      g.fillStyle = "#ffd166";
      g.fillRect(Math.round(ed.sampleToX(ed.playhead)), 0, 1.5, h);
    }

    if (ed.tool === "brush" && this.hover) {
      const { x, y } = this.hover;
      const r = ed.brush.size / 2;
      g.lineWidth = 1.5;
      g.strokeStyle = "rgba(0,0,0,0.6)";
      g.beginPath();
      g.arc(x, y, r + 1, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = ed.brush.mode === "cut" ? "#6cd0ff" : ed.brush.mode === "boost" ? "#8dff8d" : "#ffffff";
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
      if (ed.brush.hardness > 0.02) {
        g.setLineDash([2, 3]);
        g.beginPath();
        g.arc(x, y, r * ed.brush.hardness, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
      }
    } else if (ed.tool === "rect" && this.hover) {
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.beginPath();
      g.moveTo(0, Math.round(this.hover.y) + 0.5);
      g.lineTo(w, Math.round(this.hover.y) + 0.5);
      g.stroke();
    }
  }

  private drawFreqAxis(g: CanvasRenderingContext2D, w: number) {
    const v = this.view();
    const ticks: number[] = [];
    if (v.log) ticks.push(...LOG_TICKS.filter((f) => f > v.fmin && f < v.fmax));
    else {
      const step = v.fmax > 30000 ? 5000 : v.fmax > 12000 ? 2000 : 1000;
      for (let f = step; f < v.fmax; f += step) ticks.push(f);
    }
    g.font = "10px ui-monospace, Menlo, monospace";
    for (const f of ticks) {
      const y = Math.round(this.freqToY(f)) + 0.5;
      g.strokeStyle = "rgba(255,255,255,0.08)";
      g.beginPath();
      g.moveTo(34, y);
      g.lineTo(w, y);
      g.stroke();
      g.fillStyle = "rgba(220,224,240,0.75)";
      g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 4, y + 3);
    }
  }
}
