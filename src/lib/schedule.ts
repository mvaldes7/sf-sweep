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
  /** Window start, hours past midnight. May be fractional (7.5 = 7:30). */
  from: number; // 0-23.5
  /** Window end, hours past midnight, exclusive. May be fractional; 0 means midnight (24:00). */
  to: number; // 0-24
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

/** Hours (possibly fractional) to whole minutes past midnight. */
export function minutesFromHours(h: number): number {
  return Math.round(h * 60);
}
export function minutesOf(p: LocalParts): number {
  return p.h * 60 + p.min;
}
/** A window like 22-2 crosses midnight: it starts on the scheduled date and ends on the next day. */
export function crossesMidnight(rule: Rule): boolean {
  const to = minutesFromHours(rule.to);
  return to > 0 && to < minutesFromHours(rule.from);
}
/** Minute-of-day falls in the part of the window that belongs to the scheduled (start) date. */
function inWindow(rule: Rule, min: number): boolean {
  const from = minutesFromHours(rule.from);
  const toRaw = minutesFromHours(rule.to);
  const to = toRaw === 0 || crossesMidnight(rule) ? 1440 : toRaw;
  return min >= from && min < to;
}
/** Minute-of-day falls in the after-midnight tail of a crossing window (belongs to the previous date). */
function inTail(rule: Rule, min: number): boolean {
  return crossesMidnight(rule) && min < minutesFromHours(rule.to);
}
function partsActive(rule: Rule, p: LocalParts, prev: () => LocalParts, hol: HolidayTable): boolean {
  const m = minutesOf(p);
  if (inWindow(rule, m) && ruleAppliesOnDate(rule, p, hol)) return true;
  return inTail(rule, m) && ruleAppliesOnDate(rule, prev(), hol);
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
    const nightly = minutesFromHours(rule.from) < 6 * 60;
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

/** Local parts for the next local calendar date (midnight or just after). */
function nextDayParts(ms: number, p: LocalParts): LocalParts {
  return sfParts(ms + (1440 - minutesOf(p)) * MIN);
}

function addYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Epoch ms for a Pacific wall-clock time on a local YYYY-MM-DD date (`minutes` may be 1440
 * for midnight at the end of the day). On the fall-back night the repeated 1 AM hour resolves
 * to the earlier (daylight-time) instant. A skipped spring-forward hour returns the first
 * instant after the gap, so a 2-3 AM window that night has end <= start and is dropped.
 */
export function sfAt(ymd: string, minutes: number): number {
  if (minutes >= 1440) return sfAt(addYmd(ymd, Math.floor(minutes / 1440)), minutes % 1440);
  const [y, m, d] = ymd.split("-").map(Number);
  // Seed from daylight time (UTC-7) so the first 1:00 on fall-back night is found first.
  let t = Date.UTC(y, m - 1, d, 7, 0, 0) + minutes * MIN;
  const matches: number[] = [];
  const after: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < 8; i++) {
    if (seen.has(t)) break;
    seen.add(t);
    const p = sfParts(t);
    const got = minutesOf(p);
    const dayDelta = (Date.UTC(y, m - 1, d) - Date.UTC(p.y, p.m - 1, p.d)) / 86_400_000;
    if (dayDelta === 0 && got === minutes) {
      matches.push(t);
      const earlier = t - HOUR;
      const pe = sfParts(earlier);
      if (pe.y === y && pe.m === m && pe.d === d && minutesOf(pe) === minutes) matches.push(earlier);
      break;
    }
    if (dayDelta === 0 && got > minutes) after.push(t);
    t += (dayDelta * 1440 + (minutes - got)) * MIN;
  }
  if (matches.length) return Math.min(...matches);
  if (after.length) return Math.min(...after);
  return t;
}

function partsForYmd(ymd: string): LocalParts {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
  return { y, m, d, dow, h: 12, min: 0, ymd };
}

function windowEndYmd(ymd: string, rule: Rule): { ymd: string; minutes: number } {
  const toRaw = minutesFromHours(rule.to);
  if (toRaw === 0 || crossesMidnight(rule)) {
    return crossesMidnight(rule) ? { ymd: addYmd(ymd, 1), minutes: toRaw } : { ymd: addYmd(ymd, 1), minutes: 0 };
  }
  return { ymd, minutes: toRaw };
}

