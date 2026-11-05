/**
 * "Tickets usually ~9:12": typical citation minute within a posted sweep window, from DataSF
 * parking citations (ab4h-6ztd, violation TRC7.2.22 / STR CLEAN). Pure functions used by the
 * build script (scripts/build-ticket-times.ts) and the UI. Citation times are SF wall-clock.
 */
import { type HolidayTable, ruleAppliesOnDate, type LocalParts, type Rule, type Weekday } from "./schedule.ts";

export const SNAP_M = 40;
export const MIN_TICKETS = 5;
export const MIN_DATES = 3;
export const TRIM = 0.05;
export const MAX_IQR_MIN = 45;

/** Parse a SODA floating timestamp ("2026-10-30T12:37:00.000", SF wall time) without time zones. */
export function parseLocal(s: string): LocalParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() as Weekday;
  return { y, m: mo, d, dow, h, min: mi, ymd: `${m[1]}-${m[2]}-${m[3]}` };
}
function prevDay(p: LocalParts): LocalParts {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86_400_000);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
  return { y, m, d, dow: t.getUTCDay() as Weekday, h: 23, min: 59, ymd: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** Rules on this side whose posted window contains the ticket, with minutes after the window start. */
export function matchWindows(rules: Rule[], p: LocalParts, hol: HolidayTable): { rule: number; mins: number }[] {
  const out: { rule: number; mins: number }[] = [];
  rules.forEach((r, i) => {
    const crosses = r.to > 0 && r.to < r.from;
    const end = r.to === 0 || crosses ? 24 : r.to;
    if (p.h >= r.from && p.h < end && ruleAppliesOnDate(r, p, hol)) out.push({ rule: i, mins: (p.h - r.from) * 60 + p.min });
    else if (crosses && p.h < r.to && ruleAppliesOnDate(r, prevDay(p), hol)) out.push({ rule: i, mins: (24 - r.from + p.h) * 60 + p.min });
  });
  return out;
}

/** Linear-interpolated quantile of a sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface TimeStat { median: number; iqr: number; n: number; days: number }
/**
 * Median minutes after window start and IQR. Needs >= 5 tickets on >= 3 distinct dates; drops the
 * first and last 5% (by minute) before the stats; returns null when IQR > 45 min (too spread to help).
 */
export function windowStat(samples: { mins: number; ymd: string }[]): TimeStat | null {
  if (samples.length < MIN_TICKETS) return null;
  const days = new Set(samples.map((s) => s.ymd)).size;
  if (days < MIN_DATES) return null;
  const sorted = samples.map((s) => s.mins).sort((a, b) => a - b);
  const k = Math.floor(sorted.length * TRIM);
  const kept = sorted.slice(k, sorted.length - k);
  const iqr = quantile(kept, 0.75) - quantile(kept, 0.25);
  if (iqr > MAX_IQR_MIN) return null;
  return { median: Math.round(quantile(kept, 0.5)), iqr: Math.round(iqr), n: samples.length, days };
}

/** "9:12 AM" for a window starting at `fromHour` plus `mins`. */
export function clockFor(fromHour: number, mins: number): string {
  const total = (fromHour * 60 + mins) % 1440;
  const h = Math.floor(total / 60), m = total % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ---------- snapping ----------
type Line = [number, number][];
const M_PER_DEG_LAT = 111_320;
/** Distance in meters from a point to a polyline (local equirectangular; fine at city scale). */
export function pointLineM(pt: [number, number], line: Line): number {
  const kx = M_PER_DEG_LAT * Math.cos((pt[1] * Math.PI) / 180), ky = M_PER_DEG_LAT;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - pt[0]) * kx, ay = (line[i - 1][1] - pt[1]) * ky;
    const bx = (line[i][0] - pt[0]) * kx, by = (line[i][1] - pt[1]) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const x = ax + t * dx, y = ay + t * dy;
    best = Math.min(best, Math.hypot(x, y));
  }
  return best;
}

/** Grid index over lines (cell ~ 0.001 deg, about 90-110 m) for nearest-line lookup within SNAP_M. */
export class LineIndex {
  cells = new Map<string, number[]>();
  lines: { key: string; line: Line }[] = [];
  add(key: string, line: Line) {
    const i = this.lines.push({ key, line }) - 1;
    const seen = new Set<string>();
    const pts: [number, number][] = [line[0]];
    for (let k = 1; k < line.length; k++) {
      const [ax, ay] = line[k - 1], [bx, by] = line[k];
      const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / 0.0005);
      for (let s = 1; s <= steps; s++) pts.push([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps]);
    }
    for (const [x, y] of pts) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const c = `${Math.floor(x * 1000) + dx},${Math.floor(y * 1000) + dy}`;
      if (seen.has(c)) continue; seen.add(c);
      (this.cells.get(c) ?? this.cells.set(c, []).get(c)!).push(i);
    }
  }
  nearest(pt: [number, number], maxM = SNAP_M): { key: string; dist: number } | null {
    const ids = this.cells.get(`${Math.floor(pt[0] * 1000)},${Math.floor(pt[1] * 1000)}`);
    let best: { key: string; dist: number } | null = null;
    for (const i of ids ?? []) {
      const d = pointLineM(pt, this.lines[i].line);
      if (d <= maxM && (!best || d < best.dist)) best = { key: this.lines[i].key, dist: d };
    }
    return best;
  }
}

/** Order items by their rule's weekday Mon -> Sun (holiday-only rules last), then by start hour. */
export function sortByWeekday<T>(items: T[], ruleOf: (x: T) => Rule): T[] {
  const key = (r: Rule) => (r.day === "H" ? 7 : (r.day + 6) % 7) * 100 + r.from;
  return [...items].sort((a, b) => key(ruleOf(a)) - key(ruleOf(b)));
}
