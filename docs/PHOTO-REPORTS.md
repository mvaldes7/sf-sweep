# Photo reports (issue #10)

Users can report a posted street-cleaning sign with a photo. Reports go to a review
queue. Nothing on the map changes until a report is confirmed, and a confirmed
report only produces a proposed `src/data/corrections.json` entry (same schema as
the versioned corrections file). There is no automatic commit, merge or deploy.

The generator in `workers/reports/src/corrections.ts` matches that schema (cnn, side,
optional street/limits/blockside, rules with `HH:MM` times including `:30`, source,
reported date, optional note).

## Feature flag (off by default)

The "Report a sign" button is shown only when all of these are set at build time:

- `VITE_PHOTO_REPORTS=1`
- `VITE_REPORTS_API_BASE` (the reports Worker URL)
- `VITE_TURNSTILE_SITE_KEY` (public site key)

Leave them unset in production. A frontend redeploy without this flag will not show
the reporting UI. Deploying the frontend with the flag on, or deploying the real
Worker (`workers/reports/src/index.ts`), still needs Mike's explicit OK.

## Resources (Cloudflare free tier only)

Do not enable Workers Paid, custom domains, or paid add-ons. Do not create these
without Mike's approval. Do not apply `workers/reports/schema.sql` to any database
other than `sf-sweep-reports`.

| Resource | Type | Name / ID | Notes |
| --- | --- | --- | --- |
| `sf-sweep-sign-photos` | KV namespace | `2e73ed962475440fb4a7edc35981cf78` | Photos, keyed by report id. Used instead of R2 (R2 is not enabled on this account; the Nov 4, 2026 decision also kept R2 off for static/basemap data). |
| `sf-sweep-reports` | D1 database | `970b90d1-0ad2-4424-9807-517bca2a85a0` | Schema: `workers/reports/schema.sql` |
| `sf-sweep-reports` | Worker | https://sf-sweep-reports.miggyman7.workers.dev | Live code must stay the 503 stub until Mike OKs the real Worker |
| Turnstile site | Turnstile | TODO: public `TURNSTILE_SITE_KEY` (not created yet) | Fill wrangler `[vars]` and `VITE_TURNSTILE_SITE_KEY` after the site exists. Secret is the `TURNSTILE_SECRET` Worker secret |
| Rate limiting | Workers rate-limit binding | `namespace_id` `1802` in wrangler.toml | 5 requests / 60 seconds |
| `REVIEW_TOKEN` | Worker secret | set with `wrangler secret put` | Not in git. Box path (if generated here): `/workspace/secrets/sfsweep_review_token.txt` |

## Setup commands (run only with Mike's OK)

From `workers/reports/`:

```
npx wrangler kv namespace create sf-sweep-sign-photos
# put the printed id into wrangler.toml and wrangler.stub.toml
npx wrangler d1 create sf-sweep-reports
# put the printed database_id into wrangler.toml and wrangler.stub.toml
npx wrangler d1 execute sf-sweep-reports --remote --file=schema.sql
# Do not run that execute against the sf-sweep alerts database.

# Turnstile site (siteverify-managed, hosts sf-sweep.pages.dev and localhost):
# created via the Cloudflare API; store the site key in wrangler [vars] and the
# secret with: npx wrangler secret put TURNSTILE_SECRET

# Placeholder Worker only (503 for every request), not src/index.ts:
npx wrangler deploy -c wrangler.stub.toml

# Secrets (values are never committed):
#   npx wrangler secret put REVIEW_TOKEN
#   npx wrangler secret put TURNSTILE_SECRET
```

The real Worker is deployed only after a separate OK:

```
npx wrangler deploy
```

## Review

The review API is `GET/POST /api/review/...` and requires
`Authorization: Bearer <REVIEW_TOKEN>` (or the `x-review-token` header).

- `GET /api/review` lists reports
- `GET /api/review/:id` and `GET /api/review/:id/photo` show one report
- `POST /api/review/:id/edit` updates optional days and times on a pending report
- `POST /api/review/:id/reject` rejects it
- `POST /api/review/:id/confirm` confirms it and returns `{ correction }` in the
  corrections-file entry shape. The Worker does not write git.

## Submit

`POST /api/reports` (multipart, CORS-limited to the Pages origins): one JPEG, PNG
or WebP photo (3 MB cap), block side, device geolocation, optional days and
`HH:MM` times, Turnstile token. The Worker strips EXIF (including GPS) before the
value is stored in the `sf-sweep-sign-photos` KV namespace (keyed by report id, 3 MB cap).
