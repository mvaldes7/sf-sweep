/**
 * Muted Protomaps (v4 schema) basemap layers. Context only: parks, water, buildings, street names and
 * neighborhood labels, kept low-contrast so the sweep street colors stay dominant.
 */
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

export type Scheme = "dark" | "light";
export interface BasemapColors {
  bg: string; earth: string; park: string; water: string; building: string; buildingLine: string;
  road: string; roadMajor: string; label: string; labelHalo: string; place: string;
}
export const BASEMAP_COLORS: Record<Scheme, BasemapColors> = {
  dark: {
    bg: "#0b0b0d", earth: "#111114", park: "#0f1a13", water: "#0c1620", building: "#16161b", buildingLine: "#1f1f26",
    road: "#1a1a20", roadMajor: "#22222a", label: "#7d7f88", labelHalo: "#0b0b0d", place: "#9a9ca6",
  },
  light: {
    bg: "#eef0f3", earth: "#f2f3f5", park: "#dcebdc", water: "#c9dcec", building: "#e4e6ea", buildingLine: "#d5d8dd",
    road: "#ffffff", roadMajor: "#fbfbfc", label: "#6b6f78", labelHalo: "#f2f3f5", place: "#4f535c",
  },
};
export const BASEMAP_FONT = "Noto Sans Regular";
export const BASEMAP_FONT_MEDIUM = "Noto Sans Medium";
export const BASEMAP_ATTRIBUTION = '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * A ".pmtiles" URL is read with HTTP range requests (needs a host that answers 206, e.g. R2).
 * Anything else is a {z}/{x}/{y} tile template; Cloudflare Pages serves the basemap this way because it does
 * not answer range requests with 206. Relative templates are resolved against origin.
 */
export function basemapSource(url: string, origin = ""): SourceSpecification {
  if (/\.pmtiles$/.test(url)) return { type: "vector", url: `pmtiles://${url}`, attribution: BASEMAP_ATTRIBUTION };
  return { type: "vector", tiles: [url.startsWith("/") ? origin + url : url], minzoom: 0, maxzoom: BASEMAP_MAXZOOM,
    bounds: BASEMAP_BOUNDS, attribution: BASEMAP_ATTRIBUTION };
}
export const BASEMAP_MAXZOOM = 15;
export const BASEMAP_BOUNDS: [number, number, number, number] = [-122.65, 37.65, -122.3, 37.86];

const PARK_KINDS = ["park", "garden", "golf_course", "nature_reserve", "playground", "recreation_ground", "cemetery", "grass", "forest", "wood"];

/** Layers drawn below the sweep lines. */
export function basemapLayers(scheme: Scheme, source = "base"): LayerSpecification[] {
  const c = BASEMAP_COLORS[scheme];
  return [
    { id: "base-earth", type: "fill", source, "source-layer": "earth", paint: { "fill-color": c.earth } },
    { id: "base-park", type: "fill", source, "source-layer": "landuse", filter: ["in", ["get", "kind"], ["literal", PARK_KINDS]], paint: { "fill-color": c.park } },
    { id: "base-water", type: "fill", source, "source-layer": "water", paint: { "fill-color": c.water } },
    { id: "base-roads", type: "line", source, "source-layer": "roads",
      filter: ["in", ["get", "kind"], ["literal", ["highway", "major_road", "minor_road", "other"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["match", ["get", "kind"], ["highway", "major_road"], c.roadMajor, c.road],
        "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.4, 15, 2, 18, 12] } },
    { id: "base-buildings", type: "fill", source, "source-layer": "buildings", minzoom: 14,
      paint: { "fill-color": c.building, "fill-outline-color": c.buildingLine, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 1] } },
  ];
}

/** Label layers drawn above the sweep lines (small, muted). */
export function basemapLabelLayers(scheme: Scheme, source = "base"): LayerSpecification[] {
  const c = BASEMAP_COLORS[scheme];
  return [
    { id: "base-street-names", type: "symbol", source, "source-layer": "roads", minzoom: 14,
      filter: ["all", ["has", "name"], ["in", ["get", "kind"], ["literal", ["highway", "major_road", "minor_road"]]]],
      layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-font": [BASEMAP_FONT],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 13], "text-max-angle": 30, "symbol-spacing": 300 },
      paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.5 } },
    { id: "base-neighborhoods", type: "symbol", source, "source-layer": "places", minzoom: 11, maxzoom: 16,
      filter: ["in", ["get", "kind"], ["literal", ["neighbourhood", "macrohood"]]],
      layout: { "text-field": ["get", "name"], "text-font": [BASEMAP_FONT_MEDIUM], "text-transform": "uppercase", "text-letter-spacing": 0.08,
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 15, 12], "text-max-width": 7 },
      paint: { "text-color": c.place, "text-halo-color": c.labelHalo, "text-halo-width": 1.5, "text-opacity": 0.85 } },
  ];
}

export const GLYPHS_URL = "/fonts/{fontstack}/{range}.pbf";
