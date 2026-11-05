/** "Find a safe spot": sides near a point with no sweeping in the next N hours. Pure. */
import { clockAt, statusFromClock, type Clock, type HolidayTable, type Rule } from "./schedule";

const HOUR = 3_600_000;
export const SAFE_RADIUS_M = 805; // about 0.5 mi

export function distanceM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Clocks at now and at every local top-of-hour before now + hours. Sweep windows start on the
 * hour, so a side is free for the horizon iff it is not active at any of these instants.
 * Built once per search (hours + 1 Intl calls), then reused for every side.
 */
export function horizonClocks(now: number, hours: number): Clock[] {
  const out = [clockAt(now)];
  const end = now + hours * HOUR;
  let t = now - (now % HOUR) + HOUR; // LA offsets are whole hours, so UTC hour boundaries are local ones
  for (; t < end; t += HOUR) out.push(clockAt(t));
  return out;
}

export function freeForHorizon(rules: Rule[], clocks: Clock[], hol: HolidayTable): boolean {
  for (const c of clocks) if (statusFromClock(rules, c, hol) === "now") return false;
  return true;
}

export interface SafeResult { safe: number[]; nearby: number }
export function findSafeSides(
  sides: { id: number; mid: [number, number] }[], rulesById: Map<number, Rule[]>, center: [number, number],
  now: number, hours: number, hol: HolidayTable, radiusM = SAFE_RADIUS_M,
): SafeResult {
  const clocks = horizonClocks(now, hours);
  // cheap bounding box before haversine
  const dLat = radiusM / 111_320, dLng = radiusM / (111_320 * Math.cos((center[1] * Math.PI) / 180));
  const safe: number[] = [];
  let nearby = 0;
  for (const s of sides) {
    if (Math.abs(s.mid[1] - center[1]) > dLat || Math.abs(s.mid[0] - center[0]) > dLng) continue;
    if (distanceM(s.mid, center) > radiusM) continue;
    nearby++;
    if (freeForHorizon(rulesById.get(s.id) ?? [], clocks, hol)) safe.push(s.id);
  }
  return { safe, nearby };
}
