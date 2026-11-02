import type { Rule, Weekday } from "./schedule";

/** Compact rule as written by scripts/build-data.mjs: [day(0-6, 7=holiday-only), from, to, weekBits, holidays(0|1)] */
export type CompactRule = [number, number, number, number, number];

export interface SideRecord {
  id: number; // feature id shared with line geometry
  cnn: string;
  side: "L" | "R";
  street: string;
  limits: string;
  blockside: string;
  mid: [number, number]; // lon, lat
  r: CompactRule[];
}
export interface SweepIndex {
  generated: string;
  source: string;
  sides: SideRecord[];
}

export function decodeRule(c: CompactRule): Rule {
  const [day, from, to, bits, hol] = c;
  return {
    day: day === 7 ? "H" : (day as Weekday),
    from, to,
    weeks: [0, 1, 2, 3, 4].map((i) => ((bits >> i) & 1) === 1) as Rule["weeks"],
    holidays: hol === 1,
  };
}

export function encodeRule(r: Rule): CompactRule {
  const bits = r.weeks.reduce((acc, w, i) => acc | ((w ? 1 : 0) << i), 0);
  return [r.day === "H" ? 7 : r.day, r.from, r.to, bits, r.holidays ? 1 : 0];
}

/** Very small offline street search over the dataset (no external geocoder). */
export function searchStreets(sides: SideRecord[], q: string, limit = 8): SideRecord[] {
  const needle = q.trim().toLowerCase().replace(/\s+/g, " ");
  if (needle.length < 2) return [];
  const terms = needle.split(" ");
  const seen = new Set<string>();
  const out: SideRecord[] = [];
  for (const s of sides) {
    const hay = `${s.street} ${s.limits}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    if (seen.has(s.cnn)) continue;
    seen.add(s.cnn);
    out.push(s);
  }
  out.sort((a, b) => {
    const as = a.street.toLowerCase().startsWith(terms[0]) ? 0 : 1;
    const bs = b.street.toLowerCase().startsWith(terms[0]) ? 0 : 1;
    return as - bs || a.street.localeCompare(b.street) || a.limits.localeCompare(b.limits);
  });
  return out.slice(0, limit);
}
