/**
 * Street sweeping schedule logic. Pure functions, no DOM.
 *
 * All schedule hours are San Francisco local wall-clock time (America/Los_Angeles, DST aware).
 *
 * Assumption (not documented by DataSF): week-of-month = ceil(dayOfMonth / 7),
 * so days 1-7 are week 1, 8-14 week 2, 15-21 week 3, 22-28 week 4, 29-31 week 5.
 *
 * Holiday rule (SFMTA): on a listed holiday, daytime sweeping is not enforced. Nightly sweeping
 * (window starting before 6am) is not enforced only when the holiday has nightlyNotEnforced.
 * Rows with holidays=1 are swept regardless. Rows whose weekday is "Holiday" apply only on holidays.
 */

export const TZ = "America/Los_Angeles";
export const AMBER_WINDOW_MIN = 60;
const MIN = 60_000;
const HOUR = 3_600_000;

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export interface Rule {
  /** 0-6 (Sun-Sat) or "H" for rows that apply on holidays only */
  day: Weekday | "H";
  from: number; // hour 0-23
  to: number; // hour 1-24, exclusive
  weeks: [boolean, boolean, boolean, boolean, boolean];
  holidays: boolean; // true = swept on holidays too
}
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
  nightlyNotEnforced: boolean;
  projected?: boolean;
}
export type Status = "clear" | "soon" | "now";

export interface LocalParts {
  y: number; m: number; d: number; dow: Weekday; h: number; min: number; ymd: string;
}

const DOW: Record<string, Weekday> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});

export function sfParts(t: Date | number): LocalParts {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(typeof t === "number" ? new Date(t) : t)) p[x.type] = x.value;
  const y = +p.year, m = +p.month, d = +p.day;
  return {
    y, m, d, dow: DOW[p.weekday], h: +p.hour % 24, min: +p.minute,
    ymd: `${p.year}-${p.month}-${p.day}`,
  };
}

export function weekOfMonth(dayOfMonth: number): number {
  return Math.ceil(dayOfMonth / 7);
}

export function parseWeekday(s: string): Weekday | "H" | null {
  const k = s.trim().slice(0, 3).toLowerCase();
  if (k === "hol") return "H";
  const map: Record<string, Weekday> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return k in map ? map[k] : null;
}

export class HolidayTable {
  private byDate = new Map<string, Holiday>();
  constructor(list: Holiday[]) { for (const h of list) this.byDate.set(h.date, h); }
  get(ymd: string): Holiday | undefined { return this.byDate.get(ymd); }
}

/** A window like 22-2 crosses midnight: it starts on the scheduled date and ends on the next day. */
export function crossesMidnight(rule: Rule): boolean {
  return rule.to > 0 && rule.to < rule.from;
}
/** Hour falls in the part of the window that belongs to the scheduled (start) date. */
function inWindow(rule: Rule, h: number): boolean {
  const to = rule.to === 0 || crossesMidnight(rule) ? 24 : rule.to;
  return h >= rule.from && h < to;
}
/** Hour falls in the after-midnight tail of a crossing window (belongs to the previous date). */
function inTail(rule: Rule, h: number): boolean {
  return crossesMidnight(rule) && h < rule.to;
}
function partsActive(rule: Rule, p: LocalParts, prev: () => LocalParts, hol: HolidayTable): boolean {
  if (inWindow(rule, p.h) && ruleAppliesOnDate(rule, p, hol)) return true;
  return inTail(rule, p.h) && ruleAppliesOnDate(rule, prev(), hol);
}
/** Local parts of a time on the previous local date (one minute before local midnight). */
function prevDayParts(ms: number, p: LocalParts): LocalParts {
  return sfParts(ms - (p.h * 60 + p.min + 1) * MIN);
}

/** Is this rule enforced on the local date given (ignoring the hour)? */
export function ruleAppliesOnDate(rule: Rule, p: LocalParts, hol: HolidayTable): boolean {
  const holiday = hol.get(p.ymd);
  if (rule.day === "H") return !!holiday;
  if (rule.day !== p.dow) return false;
  if (!rule.weeks[weekOfMonth(p.d) - 1]) return false;
  if (holiday && !rule.holidays) {
    const nightly = rule.from < 6;
    if (!nightly) return false;
    if (holiday.nightlyNotEnforced) return false;
  }
  return true;
}

export function ruleActiveAt(rule: Rule, t: Date | number, hol: HolidayTable): boolean {
  const ms = typeof t === "number" ? t : t.getTime();
  const p = sfParts(ms);
  return partsActive(rule, p, () => prevDayParts(ms, p), hol);
}

export function activeAt(rules: Rule[], t: Date | number, hol: HolidayTable): boolean {
  return rules.some((r) => ruleActiveAt(r, t, hol));
}


/** Next instant strictly after t that is the top of a local hour. */
function nextHourBoundary(t: number): number {
  const p = sfParts(t);
  return t - (p.min * MIN) - (t % MIN) + HOUR;
}

function addYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function partsForYmd(ymd: string): LocalParts {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
  return { y, m, d, dow, h: 12, min: 0, ymd };
}

/** Local hour `hour` on ymd after t, or the first instant after a skipped spring-forward hour. */
function startInstant(ymd: string, hour: number, t: number): number {
  let cur = nextHourBoundary(t);
  const limit = t + 48 * HOUR;
  while (cur <= limit) {
    const p = sfParts(cur);
    if (p.ymd > ymd || (p.ymd === ymd && p.h >= hour)) return cur;
    cur = nextHourBoundary(cur);
  }
  return cur;
}

