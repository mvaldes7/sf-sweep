import { describe, expect, it } from "vitest";
import holidaysJson from "../src/data/holidays.json";
import {
  HolidayTable, type Holiday, type Rule, activeAt, hourLabel, nextSweep, parseWeekday, sfParts,
  statusAt, sweptOnDate, weekOfMonth, weeksLabel,
} from "../src/lib/schedule";
import { decodeRule, encodeRule, searchStreets, type SideRecord } from "../src/lib/data";

const hol = new HolidayTable(holidaysJson.holidays as Holiday[]);
const none = new HolidayTable([]);
const ALL: Rule["weeks"] = [true, true, true, true, true];
const rule = (p: Partial<Rule>): Rule => ({ day: 5, from: 9, to: 11, weeks: ALL, holidays: false, ...p });
// SF local time helper: November 2026 is PST (UTC-8); July is PDT (UTC-7).
const pst = (s: string) => new Date(`${s}-08:00`);
const pdt = (s: string) => new Date(`${s}-07:00`);

describe("week of month", () => {
  it("days 1-7 are week 1", () => {
    for (let d = 1; d <= 7; d++) expect(weekOfMonth(d)).toBe(1);
  });
  it("maps later days", () => {
    expect(weekOfMonth(8)).toBe(2);
    expect(weekOfMonth(14)).toBe(2);
    expect(weekOfMonth(15)).toBe(3);
    expect(weekOfMonth(22)).toBe(4);
    expect(weekOfMonth(28)).toBe(4);
    expect(weekOfMonth(29)).toBe(5);
    expect(weekOfMonth(31)).toBe(5);
  });
  it("2nd and 4th Friday rule applies on Nov 13 2026 but not Nov 6", () => {
    const r = rule({ weeks: [false, true, false, true, false] });
    expect(activeAt([r], pst("2026-11-13T09:30:00"), none)).toBe(true);
    expect(activeAt([r], pst("2026-11-06T09:30:00"), none)).toBe(false);
    expect(activeAt([r], pst("2026-11-27T09:30:00"), none)).toBe(true);
  });
  it("5th week only fires on days 29-31", () => {
    const r = rule({ day: 1, weeks: [false, false, false, false, true] });
    expect(activeAt([r], pst("2026-11-30T09:00:00"), none)).toBe(true); // Mon Nov 30
    expect(activeAt([r], pst("2026-11-23T09:00:00"), none)).toBe(false);
  });
});

describe("status at time t", () => {
  const r = rule({}); // Fri 9-11
  it("is now inside the window, end exclusive", () => {
    expect(statusAt([r], pst("2026-11-13T09:00:00"), none)).toBe("now");
    expect(statusAt([r], pst("2026-11-13T10:59:00"), none)).toBe("now");
    expect(statusAt([r], pst("2026-11-13T11:00:00"), none)).toBe("clear");
  });
  it("is soon within 60 minutes of start, inclusive", () => {
    expect(statusAt([r], pst("2026-11-13T08:00:00"), none)).toBe("soon");
    expect(statusAt([r], pst("2026-11-13T08:30:00"), none)).toBe("soon");
    expect(statusAt([r], pst("2026-11-13T08:59:00"), none)).toBe("soon");
  });
  it("is clear more than 60 minutes before start", () => {
    expect(statusAt([r], pst("2026-11-13T07:59:00"), none)).toBe("clear");
    expect(statusAt([r], pst("2026-11-12T09:30:00"), none)).toBe("clear");
  });
  it("uses SF local time across DST (PDT in July)", () => {
    const tue = rule({ day: 2, from: 13, to: 15 });
    expect(statusAt([tue], pdt("2026-07-07T13:30:00"), none)).toBe("now");
    expect(statusAt([tue], pdt("2026-07-07T12:15:00"), none)).toBe("soon");
  });
  it("handles midnight windows (from 0) and to=0 meaning midnight", () => {
    const night = rule({ day: 2, from: 0, to: 6 });
    expect(statusAt([night], pst("2026-11-02T23:30:00"), none)).toBe("soon"); // Mon 23:30 -> Tue 00:00
    expect(statusAt([night], pst("2026-11-03T05:59:00"), none)).toBe("now");
    const late = rule({ day: 1, from: 22, to: 0 });
    expect(statusAt([late], pst("2026-11-02T23:30:00"), none)).toBe("now");
  });
  it("sfParts reads Los Angeles wall clock", () => {
    const p = sfParts(Date.UTC(2026, 10, 13, 17, 20));
    expect(p).toMatchObject({ y: 2026, m: 11, d: 13, dow: 5, h: 9, min: 20, ymd: "2026-11-13" });
  });
});

