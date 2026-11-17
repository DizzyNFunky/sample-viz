//! Mapping between screen pixels and the time/frequency grid of a spectrogram.
//!
//! Passed across the FFI boundary as 9 consecutive f64 values, in field order.

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct View {
    /// Fractional frame index at the left edge (x = 0).
    pub frame0: f64,
    /// Fractional frame index at the right edge (x = width).
    pub frame1: f64,
    pub width: f64,
    pub height: f64,
    pub fmin: f64,
    pub fmax: f64,
    /// 0 = linear frequency axis, otherwise logarithmic.
    pub log: f64,
    pub sample_rate: f64,
    pub nfft: f64,
}

impl View {
    pub fn from_slice(v: &[f64]) -> View {
        View {
            frame0: v[0],
            frame1: v[1],
            width: v[2],
            height: v[3],
            fmin: v[4],
            fmax: v[5],
            log: v[6],
            sample_rate: v[7],
            nfft: v[8],
        }
    }

    #[inline]
    pub fn is_log(&self) -> bool {
        self.log != 0.0
    }

    #[inline]
    pub fn bin_hz(&self) -> f64 {
        self.sample_rate / self.nfft
    }

    #[inline]
    pub fn x_to_frame(&self, x: f64) -> f64 {
        self.frame0 + x / self.width * (self.frame1 - self.frame0)
    }

    #[inline]
    pub fn frame_to_x(&self, f: f64) -> f64 {
        (f - self.frame0) / (self.frame1 - self.frame0) * self.width
    }

    /// y = 0 is the top (fmax), y = height the bottom (fmin).
    #[inline]
    pub fn y_to_freq(&self, y: f64) -> f64 {
        let u = 1.0 - y / self.height;
        if self.is_log() {
            self.fmin * (self.fmax / self.fmin).powf(u)
        } else {
            self.fmin + u * (self.fmax - self.fmin)
        }
    }

    #[inline]
    pub fn freq_to_y(&self, f: f64) -> f64 {
        let u = if self.is_log() {
            (f.max(1e-3) / self.fmin).ln() / (self.fmax / self.fmin).ln()
        } else {
            (f - self.fmin) / (self.fmax - self.fmin)
        };
        (1.0 - u) * self.height
    }
}
