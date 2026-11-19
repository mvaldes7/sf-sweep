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

## Address search (Pages-only)

- **San Francisco Addresses - Enterprise Addressing System**, DataSF **`3mea-di5p`**:
  https://data.sf.gov/d/3mea-di5p
- Metadata/license: https://data.sf.gov/api/views/3mea-di5p.json (`licenseId: PDDL`),
  **Open Data Commons Public Domain Dedication and License 1.0**:
  https://opendatacommons.org/licenses/pddl/1-0/
- API: https://data.sf.gov/resource/3mea-di5p.json . City and County of San Francisco,
  Department of Technology; active **base** addresses, nightly source updates, not apartment units.

`pnpm addresses:refresh` downloads selected fields with stable EAS BaseID pagination, checks
PDDL and minimum coverage, drops invalid/zero-number records, deduplicates identical points,
then writes the versioned `scripts/data/addresses.json.gz`. Review and commit that snapshot.
Normal `pnpm dev` / `pnpm build` **never contact DataSF**: `scripts/build-addresses.mjs`
expands it to ignored `public/addresses.json`, copied to `dist/addresses.json` by Vite.
The build reports raw/gzip/Brotli sizes and refuses files >=25 MiB. No R2 upload, Worker
change, D1 change, account, API key, geocoder, or paid resource is needed.

Version 1 groups tuples by street: `[houseWithSuffix, longitudeOffset, latitudeOffset, CNN]`.
Coordinates are integers at 1e-5 degrees (~1 m): lon = offset/100000 - 122,
lat = offset/100000 + 37. Street names appear once; the committed gzip snapshot is ~1.4 MB.
224,327 usable/deduplicated points from 224,349 source rows in the initial snapshot;
6,643,431 bytes raw, 1,459,566 gzip, 812,407 Brotli. Pages handles HTTP compression.
Initial JS grows by 3.97 kB raw / 1.52 kB gzip over main (MapLibre remains the dominant bundle).
Only an address-shaped query lazy-loads this asset; street-only searches don't load it.
User queries remain client-side. Network failure can be retried; street search still works.
The service worker's existing same-origin network-first policy provides offline fallback
once an address search has loaded the index; it is not an extra startup/precache download.

House letter suffixes are tried exactly first; if absent, an explicitly labelled base-address
fallback is offered. Apartment/unit text is ignored, not unit-geocoded. Numeric ordinals,
word ordinals through fiftieth, type abbreviations, punctuation and case are normalized.
Unknown house numbers are never interpolated or silently changed to nearby addresses.

EAS supplies the block's CNN. Selection requires the **same CNN and normalized street**;
within that block, distance to the existing left/right **offset** midpoints estimates the
building side (the midpoint difference projects across the street). No arbitrary nearest
block fallback. Setbacks/corner buildings, unusual geometry, and one-sided coverage can
make this estimate imperfect: the UI says it is estimated, shows both available sides,
and says to check the posted sign. If no matching sweep segment exists, the map still
flies to the address and explicitly reports missing coverage, without a stale detail card.

Browser regression: `pnpm exec playwright install chromium && pnpm test:e2e` uses local
sweeping data (prepare as above) and the versioned EAS index. CI reads current public
sweeping data and basemap tiles from the production Pages static assets, with no credentials
and no writes. Chromium tests run at 1440x1000 and 390x844, exercise keyboard selection,
534 30th Ave (East), 1000 Valencia St (West), suffix/unit fallback, empty results, and
street-only lazy loading. Screenshots are uploaded as the Actions artifact
`address-search-chromium-screenshots`. These tests never park a car or enable alerts.
