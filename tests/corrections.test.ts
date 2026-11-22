import { describe, expect, it } from "vitest";
import { writeTempFiles } from "../scripts/check-asset-size.mjs";
import {
  applyCorrections, invalidCorrections, loadCorrections, parseClock, weeksToBits,
} from "../scripts/corrections.mjs";
import { invalidCorrectedIndex, invalidCorrectionsFile } from "../scripts/check-dist-data.mjs";
import { buildIcs } from "../src/lib/ics";
import type { SideRecord } from "../src/lib/data";

const pst = (s: string) => new Date(`${s}-08:00`).getTime();

const base = {
  cnn: "1642000",
  side: "R" as const,
  street: "30th Ave",
  limits: "Geary Blvd - Anza St",
  blockside: "West",
  rules: [{ day: "Fri", weeks: [1, 2, 3, 4, 5], from: "07:00", to: "07:30", holidays: false }],
  source: "posted sign, reported by Mike",
  reported: "2026-11-21",
};

describe("corrections clock and weeks", () => {
  it("parses HH:MM including half hours and 24:00", () => {
    expect(parseClock("07:00")).toBe(7);
    expect(parseClock("7:30")).toBe(7.5);
    expect(parseClock("07:30")).toBe(7.5);
    expect(parseClock("24:00")).toBe(24);
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("7:60")).toBeNull();
  });
  it("encodes weeks 1-5 as bits", () => {
    expect(weeksToBits([1, 3, 5])).toBe(21);
    expect(weeksToBits([1, 2, 3, 4, 5])).toBe(31);
    expect(weeksToBits([0])).toBeNull();
  });
});

describe("committed corrections file", () => {
  it("is valid and the first entry is 30th Ave west, Friday 07:00-07:30", () => {
    expect(invalidCorrectionsFile()).toEqual([]);
    const data = loadCorrections();
    expect(invalidCorrections(data)).toEqual([]);
    expect(data.corrections).toHaveLength(1);
    const c = data.corrections[0];
    expect(c).toMatchObject({
      cnn: "1642000",
      side: "R",
      street: "30th Ave",
      limits: "Geary Blvd - Anza St",
      blockside: "West",
      source: "posted sign, reported by Mike",
      reported: "2026-11-21",
    });
    expect(c.rules).toEqual([{ day: "Fri", weeks: [1, 2, 3, 4, 5], from: "07:00", to: "07:30", holidays: false }]);
    // East side of the same block is a different DataSF day/pattern; it is not corrected.
    expect(data.corrections.some((x: { cnn: string; side: string }) => x.cnn === "1642000" && x.side === "L")).toBe(false);
  });
});

describe("applyCorrections", () => {
  const west: SideRecord = {
    id: 19466, cnn: "1642000", side: "R", street: "30th Ave", limits: "Geary Blvd - Anza St",
    blockside: "West", mid: [0, 0], r: [[5, 7, 8, 21, 0], [5, 7, 8, 26, 0]],
  };
  const east: SideRecord = {
    id: 20807, cnn: "1642000", side: "L", street: "30th Ave", limits: "Geary Blvd - Anza St",
    blockside: "East", mid: [0, 0], r: [[4, 10, 12, 10, 0]],
  };

  it("replaces west-side rules with Friday 7:00-7:30 and leaves the east side alone", () => {
    const sides = [structuredClone(west), structuredClone(east)];
    applyCorrections(sides, { version: 1, corrections: [base] });
    expect(sides[0].r).toEqual([[5, 7, 7.5, 31, 0]]);
    expect(sides[0].corrected).toEqual({
      source: base.source,
      reported: base.reported,
    });
    // note is included only when present
    const withNote = { ...base, note: "posted 7:30" };
    const again = [structuredClone(west)];
    applyCorrections(again, { version: 1, corrections: [withNote] });
    expect(again[0].corrected).toMatchObject({ note: "posted 7:30" });
    expect(sides[1].r).toEqual([[4, 10, 12, 10, 0]]);
    expect(sides[1].corrected).toBeUndefined();
  });

  it("throws when cnn+side is missing or labels conflict", () => {
    expect(() => applyCorrections([structuredClone(east)], { version: 1, corrections: [base] }))
      .toThrow(/matched no side/);
    expect(() => applyCorrections([structuredClone(west)], { version: 1, corrections: [{ ...base, street: "29th Ave" }] }))
      .toThrow(/street does not match/);
  });

  it("rejects a bad document", () => {
    expect(invalidCorrections({ version: 2, corrections: [] })).toContain("corrections: version must be 1");
    expect(invalidCorrections({ version: 1, corrections: [{ ...base, rules: [{ ...base.rules[0], to: "07:70" }] }] }).join("\n"))
      .toMatch(/invalid rule day, time or weeks/);
    expect(invalidCorrections({ version: 1, corrections: [base, base] }).join("\n")).toMatch(/duplicate cnn\+side/);
  });
});

describe("ICS half-hour end", () => {
  it("writes DTSTART 7:00 and DTEND 7:30 in UTC", () => {
    const ics = buildIcs({
      start: pst("2026-11-13T07:00:00"),
      end: pst("2026-11-13T07:30:00"),
      title: "Move car: street cleaning on 30th Ave",
      location: "30th Ave (Geary Blvd - Anza St), West, San Francisco",
      alarmMin: 60,
    });
    expect(ics).toMatch(/DTSTART:20261113T150000Z/);
    expect(ics).toMatch(/DTEND:20261113T153000Z/);
  });
});

describe("invalidCorrectionsFile", () => {
  it("reports a missing or malformed file", () => {
    const dir = writeTempFiles({});
    expect(invalidCorrectionsFile(`${dir}/missing.json`).join("\n")).toMatch(/missing or empty/);
    const html = writeTempFiles({ "bad.json": "<html>404</html>" });
    expect(invalidCorrectionsFile(`${html}/bad.json`).join("\n")).toMatch(/not valid JSON/);
    const shape = writeTempFiles({ "bad.json": JSON.stringify({ version: 1 }) });
    expect(invalidCorrectionsFile(`${shape}/bad.json`).join("\n")).toMatch(/missing corrections array/);
  });
});

describe("compactRule rejects a zero-length window", () => {
  it("from == to is invalid", () => {
    const eq = { version: 1, corrections: [{ ...base, rules: [{ ...base.rules[0], from: "07:00", to: "07:00" }] }] };
    expect(invalidCorrections(eq).join("\n")).toMatch(/from and to must differ/);
  });
});

describe("invalidCorrectedIndex", () => {
  it("requires a corrected flag on matching sides and reports a missing side", () => {
    const west = {
      id: 19466, cnn: "1642000", side: "R", street: "30th Ave", limits: "Geary Blvd - Anza St",
      blockside: "West", mid: [0, 0], r: [[5, 7, 7.5, 31, 0]],
    };
    expect(invalidCorrectedIndex({ sides: [west] }).join("\n")).toMatch(/missing the corrected flag/);
    expect(invalidCorrectedIndex({
      sides: [{ ...west, corrected: { source: "posted sign, reported by Mike", reported: "2026-11-21" } }],
    })).toEqual([]);
    expect(invalidCorrectedIndex({ sides: [] }).join("\n")).toMatch(/side missing/);
  });
});
