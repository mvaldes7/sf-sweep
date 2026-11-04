import { describe, expect, it } from "vitest";
import holidaysJson from "../src/data/holidays.json";
import { PAGES_MAX_FILE_BYTES, makeTempFiles, oversized, readJsonIfExists } from "../scripts/check-asset-size.mjs";
import { crossesMidnight } from "../src/lib/schedule";
import { type CompactRule, decodeRule } from "../src/lib/data";

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
