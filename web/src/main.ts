import "./style.css";
import { Dsp } from "./dsp";
import { Doc, Editor, Tool } from "./editor";
import { LibraryPanel } from "./library";
import { Player } from "./player";
import { ProcessPanel } from "./process";
import { loadConfig, saveConfig, Storage } from "./storage";
import { clamp, formatHz, formatTime } from "./util";
import { SpectrogramView } from "./views/spectrogram";
import { WaveformView } from "./views/waveform";
import { decodeAudio, encodeWav } from "./wav";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const dsp = await Dsp.load();
const ed = new Editor(dsp);
const player = new Player();
const storage = new Storage(loadConfig());
let loop = false;

const wave = new WaveformView($("wave") as HTMLCanvasElement, ed);
const spec = new SpectrogramView($("spec-img") as HTMLCanvasElement, $("spec-ovl") as HTMLCanvasElement, ed);
const process = new ProcessPanel(ed, (m, e) => status(m, e));
const library = new LibraryPanel(storage, {
  open: (key) => void openFromStorage(key),
  upload: (files) => uploadFiles(files),
  status: (m, e) => status(m, e),
  openSettings: () => openSettings(),
  activeKey: () => ed.doc?.key ?? null,
});

// ------------------------------------------------------------------ status

let msgTimer = 0;
function status(msg: string, err = false) {
  const el = $("st-msg");
  el.textContent = msg;
  el.classList.toggle("err", err);
  clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => (el.textContent = ""), err ? 8000 : 3500);
}

async function busy<T>(msg: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  status(msg);
  document.body.style.cursor = "progress";
  try {
    // let the status paint before heavy synchronous wasm work
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    return await fn();
  } catch (e) {
    console.error(e);
    status((e as Error).message, true);
    return undefined;
  } finally {
    document.body.style.cursor = "";
  }
}

// ------------------------------------------------------------------ rendering

let frame = 0;
function scheduleRender() {
  if (!frame) frame = requestAnimationFrame(render);
}
ed.onChange(scheduleRender);

function render() {
  frame = 0;
  const pos = player.position();
  ed.playhead = pos;
  if (pos !== null) ed.reveal(pos);

  wave.draw();
  spec.draw();
  process.update();

  const doc = ed.doc;
  $("empty").hidden = !!doc;
  $("file-name").textContent = doc ? doc.key ?? doc.name : "No file";
  $("file-info").textContent = doc
    ? `${doc.sampleRate / 1000} kHz · ${doc.channels.length === 1 ? "mono" : doc.channels.length === 2 ? "stereo" : `${doc.channels.length} ch`} · ${
        doc.format.kind === "float" ? `${doc.format.bits}-bit float` : `${doc.format.bits}-bit`
      } · ${formatTime(ed.length / doc.sampleRate)}`
    : "";
  $("file-dirty").hidden = !ed.dirty;

  const undo = $<HTMLButtonElement>("btn-undo");
  const redo = $<HTMLButtonElement>("btn-redo");
  undo.disabled = !ed.canUndo;
  redo.disabled = !ed.canRedo;
  undo.title = ed.undoLabel ? `Undo ${ed.undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)";
  redo.title = ed.redoLabel ? `Redo ${ed.redoLabel} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)";
  for (const id of ["btn-save", "btn-save-as", "btn-download", "btn-zoom-in", "btn-zoom-out", "btn-zoom-fit", "btn-play"])
    $<HTMLButtonElement>(id).disabled = !doc;
  $<HTMLButtonElement>("btn-zoom-sel").disabled = !ed.selection;
  $("btn-play").textContent = player.playing ? "■" : "▶";
  $("btn-loop").setAttribute("aria-pressed", String(loop));

  for (const b of document.querySelectorAll<HTMLButtonElement>(".tools button"))
    b.setAttribute("aria-checked", String(b.dataset.tool === ed.tool));
  const rectBtns = document.querySelectorAll<HTMLButtonElement>("[data-rect]");
  rectBtns.forEach((b) => (b.disabled = !ed.rect));

  const pending = $("pending");
  pending.hidden = !ed.hasPending;
  const what = [ed.maskActive && "spectral", ed.envelopeActive && "envelope"].filter(Boolean).join(" + ");
  $("pending-label").textContent = `Pending ${what} edits`;
  $<HTMLInputElement>("pending-bypass").checked = ed.bypassPreview;

  // status bar
  const sr = ed.sampleRate;
  $("st-pos").textContent = doc ? `cursor ${formatTime(ed.cursor / sr)}` : "";
  const sel = ed.selection;
  $("st-sel").textContent = sel
    ? `sel ${formatTime(sel.start / sr)} → ${formatTime(sel.end / sr)} (${formatTime((sel.end - sel.start) / sr)})`
    : "";
  const h = ed.hover;
  $("st-hover").textContent =
    h && doc
      ? `@ ${formatTime(clamp(h.sample, 0, ed.length) / sr)}` +
        (h.freq !== null ? ` · ${formatHz(h.freq)}` : "") +
        (h.level !== undefined && h.level !== null ? ` · ${h.level.toFixed(1)} dB` : "")
      : "";

  if (player.playing) scheduleRender();
}

