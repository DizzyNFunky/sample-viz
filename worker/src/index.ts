/**
 * sample-viz storage API: a thin, single-user REST layer over an R2 bucket.
 *
 *   GET    /api/samples?prefix=&cursor=   list samples (JSON)
 *   GET    /api/samples/<key>             download (supports Range / conditional requests)
 *   HEAD   /api/samples/<key>             metadata only
 *   PUT    /api/samples/<key>             upload body; optional `x-sample-meta: {json}`
 *   DELETE /api/samples/<key>             delete
 *   POST   /api/rename  {"from","to"}     move a sample
 *
 * Every /api request must carry `Authorization: Bearer <API_TOKEN>`.
 * Anything else is served from the static editor build.
 */

export interface Env {
  SAMPLES: R2Bucket;
  ASSETS: Fetcher;
  API_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
}

/** Objects live under this prefix so the bucket can hold other data later (projects, effect presets, ...). */
const ROOT = "samples/";
const MAX_META_BYTES = 2000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    let res: Response;
    try {
      if (!(await authorized(req, env))) {
        res = json({ error: "unauthorized" }, 401);
      } else {
        res = await route(req, url, env);
      }
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message }, err.status);
      else {
        console.error(err);
        res = json({ error: "internal error" }, 500);
      }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
} satisfies ExportedHandler<Env>;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function route(req: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/samples" || path === "/api/samples/") {
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    return list(url, env);
  }

  if (path.startsWith("/api/samples/")) {
    const key = parseKey(path.slice("/api/samples/".length));
    switch (req.method) {
      case "GET":
      case "HEAD":
        return get(req, key, env);
      case "PUT":
        return put(req, key, env);
      case "DELETE":
        await env.SAMPLES.delete(ROOT + key);
        return new Response(null, { status: 204 });
      default:
        throw new HttpError(405, "method not allowed");
    }
  }

  if (path === "/api/rename" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { from?: string; to?: string } | null;
    if (!body?.from || !body?.to) throw new HttpError(400, "expected {from, to}");
    const from = parseKey(body.from);
    const to = parseKey(body.to);
    const obj = await env.SAMPLES.get(ROOT + from);
    if (!obj) throw new HttpError(404, "not found");
    if (from !== to) {
      await env.SAMPLES.put(ROOT + to, obj.body, {
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
      });
      await env.SAMPLES.delete(ROOT + from);
    }
    return json({ key: to });
  }

  throw new HttpError(404, "not found");
}

async function list(url: URL, env: Env): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? "";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const res = await env.SAMPLES.list({
    prefix: ROOT + prefix,
    cursor,
    limit: 1000,
    include: ["httpMetadata", "customMetadata"],
  });
  return json({
    samples: res.objects.map((o) => ({
      key: o.key.slice(ROOT.length),
      size: o.size,
      uploaded: o.uploaded.toISOString(),
      etag: o.httpEtag,
      contentType: o.httpMetadata?.contentType ?? null,
      meta: o.customMetadata ?? {},
    })),
    cursor: res.truncated ? res.cursor : null,
  });
}

async function get(req: Request, key: string, env: Env): Promise<Response> {
  const obj = await env.SAMPLES.get(ROOT + key, { range: req.headers, onlyIf: req.headers });
  if (obj === null) throw new HttpError(404, "not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-cache");
  headers.set("x-sample-meta", JSON.stringify(obj.customMetadata ?? {}));
  // `onlyIf` precondition failed -> R2Object without body
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  if (req.method === "HEAD") {
    headers.set("content-length", String(obj.size));
    return new Response(null, { headers });
  }
  const range = obj.range as { offset?: number; length?: number } | undefined;
  if (req.headers.has("range") && range && range.offset !== undefined) {
    const length = range.length ?? obj.size - range.offset;
    headers.set("content-range", `bytes ${range.offset}-${range.offset + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

async function put(req: Request, key: string, env: Env): Promise<Response> {
  if (!req.body) throw new HttpError(400, "empty body");
  const meta = parseMeta(req.headers.get("x-sample-meta"));
  const obj = await env.SAMPLES.put(ROOT + key, req.body, {
    httpMetadata: { contentType: req.headers.get("content-type") ?? "application/octet-stream" },
    customMetadata: meta,
  });
  return json({ key, size: obj.size, etag: obj.httpEtag, uploaded: obj.uploaded.toISOString() }, 201);
}

function parseKey(raw: string): string {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "bad key encoding");
  }
  if (
    !key ||
    key.length > 512 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.split("/").some((seg) => seg === "" || seg === "." || seg === "..") ||
    /[\u0000-\u001f\u007f\\]/.test(key)
  ) {
    throw new HttpError(400, "invalid key");
  }
  return key;
}

function parseMeta(header: string | null): Record<string, string> {
  if (!header) return {};
  if (header.length > MAX_META_BYTES) throw new HttpError(400, "metadata too large");
  let raw: unknown;
  try {
    raw = JSON.parse(header);
  } catch {
    throw new HttpError(400, "x-sample-meta must be JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "x-sample-meta must be an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

async function authorized(req: Request, env: Env): Promise<boolean> {
  const token = env.API_TOKEN;
  if (!token) return false; // fail closed: a token must be configured
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const enc = new TextEncoder();
  // Hash both sides so lengths match, then compare in constant time.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, PUT, DELETE, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-sample-meta, range",
    "access-control-expose-headers": "x-sample-meta, etag, content-range",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
