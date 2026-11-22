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
    PHOTOS: {} as R2Bucket,
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