function intervalsInRange(rules: Rule[], fromYmd: string, days: number, hol: HolidayTable): { start: number; end: number }[] {
  const raw: { start: number; end: number }[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = addYmd(fromYmd, i);
    const p = partsForYmd(ymd);
    for (const r of rules) {
      if (!ruleAppliesOnDate(r, p, hol)) continue;
      const start = sfAt(ymd, minutesFromHours(r.from));
      const endAt = windowEndYmd(ymd, r);
      const end = sfAt(endAt.ymd, endAt.minutes);
      if (end <= start) continue; // zero-length, e.g. 2-3 AM on the spring-forward night
      raw.push({ start, end });
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

/**
 * Status at time t: "now" if sweeping is in effect, "soon" if it starts within the next
 * 60 minutes (inclusive of exactly 60), otherwise "clear". Windows may start or end on
 * the half hour, so this uses minute precision rather than the next top-of-hour.
 */
export function statusAt(rules: Rule[], t: Date | number, hol: HolidayTable): Status {
  return statusFromClock(rules, clockAt(t), hol);
}

/** Precomputed local parts for a time t, so many sides can be evaluated with few Intl calls. */
export interface Clock { t: number; now: LocalParts; next: LocalParts; minsToNext: number; nowPrev: LocalParts; nextPrev: LocalParts; tomorrow: LocalParts }
export function clockAt(t: Date | number): Clock {
  const ms = typeof t === "number" ? t : t.getTime();
  const nb = nextHourBoundary(ms);
  const now = sfParts(ms), next = sfParts(nb);
  return {
    t: ms, now, next, minsToNext: (nb - ms) / MIN,
    nowPrev: prevDayParts(ms, now), nextPrev: prevDayParts(nb, next),
    tomorrow: nextDayParts(ms, now),
  };
}

/** Real minutes until this rule's next start after t, if that start is today or tomorrow. */
function minsUntilStart(rule: Rule, t: number, p: LocalParts, hol: HolidayTable): number | null {
  const from = minutesFromHours(rule.from);
  const today = ruleAppliesOnDate(rule, p, hol) && from > minutesOf(p);
  const startYmd = today ? p.ymd : addYmd(p.ymd, 1);
  if (!today && !ruleAppliesOnDate(rule, partsForYmd(startYmd), hol)) return null;
  return (sfAt(startYmd, from) - t) / MIN;
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
  const ymd = sfParts(ms).ymd;
  // Include the previous local day so a midnight-crossing tail already in progress is found.
  const intervals = intervalsInRange(rules, addYmd(ymd, -1), maxDays + 2, hol);
  for (const iv of intervals) {
    if (iv.end <= ms) continue;
    return { start: Math.max(iv.start, ms), end: iv.end };
  }
  return null;
}

/** True if any rule is enforced at some hour on the local date of t. */
export function sweptOnDate(rules: Rule[], t: Date | number | LocalParts, hol: HolidayTable): boolean {
  const p = typeof t === "object" && "ymd" in t ? t : sfParts(t);
  return rules.some((r) => ruleAppliesOnDate(r, p, hol));
}

const ORD = ["1st", "2nd", "3rd", "4th", "5th"];
export function weeksLabel(weeks: boolean[]): string {
  if (weeks.every(Boolean)) return "EVERY WEEK";
  const on = weeks.map((w, i) => (w ? ORD[i] : null)).filter(Boolean) as string[];
  if (on.length === 0) return "NO WEEKS";
  const last = on.pop();
  return `${on.length ? on.join(", ") + " & " : ""}${last} OF MONTH`;
}

/** "7 AM" or "7:30 AM". `h` is hours past midnight and may be fractional; 0 and 24 are "12 AM". */
export function hourLabel(h: number): string {
  const total = minutesFromHours(h);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  const base = hh % 12 === 0 ? 12 : hh % 12;
  const ap = hh < 12 ? "AM" : "PM";
  return mm === 0 ? `${base} ${ap}` : `${base}:${String(mm).padStart(2, "0")} ${ap}`;
}

export const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
export function dayLabel(day: Weekday | "H"): string {
  return day === "H" ? "HOLIDAYS" : DAY_NAMES[day];
}
