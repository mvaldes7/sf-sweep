import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import holidaysJson from "../src/data/holidays.json";
import { PAGES_MAX_FILE_BYTES, makeTempFiles, oversized, readJsonIfExists, writeTempFiles } from "../scripts/check-asset-size.mjs";
import { crossesMidnight } from "../src/lib/schedule";
import { type CompactRule, decodeRule, type SweepIndex } from "../src/lib/data";

describe("holiday table expiry", () => {
  it("covers at least 90 days past today (fails near expiry: re-check SFMTA and extend holidays.json)", () => {
    const last = holidaysJson.holidays.map((h) => h.date).sort().at(-1)!;
    expect(new Date(`${last}T00:00:00Z`).getTime()).toBeGreaterThan(Date.now() + 90 * 86400000);
  });
});

describe("Pages 25MB per-file limit", () => {
  it("flags files over the limit", async () => {
    const d = makeTempFiles({ "ok.json": 2, "big.bin": PAGES_MAX_FILE_BYTES + 1 });
    const bad = await oversized(d);
    expect(bad.map((b) => b.path.split("/").pop())).toEqual(["big.bin"]);
  });
  it("current public/data files are under the limit", async () => {
    expect(await oversized("public/data")).toEqual([]);
  });
});

describe("dataset midnight crossing", () => {
  const d = readJsonIfExists("public/data/sweep-index.json") as { sides: { r: CompactRule[] }[] } | null;
  it.skipIf(!d)("no rule in the built dataset crosses midnight (logic handles it anyway)", () => {
    const crossing = d!.sides.flatMap((s) => s.r.map(decodeRule)).filter(crossesMidnight);
    expect(crossing).toEqual([]);
  });
});

describe("dist data check", () => {
  it("reports missing data and passes when everything is present", async () => {
    const { missingData, REQUIRED_FILES } = await import("../scripts/check-dist-data.mjs");
    const empty = makeTempFiles({ "index.html": 10 });
    expect(missingData(empty).length).toBe(REQUIRED_FILES.length + 1);
    const full = makeTempFiles(Object.fromEntries([...REQUIRED_FILES, "data/basemap/15/5240/12663.mvt"].map((f) => [f, 10])));
    expect(missingData(full)).toEqual([]);
    const noTiles = makeTempFiles(Object.fromEntries(REQUIRED_FILES.filter((f) => !f.endsWith(".mvt")).map((f) => [f, 10])));
    expect(missingData(noTiles).join(" ")).toMatch(/0\/0\/0\.mvt.*15/);
  });
});

const HTML_404 = readFileSync("public/404.html", "utf8");
const fixtureFile = (name: string) => readFileSync(`tests/fixtures/data/${name}`, "utf8");

function writeDist(files: Record<string, string>): string {
  return writeTempFiles({ "index.html": "x", ...files });
}

/** Ticket-times file shape used by src/main.ts. */
type SweepTimes = { range: { from: string; to: string }; sides: Record<string, [number, number, number, number][]> };

describe("dist JSON shape check", () => {
  it("fails when an HTML 404 is saved under each generated data name", async () => {
    const { invalidJsonData, JSON_DATA_FILES } = await import("../scripts/check-dist-data.mjs");
    for (const name of JSON_DATA_FILES) {
      const problems = invalidJsonData(writeDist({ [name]: HTML_404 })).join("\n");
      expect(problems, name).toMatch(new RegExp(`${name.replaceAll(".", "\\.")}: not valid JSON`));
      expect(problems, name).toMatch(/HTML 404/);
    }
  });

  it("fails when JSON is the wrong top-level shape", async () => {
    const { invalidJsonData } = await import("../scripts/check-dist-data.mjs");
    const problems = invalidJsonData(writeDist({
      "data/sweep-index.json": JSON.stringify({ generated: "x", source: "y" }),
      "data/sweep-sides.geojson": JSON.stringify({ type: "Feature", features: [] }),
      "data/sweep-times.json": JSON.stringify({ generated: "x", sides: [] }),
    })).join("\n");
    expect(problems).toMatch(/sweep-index\.json: missing top-level keys: sides/);
    expect(problems).toMatch(/sweep-sides\.geojson: expected a GeoJSON FeatureCollection/);
    expect(problems).toMatch(/sweep-times\.json: missing top-level keys: range/);
    const timesArray = invalidJsonData(writeDist({
      "data/sweep-times.json": JSON.stringify({ range: { from: "2024-01-01", to: "2026-01-01" }, sides: [] }),
    })).join("\n");
    expect(timesArray).toMatch(/sweep-times\.json: sides must be an object keyed by side id/);
  });

  it("accepts the committed browser fixtures", async () => {
    const { invalidJsonData, missingData } = await import("../scripts/check-dist-data.mjs");
    const d = writeDist({
      "data/sweep-index.json": fixtureFile("sweep-index.json"),
      "data/sweep-sides.geojson": fixtureFile("sweep-sides.geojson"),
      "data/sweep-times.json": fixtureFile("sweep-times.json"),
    });
    expect(invalidJsonData(d)).toEqual([]);
    expect(missingData(d).some((m) => m.includes("sweep-"))).toBe(false);
  });
});

describe("browser data fixtures", () => {
  it("keeps index, sides, and times ids and rules consistent", () => {
    const index = JSON.parse(fixtureFile("sweep-index.json")) as SweepIndex;
    const geo = JSON.parse(fixtureFile("sweep-sides.geojson")) as FeatureCollection;
    const times = JSON.parse(fixtureFile("sweep-times.json")) as SweepTimes;
    expect(index.sides.length).toBeGreaterThan(0);
    const byId = new Map(index.sides.map((s) => [s.id, s]));
    expect(byId.size).toBe(index.sides.length);
    expect(new Set(geo.features.map((f) => f.id))).toEqual(new Set(byId.keys()));
    expect(geo.features.every((f) => f.properties?.fid === f.id)).toBe(true);
    expect(times.range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(times.range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [sid, rows] of Object.entries(times.sides)) {
      const side = byId.get(Number(sid));
      expect(side, `times side ${sid} is in the index`).toBeTruthy();
      for (const [ruleIdx, median, iqr, n] of rows) {
        expect(Number.isInteger(ruleIdx) && ruleIdx >= 0 && ruleIdx < side!.r.length).toBe(true);
        expect(n).toBeGreaterThan(0);
        expect(median).toBeGreaterThanOrEqual(0);
        expect(iqr).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