// ------------------------------------------------------------------ layout

const stage = $("stage");
new ResizeObserver(() => {
  ed.width = $("wave").clientWidth || 800;
  ed.clampView();
  scheduleRender();
}).observe(stage);

{
  const split = $("splitter");
  let startY = 0;
  let startH = 0;
  split.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    startH = $("wave").parentElement!.clientHeight;
    split.setPointerCapture(e.pointerId);
  });
  split.addEventListener("pointermove", (e) => {
    if (!split.hasPointerCapture(e.pointerId)) return;
    const total = $("wave").parentElement!.clientHeight + $("spec-ovl").parentElement!.clientHeight;
    const h = clamp(startH + e.clientY - startY, 60, total - 60);
    stage.style.setProperty("--wave-h", `${h}px`);
    stage.style.setProperty("--spec-h", `${total - h}px`);
  });
}

// ------------------------------------------------------------------ tool options

function slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) {
  const l = document.createElement("label");
  l.append(label);
  const i = document.createElement("input");
  i.type = "range";
  Object.assign(i, { min, max, step, value: String(get()) });
  const o = document.createElement("output");
  o.textContent = fmt(get());
  i.oninput = () => {
    set(Number(i.value));
    o.textContent = fmt(Number(i.value));
    scheduleRender();
  };
  l.append(i, o);
  // keep in sync when changed from elsewhere (e.g. Alt+wheel, [ ])
  (l as HTMLLabelElement & { sync?: () => void }).sync = () => {
    i.value = String(get());
    o.textContent = fmt(get());
  };
  return l;
}

function hint(text: string) {
  const s = document.createElement("span");
  s.className = "hint";
  s.textContent = text;
  return s;
}

function segmented<T extends string>(options: [T, string][], get: () => T, set: (v: T) => void) {
  const g = document.createElement("div");
  g.className = "group";
  const btns = options.map(([v, label]) => {
    const b = document.createElement("button");
    b.className = "small toggle";
    b.textContent = label;
    b.onclick = () => {
      set(v);
      btns.forEach((x, i) => x.setAttribute("aria-pressed", String(options[i][0] === get())));
      scheduleRender();
    };
    b.setAttribute("aria-pressed", String(v === get()));
    return b;
  });
  g.append(...btns);
  return g;
}

let syncers: (() => void)[] = [];
function buildToolOptions() {
  const box = $("tool-options");
  box.replaceChildren();
  syncers = [];
  const add = (...els: HTMLElement[]) => {
    for (const el of els) {
      const s = (el as HTMLElement & { sync?: () => void }).sync;
      if (s) syncers.push(s);
    }
    box.append(...els);
  };
  const b = ed.brush;
  switch (ed.tool) {
    case "select":
      add(hint("Drag to select · Shift+click extends · Wheel zooms, Shift+wheel scrolls"));
      break;
    case "envelope":
      add(hint("Click to add a point · drag to move · double-click to remove · Enter applies"));
      break;
    case "pencil":
      add(hint("Zoom in until individual samples show, then draw on a channel"));
      break;
    case "brush":
      add(
        segmented<typeof b.mode>([["cut", "Cut"], ["boost", "Boost"], ["restore", "Restore"]], () => b.mode, (v) => (b.mode = v)),
        slider("Size", 2, 400, 1, () => b.size, (v) => (b.size = v), (v) => `${v}px`),
        slider("Depth", 3, 120, 1, () => b.depth, (v) => (b.depth = v), (v) => `${v} dB`),
        slider("Flow", 0.02, 1, 0.01, () => b.strength, (v) => (b.strength = v), (v) => `${Math.round(v * 100)}%`),
        slider("Hardness", 0, 1, 0.01, () => b.hardness, (v) => (b.hardness = v), (v) => `${Math.round(v * 100)}%`),
        hint("Alt+wheel or [ ] resizes"),
      );
      break;
    case "rect": {
      const mk = (label: string, mode: "cut" | "boost" | "isolate", title: string) => {
        const btn = document.createElement("button");
        btn.className = "small";
        btn.textContent = label;
        btn.title = title;
        btn.dataset.rect = mode;
        btn.onclick = () => ed.rectAction(mode);
        return btn;
      };
      add(
        slider("Amount", 1, 120, 1, () => ed.rectGainDb, (v) => (ed.rectGainDb = v), (v) => `${v} dB`),
        mk("Cut", "cut", "Attenuate inside the region"),
        mk("Boost", "boost", "Boost inside the region (max +24 dB)"),
        mk("Isolate", "isolate", "Attenuate everything outside the region"),
        hint("Drag a time × frequency box on the spectrogram"),
      );
      break;
    }
  }
}

