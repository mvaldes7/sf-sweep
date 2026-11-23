import { describe, expect, it, vi } from "vitest";
import worker, { rateLimited, reviewAuthorized, timingSafeEqual, verifyTurnstile, type Env } from "../workers/reports/src/index";
import { rulesFromConfirm } from "../workers/reports/src/index";

function req(path: string, init: RequestInit = {}, ip = "203.0.113.9"): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", "https://sf-sweep.pages.dev");
  headers.set("cf-connecting-ip", ip);
  return new Request(`https://sf-sweep-reports.miggyman7.workers.dev${path}`, { ...init, headers });
}

function env(over: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    PHOTOS: {} as KVNamespace,
    ALLOWED_ORIGIN: "https://sf-sweep.pages.dev,https://*.sf-sweep.pages.dev",
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET: "secret",
    REVIEW_TOKEN: "review-token-test",
    ...over,
  };
}

describe("review auth", () => {
  const token = "review-token-test";
  it("accepts a Bearer token and rejects a missing or wrong one", () => {
    expect(reviewAuthorized(req("/api/review", { headers: { authorization: "Bearer review-token-test" } }), token)).toBe(true);
    expect(reviewAuthorized(req("/api/review", { headers: { "x-review-token": token } }), token)).toBe(true);
    expect(reviewAuthorized(req("/api/review"), token)).toBe(false);
    expect(reviewAuthorized(req("/api/review", { headers: { authorization: "Bearer no" } }), token)).toBe(false);
    expect(timingSafeEqual("abcd", "abce")).toBe(false);
    expect(timingSafeEqual("abcd", "abcd")).toBe(true);
  });
  it("GET /api/review without a token is 401", async () => {
    const res = await worker.fetch(req("/api/review"), env());
    expect(res.status).toBe(401);
  });
});

describe("Turnstile verification", () => {
  it("returns true only when siteverify reports success", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const bad = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
    expect(await verifyTurnstile("tok", "secret", "1.1.1.1", ok as unknown as typeof fetch)).toBe(true);
    expect(await verifyTurnstile("tok", "secret", "1.1.1.1", bad as unknown as typeof fetch)).toBe(false);
    expect(await verifyTurnstile("tok", "", null)).toBe(false);
    expect(ok).toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("uses the binding when present and falls back to an in-memory cap", async () => {
    const limited = env({ API_LIMITER: { limit: async () => ({ success: false }) } });
    expect(await rateLimited(req("/api/reports", { method: "POST" }), limited)).toBe(true);
    const open = env({ API_LIMITER: { limit: async () => ({ success: true }) } });
    expect(await rateLimited(req("/api/reports", { method: "POST" }), open)).toBe(false);

    const mem = env();
    const ip = "198.51.100.20";
    const r = () => rateLimited(req("/api/reports", { method: "POST" }, ip), mem, 1_700_000_000_000);
    for (let i = 0; i < 5; i++) expect(await r()).toBe(false);
    expect(await r()).toBe(true);
  });
});

describe("rulesFromConfirm", () => {
  it("builds Friday 07:00-07:30 rules from the stored report or the confirm body", () => {
    const fromRow = rulesFromConfirm({}, {
      days: JSON.stringify(["Fri"]),
      from_time: "07:00",
      to_time: "07:30",
      weeks: JSON.stringify([1, 2, 3, 4, 5]),
      holidays: 0,
    });
    expect(fromRow).toEqual([{ day: "Fri", weeks: [1, 2, 3, 4, 5], from: "07:00", to: "07:30", holidays: false }]);
    const edited = rulesFromConfirm({
      rules: [{ day: "Fri", weeks: [1, 2, 3, 4, 5], from: "07:00", to: "07:30", holidays: false }],
    }, {});
    expect(edited[0].to).toBe("07:30");
  });
});

function jpegBytes(): Uint8Array {
  const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
  const app0 = [0xff, 0xe0, ...u16be(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sos = [0xff, 0xda, ...u16be(2), 0x00, 0xff, 0xd9];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sos]);
}

function reportForm(extra: Record<string, string> = {}, includePhoto = true): FormData {
  const fd = new FormData();
  fd.set("cnn", "1642000");
  fd.set("side", "R");
  fd.set("lat", "37.78");
  fd.set("lng", "-122.48");
  fd.set("street", "30th Ave");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  if (includePhoto) fd.set("photo", new File([jpegBytes()], "sign.jpg", { type: "image/jpeg" }));
  return fd;
}

function memoryDbAndPhotos(): Pick<Env, "DB" | "PHOTOS"> {
  const run = vi.fn(async () => ({ success: true }));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    DB: { prepare } as unknown as D1Database,
    PHOTOS: { put: vi.fn(async () => undefined) } as unknown as KVNamespace,
  };
}

describe("submit without Turnstile", () => {
  it("accepts a report with no token when TURNSTILE_SECRET is unset", async () => {
    const store = memoryDbAndPhotos();
    const res = await worker.fetch(
      req("/api/reports", { method: "POST", body: reportForm() }),
      env({ ...store, TURNSTILE_SECRET: "" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { ok?: boolean; id?: string };
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(store.PHOTOS.put).toHaveBeenCalled();
    expect(store.DB.prepare).toHaveBeenCalled();
  });
});

describe("submit with Turnstile enabled", () => {
  it("still verifies the token when TURNSTILE_SECRET is set", async () => {
    const store = memoryDbAndPhotos();
    const missing = await worker.fetch(
      req("/api/reports", { method: "POST", body: reportForm() }),
      env({ ...store }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "turnstile token required" });

    const siteverify = vi.spyOn(globalThis, "fetch");
    siteverify.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const denied = await worker.fetch(
      req("/api/reports", { method: "POST", body: reportForm({ "cf-turnstile-response": "turnstile-token-ok" }) }),
      env({ ...store }),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "turnstile failed" });

    siteverify.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const ok = await worker.fetch(
      req("/api/reports", { method: "POST", body: reportForm({ "cf-turnstile-response": "turnstile-token-ok" }) }),
      env({ ...store }),
    );
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ ok: true });
    siteverify.mockRestore();
  });
});

describe("POST /api/reports rate limiting", () => {
  it("returns 429 on the 6th request in the window, and when the binding denies", async () => {
    const ip = "198.51.100.21";
    const headers = { origin: "https://sf-sweep.pages.dev", "cf-connecting-ip": ip };
    const post = () => worker.fetch(req("/api/reports", { method: "POST", headers }, ip), env());
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post()).status);
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);

    const limited = env({ API_LIMITER: { limit: async () => ({ success: false }) } });
    const res = await worker.fetch(req("/api/reports", { method: "POST" }, "198.51.100.22"), limited);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toMatchObject({ error: "rate limited" });
  });
});
