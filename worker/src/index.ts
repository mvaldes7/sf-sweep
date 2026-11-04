/**
 * sf-sweep-alerts: stores {push subscription, parked spot, fire time} in D1 (no identity),
 * and a per-minute cron sends a payload-less Web Push (VAPID) when an alert is due, then deletes the row.
 * Payload-less push avoids message encryption; the service worker shows a fixed notification.
 */
export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN: string; // comma separated; "https://*.example.dev" style wildcards allowed
  VAPID_SUBJECT: string; // e.g. mailto:someone@example.com
  VAPID_PUBLIC_KEY: string; // secret binding not required (public), base64url raw P-256 point
  VAPID_PRIVATE_KEY: string; // secret: base64url "d"
  /** Optional Workers rate limiting binding (see wrangler.toml). Absent = in-memory best-effort limiter only. */
  API_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

interface SpotBody {
  subscription: { endpoint: string; keys?: Record<string, string> };
  spot: { cnn: string; side: string; lat: number; lng: number };
  fireAt: number;
}

const MAX_AHEAD_MS = 75 * 86400000;
export const MAX_BODY_BYTES = 4096;
export const MAX_SUBSCRIPTION_CHARS = 2048;
export const MAX_ROWS = 5000;
/** Free plan allows 50 subrequests per invocation; each due row costs up to 3 (claim, push, re-queue). */
export const SEND_BATCH = 15;
export const SEND_CONCURRENCY = 5;
const MEM_LIMIT = 30; // requests per IP per minute per isolate (fallback only)

/** Push service hosts. Exact entries match exactly; "*." entries match proper subdomains only. */
export const PUSH_HOSTS = ["fcm.googleapis.com", "*.push.services.mozilla.com", "*.notify.windows.com", "web.push.apple.com", "*.push.apple.com"];

export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  if (!/^https:\/\/[a-z0-9.-]+\//i.test(endpoint)) return false; // no userinfo/port/odd authority in the raw string
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => h.startsWith("*.")
    ? host.endsWith(h.slice(1)) && host.length > h.length - 1 && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, -(h.length - 1)))
    : host === h);
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

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Read a JSON body, refusing anything over max bytes by header or by actual streamed size. */
export async function readJsonCapped(req: Request, max = MAX_BODY_BYTES): Promise<unknown> {
  const cl = req.headers.get("content-length");
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > max)) throw new HttpError(413, "body too large");
  if (!req.body) throw new HttpError(400, "body required");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); throw new HttpError(413, "body too large"); }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { throw new HttpError(400, "bad json"); }
}

/** Rate-limit key: IPv4 as is, IPv6 by /64 prefix (one end user usually owns a whole /64). */
export function rateKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === "/api/health") return json({ ok: true }, 200, cors);
      if (url.pathname.startsWith("/api/") && (await rateLimited(req, env))) return json({ error: "rate limited" }, 429, { ...cors, "Retry-After": "60" });
      if (url.pathname === "/api/spot" && (req.method === "PUT" || req.method === "DELETE")) {
        if (!originAllowed(req.headers.get("origin"), env.ALLOWED_ORIGIN)) return json({ error: "origin not allowed" }, 403, cors);
      }
      if (url.pathname === "/api/spot" && req.method === "PUT") {
        const b = (await readJsonCapped(req)) as SpotBody;
        const err = validate(b);
        if (err) return json({ error: err }, 400, cors);
        const sub = JSON.stringify(b.subscription);
        if (sub.length > MAX_SUBSCRIPTION_CHARS) return json({ error: "subscription too large" }, 400, cors);
        const exists = await env.DB.prepare("SELECT 1 AS x FROM spots WHERE endpoint = ?1").bind(b.subscription.endpoint).first();
        if (!exists) {
          const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM spots").first<{ n: number }>();
          if ((c?.n ?? 0) >= MAX_ROWS) return json({ error: "alerts temporarily unavailable" }, 503, { ...cors, "Retry-After": "3600" });
        }
        await env.DB.prepare(
          `INSERT INTO spots (endpoint, subscription, cnn, side, lat, lng, fire_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(endpoint) DO UPDATE SET subscription=?2, cnn=?3, side=?4, lat=?5, lng=?6, fire_at=?7, created_at=?8`,
        ).bind(b.subscription.endpoint, sub, b.spot.cnn, b.spot.side,
          round(b.spot.lat), round(b.spot.lng), Math.floor(b.fireAt), Date.now()).run();
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/api/spot" && req.method === "DELETE") {
        const b = (await readJsonCapped(req)) as { endpoint?: unknown };
        if (typeof b?.endpoint !== "string" || !b.endpoint || b.endpoint.length > 1024) return json({ error: "endpoint required" }, 400, cors);
        await env.DB.prepare("DELETE FROM spots WHERE endpoint = ?1").bind(b.endpoint).run();
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      return json({ error: "bad request" }, 400, cors);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDue(env));
  },
};

interface SpotRow { endpoint: string; subscription: string; cnn: string; side: string; lat: number; lng: number; fire_at: number; created_at: number }

