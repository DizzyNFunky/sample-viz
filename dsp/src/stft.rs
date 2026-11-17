//! Short-time Fourier analysis / resynthesis.
//!
//! Framing convention ("centered"): frame `t` is centered on sample `t * hop`
//! and spans `[t*hop - nfft/2, t*hop + nfft/2)`. Samples outside the signal
//! read as zero. `num_frames` frames are enough to cover every sample.
//!
//! Resynthesis uses weighted overlap-add with the same periodic Hann window
//! for analysis and synthesis, normalised by the per-sample sum of squared
//! windows. A unity mask reconstructs the input exactly (up to float error),
//! including at the edges.

use crate::fft::Fft;

pub fn num_bins(nfft: usize) -> usize {
    nfft / 2 + 1
}

pub fn num_frames(len: usize, hop: usize) -> usize {
    len.div_ceil(hop) + 1
}

pub fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()) as f32)
        .collect()
}

/// Copy the windowed frame `t` into `re`, zero `im`.
fn load_frame(input: &[f32], window: &[f32], t: usize, hop: usize, re: &mut [f32], im: &mut [f32]) {
    let nfft = window.len();
    let start = (t * hop) as isize - (nfft / 2) as isize;
    for i in 0..nfft {
        let s = start + i as isize;
        re[i] = if s >= 0 && (s as usize) < input.len() {
            input[s as usize] * window[i]
        } else {
            0.0
        };
        im[i] = 0.0;
    }
}

/// Magnitude spectrogram in dBFS (a full-scale sine reads ~0 dB).
/// `out` must hold `num_frames * num_bins` values, frame-major.
pub fn stft_db(input: &[f32], nfft: usize, hop: usize, out: &mut [f32]) {
    let fft = Fft::new(nfft);
    let window = hann(nfft);
    let bins = num_bins(nfft);
    let frames = num_frames(input.len(), hop);
    assert!(out.len() >= frames * bins);
    let scale = 4.0 / nfft as f32; // 2 / sum(hann)
    let mut re = vec![0.0f32; nfft];
    let mut im = vec![0.0f32; nfft];
    for t in 0..frames {
        load_frame(input, &window, t, hop, &mut re, &mut im);
        fft.forward(&mut re, &mut im);
        let row = &mut out[t * bins..(t + 1) * bins];
        for k in 0..bins {
            let p = (re[k] * re[k] + im[k] * im[k]).sqrt() * scale;
            row[k] = 20.0 * (p + 1e-12).log10();
        }
    }
}

/// Apply a time-frequency gain mask (in dB, `num_frames * num_bins`,
/// frame-major) and resynthesise into `out` (same length as `input`).
/// Phase is preserved; frames whose mask is entirely 0 dB skip the FFT.
pub fn spectral_gain(input: &[f32], nfft: usize, hop: usize, mask_db: &[f32], out: &mut [f32]) {
    let fft = Fft::new(nfft);
    let window = hann(nfft);
    let bins = num_bins(nfft);
    let len = input.len();
    let frames = num_frames(len, hop);
    assert!(mask_db.len() >= frames * bins);
    assert!(out.len() == len);

    let mut acc = vec![0.0f32; len];
    let mut wsum = vec![0.0f32; len];
    let mut re = vec![0.0f32; nfft];
    let mut im = vec![0.0f32; nfft];
    let mut gains = vec![1.0f32; bins];

    for t in 0..frames {
        let row = &mask_db[t * bins..(t + 1) * bins];
        let identity = row.iter().all(|&d| d == 0.0);
        load_frame(input, &window, t, hop, &mut re, &mut im);
        if !identity {
            for k in 0..bins {
                gains[k] = db_to_gain(row[k]);
            }
            fft.forward(&mut re, &mut im);
            for k in 0..bins {
                let g = gains[k];
                re[k] *= g;
                im[k] *= g;
                if k > 0 && k < nfft / 2 {
                    re[nfft - k] *= g;
                    im[nfft - k] *= g;
                }
            }
            fft.inverse(&mut re, &mut im);
        }
        let start = (t * hop) as isize - (nfft / 2) as isize;
        for i in 0..nfft {
            let s = start + i as isize;
            if s >= 0 && (s as usize) < len {
                let s = s as usize;
                acc[s] += re[i] * window[i];
                wsum[s] += window[i] * window[i];
            }
        }
    }
    for i in 0..len {
        out[i] = if wsum[i] > 1e-8 { acc[i] / wsum[i] } else { 0.0 };
    }
}

#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    if db <= -119.0 {
        0.0
    } else {
        10f32.powf(db / 20.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize) -> Vec<f32> {
        let mut x: u32 = 12345;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x as f32 / u32::MAX as f32) * 2.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn unity_mask_reconstructs() {
        for &(nfft, len) in &[(512usize, 3000usize), (2048, 10007), (256, 100)] {
            let hop = nfft / 4;
            let x = noise(len);
            let frames = num_frames(len, hop);
            let mut mask = vec![0.0f32; frames * num_bins(nfft)];
            // force the FFT path on every frame with a tiny non-zero value
            for m in mask.iter_mut() {
                *m = 1e-7;
            }
            let mut y = vec![0.0f32; len];
            spectral_gain(&x, nfft, hop, &mask, &mut y);
            let err = x.iter().zip(&y).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
            assert!(err < 1e-4, "nfft {nfft} len {len} err {err}");
        }
    }

    #[test]
    fn full_cut_silences() {
        let nfft = 1024;
        let hop = 256;
        let x = noise(8000);
        let frames = num_frames(x.len(), hop);
        let mask = vec![-120.0f32; frames * num_bins(nfft)];
        let mut y = vec![0.0f32; x.len()];
        spectral_gain(&x, nfft, hop, &mask, &mut y);
        assert!(y.iter().all(|v| v.abs() < 1e-6));
    }

    #[test]
    fn sine_reads_zero_db() {
        let nfft = 1024;
        let sr = 48000.0;
        let k = 64.0; // put it exactly on a bin
        let f = k * sr / nfft as f32;
        let x: Vec<f32> = (0..8192)
            .map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr).sin())
            .collect();
        let frames = num_frames(x.len(), 256);
        let bins = num_bins(nfft);
        let mut out = vec![0.0; frames * bins];
        stft_db(&x, nfft, 256, &mut out);
        let mid = frames / 2;
        assert!(out[mid * bins + 64].abs() < 0.1, "{}", out[mid * bins + 64]);
    }
}
