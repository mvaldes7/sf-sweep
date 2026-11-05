import { describe, expect, it } from "vitest";
import { legendItems, sideLabel } from "../src/lib/labels";
import { BASEMAP_COLORS } from "../src/lib/basemap";

describe("side labels", () => {
  it("maps DataSF blockside to compass wording", () => {
    expect(sideLabel("North", "L")).toBe("North side");
    expect(sideLabel("NorthEast", "R")).toBe("Northeast side");
    expect(sideLabel("SouthWest", "L")).toBe("Southwest side");
  });
  it("falls back to the CNN side when blockside is missing", () => {
    expect(sideLabel("", "L")).toBe("Left side (L)");
    expect(sideLabel(undefined, "R")).toBe("Right side (R)");
  });
});

describe("legend wording", () => {
  it("live mode shows live states", () => expect(legendItems("live").map((i) => i.text)).toEqual(["Clear", "Within 1 hr", "Sweeping now"]));
  it("plan mode uses plan wording and no amber", () => {
    const p = legendItems("plan");
    expect(p.map((i) => i.text)).toEqual(["Swept this day", "No sweeping"]);
    expect(p.some((i) => i.cls === "soon")).toBe(false);
  });
});

describe("dark basemap contrast", () => {
  const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255; };
  it("park and water stand out from land but stay muted", () => {
    const c = BASEMAP_COLORS.dark;
    expect(lum(c.park) - lum(c.earth)).toBeGreaterThan(0.05);
    expect(lum(c.water) - lum(c.earth)).toBeGreaterThan(0.05);
    expect(lum(c.park)).toBeLessThan(0.15);
  });
});

import { alertStatus } from "../src/lib/labels";
describe("alert status (saving never depends on push)", () => {
  const env = { pushSupported: true, apiConfigured: true, blocked: false };
  it("blocked notifications give a note, not an error, and no arm button", () => {
    const a = alertStatus({}, { ...env, blocked: true });
    expect(a.kind).toBe("note"); expect(a.canArm).toBe(false); expect(a.text).toMatch(/Car saved/);
  });
  it("offers opt-in when alerts are off", () => expect(alertStatus({}, env)).toMatchObject({ kind: "off", canArm: true }));
  it("on when armed", () => expect(alertStatus({ alert: true }, env).kind).toBe("on"));
  it("other failures keep the car saved and allow retry", () => {
    const a = alertStatus({ alertError: "server 500" }, env);
    expect(a).toMatchObject({ kind: "error", canArm: true }); expect(a.text).toMatch(/still saved/);
  });
});