/** "sent" = done (delivered or permanently rejected); "retry" = re-queue for next minute. */
export function pushOutcome(status: number): "sent" | "retry" {
  if (status >= 200 && status < 300) return "sent";
  if (status === 429 || status >= 500) return "retry";
  return "sent"; // other 4xx are final (404/410 mean the subscription is gone)
}

async function mapBounded<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Claim-then-push: the row is deleted (atomically, only if unchanged) before the push is sent, so a failed DELETE
 * can never cause a duplicate notification. On a retryable failure the row is re-inserted unless the user saved
 * a newer one meanwhile.
 */
export async function sendDue(env: Env, now = Date.now(), push: (endpoint: string, env: Env) => Promise<Response> = sendPush) {
  const { results } = await env.DB.prepare("SELECT * FROM spots WHERE fire_at <= ?1 ORDER BY fire_at LIMIT ?2").bind(now, SEND_BATCH).all<SpotRow>();
  await mapBounded(results ?? [], SEND_CONCURRENCY, async (r) => {
    let claimed: unknown;
    try {
      claimed = await env.DB.prepare("DELETE FROM spots WHERE endpoint = ?1 AND fire_at = ?2 AND created_at = ?3 RETURNING endpoint")
        .bind(r.endpoint, r.fire_at, r.created_at).first();
    } catch { return; } // could not claim: leave for next minute, nothing sent
    if (!claimed) return; // changed or claimed by another run
    let outcome: "sent" | "retry";
    try { outcome = pushOutcome((await push(r.endpoint, env)).status); } catch { outcome = "retry"; }
    if (outcome === "retry" && r.fire_at >= now - 86400000) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO spots (endpoint, subscription, cnn, side, lat, lng, fire_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(r.endpoint, r.subscription, r.cnn, r.side, r.lat, r.lng, r.fire_at, r.created_at).run().catch(() => undefined);
    }
  });
  // garbage-collect anything stale (more than a day overdue)
  await env.DB.prepare("DELETE FROM spots WHERE fire_at < ?1").bind(now - 86400000).run();
}

const B64URL = /^[A-Za-z0-9_-]+$/;
export function validate(b: SpotBody, now = Date.now()): string | null {
  if (!b || typeof b !== "object" || !b.subscription || typeof b.subscription !== "object") return "subscription.endpoint required";
  if (typeof b.subscription.endpoint !== "string" || !/^https:\/\//.test(b.subscription.endpoint)) return "subscription.endpoint required";
  if (b.subscription.endpoint.length > 1024) return "endpoint too long";
  if (!isAllowedPushEndpoint(b.subscription.endpoint)) return "push service not allowed";
  const k = b.subscription.keys;
  if (k !== undefined) {
    if (!k || typeof k !== "object") return "keys invalid";
    // p256dh: 65-byte point = 87 chars; auth: 16 bytes = 22 chars. Allow padding-free slack.
    if (typeof k.p256dh !== "string" || !B64URL.test(k.p256dh) || k.p256dh.length < 80 || k.p256dh.length > 100) return "keys.p256dh invalid";
    if (typeof k.auth !== "string" || !B64URL.test(k.auth) || k.auth.length < 16 || k.auth.length > 32) return "keys.auth invalid";
    if (Object.keys(k).some((x) => x !== "p256dh" && x !== "auth")) return "keys invalid";
  }
  if (!b.spot || typeof b.spot.lat !== "number" || typeof b.spot.lng !== "number" || !Number.isFinite(b.spot.lat) || !Number.isFinite(b.spot.lng)) return "spot required";
  if (typeof b.spot.cnn !== "string" || !/^\d{1,10}$/.test(b.spot.cnn)) return "spot.cnn invalid";
  if (b.spot.lat < 37.6 || b.spot.lat > 37.9 || b.spot.lng < -122.6 || b.spot.lng > -122.3) return "spot outside San Francisco";
  if (!["L", "R"].includes(b.spot.side)) return "side must be L or R";
  if (typeof b.fireAt !== "number" || !Number.isFinite(b.fireAt) || b.fireAt < now - 60000 || b.fireAt > now + MAX_AHEAD_MS) return "fireAt out of range";
  return null;
}

async function sendPush(endpoint: string, env: Env): Promise<Response> {
  if (!isAllowedPushEndpoint(endpoint)) return new Response(null, { status: 400 }); // final: row is dropped
  const aud = new URL(endpoint).origin;
  const jwt = await vapidJwt(aud, env);
  return fetch(endpoint, {
    method: "POST", redirect: "manual",
    headers: { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, TTL: "3600", Urgency: "high", "Content-Length": "0" },
  });
}

let keyCache: CryptoKey | null = null;
async function vapidJwt(aud: string, env: Env): Promise<string> {
  if (!keyCache) {
    const pub = b64urlDecode(env.VAPID_PUBLIC_KEY);
    keyCache = await crypto.subtle.importKey("jwk", {
      kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY,
      x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: false,
    }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const enc = new TextEncoder();
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyCache, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return originAllowed(origin, env.ALLOWED_ORIGIN) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" } : { Vary: "Origin" };
}
function json(o: unknown, status: number, h: Record<string, string>) {
  return new Response(JSON.stringify(o), { status, headers: { ...h, "content-type": "application/json" } });
}
function round(v: number) { return Math.round(v * 1e5) / 1e5; }
export function b64urlEncode(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
