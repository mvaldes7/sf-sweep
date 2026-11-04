#!/usr/bin/env node
// Data pipeline: DataSF yhqp-riqs -> per-side offset lines + compact schedule index (+ PMTiles if tippecanoe exists).
//
// Usage:
//   node scripts/build-data.mjs              full city (about 38k rows)
//   node scripts/build-data.mjs --limit 2000 first N rows only (quick local check)
//   node scripts/build-data.mjs --input rows.json   use a saved SODA JSON export instead of the network
//
// Outputs (default dir public/data, override with --out):
//   sweep-index.json     schedule + label data per side (used for status, sign cards, offline search)
//   sweep-sides.geojson  offset LineStrings, one per (cnn, side), feature id = index id
//   sweep.pmtiles        vector tiles (layer "sides") when tippecanoe is on PATH or TIPPECANOE is set
//
// Free tools only: Node 22+, optional tippecanoe (https://github.com/felt/tippecanoe, BSD-2).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { offsetLine, midpoint } from "./offset.mjs";

const SODA = "https://data.sf.gov/resource/yhqp-riqs.json";
const OFFSET_M = 4;
const PAGE = 50000;

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outDir = arg("--out", "public/data");
const limit = Number(arg("--limit", "0")) || 0;
const input = arg("--input", "");

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, hol: 7 };

async function fetchRows() {
  if (input) return JSON.parse(await readFile(input, "utf8"));
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const n = limit ? Math.min(PAGE, limit - rows.length) : PAGE;
    if (n <= 0) break;
    const url = `${SODA}?$limit=${n}&$offset=${offset}&$order=blocksweepid`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`SODA ${res.status} for ${url}`);
    const page = await res.json();
    rows.push(...page);
    console.log(`fetched ${rows.length} rows`);
    if (page.length < n) break;
  }
  return rows;
}

export function buildSides(rows) {
  const groups = new Map();
  let skipped = 0;
  for (const r of rows) {
    const coords = r.line?.coordinates;
    const side = r.cnnrightleft === "L" ? "L" : r.cnnrightleft === "R" ? "R" : null;
    const day = DAYS[String(r.weekday || "").slice(0, 3).toLowerCase()];
    if (!coords || coords.length < 2 || !side || day === undefined) { skipped++; continue; }
    const key = `${r.cnn}:${side}`;
    let g = groups.get(key);
    if (!g) {
      g = { cnn: String(r.cnn), side, street: (r.corridor || "").trim(), limits: (r.limits || "").replace(/\s+-\s+/, " - ").replace(/\s+/g, " ").trim(), blockside: r.blockside || "", coords, rules: [], seen: new Set() };
      groups.set(key, g);
    }
    let bits = 0;
    for (let w = 1; w <= 5; w++) if (String(r[`week${w}`]) === "1") bits |= 1 << (w - 1);
    const rule = [day, Number(r.fromhour), Number(r.tohour), bits, String(r.holidays) === "1" ? 1 : 0];
    const rk = rule.join(",");
    if (!g.seen.has(rk)) { g.seen.add(rk); g.rules.push(rule); }
  }
  const sides = [];
  const features = [];
  let id = 1;
  for (const g of groups.values()) {
    const line = offsetLine(g.coords, g.side === "L" ? OFFSET_M : -OFFSET_M);
    g.rules.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    sides.push({ id, cnn: g.cnn, side: g.side, street: g.street, limits: g.limits, blockside: g.blockside, mid: midpoint(line), r: g.rules });
    features.push({ type: "Feature", id, properties: { fid: id }, geometry: { type: "LineString", coordinates: line } });
    id++;
  }
  return { sides, features, skipped };
}

async function main() {
  const rows = await fetchRows();
  const { sides, features, skipped } = buildSides(rows);
  await mkdir(outDir, { recursive: true });
  const generated = new Date().toISOString();
  await writeFile(join(outDir, "sweep-index.json"), JSON.stringify({ generated, source: "DataSF Street Sweeping Schedule (yhqp-riqs), https://data.sf.gov/d/yhqp-riqs", sides }));
  const gj = join(outDir, "sweep-sides.geojson");
  await writeFile(gj, JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`rows ${rows.length}, sides ${sides.length}, skipped ${skipped} (null geometry or unknown side/day)`);

  const tc = process.env.TIPPECANOE || "tippecanoe";
  const probe = spawnSync(tc, ["--version"], { encoding: "utf8" });
  if (probe.error) {
    console.log("tippecanoe not found: GeoJSON fallback only. See docs/DATA.md to build sweep.pmtiles.");
    return;
  }
  const out = join(outDir, "sweep.pmtiles");
  const res = spawnSync(tc, ["-o", out, "--force", "-l", "sides", "-Z", "11", "-z", "16", "--no-feature-limit", "--no-tile-size-limit", "--use-attribute-for-id=fid", gj], { stdio: "inherit" });
  if (res.status !== 0) throw new Error("tippecanoe failed");
  console.log(`wrote ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
