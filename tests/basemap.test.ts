import { describe, expect, it } from "vitest";
import { BASEMAP_COLORS, basemapLabelLayers, basemapLayers, basemapSource } from "../src/lib/basemap";

const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255; };

describe("basemap style builder", () => {
  it("covers parks, water, buildings, street names and neighborhoods from Protomaps layers", () => {
    for (const s of ["dark", "light"] as const) {
      const all = [...basemapLayers(s), ...basemapLabelLayers(s)];
      const srcLayers = new Set(all.map((l) => (l as { "source-layer"?: string })["source-layer"]));
      for (const sl of ["water", "landuse", "buildings", "roads", "places"]) expect(srcLayers.has(sl)).toBe(true);
      expect(new Set(all.map((l) => l.id)).size).toBe(all.length);
      expect(all.every((l) => (l as { source?: string }).source === "base")).toBe(true);
    }
  });
  it("dark variant is muted (low luminance) and light variant is light", () => {
    for (const v of Object.values(BASEMAP_COLORS.dark).filter((x) => x !== BASEMAP_COLORS.dark.label && x !== BASEMAP_COLORS.dark.place)) expect(lum(v)).toBeLessThan(0.15);
    expect(lum(BASEMAP_COLORS.light.bg)).toBeGreaterThan(0.85);
  });
  it("source uses the pmtiles protocol with attribution", () => {
    const s = basemapSource("/data/sf-basemap.pmtiles") as { url: string; attribution: string };
    expect(s.url).toBe("pmtiles:///data/sf-basemap.pmtiles");
    expect(s.attribution).toMatch(/OpenStreetMap/);
  });
});
