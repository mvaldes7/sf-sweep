# SF Sweep contributor instructions

This file is the source of truth for anyone working in this repo, human or AI: builders, reviewers and any tool
that reads or changes the code.

Related docs: `ROADMAP.md` (what shipped and what is planned), `README.md` (product overview and local commands),
`docs/DEPLOY.md` (Cloudflare resources, deploy and recovery), `docs/DATA.md` (data pipeline and assumptions).

Precedence: if this file, another doc, or the code disagree, the code wins. Fix the doc in the same PR as you
notice it, and say so in the PR description. Mark anything you add but cannot verify as **(unclear)**.

## 1. What it is

SF Sweep is a mobile-first PWA that shows San Francisco street-cleaning status for each side of every block.
Production: https://sf-sweep.pages.dev.

- Live mode with a 6 hour timelapse, and Plan mode with day chips (Today, All, Mon-Sun).
- Each side of a block is its own thick line: green solid = no cleaning, amber dashed + clock = cleaning within
  1 hour, red solid + circled x = sweeping now. Every color also has a shape and a text label.
- Tap a block for an SF-style street sign card per side, including typical "Tickets usually ~..." citation times
  when that data is present.
- Park here saves the spot only on this device. Optional Web Push 1 hour before sweeping (Cloudflare Worker + D1),
  plus an .ics fallback.
- Street cleaning only; tow-away and other restrictions are out of scope. Posted signs are authoritative.

## 2. Stack and layout

