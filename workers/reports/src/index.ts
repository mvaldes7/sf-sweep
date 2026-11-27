/**
 * sf-sweep-reports: accept a sign photo + optional hours, store in KV + D1, and
 * serve a review queue. A confirmed report returns a proposed corrections.json
 * entry (same schema as src/data/corrections.json) and does not write git or deploy the map.
 *
 * Do not deploy this module without Mike's explicit OK. The live placeholder is src/stub.ts.
 */
import { mimeFor, stripExif, MAX_PHOTO_BYTES } from "./exif";
import { proposedCorrection, reportedDate, rulesFromConfirm } from "./corrections";
import { fieldsFromForm, validateSubmit, type SubmitFields } from "./validate";
import type { Env } from "./env";
import { DAILY_SUBMIT_CAP, PENDING_REPORT_CEILING, PHOTO_TTL_SECONDS, isPendingPhotoExpired, roundCoord, secondsUntilNextUtcMidnight, startOfUtcDay, withExpiredFlag } from "./limits";
import { scheduleCleanup } from "./cleanup";
import { originAllowed, rateLimited, reviewAuthorized, verifyTurnstile } from "./http";

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function countRows(env: Env, sql: string, bind?: number): Promise<number> {
  const stmt = bind === undefined ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(bind);
  const row = await stmt.first<{ n: number }>();
  return Number(row?.n ?? 0);
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
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
        return await handleReviewList(env, cors, ctx);
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

async function handleReviewList(env: Env, cors: Record<string, string>, ctx?: ExecutionContext): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, status, cnn, side, street, limits, blockside, lat, lng, days, from_time, to_time, weeks, holidays, note, created_at, reviewed_at FROM reports ORDER BY created_at DESC LIMIT 200",
  ).all<Record<string, unknown>>();
  const reports = (results ?? []).map((row) => withExpiredFlag(row));
  const res = json({ reports }, 200, cors);
  scheduleCleanup(env, ctx);
  return res;
}

async function handleReviewOne(env: Env, id: string, cors: Record<string, string>): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not found");
  return json({ report: withExpiredFlag(row) }, 200, cors);
}

async function handleReviewPhoto(env: Env, id: string, cors: Record<string, string>): Promise<Response> {
  const row = await env.DB.prepare("SELECT photo_key, photo_type, status, created_at FROM reports WHERE id = ?").bind(id).first<{ photo_key: string; photo_type: string; status: string; created_at: number }>();
  if (!row) throw new HttpError(404, "not found");
  if (isPendingPhotoExpired(row.status, row.created_at)) {
    return json({ error: "expired" }, 410, cors);
  }
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

