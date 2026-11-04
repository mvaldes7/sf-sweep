import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { buildSides } from "../scripts/build-data.mjs";
// @ts-expect-error plain JS module
import { offsetLine } from "../scripts/offset.mjs";
import rows from "./fixtures/rows.json";

describe("pipeline", () => {
  it("offsets left and right sides about 4 m apart each way", () => {
    const line = [[-122.49, 37.779], [-122.48, 37.779]]; // eastbound
    const left = offsetLine(line, 4), right = offsetLine(line, -4);
    const mPerDegLat = 111320;
    expect((left[0][1] - 37.779) * mPerDegLat).toBeCloseTo(4, 0);
    expect((right[0][1] - 37.779) * mPerDegLat).toBeCloseTo(-4, 0);
  });
  it("groups rows into one feature per cnn and side", () => {
    const { sides, features, skipped } = buildSides(rows);
    expect(skipped).toBe(1);
    expect(sides.length).toBe(2);
    expect(features.length).toBe(2);
    const l = sides.find((s: { side: string }) => s.side === "L");
    expect(l.r).toEqual([[4, 10, 12, 10, 0], [7, 6, 8, 31, 1]]);
    expect(l.limits).toBe("Geary Blvd - Anza St");
  });
});
