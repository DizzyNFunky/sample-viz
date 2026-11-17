import { Editor } from "../editor";

/** Shared time-selection drag + wheel zoom/scroll behaviour for time-aligned views. */
export class TimeSelect {
  private anchor = 0;
  private downX = 0;
  private moved = false;

  constructor(private ed: Editor) {}

  down(x: number, shift: boolean) {
    const s = this.ed.xToSample(x);
    this.downX = x;
    this.moved = false;
    const sel = this.ed.selection;
    if (shift && sel) {
      // extend from the far edge
      this.anchor = Math.abs(s - sel.start) > Math.abs(s - sel.end) ? sel.start : sel.end;
      this.moved = true;
      this.ed.setSelection({ start: this.anchor, end: s });
    } else if (shift) {
      this.anchor = this.ed.cursor;
      this.moved = true;
      this.ed.setSelection({ start: this.anchor, end: s });
    } else {
      this.anchor = s;
    }
  }

  move(x: number) {
    if (!this.moved && Math.abs(x - this.downX) < 3) return;
    this.moved = true;
    this.ed.setSelection({ start: this.anchor, end: this.ed.xToSample(x) });
  }

  up(x: number) {
    if (!this.moved) {
      this.ed.cursor = Math.round(Math.max(0, Math.min(this.ed.length, this.ed.xToSample(x))));
      this.ed.setSelection(null);
    }
  }
}

export function attachWheel(el: HTMLElement, ed: Editor, onOther?: (e: WheelEvent) => boolean) {
  el.addEventListener(
    "wheel",
    (e) => {
      if (!ed.doc) return;
      if (onOther?.(e)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        ed.scrollBy(e.shiftKey ? dy || dx : dx);
      } else {
        ed.zoom(Math.exp(dy * 0.002), x);
      }
    },
    { passive: false },
  );
}

/**
 * Pointer capture helper: calls handlers with element-relative coordinates.
 * With an editor passed in, a second finger turns the gesture into
 * pinch-zoom + two-finger pan of the shared time axis (touch screens have no wheel).
 */
export function attachPointer(
  el: HTMLElement,
  h: {
    down(x: number, y: number, e: PointerEvent): boolean | void;
    move?(x: number, y: number, e: PointerEvent): void;
    up?(x: number, y: number, e: PointerEvent): void;
    hover?(x: number, y: number, e: PointerEvent): void;
    leave?(): void;
  },
  ed?: Editor,
) {
  let active = false;
  let last: [number, number] = [0, 0];
  const touches = new Map<number, [number, number]>();
  let pinch: { dist: number; spp: number; anchor: number } | null = null;
  // after a pinch, ignore the remaining finger until every finger is lifted
  let suppress = false;

  const pos = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };
  const capture = (id: number) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* pointer already gone */
    }
  };
  const spread = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1])), mid: (a[0] + b[0]) / 2 };
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = pos(e);
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, p);
      capture(e.pointerId);
      if (ed && touches.size === 2) {
        if (active) {
          active = false;
          h.up?.(last[0], last[1], e);
        }
        const { dist, mid } = spread();
        pinch = { dist, spp: ed.view.spp, anchor: ed.xToSample(mid) };
        suppress = true;
        e.preventDefault();
        return;
      }
      if (suppress || touches.size > 2) return;
    }
    if (h.down(p[0], p[1], e) === false) return;
    active = true;
    last = p;
    capture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    const p = pos(e);
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, p);
      if (pinch && ed && touches.size === 2) {
        const { dist, mid } = spread();
        ed.view.spp = pinch.spp * (pinch.dist / dist);
        ed.clampView();
        ed.view.start = pinch.anchor - mid * ed.view.spp;
        ed.clampView();
        ed.changed();
        return;
      }
    }
    if (active) {
      last = p;
      h.move?.(p[0], p[1], e);
    }
    if (e.pointerType !== "touch") h.hover?.(p[0], p[1], e);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (touches.size === 0) suppress = false;
    }
    if (!active) return;
    active = false;
    const [x, y] = pos(e);
    h.up?.(x, y, e);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "touch") h.leave?.();
  });
}
