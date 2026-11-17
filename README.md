# sample-viz

A single-user, browser-based sample manager and editor.

- **Storage**: samples live in a Cloudflare R2 bucket behind a small Worker
  (token-protected REST API). The same Worker serves the editor.
- **Editing**: all DSP runs in the browser in WebAssembly, compiled from a
  dependency-free Rust crate. You can edit visually in both domains:
  - **Time** (waveform): selection, gain envelope with draggable breakpoints,
    a pencil for redrawing individual samples, and destructive ops (gain,
    normalize, fades, reverse, crop, delete, ...).
  - **Frequency** (spectrogram): paint a time-frequency gain mask with a soft
    brush (cut / boost / restore), or drag a time × frequency region and cut,
    boost or isolate it. The spectrogram shows the result live. Playback
    previews it (resynthesised with the original phase), with an A/B bypass.
    Enter applies it.

```
┌──────────── browser ────────────┐        ┌──── Cloudflare ────┐
│ web/  (Vite + TS, no framework) │  /api  │ worker/            │
│   views ─ editor ─ ops registry │ ─────► │  Worker ── R2      │
│              │                  │        │  (+ static assets) │
│        dsp.ts (FFI wrapper)     │        └────────────────────┘
│              │                  │
│   dsp.wasm  ◄── dsp/ (Rust)     │
└─────────────────────────────────┘
```

## Layout

| Path | What |
| --- | --- |
| `dsp/` | Rust DSP core → `wasm32-unknown-unknown`. FFT, centred STFT / WOLA resynthesis, mask brush/rect, spectrogram rasteriser, time-domain ops, effect host. Plain C-ABI exports (`sv_*`), no wasm-bindgen. |
| `web/` | Editor UI. `editor.ts` (state, undo, pending edits), `ops.ts` (op registry), `views/` (waveform + spectrogram), `dsp.ts` (wasm wrapper), `wav.ts` (lossless WAV codec), `storage.ts` / `library.ts` (R2 client + sidebar). |
| `worker/` | Cloudflare Worker: `/api/*` → R2; everything else → static editor build. |
| `test/` | Node tests that drive the compiled wasm through its FFI. |

## Develop

Requirements: Node 20+, Rust with the wasm target (`rustup target add wasm32-unknown-unknown`).

```sh
npm install
cp worker/.dev.vars.example worker/.dev.vars   # sets a local API_TOKEN

npm run dev:worker   # storage API on :8787 with a local, simulated R2 bucket
npm run dev          # builds wasm, starts Vite on :5173 (proxies /api to :8787)
```

Open the editor, click ⚙ in the Library panel and enter the token from
`worker/.dev.vars`. The editor also works without storage: open or drop a
local file and use **Download** to save.

```sh
npm test             # Rust unit tests + wasm FFI tests
npm run typecheck
npm run build        # wasm + typecheck + web/dist
```

## Deploy

```sh
npx wrangler r2 bucket create sample-viz-samples
npx wrangler secret put API_TOKEN --config worker/wrangler.toml   # a long random string
npm run deploy
```

The Worker fails closed: with no `API_TOKEN` configured, every API call is rejected.
For extra protection you can also put the Worker behind Cloudflare Access.
To host the editor somewhere else, set `ALLOWED_ORIGIN` in `wrangler.toml`
and enter the Worker URL as the API base in the settings dialog.

### Storage API

All endpoints require `Authorization: Bearer <API_TOKEN>`. Objects are stored under the
`samples/` prefix in the bucket. Keys may contain `/` (shown as folders).

| | |
| --- | --- |
| `GET /api/samples?prefix=&cursor=` | list → `{samples:[{key,size,uploaded,etag,contentType,meta}], cursor}` |
| `GET\|HEAD /api/samples/<key>` | download (Range and conditional requests supported) |
| `PUT /api/samples/<key>` | upload body; optional `x-sample-meta: {json}` stored as R2 custom metadata |
| `DELETE /api/samples/<key>` | delete |
| `POST /api/rename` `{from,to}` | move |

Uploads go through the Worker, so Cloudflare's request body limit applies
(100 MB on the Free and Pro plans), which is plenty for samples.

## Editor reference

| Key | |
| --- | --- |
| Space | play / stop (selection, else from cursor) |
| L | loop |
| V / E / P | select / envelope / pencil |
| B / R | spectral brush / spectral region |
| Enter | apply pending spectral + envelope edits |
| Ctrl+Z, Ctrl+Shift+Z | undo / redo (every op, stroke and point move is a step) |
| Ctrl+A, Esc | select all / clear selection or region |
| Delete | delete selection |
| wheel, Shift+wheel | zoom around pointer / scroll |
| F, Z, + / − | fit, zoom to selection, zoom |
| Alt+wheel, [ ] | brush size |
| Ctrl+S, Ctrl+Shift+S, Ctrl+O | save, save as, open local file |

How the edits work:

- **Spectral edits** are a dB gain mask on the STFT grid (Hann window, hop = N/4,
  frames centred on `t·hop`). Applying a mask runs analysis → per-bin gain →
  inverse FFT → weighted overlap-add, normalised by the per-sample window
  energy. A unity mask reconstructs the input exactly, edges included. Frames
  with an all-zero mask skip the FFT, so local edits are cheap. The
  spectrogram is computed from the mono mixdown. The mask is applied to every
  channel.
- **Envelope** points are in absolute sample positions, interpolated linearly in dB.
- WAV files are decoded and re-encoded at their original sample rate and bit
  depth (8/16/24/32-bit PCM, 32/64-bit float, WAVE_FORMAT_EXTENSIBLE). Other
  formats go through the browser decoder and are saved as 24-bit WAV.
- Very long files fall back to a larger hop to keep the spectrogram grid ≤ 24M
  cells.

## Adding effects

Effects are planned. The plumbing is already in place:

1. **Rust**: implement `effects::Effect` (`set_param`, `reset`, `process` on
   planar blocks, optional `tail_samples`) and register it under a new id in
   `effects::create`. `Utility` (gain + polarity) is the reference implementation.
2. **TS**: add an entry to `OPS` in `web/src/ops.ts` with `group: "Effects"`,
   its parameter specs, and `apply` calling `ctx.dsp.runEffect(id, sr, params, channels)`.
   The Process panel generates its UI from the specs. Undo comes for free.

The same `Effect` trait is designed so the wasm module can later be hosted in
an `AudioWorklet` for a real-time, non-destructive effect chain. The pending
edit model (`Editor.playbackChannels`) is where a chain preview would plug in.
