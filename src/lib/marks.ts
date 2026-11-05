import type { Feature, FeatureCollection } from "geojson";

const ST = ["clear", "soon", "now"] as const;

/** Status icon points for every side, from the per-side numeric state (0 clear, 1 soon, 2 now). */
export function buildMarks(sides: { id: number; mid: [number, number] }[], state: Map<number, number>): FeatureCollection {
  const features: Feature[] = new Array(sides.length);
  for (let i = 0; i < sides.length; i++) {
    const s = sides[i];
    const n = state.get(s.id) ?? 0;
    features[i] = { type: "Feature", properties: { st: ST[n] ?? "clear", rank: n }, geometry: { type: "Point", coordinates: s.mid } };
  }
  return { type: "FeatureCollection", features };
}
