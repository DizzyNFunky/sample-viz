/**
 * Time-domain view: ruler, per-channel waveform, selection, playhead, and the
 * envelope + pencil tools.
 */
import { Editor, ENV_MAX_DB, ENV_MIN_DB, EnvPoint, SILENT_DB } from "../editor";
import { clamp, fitCanvas, formatTime, niceStep } from "../util";
import { attachPointer, attachWheel, TimeSelect } from "./interaction";

export const RULER_H = 22;
const POINT_R = 5;

const C = {
  bg: "#101118",
  lane: "#14161f",
  grid: "#232633",
  center: "#2b2f3f",
  wave: "#5fd3c3",
  waveDim: "rgba(95, 211, 195, 0.25)",
  sel: "rgba(122, 162, 255, 0.18)",
  selEdge: "rgba(122, 162, 255, 0.7)",
  cursor: "rgba(255, 255, 255, 0.55)",
  playhead: "#ffd166",
  ruler: "#0c0d13",
  rulerText: "#8a90a6",
  env: "#ff9f5a",
};

export class WaveformView {
  private ctx: CanvasRenderingContext2D;
  private sel: TimeSelect;
  private dragPoint: EnvPoint | null = null;
  private pencilLast: { ch: number; s: number } | null = null;
  private hoverX: number | null = null;
  private size = { w: 1, h: 1 };

  constructor(private canvas: HTMLCanvasElement, private ed: Editor) {
    this.ctx = canvas.getContext("2d")!;
    this.sel = new TimeSelect(ed);
    attachWheel(canvas, ed);
    attachPointer(canvas, {
      down: (x, y, e) => this.down(x, y, e),
      move: (x, y, e) => this.move(x, y, e),
      up: (x, y) => this.up(x, y),
      hover: (x) => {
        this.hoverX = x;
        if (ed.doc) ed.hover = { sample: ed.xToSample(x), freq: null };
        ed.changed();
      },
      leave: () => {
        this.hoverX = null;
        ed.hover = null;
        ed.changed();
      },
    }, ed);
    canvas.addEventListener("dblclick", (e) => {
      if (this.ed.tool !== "envelope") return;
      const r = canvas.getBoundingClientRect();
      const p = this.hitPoint(e.clientX - r.left, e.clientY - r.top);
      if (p) this.removePoint(p);
    });
    canvas.addEventListener("contextmenu", (e) => {
      if (this.ed.tool !== "envelope") return;
      const r = canvas.getBoundingClientRect();
      const p = this.hitPoint(e.clientX - r.left, e.clientY - r.top);
      if (p) {
        e.preventDefault();
        this.removePoint(p);
      }
    });
  }

  // ------------------------------------------------------------ geometry

  private get top() {
    return RULER_H;
  }

  private laneRect(ch: number) {
    const n = this.ed.doc?.channels.length ?? 1;
    const h = (this.size.h - this.top) / n;
    return { y: this.top + ch * h, h };
  }

  private laneAt(y: number) {
    const n = this.ed.doc?.channels.length ?? 1;
    return clamp(Math.floor(((y - this.top) / (this.size.h - this.top)) * n), 0, n - 1);
  }

  private envY(db: number) {
    const h = this.size.h - this.top - 8;
    const d = clamp(db, ENV_MIN_DB, ENV_MAX_DB);
    return this.top + 4 + ((ENV_MAX_DB - d) / (ENV_MAX_DB - ENV_MIN_DB)) * h;
  }

  private envDb(y: number) {
    const h = this.size.h - this.top - 8;
    const db = ENV_MAX_DB - ((y - this.top - 4) / h) * (ENV_MAX_DB - ENV_MIN_DB);
    if (db <= ENV_MIN_DB + 0.5) return SILENT_DB;
    return Math.round(clamp(db, ENV_MIN_DB, ENV_MAX_DB) * 10) / 10;
  }

  private hitPoint(x: number, y: number): EnvPoint | null {
    for (const p of this.ed.envelope ?? []) {
      const px = this.ed.sampleToX(p.t);
      const py = this.envY(p.db);
      if (Math.hypot(px - x, py - y) <= POINT_R + 3) return p;
    }
    return null;
  }

  private removePoint(p: EnvPoint) {
    this.ed.checkpoint("Remove envelope point");
    const rest = (this.ed.envelope ?? []).filter((q) => q !== p);
    this.ed.setEnvelope(rest.length ? rest : null);
  }

  // ------------------------------------------------------------ interaction

