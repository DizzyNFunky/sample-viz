//! Extension point for real-time-style effects (EQ, filters, dynamics, ...).
//!
//! Every effect implements [`Effect`] and is registered in [`create`] under a
//! numeric id. The JS side mirrors the id and its parameter list in its op
//! registry (`web/src/ops.ts`), creates an instance through the FFI, sets
//! parameters by index and processes planar audio in blocks. The same trait
//! works for offline rendering of a selection and, later, for an
//! AudioWorklet-hosted live chain.

pub trait Effect {
    /// Set parameter `index` (as declared on the JS side) to `value`.
    fn set_param(&mut self, index: usize, value: f32);
    /// Clear internal state (delay lines, filter memories, ...).
    fn reset(&mut self);
    /// Process planar channels in place. All slices have the same length.
    fn process(&mut self, channels: &mut [&mut [f32]]);
    /// Extra samples the effect keeps producing after input stops.
    fn tail_samples(&self) -> usize {
        0
    }
}

pub const FX_UTILITY: u32 = 1;

/// Instantiate effect `id` for the given sample rate.
pub fn create(id: u32, sample_rate: f32) -> Option<Box<dyn Effect>> {
    match id {
        FX_UTILITY => Some(Box::new(Utility::new(sample_rate))),
        _ => None,
    }
}

/// Reference implementation: gain (dB) + polarity invert, with a short
/// parameter smoother so automation does not click.
pub struct Utility {
    target_gain: f32,
    gain: f32,
    invert: bool,
    smooth: f32,
}

impl Utility {
    pub fn new(sample_rate: f32) -> Self {
        Utility {
            target_gain: 1.0,
            gain: 1.0,
            invert: false,
            // ~5 ms one-pole smoothing
            smooth: 1.0 - (-1.0 / (0.005 * sample_rate.max(1.0))).exp(),
        }
    }
}

impl Effect for Utility {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.target_gain = crate::stft::db_to_gain(value),
            1 => self.invert = value >= 0.5,
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.gain = self.target_gain;
    }

    fn process(&mut self, channels: &mut [&mut [f32]]) {
        let len = channels.first().map_or(0, |c| c.len());
        let sign = if self.invert { -1.0 } else { 1.0 };
        for i in 0..len {
            self.gain += (self.target_gain - self.gain) * self.smooth;
            let g = self.gain * sign;
            for ch in channels.iter_mut() {
                ch[i] *= g;
            }
        }
    }
}
