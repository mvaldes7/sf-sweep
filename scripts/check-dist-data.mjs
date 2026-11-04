// Fails the build/deploy when the generated data is missing from dist (run `pnpm data` and `pnpm basemap` first).
// Set ALLOW_MISSING_DATA=1 to skip (CI only; CI has no generated data).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const REQUIRED_FILES = ["data/sweep-index.json", "data/sweep-sides.geojson", "data/basemap/meta.json", "data/basemap/0/0/0.mvt"];

export function missingData(dist = "dist") {
  const missing = REQUIRED_FILES.filter((f) => !existsSync(join(dist, f)) || statSync(join(dist, f)).size === 0);
  const z15 = join(dist, "data/basemap/15");
  if (!existsSync(z15) || readdirSync(z15).length === 0) missing.push("data/basemap/15/* (max zoom tiles)");
  return missing;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.ALLOW_MISSING_DATA === "1") { console.log("data check skipped (ALLOW_MISSING_DATA=1)"); process.exit(0); }
  const dist = process.argv[2] || "dist";
  const missing = missingData(dist);
  if (missing.length) {
    console.error(`Missing generated data in ${dist}/:\n  ${missing.join("\n  ")}\nRun \`pnpm data\` and \`pnpm basemap\`, then \`pnpm build\`. See docs/DEPLOY.md.`);
    process.exit(1);
  }
  console.log("data check passed");
}