function setTool(t: Tool) {
  ed.tool = t;
  if (t !== "rect") ed.rect = null;
  buildToolOptions();
  ed.changed();
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".tools button")) b.onclick = () => setTool(b.dataset.tool as Tool);
buildToolOptions();

// ------------------------------------------------------------------ spectrogram settings

{
  const fft = $<HTMLSelectElement>("spec-fft");
  fft.onchange = () => {
    if (ed.maskActive) status("Applied pending spectral edits before changing FFT size");
    void busy("Analysing…", () => ed.setFftSize(Number(fft.value)));
  };
  $<HTMLSelectElement>("spec-scale").onchange = (e) => {
    ed.spec.log = (e.target as HTMLSelectElement).value === "log";
    scheduleRender();
  };
  const range = (id: string, key: "floorDb" | "ceilDb") => {
    const i = $<HTMLInputElement>(id);
    const o = $(`${id}-v`);
    const upd = () => {
      ed.spec[key] = Number(i.value);
      if (ed.spec.ceilDb - ed.spec.floorDb < 10) {
        if (key === "floorDb") ed.spec.floorDb = ed.spec.ceilDb - 10;
        else ed.spec.ceilDb = ed.spec.floorDb + 10;
        i.value = String(ed.spec[key]);
      }
      o.textContent = `${ed.spec[key]} dB`;
      scheduleRender();
    };
    i.oninput = upd;
    upd();
  };
  range("spec-floor", "floorDb");
  range("spec-ceil", "ceilDb");
  $<HTMLInputElement>("spec-tint").onchange = (e) => {
    ed.spec.tint = (e.target as HTMLInputElement).checked;
    scheduleRender();
  };
  $("pending-apply").onclick = () => void busy("Applying…", () => applyPending());
  $("pending-discard").onclick = () => ed.discardPending();
  $<HTMLInputElement>("pending-bypass").onchange = (e) => {
    ed.bypassPreview = (e.target as HTMLInputElement).checked;
    if (player.playing) restartPlayback();
    scheduleRender();
  };
}

function applyPending() {
  ed.applyPending();
  status("Applied pending edits");
}

// ------------------------------------------------------------------ transport

function play() {
  if (!ed.doc) return;
  const sel = ed.selection;
  const from = sel ? sel.start : ed.cursor >= ed.length - 1 ? 0 : ed.cursor;
  const to = sel ? sel.end : ed.length;
  const chs = ed.playbackChannels();
  player.play(chs, ed.sampleRate, ed.playbackKey, from, to, loop);
  scheduleRender();
}

function restartPlayback() {
  const pos = player.position();
  player.stop();
  if (pos === null || !ed.doc) return;
  const sel = ed.selection;
  const chs = ed.playbackChannels();
  const to = sel ? sel.end : ed.length;
  if (loop && sel) {
    player.play(chs, ed.sampleRate, ed.playbackKey, sel.start, sel.end, true);
  } else player.play(chs, ed.sampleRate, ed.playbackKey, Math.floor(pos), to, loop);
}

function togglePlay() {
  if (player.playing) {
    player.stop();
    ed.playhead = null;
    scheduleRender();
  } else play();
}

player.onEnded = () => {
  ed.playhead = null;
  scheduleRender();
};

// Re-render preview audio after edits while playing (e.g. painting during loop playback).
let lastPlaybackKey = "";
ed.onChange(() => {
  if (!player.playing || !ed.doc) return;
  const key = ed.playbackKey;
  if (key !== lastPlaybackKey) {
    lastPlaybackKey = key;
    // defer: brush strokes fire many changes per frame
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => player.playing && restartPlayback(), 120);
  }
});
let previewTimer = 0;

