# Photo reports (issue #10)

Users can report a posted street-cleaning sign with a photo. Reports go to a review
queue. Nothing on the map changes until a report is confirmed, and a confirmed
report only produces a proposed `src/data/corrections.json` entry (the schema from
PR #12). There is no automatic commit, merge or deploy.

The corrections file from PR #12 was not on `main` when this landed. The generator
in `workers/reports/src/corrections.ts` matches that schema (cnn, side, optional
street/limits/blockside, rules with `HH:MM` times including `:30`, source, reported
date, optional note). Merge or rebase onto #12 before relying on the file being
present in this repo.

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
| `sf-sweep-sign-photos` | R2 bucket | name: `sf-sweep-sign-photos` | Photos only. The Nov 4, 2026 decision not to use R2 was for static/basemap data. |
| `sf-sweep-reports` | D1 database | `database_id` in `workers/reports/wrangler.toml` | Schema: `workers/reports/schema.sql` |
| `sf-sweep-reports` | Worker | https://sf-sweep-reports.miggyman7.workers.dev | Live code must stay the 503 stub until Mike OKs the real Worker |
| Turnstile site | Turnstile | public `TURNSTILE_SITE_KEY` in wrangler `[vars]` and `VITE_TURNSTILE_SITE_KEY` | Secret is the `TURNSTILE_SECRET` Worker secret |
| Rate limiting | Workers rate-limit binding | `namespace_id` `1802` in wrangler.toml | 5 requests / 60 seconds |
| `REVIEW_TOKEN` | Worker secret | set with `wrangler secret put` | Not in git. Box path (if generated here): `/workspace/secrets/sfsweep_review_token.txt` |

## Setup commands (run only with Mike's OK)

From `workers/reports/`:

```
npx wrangler r2 bucket create sf-sweep-sign-photos
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
  PR #12 entry shape. The Worker does not write git.

## Submit

`POST /api/reports` (multipart, CORS-limited to the Pages origins): one JPEG, PNG
or WebP photo (3 MB cap), block side, device geolocation, optional days and
`HH:MM` times, Turnstile token. The Worker strips EXIF (including GPS) before the
object is stored in R2.
