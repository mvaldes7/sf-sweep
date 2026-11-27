import type { Env } from "./env";
import { CLEANUP_BATCH_LIMIT, REPORT_RETENTION_DAYS } from "./limits";

/**
 * Delete rejected/confirmed reports older than 90 days.
 * One bounded D1 statement (at most CLEANUP_BATCH_LIMIT rows). Photos are left
 * to the 30-day KV TTL or to the delete-on-reject path — no per-row KV or D1 calls.
 */
export async function cleanupExpiredReports(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = await env.DB.prepare(
    `DELETE FROM reports WHERE id IN (
      SELECT id FROM reports
      WHERE status IN ('rejected', 'confirmed')
        AND COALESCE(reviewed_at, created_at) < ?
      LIMIT ${CLEANUP_BATCH_LIMIT}
    )`,
  ).bind(cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

/** Run cleanup without ever rejecting the caller. Prefer ctx.waitUntil when available. */
export function scheduleCleanup(env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): void {
  const run = cleanupExpiredReports(env).then(
    () => undefined,
    (e) => { console.warn("cleanup expired reports failed", String(e)); },
  );
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
  else void run;
}
