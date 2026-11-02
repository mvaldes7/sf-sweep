/**
 * sf-sweep-alerts: stores {push subscription, parked spot, fire time} in D1 (no identity),
 * and a per-minute cron sends a payload-less Web Push (VAPID) when an alert is due, then deletes the row.
 * Payload-less push avoids message encryption; the service worker shows a fixed notification.
 */
export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN: string; // comma separated
  VAPID_SUBJECT: string; // e.g. mailto:someone@example.com
  VAPID_PUBLIC_KEY: string; // secret binding not required (public), base64url raw P-256 point
  VAPID_PRIVATE_KEY: string; // secret: base64url "d"
}

interface SpotBody {
  subscription: { endpoint: string; keys?: Record<string, string> };
  spot: { cnn: string; side: string; lat: number; lng: number };
  fireAt: number;
}

const MAX_AHEAD_MS = 75 * 86400000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === "/api/health") return json({ ok: true }, 200, cors);
      if (url.pathname === "/api/spot" && req.method === "PUT") {
        const b = (await req.json()) as SpotBody;
        const err = validate(b);
        if (err) return json({ error: err }, 400, cors);
        await env.DB.prepare(
          `INSERT INTO spots (endpoint, subscription, cnn, side, lat, lng, fire_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(endpoint) DO UPDATE SET subscription=?2, cnn=?3, side=?4, lat=?5, lng=?6, fire_at=?7, created_at=?8`,
        ).bind(b.subscription.endpoint, JSON.stringify(b.subscription), b.spot.cnn, b.spot.side,
          round(b.spot.lat), round(b.spot.lng), Math.floor(b.fireAt), Date.now()).run();
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/api/spot" && req.method === "DELETE") {
        const b = (await req.json()) as { endpoint?: string };
        if (!b.endpoint) return json({ error: "endpoint required" }, 400, cors);
        await env.DB.prepare("DELETE FROM spots WHERE endpoint = ?1").bind(b.endpoint).run();
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch {
      return json({ error: "bad request" }, 400, cors);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDue(env));
  },
};

export async function sendDue(env: Env, now = Date.now()) {
  const { results } = await env.DB.prepare("SELECT endpoint FROM spots WHERE fire_at <= ?1 LIMIT 200").bind(now).all<{ endpoint: string }>();
  for (const r of results ?? []) {
    try {
      const res = await sendPush(r.endpoint, env);
      if (res.ok || res.status === 404 || res.status === 410 || res.status === 400 || res.status === 403) {
        await env.DB.prepare("DELETE FROM spots WHERE endpoint = ?1").bind(r.endpoint).run();
      }
    } catch {
      // keep the row; retried next minute
    }
  }
  // garbage-collect anything stale (more than a day overdue)
  await env.DB.prepare("DELETE FROM spots WHERE fire_at < ?1").bind(now - 86400000).run();
}

export function validate(b: SpotBody): string | null {
  if (!b?.subscription?.endpoint || !/^https:\/\//.test(b.subscription.endpoint)) return "subscription.endpoint required";
  if (b.subscription.endpoint.length > 1024) return "endpoint too long";
  if (!b.spot || typeof b.spot.lat !== "number" || typeof b.spot.lng !== "number") return "spot required";
  if (b.spot.lat < 37.6 || b.spot.lat > 37.9 || b.spot.lng < -122.6 || b.spot.lng > -122.3) return "spot outside San Francisco";
  if (!["L", "R"].includes(b.spot.side)) return "side must be L or R";
  if (typeof b.fireAt !== "number" || b.fireAt < Date.now() - 60000 || b.fireAt > Date.now() + MAX_AHEAD_MS) return "fireAt out of range";
  return null;
}

async function sendPush(endpoint: string, env: Env): Promise<Response> {
  const aud = new URL(endpoint).origin;
  const jwt = await vapidJwt(aud, env);
  return fetch(endpoint, {
    method: "POST",
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
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || allowed.some((a) => a.startsWith("*.") && origin.endsWith(a.slice(1)));
  return ok ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" } : { Vary: "Origin" };
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
