import type { Env } from "./env";

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