/**
 * Status at time t: "now" if sweeping is in effect, "soon" if it starts within the next
 * 60 minutes (inclusive of exactly 60), otherwise "clear". Windows start on the hour, so
 * checking the next top-of-hour (always within 60 min) is sufficient.
 */
export function statusAt(rules: Rule[], t: Date | number, hol: HolidayTable): Status {
  return statusFromClock(rules, clockAt(t), hol);
}

/** Precomputed local parts for a time t, so many sides can be evaluated with one Intl call. */
export interface Clock { t: number; now: LocalParts; next: LocalParts; minsToNext: number; nowPrev: LocalParts; nextPrev: LocalParts }
export function clockAt(t: Date | number): Clock {
  const ms = typeof t === "number" ? t : t.getTime();
  const nb = nextHourBoundary(ms);
  const now = sfParts(ms), next = sfParts(nb);
  return { t: ms, now, next, minsToNext: (nb - ms) / MIN, nowPrev: prevDayParts(ms, now), nextPrev: prevDayParts(nb, next) };
}

/**
 * Minutes until this rule's next start after t, if that start is today or tomorrow.
 * Returns null when there is no such start, or when the window has no duration
 * (e.g. a Sunday 2-3 AM rule on the spring-forward night, when 2 AM is skipped).
 *
 * Start/end math here is hour-based. If it is later replaced with minute-precision
 * instants, keep returning null when the window has no duration (`end <= start`).
 */
function minsUntilStart(rule: Rule, t: number, p: LocalParts, hol: HolidayTable): number | null {
  const today = ruleAppliesOnDate(rule, p, hol) && rule.from > p.h;
  const startYmd = today ? p.ymd : addYmd(p.ymd, 1);
  if (!today && !ruleAppliesOnDate(rule, partsForYmd(startYmd), hol)) return null;
  const start = startInstant(startYmd, rule.from, t);
  if (!crossesMidnight(rule) && rule.to !== 0) {
    const sp = sfParts(start);
    if (sp.ymd === startYmd && sp.h >= rule.to) return null;
  }
  return (start - t) / MIN;
}

export function statusFromClock(rules: Rule[], c: Clock, hol: HolidayTable): Status {
  if (rules.some((r) => partsActive(r, c.now, () => c.nowPrev, hol))) return "now";
  for (const r of rules) {
    const d = minsUntilStart(r, c.t, c.now, hol);
    if (d !== null && d > 0 && d <= AMBER_WINDOW_MIN) return "soon";
  }
  return "clear";
}

/** Start and end (ms) of the next sweep at or after t, searching up to maxDays ahead. */
export function nextSweep(
  rules: Rule[], t: Date | number, hol: HolidayTable, maxDays = 70,
): { start: number; end: number } | null {
  const ms = typeof t === "number" ? t : t.getTime();
  let cur = activeAt(rules, ms, hol) ? ms : nextHourBoundary(ms);
  const limit = ms + maxDays * 24 * HOUR;
  while (cur < limit) {
    if (activeAt(rules, cur, hol)) {
      let end = nextHourBoundary(cur);
      while (activeAt(rules, end, hol) && end < limit) end += HOUR;
      return { start: cur, end };
    }
    cur = nextHourBoundary(cur);
  }
  return null;
}

/** True if any rule is enforced at some hour on the local date of t. */
export function sweptOnDate(rules: Rule[], t: Date | number | LocalParts, hol: HolidayTable): boolean {
  const p = typeof t === "object" && "ymd" in t ? t : sfParts(t);
  return rules.some((r) => ruleAppliesOnDate(r, p, hol));
}

/**
 * Combine rules that share a weekday and time window, unioning their weeks of month.
 * DataSF often splits "every week" into two rows (1st/3rd/5th and 2nd/4th/5th); the merged
 * weeks then cover all five and `weeksLabel` returns "EVERY WEEK".
 */
export function mergeRuleWeeks(rules: Rule[]): Rule[] {
  const out: Rule[] = [];
  const idx = new Map<string, number>();
  for (const r of rules) {
    const key = `${r.day}|${r.from}|${r.to}|${r.holidays ? 1 : 0}`;
    const i = idx.get(key);
    if (i === undefined) {
      idx.set(key, out.length);
      out.push({ ...r, weeks: [r.weeks[0], r.weeks[1], r.weeks[2], r.weeks[3], r.weeks[4]] });
    } else {
      const w = out[i].weeks;
      out[i].weeks = [w[0] || r.weeks[0], w[1] || r.weeks[1], w[2] || r.weeks[2], w[3] || r.weeks[3], w[4] || r.weeks[4]];
    }
  }
  return out;
}

const ORD = ["1st", "2nd", "3rd", "4th", "5th"];
export function weeksLabel(weeks: boolean[]): string {
  if (weeks.every(Boolean)) return "EVERY WEEK";
  const on = weeks.map((w, i) => (w ? ORD[i] : null)).filter(Boolean) as string[];
  if (on.length === 0) return "NO WEEKS";
  const last = on.pop();
  return `${on.length ? on.join(", ") + " & " : ""}${last} OF MONTH`;
}

export function hourLabel(h: number): string {
  const hh = h % 24;
  if (hh === 0) return "12 AM";
  if (hh === 12) return "12 PM";
  return hh < 12 ? `${hh} AM` : `${hh - 12} PM`;
}

export const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
export function dayLabel(day: Weekday | "H"): string {
  return day === "H" ? "HOLIDAYS" : DAY_NAMES[day];
}
