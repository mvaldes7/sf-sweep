# SF Sweep Roadmap

SF Sweep is a mobile-first PWA that shows San Francisco street-cleaning status for each side of every block.
Production: https://sf-sweep.pages.dev. The site is a static Cloudflare Pages app with an optional Web Push
Worker; there is no user account.

Sources for this file: merged PRs, GitHub issues, `docs/`, and recorded product decisions. Items whose status
could not be confirmed are marked **(status unclear)**.

Planned work lives in GitHub issues (and in the backlog below). As of Nov 21, 2026 the open issue is
[#10](https://github.com/mvaldes7/sf-sweep/issues/10).

## Shipped

Dates are merge dates (Pacific time), except the Nov 18 production deploy, which is a Pages upload rather than
a git merge.

### Foundation (Nov 4, 2026)

- SF Sweep v1: MapLibre map with per-side lines, Live and Plan modes, sign cards, offline street search, locate
  me, on-device parked car, .ics fallback, Web Push Worker + D1, SFMTA holidays, data pipeline and CI
  ([#1](https://github.com/mvaldes7/sf-sweep/pull/1)).
- Mobile polish: compact car bar, Plan-mode legend, inline location toast, contrast tweaks, compass wording for
  sign sides from DataSF `blockside` ([#2](https://github.com/mvaldes7/sf-sweep/pull/2)).

### Ticket risk and ticket times (Nov 5, 2026)

- Ticket risk on Park here (safe / within 12h / within 2h or sweeping now) and "Find a safe spot nearby"
  ([#3](https://github.com/mvaldes7/sf-sweep/pull/3)).
- "Tickets usually ~..." line from DataSF parking citations (`pnpm tickets`, `public/data/sweep-times.json`)
  ([#4](https://github.com/mvaldes7/sf-sweep/pull/4)).

### Viewport and address search (Nov 10, 2026)

- Keep the map canvas filling the viewport on iOS after search ([#6](https://github.com/mvaldes7/sf-sweep/pull/6)).
- Client-side house-number search from a DataSF EAS address snapshot
  ([#7](https://github.com/mvaldes7/sf-sweep/pull/7)).

### Sign polish, CI fixtures, data guard, and production rebuild (Nov 18, 2026)

- MOVE BY box border and text follow the car-bar ticket-risk color (safe green, amber, red). Sign cards in the
  block detail are ordered Monday to Sunday, with holiday-only signs last
  ([#5](https://github.com/mvaldes7/sf-sweep/pull/5), merged Nov 18 after earlier review).
- Production Pages deploy `667d6c4e`, a fresh rebuild from `9a3d9ab` (the #5 merge). Ticket times were rebuilt
  from DataSF citations covering 2024-11-19 to 2026-11-13 (`sweep-times.json` is 455,525 bytes; `generated`
  2026-11-19T06:20:58.081Z, which is Nov 18, 2026, 10:20 PM PT). That file is still what
  https://sf-sweep.pages.dev/data/sweep-times.json and https://667d6c4e.sf-sweep.pages.dev/data/sweep-times.json
  serve. The rollback target is `8c1d0705` (the Nov 10 deploy, which is missing `sweep-times.json`).
- Browser CI uses committed fixtures under `tests/fixtures/data/` instead of curling the live site, and sets
  `VITE_BASEMAP_PMTILES_URL=off` ([#9](https://github.com/mvaldes7/sf-sweep/pull/9)).
- Production builds must include `sweep-times.json`. `scripts/check-dist-data.mjs` requires that file, parses
  the three generated JSON files, and fails on an HTML 404 or the wrong top-level shape. Deploy docs include
  `pnpm tickets` and recovery via `curl --fail` from a specific older deployment, never from the production
  hostname ([#8](https://github.com/mvaldes7/sf-sweep/pull/8)).

## In progress

- No other open pull requests as of Nov 21, 2026 (besides the one adding this file).

## Planned / backlog

GitHub issues hold the backlog.

- Photo reports of new or changed street-cleaning signs and schedules, with a review queue before anything
  changes on the map ([#10](https://github.com/mvaldes7/sf-sweep/issues/10), opened Nov 21, 2026). A "Report a
  sign" action would capture a photo, auto-fill location and block side, and take an optional note. Confirmed
  reports could show a "recently reported change" marker or a corrected schedule. Not started; needs Mike's go
  before any build. Open questions in the issue include free-tier photo storage, abuse controls, who reviews
  reports, and privacy (faces and plates).
- Light-theme contrast for `--soon` and `--clear` in `src/style.css`. On the light `--bg` (`#eef0f3`), `--soon`
  (`#a87400`) is about 3.5:1 and `--clear` (`#3f9d68`) is about 3.0:1, short of WCAG AA 4.5:1 for normal text.
- An optional ruleset on `main` (required checks, no direct pushes). The repo currently has no rulesets and
  `main` is not branch-protected.

## Decided against

- Cloudflare R2 for static data, including the basemap; Pages serves those files (Nov 4, 2026). A single
  `.pmtiles` basemap is not used on Pages because range requests do not get a 206 (tested Nov 4, 2026).
- Workers Paid, custom domains and other paid Cloudflare add-ons; stay on the free plan (`docs/DEPLOY.md`).
- Tow-away and other non-street-cleaning restrictions; posted signs for street cleaning only.

## Product principles

- Posted signs are authoritative. Ticket times and address-side estimates are hints.
- Street cleaning only; park-here data stays on the device.
- Merges are not production releases. Pages has no Git integration; every `wrangler pages deploy` needs Mike's
  explicit OK.
- Free Cloudflare tiers only (Pages, Workers Free, D1). No card or paid plans.
- No emoji in the UI.
- Every merge, production deploy, Worker deploy and new cloud resource needs Mike's explicit approval.
