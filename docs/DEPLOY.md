# Deploy (Cloudflare free tier only)

Everything here fits the Cloudflare free plan. Do not enable Workers Paid, custom domains or any paid add-on.

## What already exists (created 2026-11-02 via the Cloudflare API)

| Resource | Type | ID / URL | State |
| --- | --- | --- | --- |
| `sf-sweep` | D1 database | `6e39009c-f6fa-4e1f-837a-b866fcdd189c` | created, `worker/schema.sql` applied |
| `sf-sweep-alerts` | Worker | script `sf-sweep-alerts` | uploaded with D1 binding, vars and the `VAPID_PRIVATE_KEY` secret |

Not created yet (blocked, needs Mike in the dashboard):

- **workers.dev subdomain**: the account has none, and Cloudflare refuses cron triggers without one.
- **Cron trigger** `* * * * *` on `sf-sweep-alerts` (blocked by the above).
- **R2 bucket** `sf-sweep-data`: R2 is not enabled on the account ("Please enable R2 through the Cloudflare Dashboard").
- **Pages project** `sf-sweep`: the connector was not granted Pages permission.

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
   cp .env.example .env.production.local   # fill VITE_API_BASE with your workers.dev URL
   pnpm build
   npx wrangler pages project create sf-sweep --production-branch main
   npx wrangler pages deploy dist --project-name sf-sweep --branch feat-v1   # preview
   ```
   `dist/data/` carries the GeoJSON fallback, so R2 is optional for v1.
6. R2 (optional, only if it does not ask for a paid plan): enable R2 in the dashboard (free tier: 10 GB-month storage),
   create bucket `sf-sweep-data`, enable its public r2.dev URL, then upload:
   ```
   npx wrangler r2 object put sf-sweep-data/sweep.pmtiles --file public/data/sweep.pmtiles --remote
   npx wrangler r2 object put sf-sweep-data/sweep-index.json --file public/data/sweep-index.json --remote
   ```
   Add a CORS rule on the bucket allowing GET and the `Range` header from `https://sf-sweep.pages.dev`, then set
   `VITE_SWEEP_PMTILES_URL` / `VITE_SWEEP_INDEX_URL` to the r2.dev URLs and rebuild.
7. If the Pages URL differs from `sf-sweep.pages.dev`, update `ALLOWED_ORIGIN` in `worker/wrangler.toml` and redeploy.
8. On iPhone (iOS 16.4+): open the Pages URL in Safari, Share > Add to Home Screen, open from the Home Screen,
   save a spot and tap "Turn on alert". Push does not work in a normal Safari tab; use the .ics reminder there.

## Data refresh

DataSF updates the schedule "as needed". Re-run `pnpm data` and redeploy (or re-upload to R2) when it changes.
Re-check the SFMTA holiday page each year and edit `src/data/holidays.json`.
