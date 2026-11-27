/** Storage and retention limits for photo reports. Kept out of the Worker entry module so workerd can boot. */

/** Max pending reports kept in D1/KV at once. */
export const PENDING_REPORT_CEILING = 200;
/** Daily submit cap, under the 1k/day KV write free-tier limit. */
export const DAILY_SUBMIT_CAP = 300;
/** Photo object TTL in KV (seconds). Pending reports older than this are shown as expired. */
export const PHOTO_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Rejected and confirmed rows are kept this many days, then cleaned up. */
export const REPORT_RETENTION_DAYS = 90;
/** Max D1 rows a single cleanup invocation may delete (free-plan query/subrequest budget). */
export const CLEANUP_BATCH_LIMIT = 100;

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

/** True when a pending report's photo may already have hit the 30-day KV TTL. */
export function isPendingPhotoExpired(status: unknown, createdAt: unknown, now = Date.now()): boolean {
  if (status !== "pending") return false;
  const created = Number(createdAt);
  if (!Number.isFinite(created) || created <= 0) return false;
  return now - created > PHOTO_TTL_SECONDS * 1000;
}

export function withExpiredFlag<T extends Record<string, unknown>>(row: T, now = Date.now()): T & { expired: boolean } {
  return { ...row, expired: isPendingPhotoExpired(row.status, row.created_at, now) };
}
