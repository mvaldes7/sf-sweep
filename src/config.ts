/** Build-time configuration (Vite env). No secrets live here: VAPID public key is public by design. */
export const config = {
  /** URL of sweep-index.json (same-origin /data on Pages) */
  indexUrl: import.meta.env.VITE_SWEEP_INDEX_URL || "/data/sweep-index.json",
  /** URL of sweep.pmtiles; when empty the GeoJSON fallback is used */
  pmtilesUrl: import.meta.env.VITE_SWEEP_PMTILES_URL || "",
  geojsonUrl: import.meta.env.VITE_SWEEP_GEOJSON_URL || "/data/sweep-sides.geojson",
  /** Ticket-time line data (scripts/build-ticket-times.ts); optional, loaded on first block detail */
  timesUrl: import.meta.env.VITE_SWEEP_TIMES_URL || "/data/sweep-times.json",
  /**
   * Protomaps basemap (SF extract), built by `pnpm basemap` into public/data/basemap as static z/x/y tiles.
   * A URL ending in .pmtiles uses range requests instead. Set "off" to disable.
   */
  basemapPmtilesUrl: import.meta.env.VITE_BASEMAP_PMTILES_URL === "off" ? "" : (import.meta.env.VITE_BASEMAP_PMTILES_URL || "/data/basemap/{z}/{x}/{y}.mvt"),
  /** Alerts Worker base URL, e.g. https://sf-sweep-alerts.<account>.workers.dev */
  apiBase: import.meta.env.VITE_API_BASE || "",
  vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY || "",
  /** Citywide fallback view (center of SF) used when geolocation is unavailable. */
  cityCenter: [-122.4425, 37.7599] as [number, number],
  cityZoom: 12,
  alertLeadMin: 60,
};
