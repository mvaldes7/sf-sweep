/**
 * Proposed src/data/corrections.json entry, using the same schema as the
 * versioned corrections file on main. This module generates an entry only; it
 * never writes the file, opens a PR, or deploys.
 *
 * Entry shape: { cnn, side, street?, limits?, blockside?, rules, source, reported, note? }
 * Each rule: { day, weeks, from, to, holidays? } with HH:MM times (minute precision, e.g. "07:30").
 */

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface CorrectionRule {
  day: string;
  weeks: number[];
  from: string;
  to: string;
  holidays?: boolean;
}
export interface CorrectionEntry {
  cnn: string;
  side: "L" | "R";
  street?: string;
  limits?: string;
  blockside?: string;
  rules: CorrectionRule[];
  source: string;
  reported: string;
  note?: string;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$|^24:00$/;

/** Normalize "7:30" or "07:30" to "HH:MM". "24:00" is allowed as an end time. */
export function normalizeClock(s: string, end = false): string | null {
  const t = String(s).trim();
  if (end && t === "24:00") return "24:00";
  const m = /^([01]?\d|2[0-3])(?::([0-5]\d))?$/.exec(t);
  if (!m) return null;
  const hh = m[1].padStart(2, "0");
  const mm = (m[2] ?? "00").padStart(2, "0");
  if (!TIME.test(`${hh}:${mm}`) && !(end && `${hh}:${mm}` === "24:00")) return null;
  return `${hh}:${mm}`;
}

export function parseDay(s: string): string | null {
  const k = String(s).trim().slice(0, 3).toLowerCase();
  const hit = DAY_NAMES.find((d) => d.toLowerCase() === k);
  return hit ?? null;
}

export function normalizeWeeks(weeks: unknown): number[] | null {
  if (weeks == null) return [1, 2, 3, 4, 5];
  if (!Array.isArray(weeks) || weeks.length === 0) return null;
  const out: number[] = [];
  for (const w of weeks) {
    const n = Number(w);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    if (!out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out.length ? out : null;
}

export function normalizeRule(r: { day?: unknown; weeks?: unknown; from?: unknown; to?: unknown; holidays?: unknown }): CorrectionRule | { error: string } {
  const day = parseDay(String(r.day ?? ""));
  const from = normalizeClock(String(r.from ?? ""), false);
  const to = normalizeClock(String(r.to ?? ""), true);
  const weeks = normalizeWeeks(r.weeks);
  if (!day) return { error: "invalid rule day" };
  if (!from || !to) return { error: "invalid rule time" };
  if (from === to) return { error: "from and to must differ" };
  if (!weeks) return { error: "invalid rule weeks" };
  const holidays = r.holidays === true || r.holidays === 1 || r.holidays === "1";
  return { day, weeks, from, to, holidays };
}

export interface ReportDraft {
  cnn: string;
  side: "L" | "R";
  street?: string;
  limits?: string;
  blockside?: string;
  rules: CorrectionRule[];
  reported: string; // YYYY-MM-DD
  note?: string;
  reportId?: string;
}

/** Build one corrections-file entry. Caller must supply at least one valid rule. */
export function proposedCorrection(draft: ReportDraft): CorrectionEntry | { error: string } {
  if (!draft.cnn || !/^\d+$/.test(draft.cnn)) return { error: "cnn is required" };
  if (draft.side !== "L" && draft.side !== "R") return { error: "side must be L or R" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.reported)) return { error: "reported must be YYYY-MM-DD" };
  if (!Array.isArray(draft.rules) || draft.rules.length === 0) return { error: "at least one rule is required" };
  const rules: CorrectionRule[] = [];
  for (const r of draft.rules) {
    const n = normalizeRule(r);
    if ("error" in n) return n;
    rules.push(n);
  }
  const noteParts = [draft.note?.trim(), draft.reportId ? `Report ${draft.reportId}` : ""].filter(Boolean);
  const entry: CorrectionEntry = {
    cnn: draft.cnn,
    side: draft.side,
    rules,
    source: "posted sign, photo report",
    reported: draft.reported,
  };
  if (draft.street) entry.street = draft.street;
  if (draft.limits) entry.limits = draft.limits;
  if (draft.blockside) entry.blockside = draft.blockside;
  if (noteParts.length) entry.note = noteParts.join(". ");
  return entry;
}

/** Pacific calendar date (YYYY-MM-DD) for an epoch ms. */
export function reportedDate(ms: number, timeZone = "America/Los_Angeles"): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export function rulesFromConfirm(body: Record<string, unknown>, row: Record<string, unknown>): CorrectionRule[] {
  if (Array.isArray(body.rules)) return body.rules as CorrectionRule[];
  const daysRaw = body.days ?? row.days;
  let days: string[] = [];
  if (Array.isArray(daysRaw)) days = daysRaw.map(String);
  else if (typeof daysRaw === "string" && daysRaw) {
    try { days = JSON.parse(daysRaw) as string[]; } catch { days = []; }
  }
  const from = normalizeClock(String(body.from ?? row.from_time ?? ""), false);
  const to = normalizeClock(String(body.to ?? row.to_time ?? ""), true);
  let weeks = normalizeWeeks(body.weeks);
  if (!weeks && typeof row.weeks === "string" && row.weeks) {
    try { weeks = normalizeWeeks(JSON.parse(row.weeks)); } catch { weeks = [1, 2, 3, 4, 5]; }
  }
  if (!weeks) weeks = [1, 2, 3, 4, 5];
  const holidays = body.holidays === true || row.holidays === 1;
  if (!days.length || !from || !to) return [];
  return days.map((d) => ({ day: parseDay(d) ?? d, weeks, from, to, holidays }));
}
