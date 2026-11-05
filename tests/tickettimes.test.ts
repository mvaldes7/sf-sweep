import { describe, expect, it } from "vitest";
import { HolidayTable, type Rule } from "../src/lib/schedule";
import { LineIndex, clockFor, sortByWeekday, matchWindows, parseLocal, pointLineM, quantile, windowStat } from "../src/lib/tickettimes";

const hol = new HolidayTable([{ date: "2026-11-26", name: "Thanksgiving Day", nightlyNotEnforced: true }]);
const all = [true, true, true, true, true];
const rule = (day: Rule["day"], from: number, to: number, holidays = false): Rule => ({ day, from, to, weeks: all, holidays }) as Rule;

describe("parseLocal", () => {
  it("reads SF wall time without zone shifts, including DST days", () => {
    const p = parseLocal("2026-03-08T02:30:00.000")!; // spring-forward night: kept as written
    expect([p.ymd, p.dow, p.h, p.min]).toEqual(["2026-03-08", 0, 2, 30]);
    const q = parseLocal("2026-11-01T01:30:00.000")!; // repeated hour
    expect([q.dow, q.h, q.min]).toEqual([0, 1, 30]);
    expect(parseLocal("bad")).toBeNull();
  });
});

describe("matchWindows", () => {
  it("returns minutes after window start only inside the posted window", () => {
    const r = [rule(2, 8, 10), rule(4, 8, 10)];
    expect(matchWindows(r, parseLocal("2026-11-03T09:12:00")!, hol)).toEqual([{ rule: 0, mins: 72 }]);
    expect(matchWindows(r, parseLocal("2026-11-03T10:00:00")!, hol)).toEqual([]); // end exclusive
    expect(matchWindows(r, parseLocal("2026-11-03T07:59:00")!, hol)).toEqual([]);
  });
  it("handles windows crossing midnight (tail belongs to previous date)", () => {
    const r = [rule(1, 22, 2)]; // Mon 10 PM - Tue 2 AM
    expect(matchWindows(r, parseLocal("2026-11-02T23:05:00")!, hol)).toEqual([{ rule: 0, mins: 65 }]);
    expect(matchWindows(r, parseLocal("2026-11-03T01:30:00")!, hol)).toEqual([{ rule: 0, mins: 210 }]);
    expect(matchWindows(r, parseLocal("2026-11-04T01:30:00")!, hol)).toEqual([]); // Wed tail: no Tue rule
  });
  it("respects holidays and week-of-month", () => {
    expect(matchWindows([rule(4, 8, 10)], parseLocal("2026-11-26T09:00:00")!, hol)).toEqual([]);
    expect(matchWindows([rule(4, 8, 10, true)], parseLocal("2026-11-26T09:00:00")!, hol)).toHaveLength(1);
    const wk1 = { ...rule(2, 8, 10), weeks: [true, false, false, false, false] } as Rule;
    expect(matchWindows([wk1], parseLocal("2026-11-03T09:00:00")!, hol)).toHaveLength(1);
    expect(matchWindows([wk1], parseLocal("2026-11-10T09:00:00")!, hol)).toHaveLength(0);
  });
});

describe("stats", () => {
  it("quantile interpolates", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(quantile([7], 0.75)).toBe(7);
  });
  const days = (n: number, ds = n) => Array.from({ length: n }, (_, i) => `2026-01-${String((i % ds) + 1).padStart(2, "0")}`);
  it("needs 5 tickets on 3 dates", () => {
    expect(windowStat([1, 2, 3, 4].map((m, i) => ({ mins: m, ymd: days(4)[i] })))).toBeNull();
    expect(windowStat([1, 2, 3, 4, 5].map((m, i) => ({ mins: m, ymd: days(5, 2)[i] })))).toBeNull();
    expect(windowStat([10, 20, 30, 40, 50].map((m, i) => ({ mins: m, ymd: days(5, 3)[i] })))).toEqual({ median: 30, iqr: 20, n: 5, days: 3 });
  });
  it("drops the first and last 5% before median/IQR", () => {
    const mins = [...Array(18).fill(70), 0, 119]; // 20 samples: trims one each end
    const st = windowStat(mins.map((m, i) => ({ mins: m, ymd: days(20)[i] })))!;
    expect(st).toEqual({ median: 70, iqr: 0, n: 20, days: 20 });
  });
  it("hides spread-out windows (IQR > 45)", () => {
    const s = [0, 10, 20, 100, 110, 120].map((m, i) => ({ mins: m, ymd: days(6)[i] }));
    expect(windowStat(s)).toBeNull();
    const ok = [0, 15, 30, 45, 60].map((m, i) => ({ mins: m, ymd: days(5)[i] })); // IQR 30
    expect(windowStat(ok)?.iqr).toBe(30);
  });
  it("clockFor formats Pacific wall clock", () => {
    expect(clockFor(8, 72)).toBe("9:12 AM");
    expect(clockFor(22, 150)).toBe("12:30 AM");
    expect(clockFor(12, 5)).toBe("12:05 PM");
  });
});

describe("snapping", () => {
  const line: [number, number][] = [[-122.49, 37.78], [-122.48, 37.78]]; // ~880 m east-west
  it("point-to-line distance in meters", () => {
    expect(pointLineM([-122.485, 37.78], line)).toBeCloseTo(0, 3);
    expect(pointLineM([-122.485, 37.7803], line)).toBeCloseTo(33.4, 0);
    expect(pointLineM([-122.495, 37.78], line)).toBeGreaterThan(400); // past the end
  });
  it("finds the nearest line within 40 m, even mid-segment", () => {
    const ix = new LineIndex();
    ix.add("a", line);
    ix.add("b", [[-122.49, 37.7806], [-122.48, 37.7806]]);
    expect(ix.nearest([-122.4851, 37.78025])?.key).toBe("a");
    expect(ix.nearest([-122.4851, 37.7805])?.key).toBe("b");
    expect(ix.nearest([-122.4851, 37.7812])).toBeNull(); // > 40 m from both
  });
});

describe("sortByWeekday", () => {
  it("orders Mon -> Sun, holiday-only last, then by hour", () => {
    const rs = [rule(0, 6, 8), rule(4, 6, 8), rule("H", 6, 8), rule(1, 9, 11), rule(1, 6, 8), rule(6, 6, 8)];
    expect(sortByWeekday(rs, (r) => r).map((r) => `${r.day}@${r.from}`)).toEqual(["1@6", "1@9", "4@6", "6@6", "0@6", "H@6"]);
  });
});
