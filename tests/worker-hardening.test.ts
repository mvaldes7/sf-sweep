import { describe, expect, it } from "vitest";
import worker, {
  MAX_ROWS, SEND_BATCH, rateKey, type Env, isAllowedPushEndpoint, originAllowed, pushOutcome, readJsonCapped, sendDue, validate,
} from "../worker/src/index";

const P256 = "B" + "A".repeat(86);
const AUTH = "A".repeat(22);
const good = (now = Date.now()) => ({
  subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: P256, auth: AUTH } },
  spot: { cnn: "1579000", side: "R", lat: 37.78, lng: -122.45 },
  fireAt: now + 3600000,
});

interface Row { endpoint: string; subscription: string; cnn: string; side: string; lat: number; lng: number; fire_at: number; created_at: number }
/** Minimal D1 stand-in that understands the statements the Worker issues. */
function fakeDb(opts: { failDelete?: boolean; count?: number } = {}) {
  const rows = new Map<string, Row>();
  const log: string[] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first<T>(): Promise<T | null> {
      log.push(sql);
      if (sql.startsWith("SELECT 1")) return (rows.has(args[0] as string) ? { x: 1 } : null) as T;
      if (sql.startsWith("SELECT COUNT")) return { n: opts.count ?? rows.size } as T;
      if (sql.startsWith("DELETE FROM spots WHERE endpoint = ?1 AND")) {
        if (opts.failDelete) throw new Error("d1 down");
        const r = rows.get(args[0] as string);
        if (r && r.fire_at === args[1] && r.created_at === args[2]) { rows.delete(r.endpoint); return { endpoint: r.endpoint } as T; }
        return null;
      }
      throw new Error(sql);
    },
    async all<T>() {
      log.push(sql);
      const due = [...rows.values()].filter((r) => r.fire_at <= (args[0] as number)).slice(0, args[1] as number);
      return { results: due as T[] };
    },
    async run() {
      log.push(sql);
      if (sql.includes("INSERT")) {
        const [endpoint, subscription, cnn, side, lat, lng, fire_at, created_at] = args as [string, string, string, string, number, number, number, number];
        if (sql.includes("OR IGNORE") && rows.has(endpoint)) return {};
        rows.set(endpoint, { endpoint, subscription, cnn, side, lat, lng, fire_at, created_at });
      } else if (sql.startsWith("DELETE FROM spots WHERE fire_at")) {
        for (const r of [...rows.values()]) if (r.fire_at < (args[0] as number)) rows.delete(r.endpoint);
      } else if (sql.startsWith("DELETE FROM spots WHERE endpoint")) rows.delete(args[0] as string);
      return {};
    },
  });
  return { db: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database, rows, log };
}
const envWith = (db: D1Database): Env => ({ DB: db, ALLOWED_ORIGIN: "https://sf-sweep.pages.dev,https://*.sf-sweep.pages.dev", VAPID_SUBJECT: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" });
const row = (endpoint: string, fire_at: number): Row => ({ endpoint, subscription: "{}", cnn: "1", side: "L", lat: 37.7, lng: -122.4, fire_at, created_at: 1 });

describe("push endpoint allowlist (SSRF)", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/QAbc", "https://api.push.apple.com/x",
  ])("accepts %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(true));
  it.each([
    "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.com/x", "https://evilfcm.googleapis.com/x",
    "https://evilpush.apple.com/x", "https://push.apple.com/x", "https://user@fcm.googleapis.com/x",
    "https://fcm.googleapis.com@evil.com/x", "https://fcm.googleapis.com:8443/x", "https://169.254.169.254/x",
    "https://localhost/x", "https://x.push.services.mozilla.com.evil.io/x", "ftp://fcm.googleapis.com/x", "not a url",
  ])("rejects %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(false));
});

describe("validation", () => {
  it("accepts a valid body", () => expect(validate(good())).toBeNull());
  it("rejects bad keys", () => {
    expect(validate({ ...good(), subscription: { ...good().subscription, keys: { p256dh: "a+b/" + P256, auth: AUTH } } })).toMatch(/p256dh/);
    expect(validate({ ...good(), subscription: { ...good().subscription, keys: { p256dh: P256 + "A".repeat(50), auth: AUTH } } })).toMatch(/p256dh/);
    expect(validate({ ...good(), subscription: { ...good().subscription, keys: { p256dh: P256, auth: "A".repeat(100) } } })).toMatch(/auth/);
    expect(validate({ ...good(), subscription: { ...good().subscription, keys: { p256dh: P256, auth: AUTH, x: "y" } } })).toMatch(/keys/);
  });
  it("rejects non-allowlisted push host", () =>
    expect(validate({ ...good(), subscription: { endpoint: "https://evil.example/x" } })).toMatch(/not allowed/));
  it("cnn must be 1-10 digits", () => {
    for (const c of ["", "12a", "12345678901", "1;drop"]) expect(validate({ ...good(), spot: { ...good().spot, cnn: c } })).toMatch(/cnn/);
  });
  it("fireAt must be finite", () => {
    for (const f of [NaN, Infinity]) expect(validate({ ...good(), fireAt: f })).toMatch(/fireAt/);
  });
});

describe("origins", () => {
  const A = "https://sf-sweep.pages.dev,https://*.sf-sweep.pages.dev";
  it("matches exact and proper subdomains, https only", () => {
    expect(originAllowed("https://sf-sweep.pages.dev", A)).toBe(true);
    expect(originAllowed("https://feat-v1.sf-sweep.pages.dev", A)).toBe(true);
    expect(originAllowed("http://feat-v1.sf-sweep.pages.dev", A)).toBe(false);
    expect(originAllowed("https://evilsf-sweep.pages.dev", A)).toBe(false);
    expect(originAllowed("http://localhost:5173", A)).toBe(false);
    expect(originAllowed(null, A)).toBe(false);
  });
});

describe("request limits", () => {
  const put = (body: string, headers: Record<string, string> = {}) => new Request("https://w.dev/api/spot", {
    method: "PUT", body, headers: { origin: "https://sf-sweep.pages.dev", "content-type": "application/json", ...headers },
  });
  it("rejects bodies over 4KB by header and by streamed size", async () => {
    await expect(readJsonCapped(put("{}", { "content-length": "9999" }))).rejects.toThrow(/too large/);
    const big = JSON.stringify({ x: "a".repeat(5000) });
    const streamed = new Request("https://w.dev/api/spot", { method: "PUT", body: new Blob([big]).stream(), duplex: "half" } as RequestInit);
    await expect(readJsonCapped(streamed)).rejects.toThrow(/too large/);
  });
  it("PUT: 403 without allowed origin, 413 when large, 503 at row ceiling, 200 otherwise", async () => {
    const { db, rows } = fakeDb();
    const env = envWith(db);
    expect((await worker.fetch(put(JSON.stringify(good()), { origin: "https://evil.example" }), env)).status).toBe(403);
    expect((await worker.fetch(put("x".repeat(5000)), env)).status).toBe(413);
    expect((await worker.fetch(put(JSON.stringify(good())), env)).status).toBe(200);
    expect(rows.size).toBe(1);
    const full = fakeDb({ count: MAX_ROWS });
    expect((await worker.fetch(put(JSON.stringify(good())), envWith(full.db))).status).toBe(503);
  });
  it("OPTIONS preflight: 204 for allowed origin, 403 otherwise", async () => {
    const env = envWith(fakeDb().db);
    const pre = (o: string) => new Request("https://w.dev/api/spot", { method: "OPTIONS", headers: { origin: o } });
    expect((await worker.fetch(pre("https://sf-sweep.pages.dev"), env)).status).toBe(204);
    expect((await worker.fetch(pre("https://evil.example"), env)).status).toBe(403);
  });
  it("rate limits /api/* via the binding when present", async () => {
    const { db } = fakeDb();
    const env = { ...envWith(db), API_LIMITER: { limit: async () => ({ success: false }) } };
    expect((await worker.fetch(put(JSON.stringify(good())), env)).status).toBe(429);
  });
  it("in-memory fallback limiter trips after a burst", async () => {
    const { db } = fakeDb();
    const env = envWith(db);
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await worker.fetch(put("{}", { "cf-connecting-ip": "203.0.113.9" }), env)).status);
    expect(codes).toContain(429);
  });
});

