/** Ticket risk for a parked car. Pure; all wall-clock text is America/Los_Angeles. */
import { TZ } from "./schedule";

export type RiskLevel = "red" | "amber" | "safe" | "none";
export interface Risk { level: RiskLevel; text: string }
const MIN = 60_000, HOUR = 3_600_000;
export const AMBER_HOURS = 12;
export const RED_HOURS = 2;

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
const hmFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

/** "8 AM" or "8:30 AM" (drops ":00"). */
export function clockText(t: number): string { return hmFmt.format(t).replace(":00", "").replace(/\u202f/g, " "); }

/** "Tue 8 AM" within the next 6 days, else "Tue, Nov 17 8 AM" so a week rollover is unambiguous. */
export function whenText(t: number, now: number): string {
  const d = t - now < 6 * 24 * HOUR ? dayFmt.format(t) : dateFmt.format(t);
  return `${d} ${clockText(t)}`;
}

/** Elapsed real time (DST safe because it is absolute ms): "45m", "2h", "2h 15m", "3d 4h". */
export function durationText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export function carRisk(next: { start: number; end: number } | null, now: number): Risk {
  if (!next) return { level: "none", text: "No sweeping scheduled" };
  if (now >= next.start && now < next.end) return { level: "red", text: `Sweeping now until ${clockText(next.end)}` };
  const left = next.start - now;
  if (left <= RED_HOURS * HOUR) return { level: "red", text: `Sweeping in ${durationText(left)}` };
  if (left <= AMBER_HOURS * HOUR) return { level: "amber", text: `Sweeping in ${durationText(left)}` };
  return { level: "safe", text: `Safe until ${whenText(next.start, now)}` };
}

/** Detail-sheet line for any side: "Next sweep Tue 8 AM (in 5h)". */
export function nextText(next: { start: number; end: number } | null, now: number): string {
  if (!next) return "No sweeping scheduled";
  if (now >= next.start && now < next.end) return `Sweeping now until ${clockText(next.end)}`;
  return `Next sweep ${whenText(next.start, now)} (in ${durationText(next.start - now)})`;
}
