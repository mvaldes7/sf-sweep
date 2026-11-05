#!/usr/bin/env node
// Ticket-time line: typical citation minute inside each posted sweep window, per side + rule.
//
// Source: DataSF SFMTA Parking Citations (ab4h-6ztd), violation TRC7.2.22 with description STR CLEAN.
// Only citation_issued_datetime, latitude and longitude are requested ($select). Plate columns are
// never fetched. No truck GPS. Run after `pnpm data` (needs public/data/sweep-index.json + geojson).
//
// Usage: node scripts/build-ticket-times.ts [--months 24] [--out public/data] [--cache .cache/tickets.json]
// Output: public/data/sweep-times.json { generated, source, range, counts, sides: { [sideId]: [[ruleIdx, medianMin, iqrMin, n]] } }
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HolidayTable, type Holiday, type Rule } from "../src/lib/schedule.ts";
import { decodeRule } from "../src/lib/data.ts";
import { LineIndex, matchWindows, parseLocal, windowStat, SNAP_M } from "../src/lib/tickettimes.ts";

const SODA = "https://data.sf.gov/resource/ab4h-6ztd.json";
const PAGE = 50000;
const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const months = Number(arg("--months", "24"));
const outDir = arg("--out", "public/data");
const cache = arg("--cache", ".cache/tickets.json");

const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
const since = start.toISOString().slice(0, 10) + "T00:00:00";

async function fetchTickets(): Promise<[string, number, number][]> {
  try {
    const c = JSON.parse(await readFile(cache, "utf8"));
    if (c.since === since) { console.log(`cache ${cache}: ${c.rows.length} rows`); return c.rows; }
  } catch { /* no cache */ }
  const rows: [string, number, number][] = [];
  for (let off = 0; ; off += PAGE) {
    const q = new URLSearchParams({
      $select: "citation_issued_datetime,latitude,longitude",
      $where: `violation='TRC7.2.22' AND violation_desc='STR CLEAN' AND citation_issued_datetime >= '${since}' AND latitude IS NOT NULL`,
      $order: ":id", $limit: String(PAGE), $offset: String(off),
    });
    let page: { citation_issued_datetime?: string; latitude?: string; longitude?: string }[] = [];
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${SODA}?${q}`);
      if (res.ok) { page = await res.json(); break; }
      if (attempt >= 3) throw new Error(`SODA ${res.status}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
    for (const r of page) if (r.citation_issued_datetime && r.latitude && r.longitude) rows.push([r.citation_issued_datetime, Number(r.longitude), Number(r.latitude)]);
    console.log(`fetched ${rows.length}`);
    if (page.length < PAGE) break;
  }
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify({ since, rows }));
  return rows;
}

const idx = JSON.parse(await readFile(join(outDir, "sweep-index.json"), "utf8")) as { sides: { id: number; cnn: string; side: string; r: never[] }[] };
const geo = JSON.parse(await readFile(join(outDir, "sweep-sides.geojson"), "utf8")) as { features: { id: number; geometry: { coordinates: [number, number][] } }[] };
// src/data/holidays.json starts at 2026 (the app only looks forward). The ticket window reaches back
// to late 2024, so past SFMTA enforcement holidays are listed here: standard observed dates, same set
// as the 2026 table. Not checked against an archived SFMTA page.
const PAST: [string, string, boolean][] = [
  ["2024-11-11", "Veterans Day", false], ["2024-11-28", "Thanksgiving Day", true], ["2024-11-29", "Day After Thanksgiving", false],
  ["2024-12-25", "Christmas Day", true], ["2025-01-01", "New Year's Day", true], ["2025-01-20", "Dr. Martin Luther King, Jr. Day", false],
  ["2025-02-17", "Presidents' Day", false], ["2025-05-26", "Memorial Day", false], ["2025-06-19", "Juneteenth", false],
  ["2025-07-04", "Independence Day", false], ["2025-09-01", "Labor Day", false], ["2025-10-13", "Indigenous Peoples Day", false],
  ["2025-11-11", "Veterans Day", false], ["2025-11-27", "Thanksgiving Day", true], ["2025-11-28", "Day After Thanksgiving", false],
  ["2025-12-25", "Christmas Day", true],
];
const hol = new HolidayTable([
  ...PAST.map(([date, name, nightlyNotEnforced]) => ({ date, name, nightlyNotEnforced }) as Holiday),
  ...(JSON.parse(await readFile("src/data/holidays.json", "utf8")) as { holidays: Holiday[] }).holidays,
]);

