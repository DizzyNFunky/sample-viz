//! Editing operations on a time-frequency gain mask (dB, frame-major).

use crate::view::View;

pub const MASK_MIN_DB: f32 = -120.0;
pub const MASK_MAX_DB: f32 = 24.0;

fn smoothstep(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Brush falloff for normalised distance `d` in [0, 1].
fn falloff(d: f64, hardness: f64) -> f64 {
    let h = hardness.clamp(0.0, 0.999);
    if d <= h {
        1.0
    } else {
        1.0 - smoothstep((d - h) / (1.0 - h))
    }
}

/// Distance from `c` to the closed interval [a, b] (in any order).
fn dist_to_span(c: f64, a: f64, b: f64) -> f64 {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    if c < lo {
        lo - c
    } else if c > hi {
        c - hi
    } else {
        0.0
    }
}

/// Stamp a round brush (in screen space) centred on (cx, cy) with radius `r`
/// pixels. Each covered cell moves toward `target_db` by `strength * falloff`.
pub fn brush(
    mask: &mut [f32],
    frames: usize,
    bins: usize,
    view: &View,
    cx: f64,
    cy: f64,
    r: f64,
    target_db: f32,
    strength: f32,
    hardness: f32,
) {
    if r <= 0.0 || frames == 0 {
        return;
    }
    let bin_hz = view.bin_hz();
    let fa = view.x_to_frame(cx - r);
    let fb = view.x_to_frame(cx + r);
    let t_lo = (fa.min(fb).floor() - 1.0).max(0.0) as usize;
    let t_hi = ((fa.max(fb).ceil() + 1.0) as usize).min(frames - 1);
    for t in t_lo..=t_hi {
        let dx = dist_to_span(
            cx,
            view.frame_to_x(t as f64 - 0.5),
            view.frame_to_x(t as f64 + 0.5),
        );
        if dx > r {
            continue;
        }
        let dy_max = (r * r - dx * dx).sqrt();
        let f_hi = view.y_to_freq(cy - dy_max);
        let f_lo = view.y_to_freq(cy + dy_max);
        let k_lo = ((f_lo / bin_hz - 0.5).floor().max(0.0)) as usize;
        let k_hi = ((f_hi / bin_hz + 0.5).ceil().max(0.0) as usize).min(bins - 1);
        if k_lo > k_hi {
            continue;
        }
        for k in k_lo..=k_hi {
            let y_top = view.freq_to_y((k as f64 + 0.5) * bin_hz);
            let y_bot = view.freq_to_y(((k as f64 - 0.5) * bin_hz).max(1e-3));
            let dy = dist_to_span(cy, y_top, y_bot);
            let d = (dx * dx + dy * dy).sqrt() / r;
            if d > 1.0 {
                continue;
            }
            let w = falloff(d, hardness as f64) as f32 * strength;
            let i = t * bins + k;
            let v = mask[i] + (target_db - mask[i]) * w;
            mask[i] = v.clamp(MASK_MIN_DB, MASK_MAX_DB);
        }
    }
}

fn edge_weight(v: f64, lo: f64, hi: f64, feather: f64) -> f64 {
    let d = if v < lo {
        lo - v
    } else if v > hi {
        v - hi
    } else {
        0.0
    };
    if d == 0.0 {
        1.0
    } else if feather <= 0.0 {
        0.0
    } else {
        1.0 - smoothstep(d / feather)
    }
}

/// Add `gain_db` to a rectangle in grid coordinates (frames t0..t1, bins
/// k0..k1, inclusive, fractional allowed), with soft edges. When `invert`
/// is set the gain is applied everywhere *outside* the rectangle instead.
pub fn rect(
    mask: &mut [f32],
    frames: usize,
    bins: usize,
    t0: f64,
    t1: f64,
    k0: f64,
    k1: f64,
    gain_db: f32,
    feather_t: f64,
    feather_k: f64,
    invert: bool,
) {
    let (t0, t1) = (t0.min(t1), t0.max(t1));
    let (k0, k1) = (k0.min(k1), k0.max(k1));
    let (ta, tb, ka, kb) = if invert {
        (0, frames.saturating_sub(1), 0, bins.saturating_sub(1))
    } else {
        (
            (t0 - feather_t).floor().max(0.0) as usize,
            ((t1 + feather_t).ceil().max(0.0) as usize).min(frames.saturating_sub(1)),
            (k0 - feather_k).floor().max(0.0) as usize,
            ((k1 + feather_k).ceil().max(0.0) as usize).min(bins.saturating_sub(1)),
        )
    };
    for t in ta..=tb {
        let wt = edge_weight(t as f64, t0, t1, feather_t);
        for k in ka..=kb {
            let mut w = wt * edge_weight(k as f64, k0, k1, feather_k);
            if invert {
                w = 1.0 - w;
            }
            if w <= 0.0 {
                continue;
            }
            let i = t * bins + k;
            mask[i] = (mask[i] + gain_db * w as f32).clamp(MASK_MIN_DB, MASK_MAX_DB);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_and_invert() {
        let (frames, bins) = (10, 8);
        let mut m = vec![0.0; frames * bins];
        rect(&mut m, frames, bins, 2.0, 4.0, 1.0, 3.0, -12.0, 0.0, 0.0, false);
        assert_eq!(m[3 * bins + 2], -12.0);
        assert_eq!(m[5 * bins + 2], 0.0);
        let mut m = vec![0.0; frames * bins];
        rect(&mut m, frames, bins, 2.0, 4.0, 1.0, 3.0, -12.0, 0.0, 0.0, true);
        assert_eq!(m[3 * bins + 2], 0.0);
        assert_eq!(m[5 * bins + 2], -12.0);
    }

    #[test]
    fn brush_hits_centre() {
        let (frames, bins) = (100, 513);
        let view = View {
            frame0: 0.0,
            frame1: 100.0,
            width: 400.0,
            height: 200.0,
            fmin: 20.0,
            fmax: 24000.0,
            log: 1.0,
            sample_rate: 48000.0,
            nfft: 1024.0,
        };
        let mut m = vec![0.0; frames * bins];
        brush(&mut m, frames, bins, &view, 200.0, 100.0, 10.0, -60.0, 1.0, 0.5);
        let f = view.y_to_freq(100.0);
        let k = (f / view.bin_hz()).round() as usize;
        assert!(m[50 * bins + k] < -59.0);
        assert_eq!(m[10 * bins + k], 0.0);
    }
}
