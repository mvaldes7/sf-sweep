// Build-time schedule corrections: override DataSF rules for specific block sides.
// Source of truth: src/data/corrections.json (versioned). Applied by scripts/build-data.mjs.
import { readFileSync } from "node:fs";

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, hol: "H" };
function parseWeekday(s) {
  const k = String(s).trim().slice(0, 3).toLowerCase();
  return k in DAYS ? DAYS[k] : null;
}

export const CORRECTIONS_PATH = "src/data/corrections.json";

/** "07:30" or "7:30" -> hours past midnight (7.5). "24:00" -> 24. */
export function parseClock(s) {
  const t = String(s).trim();
  if (t === "24:00") return 24;
  const m = /^([01]?\d|2[0-3])(?::([0-5]\d))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) + Number(m[2] || 0) / 60;
}

export function weeksToBits(weeks) {
  if (!Array.isArray(weeks) || weeks.length === 0) return null;
  let bits = 0;
  for (const w of weeks) {
    const n = Number(w);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    bits |= 1 << (n - 1);
  }
  return bits;
}

function compactRule(rule) {
  const day = parseWeekday(String(rule.day ?? ""));
  const from = parseClock(rule.from);
  const to = parseClock(rule.to);
  const bits = weeksToBits(rule.weeks);
  if (day === null || from === null || to === null || bits === null || bits === 0) return { error: "invalid rule day, time or weeks" };
  if (!(from >= 0 && from < 24)) return { error: "from must be in 00:00-23:59" };
  if (!(to > 0 && to <= 24)) return { error: "to must be in 00:01-24:00" };
  return { rule: [day === "H" ? 7 : day, from, to, bits, rule.holidays ? 1 : 0] };
}

export function loadCorrections(source) {
  const data = typeof source === "string" || source === undefined
    ? JSON.parse(readFileSync(source || CORRECTIONS_PATH, "utf8"))
    : source;
  return data;
}

/** Returns problem strings for a corrections document. */
export function invalidCorrections(data) {
  const problems = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["corrections: expected a JSON object"];
  if (data.version !== 1) problems.push("corrections: version must be 1");
  if (!Array.isArray(data.corrections)) {
    problems.push("corrections: missing corrections array");
    return problems;
  }
  const seen = new Set();
  data.corrections.forEach((c, i) => {
    const at = `corrections[${i}]`;
    if (!c || typeof c !== "object") { problems.push(`${at}: expected an object`); return; }
    if (!c.cnn || typeof c.cnn !== "string") problems.push(`${at}: cnn is required`);
    if (c.side !== "L" && c.side !== "R") problems.push(`${at}: side must be L or R`);
    if (!c.source || typeof c.source !== "string") problems.push(`${at}: source is required`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.reported || "")) problems.push(`${at}: reported must be YYYY-MM-DD`);
    if (!Array.isArray(c.rules) || c.rules.length === 0) problems.push(`${at}: rules must be a non-empty array`);
    else for (const [j, r] of c.rules.entries()) {
      const cr = compactRule(r);
      if (cr.error) problems.push(`${at}.rules[${j}]: ${cr.error}`);
    }
    const key = `${c.cnn}:${c.side}`;
    if (seen.has(key)) problems.push(`${at}: duplicate cnn+side ${key}`);
    seen.add(key);
  });
  return problems;
}

/**
 * Replace rules on matching sides (cnn + L/R). If street/limits/blockside are set, they must match
 * (case-insensitive). Throws if a correction matches no side or conflicts with labels.
 * Mutates and returns sides.
 */
export function applyCorrections(sides, data) {
  const problems = invalidCorrections(data);
  if (problems.length) throw new Error(problems.join("\n"));
  const list = sides.slice();
  for (const c of data.corrections) {
    const hits = list.filter((s) => String(s.cnn) === String(c.cnn) && s.side === c.side);
    if (!hits.length) throw new Error(`correction cnn ${c.cnn} side ${c.side} matched no side`);
    for (const field of ["street", "limits", "blockside"]) {
      if (c[field] && hits.some((s) => String(s[field] || "").toLowerCase() !== String(c[field]).toLowerCase())) {
        throw new Error(`correction cnn ${c.cnn} side ${c.side}: ${field} does not match the DataSF side`);
      }
    }
    const rules = c.rules.map((r) => compactRule(r).rule);
    const meta = { source: c.source, reported: c.reported, ...(c.note ? { note: c.note } : {}) };
    for (const s of hits) {
      s.r = rules;
      s.corrected = meta;
    }
  }
  return list;
}
