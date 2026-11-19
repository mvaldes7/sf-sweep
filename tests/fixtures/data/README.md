# Browser CI fixtures

Small slices of the generated sweep data used by the Playwright job, covering the
two addresses the e2e test looks up: 534 30th Ave (CNN 1642000, East) and
1000 Valencia St (CNN 13069000, West), plus the opposite side of each block so
side selection can compare midpoints. Street-only search for "30th ave" also
resolves from the 30th Ave sides.

House-number search still uses the committed `scripts/data/addresses.json.gz`
snapshot (`pnpm dev` / `pnpm build` expand it to `public/addresses.json`), so
these fixtures do not include an address index.

Shapes follow the real files from `pnpm data` and `pnpm tickets`. Copy into
`public/data/` in CI; do not download a live deployment. Set
`VITE_BASEMAP_PMTILES_URL=off` in that job (the app supports it; no tile fixtures).
