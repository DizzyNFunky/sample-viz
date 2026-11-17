//! sample-viz DSP core, compiled to `wasm32-unknown-unknown`.
//!
//! The FFI is deliberately plain (no wasm-bindgen): the host allocates
//! buffers with `sv_alloc`, writes into linear memory, calls an `sv_*`
//! function with pointers + lengths, and reads results back. See
//! `web/src/dsp.ts` for the TypeScript side.

pub mod effects;
pub mod fft;
pub mod mask;
pub mod ops;
pub mod render;
pub mod stft;
pub mod view;

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;
use std::slice;

// ---------------------------------------------------------------- memory

const ALIGN: usize = 8;

#[no_mangle]
pub extern "C" fn sv_alloc(bytes: usize) -> *mut u8 {
    if bytes == 0 {
        return ALIGN as *mut u8;
    }
    unsafe { alloc(Layout::from_size_align_unchecked(bytes, ALIGN)) }
}

/// # Safety
/// `ptr`/`bytes` must come from a matching `sv_alloc` call.
#[no_mangle]
pub unsafe extern "C" fn sv_free(ptr: *mut u8, bytes: usize) {
    if bytes != 0 {
        dealloc(ptr, Layout::from_size_align_unchecked(bytes, ALIGN));
    }
}

unsafe fn f32s<'a>(ptr: *const f32, len: usize) -> &'a [f32] {
    if len == 0 {
        &[]
    } else {
        slice::from_raw_parts(ptr, len)
    }
}

unsafe fn f32s_mut<'a>(ptr: *mut f32, len: usize) -> &'a mut [f32] {
    if len == 0 {
        &mut []
    } else {
        slice::from_raw_parts_mut(ptr, len)
    }
}

// ---------------------------------------------------------------- spectral

#[no_mangle]
pub extern "C" fn sv_stft_frames(len: usize, hop: usize) -> usize {
    stft::num_frames(len, hop)
}

/// # Safety
/// `out` must hold `sv_stft_frames(len, hop) * (nfft/2+1)` floats.
#[no_mangle]
pub unsafe extern "C" fn sv_stft_db(input: *const f32, len: usize, nfft: usize, hop: usize, out: *mut f32) {
    let frames = stft::num_frames(len, hop);
    let bins = stft::num_bins(nfft);
    stft::stft_db(f32s(input, len), nfft, hop, f32s_mut(out, frames * bins));
}

/// # Safety
/// `mask` holds frames*bins floats; `out` holds `len` floats (may alias nothing).
#[no_mangle]
pub unsafe extern "C" fn sv_spectral_gain(
    input: *const f32,
    len: usize,
    nfft: usize,
    hop: usize,
    mask: *const f32,
    out: *mut f32,
) {
    let frames = stft::num_frames(len, hop);
    let bins = stft::num_bins(nfft);
    stft::spectral_gain(
        f32s(input, len),
        nfft,
        hop,
        f32s(mask, frames * bins),
        f32s_mut(out, len),
    );
}

/// # Safety
/// `view` points to 9 f64s (see `view::View`); `out` holds width*height*4 bytes.
/// `mask` may be null.
#[no_mangle]
pub unsafe extern "C" fn sv_render_spectrogram(
    db: *const f32,
    mask: *const f32,
    frames: usize,
    bins: usize,
    view: *const f64,
    floor_db: f32,
    ceil_db: f32,
    tint: i32,
    out: *mut u8,
) {
    let v = view::View::from_slice(slice::from_raw_parts(view, 9));
    let n = frames * bins;
    let mask = if mask.is_null() { &[][..] } else { f32s(mask, n) };
    let px = (v.width as usize) * (v.height as usize) * 4;
    render::render(
        f32s(db, n),
        mask,
        frames,
        bins,
        &v,
        floor_db,
        ceil_db,
        tint != 0,
        slice::from_raw_parts_mut(out, px),
    );
}

/// # Safety
/// `mask` holds frames*bins floats; `view` points to 9 f64s.
#[no_mangle]
pub unsafe extern "C" fn sv_mask_brush(
    mask: *mut f32,
    frames: usize,
    bins: usize,
    view: *const f64,
    cx: f64,
    cy: f64,
    radius: f64,
    target_db: f32,
    strength: f32,
    hardness: f32,
) {
    let v = view::View::from_slice(slice::from_raw_parts(view, 9));
    mask::brush(
        f32s_mut(mask, frames * bins),
        frames,
        bins,
        &v,
        cx,
        cy,
        radius,
        target_db,
        strength,
        hardness,
    );
}