| Area | What | Where |
|---|---|---|
| App | Vite 6, TypeScript, MapLibre GL, PMTiles (GeoJSON fallback). No Mapbox, no tokens | `src/main.ts`, `index.html`, `src/lib/basemap.ts` |
| Runtime | Node 22+ (CI uses 24), pnpm 10.33.4 (`packageManager` in `package.json`). `pnpm tickets` needs Node >= 22.18 | `package.json` |
| Sweep data | DataSF Street Sweeping Schedule (`yhqp-riqs`). Output is gitignored under `public/data/` | `scripts/build-data.mjs`, `docs/DATA.md` |
| Ticket times | DataSF SFMTA parking citations (`ab4h-6ztd`, STR CLEAN only). `pnpm tickets` writes `public/data/sweep-times.json` | `scripts/build-ticket-times.ts`, `src/lib/tickettimes.ts` |
| Addresses | Committed DataSF EAS snapshot; `pnpm dev` / `pnpm build` expand it. Queries stay on-device | `scripts/data/addresses.json.gz`, `scripts/build-addresses.mjs`, `src/lib/addresses.ts` |
| Basemap | Protomaps SF extract unpacked to static `/data/basemap/{z}/{x}/{y}.mvt` tiles; glyphs in `public/fonts` | `scripts/build-basemap.sh` |
| Schedule and risk | Week of month, holiday skip, ticket risk, nearby safe spots | `src/lib/schedule.ts`, `src/lib/risk.ts`, `src/lib/safespot.ts`, `src/data/holidays.json` |
| Push worker | Cloudflare Worker + D1, cron `* * * * *` | `worker/` (`worker/wrangler.toml`, `worker/schema.sql`) |
| Photo reports | Sign-photo reports and a review queue (issue #10). UI is behind `VITE_PHOTO_REPORTS`, off by default | `workers/reports/`, `docs/PHOTO-REPORTS.md`, `src/lib/report-ui.ts` |
| Tests | Vitest unit tests; Playwright e2e (house-number search) | `tests/`, `e2e/address-search.spec.ts` |
| CI | GitHub Actions jobs `check` and `browser` | `.github/workflows/ci.yml` |
| Hosting | Cloudflare Pages (direct upload; no Git integration), Workers Free, D1. R2 is used only for sign-photo reports (not the basemap) | `wrangler.toml`, `docs/DEPLOY.md`, `docs/PHOTO-REPORTS.md` |

## 3. Local setup and commands

Requires Node 22+ and pnpm 10. `pnpm tickets` must run on Node >= 22.18, because `package.json` invokes
`node scripts/build-ticket-times.ts` with no experimental flag (Node's built-in type stripping). The
`engines.node` field is still `>=22` for the rest of the app.

1. `pnpm install`.
2. `pnpm data` then `pnpm tickets`. These write gitignored files under `public/data/` (streets, sides and ticket
   times). Without them the map has no sweep data. `pnpm dev` and `pnpm build` do not fetch DataSF themselves;
   they only expand the committed address snapshot to ignored `public/addresses.json`.
3. Optional: `pnpm basemap` if you want the self-hosted basemap locally (needs the `pmtiles` CLI). Set
   `VITE_BASEMAP_PMTILES_URL=off` to disable it; the app already supports that.
4. Copy `.env.example` to `.env.local` if you need to point the PWA at the alerts Worker. The names it lists are
   public config, not secrets. Never commit `.env.local` or paste secret values into PRs, issues or chat.
5. `pnpm dev`.

| Command | What it does |
|---|---|
| `pnpm lint` | ESLint, then `scripts/check-no-emoji.mjs` on tracked text files |
| `pnpm typecheck` | `tsc --noEmit` for the app and for `worker/` |
| `pnpm test` | Unit tests (`tests/*.test.ts`, Vitest). No network required |
| `pnpm test:e2e` | Playwright (`e2e/`, Chromium; desktop and iphone-width). Needs sweep data in `public/data/` (see section 4) |
| `pnpm build` | Expands addresses, typechecks, Vite build, asset-size check, then `scripts/check-dist-data.mjs` on `dist` |
| `pnpm data` | Fetch DataSF and build `public/data/sweep-index.json` and `sweep-sides.geojson` |
| `pnpm tickets` | Build `public/data/sweep-times.json` from citations (run after `pnpm data`; Node >= 22.18) |
| `pnpm basemap` | Build the SF basemap tiles into `public/data/basemap/` |
| `pnpm addresses:refresh` | Download a new EAS snapshot into `scripts/data/addresses.json.gz`. Review and commit that file; it is the only address refresh that talks to DataSF |

## 4. How work flows

- **PRs only.** Every change goes through a pull request from a branch. No direct pushes to `main`.
- **Merging.** Agents that write or review code never merge or self-approve. The coordinating agent (Product Lead)
  merges only after Mike explicitly approves that PR. No force-push and no rebase; if `main` has moved, merge
  `main` into the branch.
- **CI must be green** on both jobs (`check` and `browser`) before asking for a merge.
- **Merges do not auto-deploy.** The Pages project has no Git integration. Shipping to production is a separate,
  manual upload (below) and needs Mike's explicit OK each time.
- **Tests and CI.**
  - The `check` job runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` with
    `ALLOW_MISSING_DATA=1`. That env var skips `scripts/check-dist-data.mjs` because the job has no generated
    citywide data. It is for CI only. Never set it for a production build.
  - The `browser` job installs Playwright Chromium, copies the committed fixtures
    `tests/fixtures/data/sweep-index.json`, `sweep-sides.geojson` and `sweep-times.json` into `public/data/`,
    and runs `pnpm test:e2e` with `VITE_BASEMAP_PMTILES_URL=off`. It does not curl the live site. The fixtures
    cover the e2e addresses (534 30th Ave and 1000 Valencia St). House-number search still uses the committed
    `scripts/data/addresses.json.gz` snapshot that `pnpm dev` expands; there is no `addresses.json` fixture.
- **Data builds and the guard.** A production build is:

  ```
  pnpm data && pnpm tickets && pnpm basemap && pnpm build
  ```

  Do not set `ALLOW_MISSING_DATA`. `pnpm build` runs `scripts/check-dist-data.mjs`, which requires
  `dist/data/sweep-index.json`, `sweep-sides.geojson`, `sweep-times.json`, and basemap tiles
  (`data/basemap/meta.json`, `0/0/0.mvt`, and z15 tiles). It also parses the three JSON files and fails if a
  file is missing, empty, an HTML 404 (or any other non-JSON body), or the wrong top-level shape: the index
  needs `generated`, `source`, and a `sides` array; the GeoJSON must be a `FeatureCollection` with a `features`
  array; ticket times need `range` (with `from` and `to`) and `sides` as an object keyed by side id.
- **Deploys.** After a successful production build, upload with:

  ```
  npx wrangler pages deploy dist --project-name sf-sweep --branch main
  ```

  Every Pages deploy needs Mike's explicit OK. Do not run `wrangler pages deploy` without it. Preview uploads
  (`pnpm deploy:preview`, or the same command with `--branch feat-v1`) also need his OK. Recovering a missing
  `sweep-times.json` without rerunning the citations pipeline is documented in `docs/DEPLOY.md`: fetch from a
  specific older Pages deployment with `curl --fail`, never from the production hostname
  (`https://sf-sweep.pages.dev`).
- **Worker deploys** (`cd worker && npx wrangler deploy`) are separate from Pages and also need Mike's OK. Do
  not change Worker secrets, cron, D1 or env vars without his approval.
- **No secrets** in code, docs, logs, issues or chat. Name env vars, never their values.

## 5. Product rules

These are Mike's decisions; change them only on his say-so.

- Street cleaning only. Tow-away and other restrictions stay out of scope.
- Posted signs are authoritative, including when they disagree with typical ticket times or address-side
  estimates.
- Week of month is `ceil(day / 7)`, so days 1-7 are week 1 (see `docs/DATA.md`).
- The parked-car spot lives only on this device. The Worker stores only the push subscription, spot and fire
  time.
- House-number search is on-device from the EAS snapshot. Unknown house numbers are not interpolated to a
  nearby address.
- `pnpm tickets` requests citation time and coordinates only; no plate columns and no truck GPS.

## 6. Design rules

- Phone first. The Playwright `iphone-width` project is 390x844.
- No emoji in the UI. `pnpm lint` runs `scripts/check-no-emoji.mjs` on tracked text files.
- Dark map by default; light mode follows the system setting (`src/style.css`).
- Every status color also has a shape and a text label, so color is not the only signal.

## 7. Security and privacy

- **Secrets.** The VAPID private key is a Worker secret only. Do not commit `.env`, `.env.*` (except
  `.env.example`), `.dev.vars`, or `.vapid-private.key`. Do not log tokens, subscriptions or secret values.
- **On-device data.** Address queries and the parked-car spot are not sent to a geocoder or to the Worker,
  except the subscription, spot and fire time needed for an optional push alert.
- **Citations pipeline.** `scripts/build-ticket-times.ts` selects issued time, latitude and longitude only.
- **Tests stay offline.** Unit tests do not need the network. The browser job uses committed fixtures, not a
  live deployment. Do not run commands that write to production D1 or Pages without approval.

## 8. Constraints

- Cloudflare free tiers only: Pages, Workers Free and D1. No Workers Paid, no custom domains, no paid add-ons,
  and no card or paid plans. R2 is not used (decision 2026-11-04); static data including the basemap is served
  by Pages.
- `public/data/*` is gitignored (except `public/data/.gitkeep`). Generated sweep data, ticket times and basemap
  tiles are not in git. `public/addresses.json` is also ignored; the source of truth is
  `scripts/data/addresses.json.gz`.
- Node >= 22.18 is required for `pnpm tickets`.
- No new Cloudflare resources, env var changes, production deploys, Worker deploys or secret changes without
  Mike's approval.
- Do not merge, deploy or write production data without explicit approval of that action.

## 9. Review checklist

- [ ] CI green on `check` and `browser`; `pnpm lint`, `pnpm typecheck` and `pnpm test` pass locally.
- [ ] Production builds ran `pnpm data && pnpm tickets && pnpm basemap && pnpm build` with no `ALLOW_MISSING_DATA`.
- [ ] No emoji in the UI; `scripts/check-no-emoji.mjs` is clean.
- [ ] No secrets, env values or credentials in code, docs, logs or the PR.
- [ ] Docs updated where behavior, setup or deploy steps changed (`instructions.md`, `ROADMAP.md`,
      `docs/DEPLOY.md`, `docs/DATA.md` as needed).
- [ ] Any Pages or Worker deploy is listed with Mike's approval status and was not run without that OK.

## 10. Decided against

See `ROADMAP.md` for dates and context.

- Cloudflare R2 for static data, including the basemap (Pages serves it; Pages does not answer range requests
  with 206, so a single `.pmtiles` file is not used there).
- Workers Paid, custom domains and other paid Cloudflare add-ons.
- Tow-away and other non-street-cleaning restrictions.