$("btn-play").onclick = togglePlay;
$("btn-loop").onclick = () => {
  loop = !loop;
  if (player.playing) restartPlayback();
  scheduleRender();
};
$("btn-undo").onclick = () => ed.undo();
$("btn-redo").onclick = () => ed.redo();
$("btn-zoom-in").onclick = () => ed.zoom(0.5);
$("btn-zoom-out").onclick = () => ed.zoom(2);
$("btn-zoom-fit").onclick = () => ed.fit();
$("btn-zoom-sel").onclick = () => ed.selection && ed.zoomTo(ed.selection);

// ------------------------------------------------------------------ files

function confirmDiscard(): boolean {
  return !ed.doc || !(ed.dirty || ed.hasPending) || confirm("Discard unsaved changes to the current file?");
}

async function openBytes(name: string, key: string | null, bytes: ArrayBuffer) {
  const audio = await decodeAudio(bytes);
  if (!audio.channels.length || !audio.channels[0].length) throw new Error("File contains no audio");
  player.stop();
  const doc: Doc = { name, key, sampleRate: audio.sampleRate, channels: audio.channels, format: audio.format };
  ed.load(doc);
  ed.getAnalysis();
  library.render();
  status(`Opened ${key ?? name}`);
}

async function openLocal(file: File) {
  if (!confirmDiscard()) return;
  await busy(`Decoding ${file.name}…`, async () => openBytes(file.name, null, await file.arrayBuffer()));
}

async function openFromStorage(key: string) {
  if (key === ed.doc?.key || !confirmDiscard()) return;
  await busy(`Loading ${key}…`, async () => openBytes(key.split("/").pop()!, key, await storage.get(key)));
}

function currentWav(): Blob {
  const doc = ed.doc!;
  return encodeWav(doc.channels, doc.sampleRate, doc.format);
}

function wavName(name: string) {
  return /\.wav$/i.test(name) ? name : name.replace(/\.[^./]+$/, "") + ".wav";
}

async function save(as: boolean) {
  const doc = ed.doc;
  if (!doc) return;
  if (!storage.configured) return openSettings();
  let key = doc.key && !as ? doc.key : null;
  if (!key) {
    key = prompt("Save to storage as (use / for folders):", wavName(doc.key ?? doc.name))?.trim() || null;
    if (!key) return;
  }
  if (!/\.wav$/i.test(key)) key = wavName(key);
  if (ed.hasPending) ed.applyPending();
  const finalKey = key;
  await busy(`Saving ${finalKey}…`, async () => {
    await storage.put(finalKey, currentWav(), {
      sampleRate: doc.sampleRate,
      channels: doc.channels.length,
      duration: (ed.length / doc.sampleRate).toFixed(4),
      format: `${doc.format.kind}${doc.format.bits}`,
    });
    doc.key = finalKey;
    ed.dirty = false;
    status(`Saved ${finalKey}`);
    await library.refresh();
    scheduleRender();
  });
}

function download() {
  const doc = ed.doc;
  if (!doc) return;
  if (ed.hasPending) ed.applyPending();
  const url = URL.createObjectURL(currentWav());
  const a = document.createElement("a");
  a.href = url;
  a.download = wavName((doc.key ?? doc.name).split("/").pop()!);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function uploadFiles(files: File[]) {
  if (!storage.configured) return openSettings();
  for (const f of files) {
    await busy(`Uploading ${f.name}…`, async () => {
      const meta: Record<string, string | number> = {};
      try {
        const a = await decodeAudio(await f.arrayBuffer());
        meta.sampleRate = a.sampleRate;
        meta.channels = a.channels.length;
        meta.duration = ((a.channels[0]?.length ?? 0) / a.sampleRate).toFixed(4);
        meta.format = `${a.format.kind}${a.format.bits}`;
      } catch {
        /* upload anyway, without metadata */
      }
      await storage.put(f.name, f, meta);
    });
  }
  status(`Uploaded ${files.length} file${files.length > 1 ? "s" : ""}`);
  await library.refresh();
}

const fileInput = $<HTMLInputElement>("file-input");
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (f) void openLocal(f);
};
$("btn-open").onclick = () => fileInput.click();
$("empty-open").onclick = () => fileInput.click();
$("btn-save").onclick = () => void save(false);
$("btn-save-as").onclick = () => void save(true);
$("btn-download").onclick = download;

