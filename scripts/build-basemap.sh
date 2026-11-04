#!/usr/bin/env bash
# Extract a San Francisco Protomaps basemap from a public Protomaps daily build and unpack it into static
# z/x/y.mvt tiles under public/data/basemap (Cloudflare Pages does not serve HTTP range requests with 206,
# so a single .pmtiles file cannot be read there). Requires the pmtiles CLI (github.com/protomaps/go-pmtiles).
# The bbox matches the map's maxBounds in src/main.ts.
set -euo pipefail
DATE="${1:-$(date -u -d yesterday +%Y%m%d)}"
mkdir -p tmp public/data
pmtiles extract "https://build.protomaps.com/${DATE}.pmtiles" tmp/sf-basemap.pmtiles --bbox=-122.65,37.65,-122.30,37.86 --maxzoom=15
node scripts/unpack-basemap.mjs tmp/sf-basemap.pmtiles public/data/basemap
node scripts/check-asset-size.mjs public/data
