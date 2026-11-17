//! Spectrogram rasterisation into an RGBA buffer.

use crate::view::View;

const STOPS: [(f32, [f32; 3]); 9] = [
    (0.00, [0.0, 0.0, 4.0]),
    (0.15, [31.0, 12.0, 72.0]),
    (0.30, [85.0, 15.0, 109.0]),
    (0.45, [136.0, 34.0, 106.0]),
    (0.60, [186.0, 54.0, 85.0]),
    (0.75, [227.0, 89.0, 51.0]),
    (0.85, [249.0, 140.0, 10.0]),
    (0.95, [249.0, 201.0, 50.0]),
    (1.00, [252.0, 255.0, 164.0]),
];

fn colormap() -> [[u8; 3]; 256] {
    let mut lut = [[0u8; 3]; 256];
    for (i, c) in lut.iter_mut().enumerate() {
        let t = i as f32 / 255.0;
        let mut j = 0;
        while j + 2 < STOPS.len() && t > STOPS[j + 1].0 {
            j += 1;
        }
        let (t0, a) = STOPS[j];
        let (t1, b) = STOPS[j + 1];
        let u = ((t - t0) / (t1 - t0)).clamp(0.0, 1.0);
        for ch in 0..3 {
            c[ch] = (a[ch] + (b[ch] - a[ch]) * u).round() as u8;
        }
    }
    lut
}

const BG: [u8; 3] = [10, 10, 14];
const CUT_TINT: [f32; 3] = [70.0, 200.0, 255.0];
const BOOST_TINT: [f32; 3] = [130.0, 255.0, 130.0];

/// Sample a range [a, b) of a 1-D grid: max over the cells when the range
/// spans more than one cell, otherwise linear interpolation at the centre.
/// Returns None when completely outside [0, n).
#[derive(Clone, Copy)]
enum Pick {
    None,
    Interp(usize, usize, f32),
    Range(usize, usize, usize), // lo, hi (inclusive), stride
}

fn pick(a: f64, b: f64, n: usize) -> Pick {
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    let last = (n - 1) as f64;
    if b < -0.5 || a > last + 0.5 {
        return Pick::None;
    }
    if b - a <= 1.0 {
        let c = ((a + b) * 0.5).clamp(0.0, last);
        let i0 = c.floor() as usize;
        let i1 = (i0 + 1).min(n - 1);
        Pick::Interp(i0, i1, (c - i0 as f64) as f32)
    } else {
        let lo = a.round().clamp(0.0, last) as usize;
        let hi = b.round().clamp(0.0, last) as usize;
        let count = hi - lo + 1;
        Pick::Range(lo, hi, (count / 8).max(1))
    }
}

/// `db` and `mask` are `frames * bins` frame-major. `mask` may be empty.
pub fn render(
    db: &[f32],
    mask: &[f32],
    frames: usize,
    bins: usize,
    view: &View,
    floor_db: f32,
    ceil_db: f32,
    tint: bool,
    out: &mut [u8],
) {
    let w = view.width as usize;
    let h = view.height as usize;
    assert!(out.len() >= w * h * 4);
    let lut = colormap();
    let has_mask = !mask.is_empty();
    let range = (ceil_db - floor_db).max(1e-3);
    let bin_hz = view.bin_hz();
    let nyquist_bin = (bins - 1) as f64;

    // Per-row bin picks (independent of column).
    let rows: Vec<Pick> = (0..h)
        .map(|y| {
            let f_top = view.y_to_freq(y as f64);
            let f_bot = view.y_to_freq(y as f64 + 1.0);
            let kb = f_top / bin_hz;
            let ka = f_bot / bin_hz;
            if ka > nyquist_bin + 0.5 {
                Pick::None
            } else {
                pick(ka, kb.min(nyquist_bin + 0.49), bins)
            }
        })
        .collect();

    let mut col = vec![0.0f32; bins];
    let mut col_mask = vec![0.0f32; bins];
    for x in 0..w {
        let p = pick(view.x_to_frame(x as f64), view.x_to_frame(x as f64 + 1.0), frames);
        let valid = !matches!(p, Pick::None);
        if valid {
            match p {
                Pick::Interp(t0, t1, u) => {
                    for k in 0..bins {
                        let m0 = if has_mask { mask[t0 * bins + k] } else { 0.0 };
                        let m1 = if has_mask { mask[t1 * bins + k] } else { 0.0 };
                        let v0 = db[t0 * bins + k] + m0;
                        let v1 = db[t1 * bins + k] + m1;
                        col[k] = v0 + (v1 - v0) * u;
                        col_mask[k] = m0 + (m1 - m0) * u;
                    }
                }
                Pick::Range(lo, hi, stride) => {
                    for k in 0..bins {
                        let mut best = f32::NEG_INFINITY;
                        let mut mbest = 0.0f32;
                        let mut t = lo;
                        while t <= hi {
                            let m = if has_mask { mask[t * bins + k] } else { 0.0 };
                            let v = db[t * bins + k] + m;
                            if v > best {
                                best = v;
                            }
                            if m.abs() > mbest.abs() {
                                mbest = m;
                            }
                            t += stride;
                        }
                        col[k] = best;
                        col_mask[k] = mbest;
                    }
                }
                Pick::None => {}
            }
        }
        for y in 0..h {
            let o = (y * w + x) * 4;
            let rp = rows[y];
            if !valid || matches!(rp, Pick::None) {
                out[o..o + 3].copy_from_slice(&BG);
                out[o + 3] = 255;
                continue;
            }
            let (v, m) = match rp {
                Pick::Interp(k0, k1, u) => (
                    col[k0] + (col[k1] - col[k0]) * u,
                    col_mask[k0] + (col_mask[k1] - col_mask[k0]) * u,
                ),
                Pick::Range(lo, hi, _) => {
                    let mut best = f32::NEG_INFINITY;
                    let mut mbest = 0.0f32;
                    for k in lo..=hi {
                        if col[k] > best {
                            best = col[k];
                        }
                        if col_mask[k].abs() > mbest.abs() {
                            mbest = col_mask[k];
                        }
                    }
                    (best, mbest)
                }
                Pick::None => unreachable!(),
            };
            let t = ((v - floor_db) / range).clamp(0.0, 1.0);
            let c = lut[(t * 255.0) as usize];
            let mut rgb = [c[0] as f32, c[1] as f32, c[2] as f32];
            if tint && m != 0.0 {
                let a = (m.abs() / 36.0).clamp(0.0, 1.0) * 0.55;
                let tc = if m < 0.0 { CUT_TINT } else { BOOST_TINT };
                for ch in 0..3 {
                    rgb[ch] += (tc[ch] - rgb[ch]) * a;
                }
            }
            out[o] = rgb[0] as u8;
            out[o + 1] = rgb[1] as u8;
            out[o + 2] = rgb[2] as u8;
            out[o + 3] = 255;
        }
    }
}