  private down(x: number, y: number, e: PointerEvent): boolean {
    const ed = this.ed;
    if (!ed.doc) return false;
    if (y < this.top) {
      // ruler: place cursor / seek
      ed.cursor = Math.round(clamp(ed.xToSample(x), 0, ed.length));
      ed.changed();
      return false;
    }
    switch (ed.tool) {
      case "envelope": {
        let p = this.hitPoint(x, y);
        ed.checkpoint(p ? "Move envelope point" : "Add envelope point");
        if (!p) {
          const t = clamp(Math.round(ed.xToSample(x)), 0, ed.length);
          // first point: start from a flat line at the clicked level
          p = { t, db: this.envDb(y) };
          const pts = ed.envelope ? [...ed.envelope, p] : [p];
          ed.setEnvelope(pts); // keeps object identity, so `p` stays draggable
        }
        this.dragPoint = p;
        return true;
      }
      case "pencil": {
        if (ed.view.spp > 4) return false;
        ed.beginPencil();
        const ch = this.laneAt(y);
        this.pencilLast = { ch, s: Math.round(ed.xToSample(x)) };
        this.pencilTo(x, y);
        return true;
      }
      default:
        this.sel.down(x, e.shiftKey);
        return true;
    }
  }

  private move(x: number, y: number, _e: PointerEvent) {
    const ed = this.ed;
    switch (ed.tool) {
      case "envelope": {
        const p = this.dragPoint;
        if (!p || !ed.envelope) return;
        p.t = clamp(Math.round(ed.xToSample(x)), 0, ed.length);
        p.db = this.envDb(y);
        ed.setEnvelope(ed.envelope);
        return;
      }
      case "pencil":
        if (this.pencilLast) this.pencilTo(x, y);
        return;
      default:
        this.sel.move(x);
    }
  }

  private up(x: number, _y: number) {
    const ed = this.ed;
    if (ed.tool === "envelope") this.dragPoint = null;
    else if (ed.tool === "pencil") {
      if (this.pencilLast) ed.endPencil();
      this.pencilLast = null;
    } else this.sel.up(x);
  }

  private pencilTo(x: number, y: number) {
    const ed = this.ed;
    const last = this.pencilLast!;
    const lane = this.laneRect(last.ch);
    const mid = lane.y + lane.h / 2;
    const v = clamp((mid - y) / (lane.h * 0.45), -1, 1);
    const s = clamp(Math.round(ed.xToSample(x)), 0, ed.length - 1);
    const ch = ed.doc!.channels[last.ch];
    const prevV = ch[clamp(last.s, 0, ed.length - 1)];
    const a = Math.min(last.s, s);
    const b = Math.max(last.s, s);
    for (let i = a; i <= b; i++) {
      const u = b === a ? 1 : (i - last.s) / (s - last.s);
      ch[i] = s === last.s ? v : prevV + (v - prevV) * u;
    }
    this.pencilLast = { ch: last.ch, s };
    ed.changed();
  }

  // ------------------------------------------------------------ drawing

  draw() {
    const { w, h, scale } = fitCanvas(this.canvas);
    this.size = { w, h };
    const g = this.ctx;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, w, h);
    const ed = this.ed;
    const doc = ed.doc;
    if (!doc) return;

    const n = doc.channels.length;
    for (let c = 0; c < n; c++) {
      const lane = this.laneRect(c);
      g.fillStyle = C.lane;
      g.fillRect(0, lane.y, w, lane.h - 1);
      g.fillStyle = C.grid;
      g.fillRect(0, lane.y + lane.h - 1, w, 1);
    }

    // selection
    const sel = ed.selection;
    if (sel) {
      const x0 = ed.sampleToX(sel.start);
      const x1 = ed.sampleToX(sel.end);
      g.fillStyle = C.sel;
      g.fillRect(x0, this.top, x1 - x0, h - this.top);
      g.fillStyle = C.selEdge;
      g.fillRect(Math.round(x0), this.top, 1, h - this.top);
      g.fillRect(Math.round(x1), this.top, 1, h - this.top);
    }

    const env = ed.envelopeActive;
    for (let c = 0; c < n; c++) this.drawChannel(doc.channels[c], this.laneRect(c), w, env);
    if (env || ed.tool === "envelope") this.drawEnvelope(w);

    this.drawRuler(w);

    // cursor & playhead
    const cx = ed.sampleToX(ed.cursor);
    g.fillStyle = C.cursor;
    g.fillRect(Math.round(cx), this.top, 1, h - this.top);
    if (ed.playhead !== null) {
      const px = ed.sampleToX(ed.playhead);
      g.fillStyle = C.playhead;
      g.fillRect(Math.round(px), 0, 1.5, h);
    }

