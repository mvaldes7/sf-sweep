import { describe, expect, it, vi } from "vitest";
import worker from "../workers/reports/src/index";
import type { Env } from "../workers/reports/src/env";
import { cleanupExpiredReports } from "../workers/reports/src/cleanup";
import { CLEANUP_BATCH_LIMIT, DAILY_SUBMIT_CAP, PENDING_REPORT_CEILING, PHOTO_TTL_SECONDS, isPendingPhotoExpired, roundCoord } from "../workers/reports/src/limits";
import { rateLimited, reviewAuthorized, timingSafeEqual, verifyTurnstile } from "../workers/reports/src/http";
import { rulesFromConfirm } from "../workers/reports/src/corrections";
import { HEIC_PHOTO_ERROR } from "../workers/reports/src/exif";

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
  const sosLen = 8; // 6 + 2*1
  const sos = [0xff, 0xda, ...u16be(sosLen), 1, 1, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9];
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

/** Encode a form so the request has a Content-Length (undici may omit it for FormData). */
async function postReports(fd: FormData, ip: string, init: RequestInit = {}): Promise<Request> {
  const tmp = new Request("https://example.com/upload", { method: "POST", body: fd });
  const buf = await tmp.arrayBuffer();
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", "https://sf-sweep.pages.dev");
  headers.set("cf-connecting-ip", ip);
  headers.set("content-type", tmp.headers.get("content-type") || "multipart/form-data");
  headers.set("content-length", String(buf.byteLength));
  return new Request("https://sf-sweep-reports.miggyman7.workers.dev/api/reports", { method: "POST", body: buf, headers });
}

function memoryDbAndPhotos(opts: {
  pending?: number;
  today?: number;
  putFails?: boolean;
  row?: Record<string, unknown> | null;
  expired?: { id: string; photo_key: string }[];
} = {}) {
  const order: string[] = [];
  const sqls: string[] = [];
  const binds: unknown[][] = [];
  const put = vi.fn(async () => {
    order.push("put");
    if (opts.putFails) throw new Error("kv put failed");
  });
  const del = vi.fn(async () => { order.push("delete"); });
  const getWithMetadata = vi.fn(async () => ({ value: new ArrayBuffer(4), metadata: { contentType: "image/jpeg" } }));
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    const first = async () => {
      if (/status = 'pending'/.test(sql)) return { n: opts.pending ?? 0 };
      if (/created_at >=/.test(sql)) return { n: opts.today ?? 0 };
      return opts.row ?? null;
    };
    const all = async () => ({ results: opts.expired ?? [] });
    const run = vi.fn(async () => {
      if (/INSERT/.test(sql)) order.push("insert");
      if (/DELETE FROM reports WHERE id/.test(sql)) order.push("rollback");
      if (/UPDATE reports SET status = 'rejected'/.test(sql)) order.push("reject");
      return { success: true };
    });
    const bind = vi.fn((...args: unknown[]) => {
      binds.push(args);
      return { run, first, all };
    });
    return { bind, run, first, all };
  });
  return {
    DB: { prepare } as unknown as D1Database,
    PHOTOS: { put, delete: del, getWithMetadata } as unknown as KVNamespace,
    order,
    sqls,
    binds,
    put,
    del,
    getWithMetadata,
  };
}

function heicFile(): File {
  const bytes = Uint8Array.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    0, 0, 0, 0, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
  ]);
  return new File([bytes], "sign.heic", { type: "image/heic" });
}

type ReviewRow = Record<string, unknown> & { id: string; status: string; created_at?: number; reviewed_at?: number; photo_key?: string };

