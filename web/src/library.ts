/** Sidebar listing samples stored in R2. */
import { SampleInfo, Storage } from "./storage";
import { formatBytes, formatTime } from "./util";

export interface LibraryHooks {
  open(key: string): void;
  upload(files: File[]): Promise<void>;
  status(msg: string, err?: boolean): void;
  openSettings(): void;
  activeKey(): string | null;
}

export class LibraryPanel {
  private items: SampleInfo[] = [];
  private list = document.getElementById("lib-list") as HTMLUListElement;
  private statusEl = document.getElementById("lib-status")!;
  private filter = document.getElementById("lib-filter") as HTMLInputElement;

  constructor(private storage: Storage, private hooks: LibraryHooks) {
    document.getElementById("lib-refresh")!.onclick = () => this.refresh();
    document.getElementById("lib-settings")!.onclick = () => hooks.openSettings();
    const input = document.getElementById("lib-upload-input") as HTMLInputElement;
    document.getElementById("lib-upload")!.onclick = () => {
      if (!this.storage.configured) return hooks.openSettings();
      input.click();
    };
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      if (files.length) await hooks.upload(files);
    };
    this.filter.oninput = () => this.render();
  }

  async refresh() {
    if (!this.storage.configured) {
      this.items = [];
      this.statusEl.innerHTML = "";
      const p = document.createElement("span");
      p.textContent = "Storage not connected. ";
      const b = document.createElement("button");
      b.className = "link";
      b.textContent = "Connect";
      b.onclick = () => this.hooks.openSettings();
      this.statusEl.append(p, b);
      this.render();
      return;
    }
    this.statusEl.textContent = "Loading…";
    try {
      this.items = await this.storage.list();
      this.items.sort((a, b) => a.key.localeCompare(b.key));
      this.statusEl.textContent = this.items.length ? "" : "No samples yet — upload or save one.";
    } catch (e) {
      this.statusEl.innerHTML = "";
      const s = document.createElement("span");
      s.className = "err";
      s.textContent = `Could not list samples: ${(e as Error).message}`;
      this.statusEl.append(s);
    }
    this.render();
  }

  render() {
    const q = this.filter.value.trim().toLowerCase();
    const active = this.hooks.activeKey();
    this.list.replaceChildren();
    let folder: string | null = null;
    for (const it of this.items) {
      if (q && !it.key.toLowerCase().includes(q)) continue;
      const slash = it.key.lastIndexOf("/");
      const dir = slash >= 0 ? it.key.slice(0, slash) : "";
      const base = slash >= 0 ? it.key.slice(slash + 1) : it.key;
      if (dir !== folder) {
        folder = dir;
        if (dir) {
          const h = document.createElement("li");
          h.className = "folder";
          h.textContent = `${dir}/`;
          this.list.append(h);
        }
      }
      const li = document.createElement("li");
      if (it.key === active) li.classList.add("active");
      li.title = it.key;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = base;
      const meta = document.createElement("span");
      meta.className = "meta";
      const m = it.meta;
      const parts = [];
      if (m.duration) parts.push(formatTime(Number(m.duration), 2));
      if (m.sampleRate) parts.push(`${Number(m.sampleRate) / 1000} kHz`);
      if (m.channels) parts.push(m.channels === "1" ? "mono" : m.channels === "2" ? "stereo" : `${m.channels} ch`);
      parts.push(formatBytes(it.size));
      meta.textContent = parts.join(" · ");
      const actions = document.createElement("span");
      actions.className = "actions";
      const ren = document.createElement("button");
      ren.textContent = "Rename";
      ren.onclick = (e) => {
        e.stopPropagation();
        void this.rename(it.key);
      };
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "danger";
      del.onclick = (e) => {
        e.stopPropagation();
        void this.remove(it.key);
      };
      actions.append(ren, del);
      li.append(name, actions, meta);
      li.onclick = () => this.hooks.open(it.key);
      this.list.append(li);
    }
  }

  private async rename(key: string) {
    const to = prompt("Rename to (use / for folders):", key)?.trim();
    if (!to || to === key) return;
    try {
      await this.storage.rename(key, to);
      this.hooks.status(`Renamed to ${to}`);
      await this.refresh();
    } catch (e) {
      this.hooks.status(`Rename failed: ${(e as Error).message}`, true);
    }
  }

  private async remove(key: string) {
    if (!confirm(`Delete "${key}" from storage? This cannot be undone.`)) return;
    try {
      await this.storage.delete(key);
      this.hooks.status(`Deleted ${key}`);
      await this.refresh();
    } catch (e) {
      this.hooks.status(`Delete failed: ${(e as Error).message}`, true);
    }
  }
}
