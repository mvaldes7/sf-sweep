# Data pipeline

Source: DataSF Street Sweeping Schedule, dataset `yhqp-riqs` (https://data.sf.gov/d/yhqp-riqs), SODA endpoint
`https://data.sf.gov/resource/yhqp-riqs.json`. About 37,900 rows; rows are updated "as needed".

```
pnpm data                 # full city -> public/data/
node scripts/build-data.mjs --limit 2000   # quick partial run
```

What it does:

1. Pages through SODA (50,000 rows per request, no API key needed).
2. Groups rows into one feature per (cnn, side). DataSF gives the shared centerline for both sides, so each side is
   offset about 4 m: `L` to the left of the digitized direction, `R` to the right (`scripts/offset.mjs`).
3. Writes `sweep-index.json` (compact rules + labels + label point per side, used for status, sign cards and the
   offline street search) and `sweep-sides.geojson` (offset lines, feature id = `fid`).
4. If `tippecanoe` is installed (or `TIPPECANOE=/path/to/tippecanoe`), writes `sweep.pmtiles` with layer `sides`.

Last full run while building v1 (2026-11-02): 37,878 rows, 22,556 sides, 22 rows skipped (null geometry).

## Building PMTiles

tippecanoe (BSD-2, free) was not installable in the build sandbox, so v1 ships with the GeoJSON fallback
(about 3.8 MB raw, roughly 1 MB gzipped by Pages). To build tiles on a machine with tippecanoe:

```
brew install tippecanoe          # macOS; on Linux build from https://github.com/felt/tippecanoe
pnpm data                        # now also writes public/data/sweep.pmtiles
```

Then host it (Pages /data) and set `VITE_SWEEP_PMTILES_URL` (see DEPLOY.md). The app automatically uses PMTiles when that
variable is set and GeoJSON otherwise.

Optional basemap: download a Protomaps extract for SF (`pmtiles extract https://build.protomaps.com/<date>.pmtiles sf.pmtiles --bbox=-122.52,37.70,-122.35,37.84`),
or run `pnpm basemap`; it is served from Pages at /data/sf-basemap.pmtiles (`VITE_BASEMAP_PMTILES_URL=off` disables it).

## Assumptions and gaps

- Week of month = ceil(day / 7): days 1-7 are week 1, 29-31 are week 5. DataSF does not document this.
- Hours are SF local time (America/Los_Angeles). `tohour` <= `fromhour` is treated as midnight.
- Rows with weekday "Holiday" apply only on dates in `src/data/holidays.json`.
- Side offset direction depends on how each centerline was digitized; spot-check against `blockside`.
- Posted signs win. The app says so on every sign card.

## Holidays

`src/data/holidays.json` is hand-maintained from the SFMTA enforcement calendar
(https://www.sfmta.com/getting-around/drive-park/holiday-enforcement-schedule, HTML only, checked 2026-11-02).
SFMTA published dates through 2027-01-01; later 2027 entries are marked `projected` and must be confirmed.
Rule: daytime sweeping is not enforced on listed holidays; nightly (12am-6am) sweeping is not enforced only on
New Year's Day, Thanksgiving Day and Christmas Day. Rows with `holidays = 1` are swept anyway.