describe("sendDue", () => {
  it("treats 4xx except 429 as final, retries 429/5xx/network", () => {
    expect(pushOutcome(201)).toBe("sent");
    for (const s of [400, 403, 404, 410, 413]) expect(pushOutcome(s)).toBe("sent");
    for (const s of [429, 500, 503]) expect(pushOutcome(s)).toBe("retry");
  });
  it("drops 404/410, keeps 429 and thrown pushes for next minute", async () => {
    const now = 1_800_000_000_000;
    const { db, rows } = fakeDb();
    for (const e of ["a", "b", "c", "d", "e"]) rows.set(e, row(e, now - 1000));
    const status: Record<string, number> = { a: 201, b: 404, c: 410, d: 429 };
    await sendDue(envWith(db), now, async (ep) => { if (ep === "e") throw new Error("net"); return new Response(null, { status: status[ep] }); });
    expect([...rows.keys()].sort()).toEqual(["d", "e"]);
  });
  it("never sends when the claim fails (no duplicate on DELETE failure)", async () => {
    const now = 1_800_000_000_000;
    const { db, rows } = fakeDb({ failDelete: true });
    rows.set("a", row("a", now - 1000));
    let sent = 0;
    await sendDue(envWith(db), now, async () => { sent++; return new Response(null, { status: 201 }); });
    await sendDue(envWith(db), now, async () => { sent++; return new Response(null, { status: 201 }); });
    expect(sent).toBe(0);
  });
  it("sends each row once across two runs and runs pushes in parallel, bounded", async () => {
    const now = 1_800_000_000_000;
    const { db, rows } = fakeDb();
    for (let i = 0; i < 30; i++) rows.set(`e${i}`, row(`e${i}`, now - 1000));
    let inflight = 0, peak = 0;
    const seen: string[] = [];
    const push = async (ep: string) => {
      seen.push(ep); inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5)); inflight--; return new Response(null, { status: 201 });
    };
    await sendDue(envWith(db), now, push);
    expect(seen.length).toBe(SEND_BATCH);
    await sendDue(envWith(db), now, push);
    expect(new Set(seen).size).toBe(seen.length);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

describe("rate limit key", () => {
  it("groups IPv6 by /64 and leaves IPv4 alone", () => {
    expect(rateKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateKey("2a09:bac1:7680:838::162:26c")).toBe(rateKey("2a09:bac1:7680:838::400:1f"));
    expect(rateKey("2a09:bac1:7680:838::1")).toBe("2a09:bac1:7680:838::/64");
    expect(rateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateKey("2001:db8:0:1::1")).not.toBe(rateKey("2001:db8:0:2::1"));
  });
});
