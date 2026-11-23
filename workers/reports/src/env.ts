/** Bindings for the sf-sweep-reports Worker. Not the Worker entry module. */
export interface Env {
  DB: D1Database;
  PHOTOS: KVNamespace;
  ALLOWED_ORIGIN: string;
  TURNSTILE_SITE_KEY?: string;
  /** When unset or empty, Turnstile verification is skipped (v1). */
  TURNSTILE_SECRET?: string;
  REVIEW_TOKEN: string;
  API_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}
