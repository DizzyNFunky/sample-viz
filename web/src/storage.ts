/** Client for the R2-backed storage Worker (worker/src/index.ts). */

export interface SampleInfo {
  key: string;
  size: number;
  uploaded: string;
  etag: string;
  contentType: string | null;
  meta: Record<string, string>;
}

export interface StorageConfig {
  /** Base URL of the API; empty = same origin. */
  apiBase: string;
  token: string;
}

const CONFIG_KEY = "sample-viz.storage";

export function loadConfig(): StorageConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { apiBase: "", token: "", ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { apiBase: "", token: "" };
}

export function saveConfig(cfg: StorageConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* storage unavailable */
  }
}

export class StorageError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export class Storage {
  constructor(public config: StorageConfig) {}

  get configured() {
    return !!this.config.token;
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.token}`);
    const base = this.config.apiBase.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/${path}`, { ...init, headers });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* not json */
      }
      throw new StorageError(res.status, `${res.status} ${msg}`);
    }
    return res;
  }

  async list(prefix = ""): Promise<SampleInfo[]> {
    const out: SampleInfo[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ prefix });
      if (cursor) q.set("cursor", cursor);
      const res = await this.req(`samples?${q}`);
      const body = (await res.json()) as { samples: SampleInfo[]; cursor: string | null };
      out.push(...body.samples);
      cursor = body.cursor;
    } while (cursor);
    return out;
  }

  async get(key: string): Promise<ArrayBuffer> {
    const res = await this.req(`samples/${encodeKey(key)}`);
    return res.arrayBuffer();
  }

  async put(key: string, body: Blob, meta: Record<string, string | number> = {}): Promise<void> {
    await this.req(`samples/${encodeKey(key)}`, {
      method: "PUT",
      body,
      headers: { "content-type": body.type || "application/octet-stream", "x-sample-meta": JSON.stringify(meta) },
    });
  }

  async delete(key: string): Promise<void> {
    await this.req(`samples/${encodeKey(key)}`, { method: "DELETE" });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.req("rename", {
      method: "POST",
      body: JSON.stringify({ from, to }),
      headers: { "content-type": "application/json" },
    });
  }
}
