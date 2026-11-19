# SF Sweep

Mobile-first PWA showing San Francisco street cleaning status for each side of every block.

- Map: MapLibre GL, self-hosted PMTiles (GeoJSON fallback). No Mapbox, no tokens.
- Each side of a block is its own thick line: green solid = no cleaning, amber dashed + clock = cleaning within 1 hour,
  red solid + circled x = sweeping now. Every color also has a shape and a text label.
- Live mode with a 6 hour timelapse (auto-play, scrubber, 1x/2x/4x) and Plan mode with day chips (Today, All, Mon-Sun).
- Tap a block for an SF-style street sign card per side with its weekly schedule.
- Park here: the spot is saved only on this device. Optional Web Push alert 1 hour before sweeping
  (Cloudflare Worker + D1 storing only the push subscription, spot and fire time), plus an .ics fallback.
- SFMTA holiday enforcement calendar applied (`src/data/holidays.json`).
- Client-side house-number search using DataSF EAS address points (lazy static index; `pnpm addresses:refresh` to update, see docs/DATA.md), plus offline street search (no geocoder), browser geolocation for "locate me".
- Dark map by default, light mode follows the system setting.

Street cleaning only; tow-away and other restrictions are out of scope. Posted signs are authoritative.

## Develop

Requires Node 22+ and pnpm 10.

```
pnpm install
pnpm data        # fetch DataSF and build public/data (needed to see streets)
pnpm dev
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- `src/lib/schedule.ts` - schedule rules, week of month, holiday skip, status at time t, next sweep
- `scripts/build-data.mjs` - data pipeline (see docs/DATA.md)
- `worker/` - push alert Worker (see docs/DEPLOY.md)

## Data and assumptions

See docs/DATA.md. Key assumption: week of month = ceil(day / 7), so days 1-7 are week 1.

Data: DataSF Street Sweeping Schedule (yhqp-riqs). Holidays: SFMTA holiday enforcement schedule.
