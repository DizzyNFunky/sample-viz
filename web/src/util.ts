export function formatTime(seconds: number, precision = 3): string {
  const sign = seconds < 0 ? "-" : "";
  seconds = Math.abs(seconds);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const ss = s.toFixed(precision).padStart(precision ? precision + 3 : 2, "0");
  return `${sign}${m}:${ss}`;
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Pick a "nice" tick step (seconds) so ticks are at least `minPx` apart. */
export function niceStep(secondsPerPx: number, minPx: number): number {
  const raw = secondsPerPx * minPx;
  const steps = [1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s >= raw) ?? 600;
}

/** Size a canvas's backing store to its CSS box × devicePixelRatio. Returns CSS size. */
export function fitCanvas(canvas: HTMLCanvasElement, scale = devicePixelRatio || 1) {
  const w = Math.max(1, Math.floor(canvas.clientWidth));
  const h = Math.max(1, Math.floor(canvas.clientHeight));
  const bw = Math.floor(w * scale);
  const bh = Math.floor(h * scale);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  return { w, h, scale };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
