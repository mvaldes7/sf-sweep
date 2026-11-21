# Deploy (Cloudflare free tier only)

Everything here fits the Cloudflare free plan. Do not enable Workers Paid, custom domains or any paid add-on.

## What already exists (created 2026-11-02 via the Cloudflare API)

| Resource | Type | ID / URL | State |
| --- | --- | --- | --- |
| `sf-sweep` | D1 database | `6e39009c-f6fa-4e1f-837a-b866fcdd189c` | created, `worker/schema.sql` applied |
| `sf-sweep` | Pages project | https://sf-sweep.pages.dev (preview: https://feat-v1.sf-sweep.pages.dev) | created 2026-11-02, production branch main; production deployed 667d6c4e from 9a3d9ab on Nov 18, 2026 (rollback: 8c1d0705) |
| `sf-sweep-alerts` | Worker | https://sf-sweep-alerts.miggyman7.workers.dev | uploaded with D1 binding, vars and the `VAPID_PRIVATE_KEY` secret; cron `* * * * *` set; `/api/health` ok |


## Steps for Mike

1. Open https://dash.cloudflare.com > Workers & Pages once. This creates the free `<name>.workers.dev` subdomain.
2. Install deps and log in locally (free): `pnpm install && npx wrangler login`.
3. Add the cron trigger and redeploy the Worker from this repo:
   ```
   cd worker && npx wrangler deploy
   ```
   `worker/wrangler.toml` already holds the real D1 id, the cron, and public vars. The private VAPID key is already a
   Worker secret; wrangler deploy keeps existing secrets. To rotate keys: `node scripts/gen-vapid.mjs`, then
   `npx wrangler secret put VAPID_PRIVATE_KEY < .vapid-private.key && rm .vapid-private.key`, and update
   `VAPID_PUBLIC_KEY` in `worker/wrangler.toml` and `VITE_VAPID_PUBLIC_KEY`.
   Check: `curl https://sf-sweep-alerts.<subdomain>.workers.dev/api/health` returns `{"ok":true}`.
4. Optional: set `VAPID_SUBJECT` in `worker/wrangler.toml` to a mailto you read (currently the GitHub noreply address).
5. Build data and the PWA, then create the Pages project by direct upload (free):
   ```
   pnpm data
   pnpm tickets
   pnpm basemap
   cp .env.example .env.production.local   # fill VITE_API_BASE with your workers.dev URL
   pnpm build
   npx wrangler pages project create sf-sweep --production-branch main
   npx wrangler pages deploy dist --project-name sf-sweep --branch feat-v1   # preview
   ```
   `dist/data/` carries the sweep data, ticket times, and basemap.
   `pnpm tickets` writes gitignored `public/data/sweep-times.json`. For a faster recovery when you
   do not need to rerun the citations pipeline, fetch the file from a specific older Pages
   deployment with `curl --fail` (never from the production hostname):
   ```
   curl --fail -o public/data/sweep-times.json \
     https://800eb8a5.sf-sweep.pages.dev/data/sweep-times.json
   ```
   Do not use https://sf-sweep.pages.dev for this file. A production 404 page saved under that
   name would fail the build guard.
7. If the Pages URL differs from `sf-sweep.pages.dev`, update `ALLOWED_ORIGIN` in `worker/wrangler.toml` and redeploy.
8. On iPhone (iOS 16.4+): open the Pages URL in Safari, Share > Add to Home Screen, open from the Home Screen,
   save a spot and tap "Turn on alert". Push does not work in a normal Safari tab; use the .ics reminder there.

## Data refresh

DataSF updates the schedule "as needed". Re-run `pnpm data` and redeploy when it changes.
Re-run `pnpm tickets` when you want updated typical citation times. If the existing file is
enough, fetch it from a specific older Pages deployment with `curl --fail` (never from the
production hostname https://sf-sweep.pages.dev):
```
curl --fail -o public/data/sweep-times.json \
  https://800eb8a5.sf-sweep.pages.dev/data/sweep-times.json
```
Re-check the SFMTA holiday page each year and edit `src/data/holidays.json`.

## Basemap (Protomaps, SF extract)

`pnpm basemap` (needs the `pmtiles` CLI) extracts an SF PMTiles (about 17.5 MB, z0-15,
bbox -122.65,37.65,-122.30,37.86) from a public Protomaps daily build and unpacks it into static tiles at
`/data/basemap/{z}/{x}/{y}.mvt` (1113 files, about 33 MB uncompressed). Pages does not answer range requests with 206 (tested 2026-11-04), so a single .pmtiles file does not work there. Glyphs are self-hosted in
`public/fonts`. Set `VITE_BASEMAP_PMTILES_URL=off` to disable.
R2 is not used (decision 2026-11-04): all static data, including the basemap, is served by Pages.

## Build guard

`pnpm build` fails with "Missing generated data" unless `dist/data/` has `sweep-index.json`, `sweep-sides.geojson`,
`sweep-times.json`, and the basemap tiles (`data/basemap/meta.json`, `0/0/0.mvt`, and z15 tiles). The three JSON
files are also parsed: an HTML 404 (or other non-JSON body) saved under those names fails the build, as does JSON
that is missing required top-level keys (`generated`/`source`/`sides` on the index; a GeoJSON `FeatureCollection`
with a `features` array; `range` and `sides` on ticket times). Run `pnpm data`, `pnpm tickets`, and `pnpm basemap`
first. `ALLOW_MISSING_DATA=1` still skips the whole check, including ticket times; CI sets it because it has no
generated data. Never set it for a deploy.
If `sweep-times.json` is the only missing file and you do not need to rebuild citation stats, fetch it from a
specific older Pages deployment with `curl --fail`. Never fetch it from the production hostname
(https://sf-sweep.pages.dev):
```
curl --fail -o public/data/sweep-times.json \
  https://800eb8a5.sf-sweep.pages.dev/data/sweep-times.json
```
Deploy a preview with `pnpm deploy:preview` (builds, so the guard runs first). Basemap tiles are stored
uncompressed (MVT protobuf, not gzip) and served with `Content-Type: application/vnd.mapbox-vector-tile`;
Pages compresses them on the wire. `public/404.html` makes missing paths return 404 (the app has no client routes).
