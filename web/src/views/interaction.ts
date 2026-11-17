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

/** Pointer capture helper: calls handlers with element-relative coordinates. */
export function attachPointer(
  el: HTMLElement,
  h: {
    down(x: number, y: number, e: PointerEvent): boolean | void;
    move?(x: number, y: number, e: PointerEvent): void;
    up?(x: number, y: number, e: PointerEvent): void;
    hover?(x: number, y: number, e: PointerEvent): void;
    leave?(): void;
  },
) {
  let active = false;
  const pos = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const [x, y] = pos(e);
    if (h.down(x, y, e) === false) return;
    active = true;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    const [x, y] = pos(e);
    if (active) h.move?.(x, y, e);
    h.hover?.(x, y, e);
  });
  const end = (e: PointerEvent) => {
    if (!active) return;
    active = false;
    const [x, y] = pos(e);
    h.up?.(x, y, e);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("pointerleave", () => h.leave?.());
}