/// # Safety
/// `mask` holds frames*bins floats.
#[no_mangle]
pub unsafe extern "C" fn sv_mask_rect(
    mask: *mut f32,
    frames: usize,
    bins: usize,
    t0: f64,
    t1: f64,
    k0: f64,
    k1: f64,
    gain_db: f32,
    feather_t: f64,
    feather_k: f64,
    invert: i32,
) {
    mask::rect(
        f32s_mut(mask, frames * bins),
        frames,
        bins,
        t0,
        t1,
        k0,
        k1,
        gain_db,
        feather_t,
        feather_k,
        invert != 0,
    );
}

// ---------------------------------------------------------------- time domain

/// # Safety
/// `buf` holds `len` floats.
#[no_mangle]
pub unsafe extern "C" fn sv_gain(buf: *mut f32, len: usize, db: f32) {
    ops::gain(f32s_mut(buf, len), db);
}

/// # Safety
/// `buf` holds `len` floats.
#[no_mangle]
pub unsafe extern "C" fn sv_fade(buf: *mut f32, len: usize, fade_in: i32, shape: i32) {
    ops::fade(f32s_mut(buf, len), fade_in != 0, ops::FadeShape::from_i32(shape));
}

/// # Safety
/// `buf` holds `len` floats.
#[no_mangle]
pub unsafe extern "C" fn sv_reverse(buf: *mut f32, len: usize) {
    ops::reverse(f32s_mut(buf, len));
}

/// # Safety
/// `buf` holds `len` floats.
#[no_mangle]
pub unsafe extern "C" fn sv_peak_abs(buf: *const f32, len: usize) -> f32 {
    ops::peak_abs(f32s(buf, len))
}

/// # Safety
/// `buf` holds `len` floats.
#[no_mangle]
pub unsafe extern "C" fn sv_remove_dc(buf: *mut f32, len: usize) {
    ops::remove_dc(f32s_mut(buf, len));
}

/// # Safety
/// `buf` holds `len` floats; `points` holds `2*npoints` f64s.
#[no_mangle]
pub unsafe extern "C" fn sv_envelope(buf: *mut f32, len: usize, offset: f64, points: *const f64, npoints: usize) {
    let pts = if npoints == 0 { &[][..] } else { slice::from_raw_parts(points, npoints * 2) };
    ops::envelope(f32s_mut(buf, len), offset, pts);
}


// ---------------------------------------------------------------- effects

thread_local! {
    static FX: RefCell<Vec<Option<Box<dyn effects::Effect>>>> = const { RefCell::new(Vec::new()) };
}

/// Returns a handle > 0, or 0 if the id is unknown.
#[no_mangle]
pub extern "C" fn sv_fx_create(id: u32, sample_rate: f32) -> u32 {
    match effects::create(id, sample_rate) {
        None => 0,
        Some(fx) => FX.with(|t| {
            let mut t = t.borrow_mut();
            t.push(Some(fx));
            t.len() as u32
        }),
    }
}

#[no_mangle]
pub extern "C" fn sv_fx_destroy(handle: u32) {
    FX.with(|t| {
        if let Some(slot) = t.borrow_mut().get_mut(handle.wrapping_sub(1) as usize) {
            *slot = None;
        }
    });
}

#[no_mangle]
pub extern "C" fn sv_fx_set_param(handle: u32, index: usize, value: f32) {
    FX.with(|t| {
        if let Some(Some(fx)) = t.borrow_mut().get_mut(handle.wrapping_sub(1) as usize) {
            fx.set_param(index, value);
        }
    });
}

#[no_mangle]
pub extern "C" fn sv_fx_reset(handle: u32) {
    FX.with(|t| {
        if let Some(Some(fx)) = t.borrow_mut().get_mut(handle.wrapping_sub(1) as usize) {
            fx.reset();
        }
    });
}

/// Process `channels` planar channels of `frames` samples stored back to back.
///
/// # Safety
/// `planar` holds `channels * frames` floats.
#[no_mangle]
pub unsafe extern "C" fn sv_fx_process(handle: u32, planar: *mut f32, channels: usize, frames: usize) {
    let data = f32s_mut(planar, channels * frames);
    let mut chans: Vec<&mut [f32]> = data.chunks_mut(frames.max(1)).collect();
    FX.with(|t| {
        if let Some(Some(fx)) = t.borrow_mut().get_mut(handle.wrapping_sub(1) as usize) {
            fx.process(&mut chans);
        }
    });
}
