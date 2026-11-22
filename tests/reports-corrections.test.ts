import { describe, expect, it } from "vitest";
import { proposedCorrection, reportedDate, normalizeClock } from "../workers/reports/src/corrections";

describe("proposedCorrection (PR #12 schema)", () => {
  it("builds a posted-sign photo-report entry with a 07:00-07:30 Friday rule", () => {
    const entry = proposedCorrection({
      cnn: "1642000",
      side: "R",
      street: "30th Ave",
      limits: "Geary Blvd - Anza St",
      blockside: "West",
      rules: [{ day: "Fri", weeks: [1, 2, 3, 4, 5], from: "7:00", to: "7:30", holidays: false }],
      reported: "2026-11-21",
      note: "Posted sign",
      reportId: "abc",
    });
    expect("error" in entry).toBe(false);
    if ("error" in entry) return;
    expect(entry.source).toBe("posted sign, photo report");
    expect(entry.reported).toBe("2026-11-21");
    expect(entry.rules).toEqual([{ day: "Fri", weeks: [1, 2, 3, 4, 5], from: "07:00", to: "07:30", holidays: false }]);
    expect(entry.note).toMatch(/Posted sign/);
    expect(entry.note).toMatch(/Report abc/);
  });
  it("rejects a missing rule list, from==to, and a bad date", () => {
    expect(proposedCorrection({ cnn: "1", side: "L", rules: [], reported: "2026-11-21" })).toMatchObject({ error: expect.stringMatching(/rule/) });
    expect(proposedCorrection({
      cnn: "1", side: "L", reported: "2026-11-21",
      rules: [{ day: "Fri", weeks: [1], from: "07:00", to: "07:00" }],
    })).toMatchObject({ error: expect.stringMatching(/differ/) });
    expect(proposedCorrection({
      cnn: "1", side: "L", reported: "11/21/2026",
      rules: [{ day: "Fri", weeks: [1], from: "07:00", to: "07:30" }],
    })).toMatchObject({ error: expect.stringMatching(/reported/) });
  });
  it("formats Pacific dates and clocks", () => {
    expect(normalizeClock("7:30")).toBe("07:30");
    expect(reportedDate(Date.UTC(2026, 10, 22, 6, 0, 0))).toBe("2026-11-21"); // 10:00 PM PT Nov 21
  });
});