// drag & drop: on the editor opens, on the library uploads
{
  const drop = $("drop");
  let depth = 0;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  stage.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    drop.hidden = false;
  });
  stage.addEventListener("dragleave", () => {
    if (--depth <= 0) {
      depth = 0;
      drop.hidden = true;
    }
  });
  stage.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    drop.hidden = true;
    const f = e.dataTransfer?.files[0];
    if (f) void openLocal(f);
  });
  const lib = document.querySelector<HTMLElement>(".library")!;
  lib.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  lib.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void uploadFiles(files);
  });
}

window.addEventListener("beforeunload", (e) => {
  if (ed.doc && (ed.dirty || ed.hasPending)) e.preventDefault();
});

// ------------------------------------------------------------------ settings

function openSettings() {
  const dlg = $<HTMLDialogElement>("settings");
  $<HTMLInputElement>("set-base").value = storage.config.apiBase;
  $<HTMLInputElement>("set-token").value = storage.config.token;
  $("set-result").textContent = "";
  dlg.showModal();
}

$("set-test").onclick = async () => {
  const s = new Storage({ apiBase: $<HTMLInputElement>("set-base").value.trim(), token: $<HTMLInputElement>("set-token").value.trim() });
  const out = $("set-result");
  out.textContent = "Testing…";
  try {
    const items = await s.list();
    out.textContent = `Connected — ${items.length} sample${items.length === 1 ? "" : "s"}.`;
  } catch (e) {
    out.textContent = `Failed: ${(e as Error).message}`;
  }
};

$<HTMLDialogElement>("settings").addEventListener("close", () => {
  const dlg = $<HTMLDialogElement>("settings");
  if (dlg.returnValue !== "save") return;
  storage.config = { apiBase: $<HTMLInputElement>("set-base").value.trim(), token: $<HTMLInputElement>("set-token").value.trim() };
  saveConfig(storage.config);
  void library.refresh();
});

// ------------------------------------------------------------------ keyboard

const TOOL_KEYS: Record<string, Tool> = { v: "select", e: "envelope", p: "pencil", b: "brush", r: "rect" };

window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea, dialog")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  // Space/Enter are app shortcuts: don't also activate whichever button has focus.
  if ((e.key === " " || e.key === "Enter") && t instanceof HTMLButtonElement) {
    e.preventDefault();
    t.blur();
  }
  if (mod && k === "z") {
    e.preventDefault();
    if (e.shiftKey) ed.redo();
    else ed.undo();
  } else if (mod && k === "y") {
    e.preventDefault();
    ed.redo();
  } else if (mod && k === "s") {
    e.preventDefault();
    void save(e.shiftKey);
  } else if (mod && k === "o") {
    e.preventDefault();
    fileInput.click();
  } else if (mod && k === "a") {
    e.preventDefault();
    if (ed.doc) ed.setSelection({ start: 0, end: ed.length });
  } else if (mod) {
    return;
  } else if (e.key === " ") {
    e.preventDefault();
    togglePlay();
  } else if (e.key === "Enter") {
    if (ed.hasPending) void busy("Applying…", () => applyPending());
  } else if (e.key === "Escape") {
    if (ed.rect) ed.rect = null;
    else ed.setSelection(null);
    ed.changed();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    const op = ed.ops.find((o) => o.id === "delete")!;
    if (ed.selection) ed.runOp(op, {});
  } else if (k in TOOL_KEYS) {
    setTool(TOOL_KEYS[k]);
  } else if (k === "l") {
    $("btn-loop").click();
  } else if (k === "f") {
    ed.fit();
  } else if (k === "z") {
    if (ed.selection) ed.zoomTo(ed.selection);
  } else if (e.key === "+" || e.key === "=") {
    ed.zoom(0.5);
  } else if (e.key === "-") {
    ed.zoom(2);
  } else if (e.key === "[" || e.key === "]") {
    ed.brush.size = clamp(Math.round(ed.brush.size * (e.key === "]" ? 1.25 : 0.8)), 2, 400);
    syncers.forEach((s) => s());
    ed.changed();
  } else if (e.key === "Home") {
    ed.cursor = 0;
    ed.reveal(0);
    ed.changed();
  } else if (e.key === "End") {
    ed.cursor = ed.length;
    ed.reveal(ed.length);
    ed.changed();
  }
});

// Alt+wheel brush resizing updates the slider too
ed.onChange(() => syncers.forEach((s) => s()));

void library.refresh();
scheduleRender();

// test/debug handle
(window as unknown as { sampleViz: unknown }).sampleViz = { ed, dsp, player, openBytes };
