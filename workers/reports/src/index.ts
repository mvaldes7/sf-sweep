/**
 * sf-sweep-reports: accept a sign photo + optional hours, store in KV + D1, and
 * serve a review queue. A confirmed report returns a proposed corrections.json
 * entry (same schema as src/data/corrections.json) and does not write git or deploy the map.
 *
 * Do not deploy this module without Mike's explicit OK. The live placeholder is src/stub.ts.
 */
import { mimeFor, stripExif, MAX_PHOTO_BYTES } from "./exif";
import { proposedCorrection, normalizeClock, parseDay, normalizeWeeks, reportedDate, type CorrectionRule } from "./corrections";
import { fieldsFromForm, validateSubmit, type SubmitFields } from "./validate";

export interface Env {
  DB: D1Database;
  PHOTOS: KVNamespace;
  ALLOWED_ORIGIN: string;
  TURNSTILE_SITE_KEY?: string;
  /** When unset or empty, Turnstile verification is skipped (v1). */
  TURNSTILE_SECRET?: string;
  REVIEW_TOKEN: string;
  API_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Max pending reports kept in D1/KV at once. */
export const PENDING_REPORT_CEILING = 200;
/** Daily submit cap, under the 1k/day KV write free-tier limit. */
export const DAILY_SUBMIT_CAP = 300;
/** Photo object TTL in KV (seconds). */
export const PHOTO_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Rejected and confirmed rows are kept this many days, then cleaned up. */
export const REPORT_RETENTION_DAYS = 90;

/** Round stored coordinates to 4 decimal degrees (about 10 m). */
export function roundCoord(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function secondsUntilNextUtcMidnight(now: number): number {
  return Math.max(1, Math.ceil((startOfUtcDay(now) + 24 * 60 * 60 * 1000 - now) / 1000));
}

async function countRows(env: Env, sql: string, bind?: number): Promise<number> {
  const stmt = bind === undefined ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(bind);
  const row = await stmt.first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Delete rejected/confirmed reports (and their photos) older than 90 days. No schema change. */
export async function cleanupExpiredReports(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    "SELECT id, photo_key FROM reports WHERE status IN ('rejected', 'confirmed') AND COALESCE(reviewed_at, created_at) < ?",
  ).bind(cutoff).all<{ id: string; photo_key: string | null }>();
  const rows = results ?? [];
  for (const r of rows) {
    if (r.photo_key) {
      try { await env.PHOTOS.delete(r.photo_key); } catch (e) { console.warn("photo delete failed", r.photo_key, String(e)); }
    }
    await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(r.id).run();
  }
  return rows.length;
}


export function originAllowed(origin: string | null, allowedCsv: string): boolean {
  if (!origin) return false;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  for (const a of (allowedCsv || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (a === origin) return true;
    const m = /^(https?):\/\/\*\.(.+)$/.exec(a) ?? (/^\*\.(.+)$/.exec(a) ? ["", "https", a.slice(2)] : null);
    if (m && u.protocol === `${m[1]}:` && !u.port && u.hostname.endsWith(`.${m[2]}`)) return true;
  }
  return false;
}

/** Rate-limit key: IPv4 as is, IPv6 by /64 prefix. */
export function rateKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

const MEM_LIMIT = 5;
const memHits = new Map<string, { t: number; n: number }>();
export async function rateLimited(req: Request, env: Env, now = Date.now()): Promise<boolean> {
  const ip = rateKey(req.headers.get("cf-connecting-ip") || "unknown");
  if (env.API_LIMITER) {
    try { return !(await env.API_LIMITER.limit({ key: ip })).success; } catch (e) { console.warn("rate limiter binding failed", String(e)); }
  }
  const minute = Math.floor(now / 60000);
  const e = memHits.get(ip);
  if (!e || e.t !== minute) {
    if (memHits.size > 10000) memHits.clear();
    memHits.set(ip, { t: minute, n: 1 });
    return false;
  }
  e.n++;
  return e.n > MEM_LIMIT;
}

/** Timing-safe compare of review tokens. */
export function reviewAuthorized(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const hdr = req.headers.get("authorization") || "";
  const bearer = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7).trim() : "";
  const alt = req.headers.get("x-review-token") || "";
  const got = bearer || alt;
  return got.length === token.length && timingSafeEqual(got, token);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export async function verifyTurnstile(token: string, secret: string, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!secret || !token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return originAllowed(origin, env.ALLOWED_ORIGIN)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, x-review-token", Vary: "Origin" }
    : { Vary: "Origin" };
}
function json(o: unknown, status: number, h: Record<string, string>) {
  return new Response(JSON.stringify(o), { status, headers: { ...h, "content-type": "application/json; charset=utf-8" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: originAllowed(req.headers.get("origin"), env.ALLOWED_ORIGIN) ? 204 : 403, headers: cors });
    try {
      if (url.pathname === "/api/health") return json({ ok: true, service: "sf-sweep-reports" }, 200, cors);

      if (url.pathname === "/api/reports" && req.method === "POST") {
        if (!originAllowed(req.headers.get("origin"), env.ALLOWED_ORIGIN)) return json({ error: "origin not allowed" }, 403, cors);
        if (await rateLimited(req, env)) return json({ error: "rate limited" }, 429, { ...cors, "Retry-After": "60" });
        return await handleSubmit(req, env, cors);
      }

      const review = /^\/api\/review(?:\/([^/]+))?(?:\/(confirm|reject|edit|photo))?$/.exec(url.pathname);
      if (review && req.method === "GET" && url.pathname === "/api/review") {
        if (!reviewAuthorized(req, env.REVIEW_TOKEN)) return json({ error: "unauthorized" }, 401, cors);
        return await handleReviewList(env, cors);
      }
      if (review && review[1] && review[2] === "photo" && req.method === "GET") {
        if (!reviewAuthorized(req, env.REVIEW_TOKEN)) return json({ error: "unauthorized" }, 401, cors);
        return await handleReviewPhoto(env, review[1], cors);
      }
      if (review && review[1] && req.method === "GET" && !review[2]) {
        if (!reviewAuthorized(req, env.REVIEW_TOKEN)) return json({ error: "unauthorized" }, 401, cors);
        return await handleReviewOne(env, review[1], cors);
      }
      if (review && review[1] && req.method === "POST" && (review[2] === "confirm" || review[2] === "reject" || review[2] === "edit")) {
        if (!reviewAuthorized(req, env.REVIEW_TOKEN)) return json({ error: "unauthorized" }, 401, cors);
        return await handleReviewAction(req, env, review[1], review[2], cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const msg = e instanceof HttpError ? e.message : "server error";
      if (status === 500) console.error("reports worker", String(e));
      return json({ error: msg }, status, cors);
    }
  },
};

async function handleSubmit(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("multipart/form-data")) throw new HttpError(400, "expected multipart form data");
  const cl = req.headers.get("content-length");
  if (cl == null || cl === "") throw new HttpError(411, "content-length required");
  // multipart overhead + 3 MB photo
  if (!/^\d+$/.test(cl) || Number(cl) > MAX_PHOTO_BYTES + 64 * 1024) throw new HttpError(413, "body too large");
  const form = await req.formData();
  const files = form.getAll("photo").filter((v) => typeof v !== "string") as { size: number; arrayBuffer: () => Promise<ArrayBuffer> }[];
  if (files.length !== 1) throw new HttpError(400, "exactly one photo is required");
  const photo = files[0];
  if (photo.size > MAX_PHOTO_BYTES) throw new HttpError(413, "photo too large");
  const raw = new Uint8Array(await photo.arrayBuffer());
  let stripped: ReturnType<typeof stripExif>;
  try { stripped = stripExif(raw); } catch (e) { throw new HttpError(400, (e as Error).message || "invalid photo"); }

  const fields = fieldsFromForm(form);
  const secret = (env.TURNSTILE_SECRET || "").trim();
  const err = validateSubmit(fields, { requireTurnstile: !!secret });
  if (err) throw new HttpError(400, err);
  const f = fields as SubmitFields;

  const ip = req.headers.get("cf-connecting-ip");
  if (secret) {
    const ok = await verifyTurnstile(f.turnstile || "", secret, ip);
    if (!ok) throw new HttpError(403, "turnstile failed");
  }

  const pending = await countRows(env, "SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'");
  if (pending >= PENDING_REPORT_CEILING) {
    return json({ error: "too many pending reports" }, 503, { ...cors, "Retry-After": "3600" });
  }
  const now = Date.now();
  const today = await countRows(env, "SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?", startOfUtcDay(now));
  if (today >= DAILY_SUBMIT_CAP) {
    return json({ error: "daily submit limit reached" }, 429, { ...cors, "Retry-After": String(secondsUntilNextUtcMidnight(now)) });
  }

  const id = crypto.randomUUID();
  const key = id; // KV key is the report id
  const lat = roundCoord(f.lat);
  const lng = roundCoord(f.lng);
  await env.DB.prepare(
    `INSERT INTO reports (id, status, cnn, side, street, limits, blockside, lat, lng, days, from_time, to_time, weeks, holidays, note, photo_key, photo_type, created_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, f.cnn, f.side, f.street ?? null, f.limits ?? null, f.blockside ?? null, lat, lng,
    f.days ? JSON.stringify(f.days) : null, f.from ?? null, f.to ?? null, f.weeks ? JSON.stringify(f.weeks) : null,
    f.holidays ? 1 : 0, f.note ?? null, key, mimeFor(stripped.kind), now,
  ).run();
  try {
    await env.PHOTOS.put(key, stripped.bytes, { expirationTtl: PHOTO_TTL_SECONDS, metadata: { contentType: mimeFor(stripped.kind) } });
  } catch (e) {
    try { await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run(); } catch (del) { console.warn("rollback failed", String(del)); }
    throw e;
  }
  return json({ ok: true, id }, 201, cors);
}

async function handleReviewList(env: Env, cors: Record<string, string>): Promise<Response> {
  try { await cleanupExpiredReports(env); } catch (e) { console.warn("cleanup expired reports failed", String(e)); }
  const { results } = await env.DB.prepare(
    "SELECT id, status, cnn, side, street, limits, blockside, lat, lng, days, from_time, to_time, weeks, holidays, note, created_at, reviewed_at FROM reports ORDER BY created_at DESC LIMIT 200",
  ).all();
  return json({ reports: results }, 200, cors);
}

async function handleReviewOne(env: Env, id: string, cors: Record<string, string>): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not found");
  return json({ report: row }, 200, cors);
}

async function handleReviewPhoto(env: Env, id: string, cors: Record<string, string>): Promise<Response> {
  const row = await env.DB.prepare("SELECT photo_key, photo_type FROM reports WHERE id = ?").bind(id).first<{ photo_key: string; photo_type: string }>();
  if (!row) throw new HttpError(404, "not found");
  const got = await env.PHOTOS.getWithMetadata<{ contentType?: string }>(row.photo_key, "arrayBuffer");
  if (got.value == null) throw new HttpError(404, "photo missing");
  const ct = got.metadata?.contentType || row.photo_type || "application/octet-stream";
  return new Response(got.value, { status: 200, headers: { ...cors, "content-type": ct, "cache-control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } });
}

async function handleReviewAction(req: Request, env: Env, id: string, action: string, cors: Record<string, string>): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not found");
  if (row.status !== "pending") throw new HttpError(409, "report already reviewed");
  let body: Record<string, unknown> = {};
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json") && req.headers.get("content-length") !== "0") {
    try { body = (await req.json()) as Record<string, unknown>; } catch { throw new HttpError(400, "bad json"); }
  }
  const now = Date.now();
  if (action === "reject") {
    await env.DB.prepare("UPDATE reports SET status = 'rejected', reviewed_at = ?, review_note = ? WHERE id = ?")
      .bind(now, typeof body.note === "string" ? body.note : null, id).run();
    if (typeof row.photo_key === "string" && row.photo_key) {
      try { await env.PHOTOS.delete(row.photo_key); } catch (e) { console.warn("photo delete failed", String(e)); }
    }
    return json({ ok: true, id, status: "rejected" }, 200, cors);
  }
  if (action === "edit") {
    const days = body.days != null ? JSON.stringify(body.days) : row.days;
    const from = typeof body.from === "string" ? body.from : row.from_time;
    const to = typeof body.to === "string" ? body.to : row.to_time;
    const weeks = body.weeks != null ? JSON.stringify(body.weeks) : row.weeks;
    const note = typeof body.note === "string" ? body.note : row.note;
    const holidays = body.holidays === true ? 1 : body.holidays === false ? 0 : row.holidays;
    await env.DB.prepare("UPDATE reports SET days = ?, from_time = ?, to_time = ?, weeks = ?, holidays = ?, note = ? WHERE id = ?")
      .bind(days ?? null, from ?? null, to ?? null, weeks ?? null, holidays ?? 0, note ?? null, id).run();
    return json({ ok: true, id, status: "pending" }, 200, cors);
  }
  // confirm
  const rules = rulesFromConfirm(body, row);
  const draft = {
    cnn: String(body.cnn ?? row.cnn),
    side: (body.side ?? row.side) as "L" | "R",
    street: (body.street ?? row.street) as string | undefined,
    limits: (body.limits ?? row.limits) as string | undefined,
    blockside: (body.blockside ?? row.blockside) as string | undefined,
    rules,
    reported: reportedDate(Number(row.created_at) || now),
    note: typeof body.note === "string" ? body.note : (row.note as string | undefined),
    reportId: id,
  };
  const entry = proposedCorrection(draft);
  if ("error" in entry) throw new HttpError(400, entry.error);
  await env.DB.prepare("UPDATE reports SET status = 'confirmed', reviewed_at = ?, review_note = ?, correction_json = ? WHERE id = ?")
    .bind(now, draft.note ?? null, JSON.stringify(entry), id).run();
  return json({ ok: true, id, status: "confirmed", correction: entry }, 200, cors);
}

export function rulesFromConfirm(body: Record<string, unknown>, row: Record<string, unknown>): CorrectionRule[] {
  if (Array.isArray(body.rules)) return body.rules as CorrectionRule[];
  const daysRaw = body.days ?? row.days;
  let days: string[] = [];
  if (Array.isArray(daysRaw)) days = daysRaw.map(String);
  else if (typeof daysRaw === "string" && daysRaw) {
    try { days = JSON.parse(daysRaw) as string[]; } catch { days = []; }
  }
  const from = normalizeClock(String(body.from ?? row.from_time ?? ""), false);
  const to = normalizeClock(String(body.to ?? row.to_time ?? ""), true);
  let weeks = normalizeWeeks(body.weeks);
  if (!weeks && typeof row.weeks === "string" && row.weeks) {
    try { weeks = normalizeWeeks(JSON.parse(row.weeks)); } catch { weeks = [1, 2, 3, 4, 5]; }
  }
  if (!weeks) weeks = [1, 2, 3, 4, 5];
  const holidays = body.holidays === true || row.holidays === 1;
  if (!days.length || !from || !to) return [];
  return days.map((d) => ({ day: parseDay(d) ?? d, weeks, from, to, holidays }));
}
