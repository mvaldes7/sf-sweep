// Fails the build/deploy when the generated data is missing or invalid in dist
// (run `pnpm data`, `pnpm tickets`, and `pnpm basemap` first).
// Set ALLOW_MISSING_DATA=1 to skip (CI only; CI has no generated data).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const REQUIRED_FILES = ["data/sweep-index.json", "data/sweep-sides.geojson", "data/sweep-times.json", "data/basemap/meta.json", "data/basemap/0/0/0.mvt"];

export const JSON_DATA_FILES = ["data/sweep-index.json", "data/sweep-sides.geojson", "data/sweep-times.json"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function missingData(dist = "dist") {
  const missing = REQUIRED_FILES.filter((f) => !existsSync(join(dist, f)) || statSync(join(dist, f)).size === 0);
  const z15 = join(dist, "data/basemap/15");
  if (!existsSync(z15) || readdirSync(z15).length === 0) missing.push("data/basemap/15/* (max zoom tiles)");
  return missing;
}

/**
 * Parse and check the top-level shape of the generated JSON files.
 * Skips missing or empty files; those are reported by missingData.
 * An HTML 404 (or any other non-JSON body) saved under these names fails.
 */
export function invalidJsonData(dist = "dist") {
  const problems = [];
  const check = (rel, validate) => {
    const path = join(dist, rel);
    if (!existsSync(path) || statSync(path).size === 0) return;
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      problems.push(`${rel}: not valid JSON (refusing HTML 404 pages or other non-JSON bodies)`);
      return;
    }
    const err = validate(data);
    if (err) problems.push(`${rel}: ${err}`);
  };

  check("data/sweep-index.json", (data) => {
    if (!isPlainObject(data)) return "expected a JSON object with generated, source, and sides";
    const missing = ["generated", "source", "sides"].filter((k) => !(k in data));
    if (missing.length) return `missing top-level keys: ${missing.join(", ")}`;
    if (!Array.isArray(data.sides)) return "sides must be an array";
    return null;
  });

  check("data/sweep-sides.geojson", (data) => {
    if (!isPlainObject(data) || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      return "expected a GeoJSON FeatureCollection with a features array";
    }
    return null;
  });

  check("data/sweep-times.json", (data) => {
    if (!isPlainObject(data)) return "expected a JSON object with range and sides";
    const missing = ["range", "sides"].filter((k) => !(k in data));
    if (missing.length) return `missing top-level keys: ${missing.join(", ")}`;
    if (!isPlainObject(data.range) || !("from" in data.range) || !("to" in data.range)) {
      return "range must be an object with from and to";
    }
    if (!isPlainObject(data.sides)) return "sides must be an object keyed by side id";
    return null;
  });

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.ALLOW_MISSING_DATA === "1") { console.log("data check skipped (ALLOW_MISSING_DATA=1)"); process.exit(0); }
  const dist = process.argv[2] || "dist";
  const missing = missingData(dist);
  const invalid = invalidJsonData(dist);
  if (missing.length || invalid.length) {
    if (missing.length) console.error(`Missing generated data in ${dist}/:\n  ${missing.join("\n  ")}`);
    if (invalid.length) console.error(`Invalid generated data in ${dist}/:\n  ${invalid.join("\n  ")}`);
    console.error("Run `pnpm data`, `pnpm tickets`, and `pnpm basemap`, then `pnpm build`. To restore ticket times without rerunning the citations pipeline, fetch sweep-times.json from a specific older Pages deployment with curl --fail (never from the production hostname). See docs/DEPLOY.md.");
    process.exit(1);
  }
  console.log("data check passed");
}