    if (ed.tool === "pencil" && ed.view.spp > 4 && this.hoverX !== null) {
      g.fillStyle = "rgba(0,0,0,0.6)";
      g.fillRect(this.hoverX + 12, this.top + 8, 150, 22);
      g.fillStyle = "#e6e8f0";
      g.font = "12px system-ui, sans-serif";
      g.fillText("Zoom in to draw samples", this.hoverX + 20, this.top + 23);
    }
  }

  private drawChannel(data: Float32Array, lane: { y: number; h: number }, w: number, env: boolean) {
    const ed = this.ed;
    const g = this.ctx;
    const mid = lane.y + lane.h / 2;
    const amp = lane.h * 0.45;
    const { start, spp } = ed.view;
    const len = data.length;

    g.fillStyle = C.center;
    g.fillRect(0, Math.round(mid), w, 1);

    if (spp >= 1) {
      const drawPeaks = (scaled: boolean, color: string) => {
        g.fillStyle = color;
        g.beginPath();
        for (let x = 0; x < w; x++) {
          const a = start + x * spp;
          const b = a + spp;
          if (b <= 0 || a >= len) continue;
          const i0 = Math.max(0, Math.floor(a));
          const i1 = Math.min(len, Math.max(i0 + 1, Math.ceil(b)));
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = i0; i < i1; i++) {
            const v = data[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (scaled) {
            const db = ed.envelopeDbAt((a + b) / 2);
            const k = db <= SILENT_DB ? 0 : Math.pow(10, db / 20);
            lo *= k;
            hi *= k;
          }
          const y0 = mid - clamp(hi, -1.05, 1.05) * amp;
          const y1 = mid - clamp(lo, -1.05, 1.05) * amp;
          g.rect(x, y0, 1, Math.max(1, y1 - y0));
        }
        g.fill();
      };
      if (env) {
        drawPeaks(false, C.waveDim);
        drawPeaks(true, C.wave);
      } else drawPeaks(false, C.wave);
    } else {
      // zoomed in: polyline through samples, dots when there's room
      const i0 = Math.max(0, Math.floor(start) - 1);
      const i1 = Math.min(len, Math.ceil(start + w * spp) + 2);
      g.strokeStyle = C.wave;
      g.lineWidth = 1.25;
      g.beginPath();
      for (let i = i0; i < i1; i++) {
        let v = data[i];
        if (env) {
          const db = ed.envelopeDbAt(i);
          v *= db <= SILENT_DB ? 0 : Math.pow(10, db / 20);
        }
        const x = (i - start) / spp;
        const y = mid - clamp(v, -1.05, 1.05) * amp;
        if (i === i0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      if (1 / spp >= 6) {
        g.fillStyle = C.wave;
        for (let i = i0; i < i1; i++) {
          const x = (i - start) / spp;
          const y = mid - clamp(data[i], -1.05, 1.05) * amp;
          g.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
      }
    }
  }

  private drawEnvelope(w: number) {
    const ed = this.ed;
    const g = this.ctx;
    const pts = ed.envelope ?? [];
    g.save();
    g.strokeStyle = C.env;
    g.lineWidth = 1.5;
    if (!pts.length) {
      g.setLineDash([4, 4]);
      g.globalAlpha = 0.6;
    }
    g.beginPath();
    if (!pts.length) {
      const y = this.envY(0);
      g.moveTo(0, y);
      g.lineTo(w, y);
    } else {
      g.moveTo(0, this.envY(pts[0].db));
      for (const p of pts) g.lineTo(ed.sampleToX(p.t), this.envY(p.db));
      g.lineTo(w, this.envY(pts[pts.length - 1].db));
    }
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = C.env;
    for (const p of pts) {
      g.beginPath();
      g.arc(ed.sampleToX(p.t), this.envY(p.db), POINT_R, 0, Math.PI * 2);
      g.fill();
    }
    // unity label
    g.globalAlpha = 0.7;
    g.font = "10px system-ui, sans-serif";
    g.fillText("0 dB", 4, this.envY(0) - 4);
    g.restore();
  }

  private drawRuler(w: number) {
    const ed = this.ed;
    const g = this.ctx;
    const sr = ed.sampleRate;
    g.fillStyle = C.ruler;
    g.fillRect(0, 0, w, RULER_H);
    const secPerPx = ed.view.spp / sr;
    const step = niceStep(secPerPx, 90);
    const t0 = ed.view.start / sr;
    const t1 = t0 + w * secPerPx;
    const precision = step < 0.001 ? 4 : step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
    g.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = C.rulerText;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round((t - t0) / secPerPx);
      g.fillRect(x, RULER_H - 7, 1, 7);
      g.fillText(formatTime(t, precision), x + 3, 12);
      for (let k = 1; k < 5; k++) {
        const xm = Math.round(x + (k * step) / 5 / secPerPx);
        g.fillRect(xm, RULER_H - 3, 1, 3);
      }
    }
    g.fillStyle = C.grid;
    g.fillRect(0, RULER_H - 1, w, 1);
  }
}