describe("holiday skip", () => {
  it("daytime sweeping skipped on Veterans Day 2026 (Wed)", () => {
    const wed = rule({ day: 3, from: 8, to: 10 });
    expect(activeAt([wed], pst("2026-11-11T08:30:00"), hol)).toBe(false);
    expect(statusAt([wed], pst("2026-11-11T07:30:00"), hol)).toBe("clear");
    expect(activeAt([wed], pst("2026-11-11T08:30:00"), none)).toBe(true);
  });
  it("rows with holidays=1 are swept anyway", () => {
    const wed = rule({ day: 3, from: 8, to: 10, holidays: true });
    expect(activeAt([wed], pst("2026-11-11T08:30:00"), hol)).toBe(true);
  });
  it("nightly sweeping is enforced on Veterans Day but not Thanksgiving", () => {
    const wedNight = rule({ day: 3, from: 2, to: 6 });
    expect(activeAt([wedNight], pst("2026-11-11T03:00:00"), hol)).toBe(true);
    const thuNight = rule({ day: 4, from: 2, to: 6 });
    expect(activeAt([thuNight], pst("2026-11-26T03:00:00"), hol)).toBe(false);
  });
  it("Holiday-weekday rows apply only on holidays", () => {
    const h = rule({ day: "H", from: 6, to: 8 });
    expect(activeAt([h], pst("2026-11-11T06:30:00"), hol)).toBe(true);
    expect(activeAt([h], pst("2026-11-12T06:30:00"), hol)).toBe(false);
  });
  it("holiday list has no duplicate dates and only 2026-2027", () => {
    const dates = holidaysJson.holidays.map((h) => h.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates.every((d) => /^202[67]-\d\d-\d\d$/.test(d))).toBe(true);
  });
});

describe("next sweep and plan mode", () => {
  it("finds the next window and its end", () => {
    const r = rule({ weeks: [false, true, false, true, false] });
    const n = nextSweep([r], pst("2026-11-12T11:20:00"), none)!;
    expect(new Date(n.start).toISOString()).toBe("2026-11-13T17:00:00.000Z");
    expect(new Date(n.end).toISOString()).toBe("2026-11-13T19:00:00.000Z");
  });
  it("skips a holiday occurrence", () => {
    const thu = rule({ day: 4, from: 9, to: 11 });
    const n = nextSweep([thu], pst("2026-11-25T12:00:00"), hol)!;
    expect(sfParts(n.start).ymd).toBe("2026-12-03");
  });
  it("returns current window when inside it", () => {
    const n = nextSweep([rule({})], pst("2026-11-13T10:15:00"), none)!;
    expect(n.start).toBe(pst("2026-11-13T10:15:00").getTime());
    expect(new Date(n.end).toISOString()).toBe("2026-11-13T19:00:00.000Z");
  });
  it("sweptOnDate", () => {
    expect(sweptOnDate([rule({})], pst("2026-11-13T00:00:00"), none)).toBe(true);
    expect(sweptOnDate([rule({})], pst("2026-11-14T12:00:00"), none)).toBe(false);
  });
});

describe("labels and encoding", () => {
  it("weeks and hours", () => {
    expect(weeksLabel([false, true, false, true, false])).toBe("2nd & 4th OF MONTH");
    expect(weeksLabel([true, false, true, false, true])).toBe("1st, 3rd & 5th OF MONTH");
    expect(weeksLabel(ALL)).toBe("EVERY WEEK");
    expect(hourLabel(0)).toBe("12 AM");
    expect(hourLabel(12)).toBe("12 PM");
    expect(hourLabel(15)).toBe("3 PM");
  });
  it("parses DataSF weekday strings", () => {
    expect(parseWeekday("Tues")).toBe(2);
    expect(parseWeekday("Holiday")).toBe("H");
    expect(parseWeekday("xyz")).toBeNull();
  });
  it("round-trips compact rules", () => {
    const r = rule({ day: "H", weeks: [true, false, true, false, true], holidays: true });
    expect(decodeRule(encodeRule(r))).toEqual(r);
  });
  it("offline street search", () => {
    const s = (cnn: string, street: string, limits: string): SideRecord =>
      ({ id: 1, cnn, side: "L", street, limits, blockside: "", mid: [0, 0], r: [] });
    const sides = [s("1", "Geary Blvd", "27th Ave - 28th Ave"), s("1", "Geary Blvd", "27th Ave - 28th Ave"), s("2", "28th Ave", "Geary Blvd - Anza St"), s("3", "Anza St", "27th Ave - 28th Ave")];
    expect(searchStreets(sides, "geary").map((x) => x.cnn)).toEqual(["1", "2"]);
    expect(searchStreets(sides, "28th anza").map((x) => x.cnn)).toEqual(["2", "3"]);
    expect(searchStreets(sides, "g")).toEqual([]);
  });
});
