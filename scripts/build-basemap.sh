#!/usr/bin/env bash
# Extract a San Francisco Protomaps basemap (PMTiles) from a public Protomaps daily build.
# Requires the pmtiles CLI (https://github.com/protomaps/go-pmtiles). Output: public/data/sf-basemap.pmtiles
# The bbox matches the map's maxBounds in src/main.ts. Keep the file under the 25 MiB Pages limit.
set -euo pipefail
DATE="${1:-$(date -u -d yesterday +%Y%m%d)}"
OUT="public/data/sf-basemap.pmtiles"
mkdir -p public/data
pmtiles extract "https://build.protomaps.com/${DATE}.pmtiles" "$OUT" --bbox=-122.65,37.65,-122.30,37.86 --maxzoom=15
node scripts/check-asset-size.mjs public/data
ls -l "$OUT"
