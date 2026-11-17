//! Time-domain ("normal space") operations on a single channel.

use crate::stft::db_to_gain;

pub fn gain(buf: &mut [f32], db: f32) {
    let g = db_to_gain(db);
    for v in buf.iter_mut() {
        *v *= g;
    }
}

#[derive(Clone, Copy)]
pub enum FadeShape {
    Linear,
    EqualPower,
    Exponential,
    SCurve,
}

impl FadeShape {
    pub fn from_i32(v: i32) -> FadeShape {
        match v {
            1 => FadeShape::EqualPower,
            2 => FadeShape::Exponential,
            3 => FadeShape::SCurve,
            _ => FadeShape::Linear,
        }
    }

    /// Gain at position u in [0, 1] for a fade-in.
    pub fn eval(self, u: f32) -> f32 {
        let u = u.clamp(0.0, 1.0);
        match self {
            FadeShape::Linear => u,
            FadeShape::EqualPower => (u * std::f32::consts::FRAC_PI_2).sin(),
            FadeShape::Exponential => u * u,
            FadeShape::SCurve => u * u * (3.0 - 2.0 * u),
        }
    }
}

pub fn fade(buf: &mut [f32], fade_in: bool, shape: FadeShape) {
    let n = buf.len();
    if n == 0 {
        return;
    }
    let denom = (n.max(2) - 1) as f32;
    for (i, v) in buf.iter_mut().enumerate() {
        let u = i as f32 / denom;
        let g = if fade_in { shape.eval(u) } else { shape.eval(1.0 - u) };
        *v *= g;
    }
}

pub fn reverse(buf: &mut [f32]) {
    buf.reverse();
}

pub fn peak_abs(buf: &[f32]) -> f32 {
    buf.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

pub fn remove_dc(buf: &mut [f32]) {
    if buf.is_empty() {
        return;
    }
    let mean = (buf.iter().map(|&v| v as f64).sum::<f64>() / buf.len() as f64) as f32;
    for v in buf.iter_mut() {
        *v -= mean;
    }
}

/// Apply a piecewise-linear (in dB) gain envelope. `points` holds
/// (time, dB) pairs sorted by time, in the same sample units as `offset`
/// (the absolute position of `buf[0]`). Gain is held flat beyond the ends.
pub fn envelope(buf: &mut [f32], offset: f64, points: &[f64]) {
    let n = points.len() / 2;
    if n == 0 {
        return;
    }
    let pt = |i: usize| (points[2 * i], points[2 * i + 1] as f32);
    let mut seg = 0usize;
    for (i, v) in buf.iter_mut().enumerate() {
        let t = offset + i as f64;
        while seg + 1 < n && pt(seg + 1).0 <= t {
            seg += 1;
        }
        let (t0, d0) = pt(seg);
        let db = if t <= t0 || seg + 1 >= n {
            d0
        } else {
            let (t1, d1) = pt(seg + 1);
            let u = ((t - t0) / (t1 - t0).max(1e-9)) as f32;
            d0 + (d1 - d0) * u
        };
        *v *= db_to_gain(db);
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_interpolates() {
        let mut b = vec![1.0f32; 11];
        envelope(&mut b, 100.0, &[100.0, 0.0, 110.0, -120.0]);
        assert!((b[0] - 1.0).abs() < 1e-6);
        assert_eq!(b[10], 0.0);
        assert!(b[5] < b[4] && b[5] > b[6]);
    }

    #[test]
    fn fades() {
        let mut b = vec![1.0f32; 5];
        fade(&mut b, true, FadeShape::Linear);
        assert_eq!(b, vec![0.0, 0.25, 0.5, 0.75, 1.0]);
    }
}