const rulesById = new Map<number, Rule[]>();
const byCnn = new Map<string, number[]>();
for (const s of idx.sides) { rulesById.set(s.id, s.r.map(decodeRule)); (byCnn.get(s.cnn) ?? byCnn.set(s.cnn, []).get(s.cnn)!).push(s.id); }
const cnnOf = new Map(idx.sides.map((s) => [s.id, s.cnn]));
const lines = new LineIndex();
for (const f of geo.features) lines.add(String(f.id), f.geometry.coordinates);

const rows = await fetchTickets();
const samples = new Map<string, { mins: number; ymd: string }[]>();
let snapped = 0, inWindow = 0, ambiguous = 0;
let minDate = "9999", maxDate = "0000";
for (const [ts, lng, lat] of rows) {
  const p = parseLocal(ts);
  if (!p) continue;
  const hit = lines.nearest([lng, lat], SNAP_M);
  if (!hit) continue;
  snapped++;
  const cnn = cnnOf.get(Number(hit.key))!;
  // side: the L/R side(s) of this CNN whose posted window contains the ticket time
  const matches: { side: number; rule: number; mins: number }[] = [];
  for (const sid of byCnn.get(cnn) ?? []) for (const m of matchWindows(rulesById.get(sid)!, p, hol)) matches.push({ side: sid, ...m });
  if (!matches.length) continue;
  inWindow++;
  if (new Set(matches.map((m) => m.side)).size > 1) ambiguous++;
  if (p.ymd < minDate) minDate = p.ymd;
  if (p.ymd > maxDate) maxDate = p.ymd;
  for (const m of matches) {
    const k = `${m.side}:${m.rule}`;
    (samples.get(k) ?? samples.set(k, []).get(k)!).push({ mins: m.mins, ymd: p.ymd });
  }
}

const sides: Record<string, [number, number, number, number][]> = {};
let kept = 0, tooFew = 0, tooSpread = 0;
for (const [k, list] of samples) {
  const st = windowStat(list);
  if (!st) { if (list.length >= 5 && new Set(list.map((s) => s.ymd)).size >= 3) tooSpread++; else tooFew++; continue; }
  const [sid, rule] = k.split(":").map(Number);
  (sides[sid] ??= []).push([rule, st.median, st.iqr, st.n]);
  kept++;
}
const counts = {
  fetched: rows.length, snapped, inWindow, bothSidesMatched: ambiguous,
  sideRules: samples.size, sideRulesKept: kept, sideRulesTooFew: tooFew, sideRulesTooSpread: tooSpread,
  sidesWithTime: Object.keys(sides).length, sidesTotal: idx.sides.length,
};
const out = {
  generated: new Date().toISOString(),
  source: "DataSF SFMTA Parking Citations (ab4h-6ztd), TRC7.2.22 STR CLEAN, https://data.sf.gov/d/ab4h-6ztd",
  range: { from: minDate, to: maxDate }, counts, sides,
};
await writeFile(join(outDir, "sweep-times.json"), JSON.stringify(out));
const sz = (await stat(join(outDir, "sweep-times.json"))).size;
console.log(JSON.stringify(counts), `range ${minDate}..${maxDate}`, `${(sz / 1024).toFixed(0)} KB`);
