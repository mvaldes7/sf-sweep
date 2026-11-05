import { describe, expect, it } from "vitest";
import { HolidayTable, nextSweep, type Rule } from "../src/lib/schedule";
import { carRisk, durationText, whenText } from "../src/lib/risk";
import { findSafeSides, freeForHorizon, horizonClocks, distanceM } from "../src/lib/safespot";

const none = new HolidayTable([]);
const ALL: Rule["weeks"] = [true, true, true, true, true];
const rule = (p: Partial<Rule>): Rule => ({ day: 5, from: 9, to: 11, weeks: ALL, holidays: false, ...p });
const pst = (s: string) => new Date(`${s}-08:00`).getTime();
const pdt = (s: string) => new Date(`${s}-07:00`).getTime();
const H = 3_600_000;

describe("durationText", () => {
  it("formats minutes, hours and days", () => {
    expect(durationText(45 * 60_000)).toBe("45m");
    expect(durationText(2 * H)).toBe("2h");
    expect(durationText(2 * H + 15 * 60_000)).toBe("2h 15m");
    expect(durationText(76 * H)).toBe("3d 4h");
    expect(durationText(-5)).toBe("0m");
  });
});

describe("carRisk levels", () => {
  const now = pst("2026-11-10T06:00:00");
  it("no schedule", () => expect(carRisk(null, now)).toEqual({ level: "none", text: "No sweeping scheduled" }));
  it("during a sweep is red with end time", () =>
    expect(carRisk({ start: now - H, end: now + H }, now)).toEqual({ level: "red", text: "Sweeping now until 7 AM" }));
  it("within 2h is red", () => expect(carRisk({ start: now + 2 * H, end: now + 4 * H }, now)).toMatchObject({ level: "red", text: "Sweeping in 2h" }));
  it("within 12h is amber", () => expect(carRisk({ start: now + 12 * H, end: now + 14 * H }, now)).toMatchObject({ level: "amber", text: "Sweeping in 12h" }));
  it("beyond 12h is safe with LA day and time", () =>
    expect(carRisk({ start: pst("2026-11-10T20:00:00"), end: pst("2026-11-10T22:00:00") }, now)).toEqual({ level: "safe", text: "Safe until Tue 8 PM" }));
});

describe("DST transitions (America/Los_Angeles)", () => {
  it("spring forward: Sun Mar 8 2026 8 AM PDT is 7 real hours after midnight PST", () => {
    const sun = rule({ day: 0, from: 8, to: 10 });
    const now = pst("2026-03-08T00:00:00");
    const n = nextSweep([sun], now, none)!;
    expect(n.start).toBe(pdt("2026-03-08T08:00:00"));
    expect(carRisk(n, now)).toEqual({ level: "amber", text: "Sweeping in 7h" });
  });
  it("fall back: Sun Nov 1 2026 8 AM PST is 9 real hours after midnight PDT", () => {
    const sun = rule({ day: 0, from: 8, to: 10 });
    const now = pdt("2026-11-01T00:00:00");
    const n = nextSweep([sun], now, none)!;
    expect(n.start).toBe(pst("2026-11-01T08:00:00"));
    expect(carRisk(n, now)).toEqual({ level: "amber", text: "Sweeping in 9h" });
  });
  it("labels stay in local wall time across the change", () => {
    expect(whenText(pst("2026-11-02T08:00:00"), pdt("2026-10-31T12:00:00"))).toBe("Mon 8 AM");
    expect(whenText(pdt("2026-03-09T08:00:00"), pst("2026-03-07T12:00:00"))).toBe("Mon 8 AM");
  });
  it("horizon clocks cover the repeated 1 AM hour on fall-back night", () => {
    const sun1am = rule({ day: 0, from: 1, to: 2 });
    const now = pdt("2026-10-31T12:00:00");
    expect(horizonClocks(now, 24)).toHaveLength(24);
    expect(freeForHorizon([sun1am], horizonClocks(now, 24), none)).toBe(false);
  });
});

describe("week rollover", () => {
  it("Saturday night to Monday morning", () => {
    const mon = rule({ day: 1, from: 2, to: 4 });
    const now = pst("2026-11-14T23:00:00");
    expect(carRisk(nextSweep([mon], now, none), now)).toEqual({ level: "safe", text: "Safe until Mon 2 AM" });
  });
  it("2nd/4th Friday rule after the 4th Friday rolls into next month with a dated label", () => {
    const fri24 = rule({ day: 5, from: 9, to: 11, weeks: [false, true, false, true, false] });
    const now = pst("2026-11-27T12:00:00");
    const n = nextSweep([fri24], now, none)!;
    expect(n.start).toBe(pst("2026-12-11T09:00:00"));
    expect(carRisk(n, now).text).toBe("Safe until Fri, Dec 11 9 AM");
  });
});

describe("safe spot search", () => {
  const center: [number, number] = [-122.42, 37.77];
  const now = pdt("2026-10-31T12:00:00");
  const mon9 = rule({ day: 1, from: 9, to: 11 });
  const sides = [
    { id: 1, mid: [-122.4205, 37.7705] as [number, number] }, // ~70 m, Monday sweep
    { id: 2, mid: [-122.421, 37.771] as [number, number] }, // nearby, no rules
    { id: 3, mid: [-122.44, 37.79] as [number, number] }, // ~2.8 km away
  ];
  const rules = new Map<number, Rule[]>([[1, [mon9]], [2, []], [3, []]]);
  it("24h: both nearby sides are free; far side is excluded", () =>
    expect(findSafeSides(sides, rules, center, now, 24, none)).toEqual({ safe: [1, 2], nearby: 2 }));
  it("48h: Monday 9 AM PST (46 real hours away) is caught", () =>
    expect(findSafeSides(sides, rules, center, now, 48, none)).toEqual({ safe: [2], nearby: 2 }));
  it("distance is about right", () => expect(Math.round(distanceM([-122.42, 37.77], [-122.42, 37.78]))).toBe(1112));
});