function reviewStore(initial: ReviewRow[]) {
  const rows = initial.map((r) => ({ ...r }));
  const sqls: string[] = [];
  const del = vi.fn(async () => undefined);
  const getWithMetadata = vi.fn(async () => ({ value: new ArrayBuffer(4), metadata: { contentType: "image/jpeg" } }));
  const store = {
    rows,
    sqls,
    deleted: 0,
    explodeCleanup: false,
    del,
    getWithMetadata,
    DB: {} as D1Database,
    PHOTOS: { put: vi.fn(), delete: del, getWithMetadata } as unknown as KVNamespace,
  };
  store.DB = {
    prepare(sql: string) {
      sqls.push(sql);
      const bind = (...args: unknown[]) => ({
        async all() {
          return { results: rows.map((r) => ({ ...r })) };
        },
        async first() {
          const id = args[0];
          return rows.find((r) => r.id === id) ?? null;
        },
        async run() {
          if (store.explodeCleanup) throw new Error("cleanup exploded");
          if (/DELETE FROM reports WHERE id IN/.test(sql)) {
            const cutoff = Number(args[0]);
            const expired = rows.filter((r) =>
              (r.status === "rejected" || r.status === "confirmed")
              && Number(r.reviewed_at ?? r.created_at ?? 0) < cutoff,
            );
            const take = expired.slice(0, 100);
            const ids = new Set(take.map((r) => r.id));
            store.deleted += take.length;
            for (let i = rows.length - 1; i >= 0; i--) if (ids.has(rows[i].id)) rows.splice(i, 1);
            return { success: true, meta: { changes: take.length } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      });
      return { bind, all: () => bind().all(), first: () => bind().first(), run: () => bind().run() };
    },
  } as unknown as D1Database;
  return store;
}


describe("submit without Turnstile", () => {
  it("accepts a report with no token when TURNSTILE_SECRET is unset", async () => {
    const store = memoryDbAndPhotos();
    const res = await worker.fetch(
      await postReports(reportForm(), "203.0.113.50"),
      env({ ...store, TURNSTILE_SECRET: "" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { ok?: boolean; id?: string };
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(store.PHOTOS.put).toHaveBeenCalled();
    expect(store.DB.prepare).toHaveBeenCalled();
    expect(store.order.indexOf("insert")).toBeGreaterThanOrEqual(0);
    expect(store.order.indexOf("insert")).toBeLessThan(store.order.indexOf("put"));
    expect(store.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Uint8Array),
      expect.objectContaining({ expirationTtl: PHOTO_TTL_SECONDS }),
    );
  });
});

describe("submit with Turnstile enabled", () => {
  it("still verifies the token when TURNSTILE_SECRET is set", async () => {
    const store = memoryDbAndPhotos();
    const missing = await worker.fetch(
      await postReports(reportForm(), "203.0.113.51"),
      env({ ...store }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "turnstile token required" });

    const siteverify = vi.spyOn(globalThis, "fetch");
    siteverify.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const denied = await worker.fetch(
      await postReports(reportForm({ "cf-turnstile-response": "turnstile-token-ok" }), "203.0.113.51"),
      env({ ...store }),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "turnstile failed" });

    siteverify.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const ok = await worker.fetch(
      await postReports(reportForm({ "cf-turnstile-response": "turnstile-token-ok" }), "203.0.113.51"),
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

describe("storage caps and coordinates", () => {
  it("returns 503 with Retry-After when pending reports are at the 200 ceiling", async () => {
    const store = memoryDbAndPhotos({ pending: PENDING_REPORT_CEILING });
    const res = await worker.fetch(
      await postReports(reportForm(), "203.0.113.52"),
      env({ ...store, TURNSTILE_SECRET: "" }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(await res.json()).toMatchObject({ error: "too many pending reports" });
    expect(store.order).not.toContain("insert");
    expect(store.order).not.toContain("put");
  });

  it("returns 429 with Retry-After when the daily submit cap of 300 is reached", async () => {
    const store = memoryDbAndPhotos({ today: DAILY_SUBMIT_CAP });
    const res = await worker.fetch(
      await postReports(reportForm(), "203.0.113.53"),
      env({ ...store, TURNSTILE_SECRET: "" }),
    );
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(24 * 60 * 60);
    expect(await res.json()).toMatchObject({ error: "daily submit limit reached" });
    expect(store.order).not.toContain("insert");
    expect(store.order).not.toContain("put");
  });

  it("rounds stored lat/lng to 4 decimals", async () => {
    expect(roundCoord(37.78004)).toBeCloseTo(37.78, 4);
    expect(roundCoord(-122.48006)).toBeCloseTo(-122.4801, 4);
    const store = memoryDbAndPhotos();
    const res = await worker.fetch(
      await postReports(reportForm({ lat: "37.78004", lng: "-122.48006" }), "203.0.113.54"),
      env({ ...store, TURNSTILE_SECRET: "" }),
    );
    expect(res.status).toBe(201);
    const insert = store.binds.find((args) => args.length >= 8 && args[0] && typeof args[0] === "string" && String(args[0]).includes("-"));
    expect(insert).toBeTruthy();
    const lat = insert![6];
    const lng = insert![7];
    expect(lat).toBeCloseTo(37.78, 4);
    expect(lng).toBeCloseTo(-122.4801, 4);
  });
});

describe("D1 insert before KV put", () => {
  it("rolls back the D1 row when the KV put fails", async () => {
    const store = memoryDbAndPhotos({ putFails: true });
    const res = await worker.fetch(
      await postReports(reportForm(), "203.0.113.55"),
      env({ ...store, TURNSTILE_SECRET: "" }),
    );
    expect(res.status).toBe(500);
    expect(store.order.filter((s) => s === "insert")).toHaveLength(1);
    expect(store.order).toContain("put");
    expect(store.order).toContain("rollback");
    expect(store.order.indexOf("insert")).toBeLessThan(store.order.indexOf("put"));
    expect(store.order.indexOf("put")).toBeLessThan(store.order.indexOf("rollback"));
  });
});

describe("Content-Length", () => {
  it("rejects a missing Content-Length with 411", async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("--x--")); c.close(); },
    });
    const r = new Request("https://sf-sweep-reports.miggyman7.workers.dev/api/reports", {
      method: "POST",
      headers: {
        origin: "https://sf-sweep.pages.dev",
        "content-type": "multipart/form-data; boundary=x",
        "cf-connecting-ip": "203.0.113.40",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    r.headers.delete("content-length");
    expect(r.headers.get("content-length")).toBeNull();
    const res = await worker.fetch(r, env({ ...memoryDbAndPhotos(), TURNSTILE_SECRET: "" }));
    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ error: "content-length required" });
  });
});

describe("review photo headers and reject delete", () => {
  const row = {
    id: "11111111-1111-1111-1111-111111111111",
    status: "pending",
    photo_key: "11111111-1111-1111-1111-111111111111",
    photo_type: "image/jpeg",
  };
  const auth = { authorization: "Bearer review-token-test" };

  it("adds nosniff and Content-Disposition: inline on photo responses", async () => {
    const store = memoryDbAndPhotos({ row });
    const res = await worker.fetch(req(`/api/review/${row.id}/photo`, { headers: auth }), env({ ...store }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("deletes the photo from KV when a report is rejected", async () => {
    const store = memoryDbAndPhotos({ row });
    const res = await worker.fetch(req(`/api/review/${row.id}/reject`, { method: "POST", headers: auth }), env({ ...store }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "rejected" });
    expect(store.order).toContain("reject");
    expect(store.del).toHaveBeenCalledWith(row.photo_key);
  });
});

describe("90-day retention cleanup", () => {
  it("deletes at most 100 expired rejected or confirmed rows in one D1 statement, without KV deletes", async () => {
    const expired = Array.from({ length: 150 }, (_, i) => ({
      id: `old-${i}`,
      status: i % 2 ? "rejected" : "confirmed",
      created_at: 1,
      reviewed_at: 1,
      photo_key: `old-${i}`,
    }));
    const rows = [
      ...expired,
      { id: "still-pending", status: "pending", created_at: Date.now(), photo_key: "pending" },
    ];
    const store = reviewStore(rows);
    const n = await cleanupExpiredReports(env({ ...store }), Date.now());
    expect(n).toBe(CLEANUP_BATCH_LIMIT);
    expect(n).toBeLessThanOrEqual(100);
    expect(store.del).not.toHaveBeenCalled();
    expect(store.rows.filter((r) => r.status !== "pending")).toHaveLength(50);
    expect(store.rows.some((r) => r.id === "still-pending")).toBe(true);
    expect(store.sqls.some((s) => /LIMIT 100/.test(s) && /DELETE FROM reports WHERE id IN/.test(s))).toBe(true);
    expect(store.sqls.filter((s) => /DELETE FROM reports/.test(s))).toHaveLength(1);
  });

  it("GET /api/review still returns 200 when more than 100 expired rows exist, and cleanup cannot fail the response", async () => {
    const expired = Array.from({ length: 150 }, (_, i) => ({
      id: `old-${i}`,
      status: "rejected" as const,
      created_at: 1,
      reviewed_at: 1,
      photo_key: `old-${i}`,
      cnn: "1",
      side: "R",
    }));
    const store = reviewStore(expired);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
    const res = await worker.fetch(
      req("/api/review", { headers: { authorization: "Bearer review-token-test" } }),
      env({ ...store }),
      ctx as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: unknown[] };
    expect(body.reports.length).toBe(150);
    await Promise.all(pending);
    expect(store.deleted).toBe(100);
    expect(store.rows).toHaveLength(50);

    const boom = reviewStore(expired);
    boom.explodeCleanup = true;
    const pending2: Promise<unknown>[] = [];
    const ctx2 = { waitUntil(p: Promise<unknown>) { pending2.push(p); } };
    const res2 = await worker.fetch(
      req("/api/review", { headers: { authorization: "Bearer review-token-test" } }),
      env({ ...boom }),
      ctx2 as ExecutionContext,
    );
    expect(res2.status).toBe(200);
    await Promise.all(pending2);
  });
});

describe("expired pending photos on the review page", () => {
  const auth = { authorization: "Bearer review-token-test" };

  it("flags pending reports older than 30 days as expired and returns expired instead of a broken photo", async () => {
    expect(isPendingPhotoExpired("pending", Date.now() - (PHOTO_TTL_SECONDS * 1000 + 1))).toBe(true);
    expect(isPendingPhotoExpired("pending", Date.now())).toBe(false);
    expect(isPendingPhotoExpired("confirmed", 1)).toBe(false);

    const oldPending = {
      id: "22222222-2222-2222-2222-222222222222",
      status: "pending",
      created_at: Date.now() - (PHOTO_TTL_SECONDS + 60) * 1000,
      photo_key: "22222222-2222-2222-2222-222222222222",
      photo_type: "image/jpeg",
      cnn: "1642000",
      side: "R",
    };
    const store = reviewStore([oldPending]);
    const list = await worker.fetch(req("/api/review", { headers: auth }), env({ ...store }), { waitUntil() {} } as unknown as ExecutionContext);
    expect(list.status).toBe(200);
    const listed = await list.json() as { reports: { expired: boolean }[] };
    expect(listed.reports[0].expired).toBe(true);

    const one = await worker.fetch(req(`/api/review/${oldPending.id}`, { headers: auth }), env({ ...store }));
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ report: { expired: true } });

    const photo = await worker.fetch(req(`/api/review/${oldPending.id}/photo`, { headers: auth }), env({ ...store }));
    expect(photo.status).toBe(410);
    expect(await photo.json()).toMatchObject({ error: "expired" });
    expect(store.getWithMetadata).not.toHaveBeenCalled();
  });
});

describe("HEIC on the server", () => {
  it("rejects a HEIC upload with a friendly error", async () => {
    const store = memoryDbAndPhotos();
    const fd = reportForm({}, false);
    fd.set("photo", heicFile());
    const res = await worker.fetch(
      await postReports(fd, "203.0.113.56"),
      env({ ...store, TURNSTILE_SECRET: "" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: HEIC_PHOTO_ERROR });
    expect(store.order).not.toContain("insert");
    expect(store.order).not.toContain("put");
  });
});
