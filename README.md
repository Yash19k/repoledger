# RepoLedger

GitHub only keeps 14 days of traffic data. RepoLedger keeps it permanently.

- **Look up anyone:** open `/u/<username>` to see a GitHub user's public repositories: stars (with full star history), commits, lines changed, issues, pull requests and contributors. No sign-in needed.
- **Sign in for your traffic:** install the RepoLedger GitHub App on the repositories you choose to keep their views, unique visitors, clones and referring sites, collected every six hours.

Traffic is only ever shown to the signed-in owner. Public lookups never include it.

## Security model

RepoLedger signs people in through a **GitHub App** rather than a plain OAuth app, so access is narrow and visible:

| Permission | Access | Why |
|---|---|---|
| Administration | read | GitHub requires it for the traffic API (views, clones, referrers) |
| Issues | read | Issue counts |
| Pull requests | read | Pull-request counts |
| Metadata | read | Repository names (required for every GitHub App) |
| Contents | **not requested** | RepoLedger can never read code |

- **Users choose repositories:** they pick all repositories or specific ones on GitHub's install screen.
- **No user tokens stored:** the sign-in token is used once to identify the user, then revoked. Collection uses one-hour installation tokens minted from the app's private key.
- **Sessions:** random tokens stored as SHA-256 hashes, in `HttpOnly`, `SameSite=Lax` cookies that are `Secure` over HTTPS.
- **Request protection:**
  - a strict Content-Security-Policy and other security headers
  - per-client rate limits (IPv6 clients are grouped by /56 network, so rotating addresses doesn't help)
  - an Origin check on every state-changing request
  - API responses are marked `no-store`, so no browser or proxy cache keeps private traffic
- **Shared GitHub budget:** public lookups stop when the hourly GitHub budget falls to its reserve, so one large
  account can't use up everyone's lookups. Every GitHub request has a timeout, and tokens are only ever sent to
  `api.github.com`.
- **Bounded storage:** cached lookups expire after 30 days unopened and are capped at 200, so lookups can't fill the
  database and crowd out owners' traffic.
- **Users can leave:**
  - *Delete my data* uninstalls the app and deletes their stats immediately.
  - Uninstalling on GitHub deletes them on the next collection run.
  - Removing a repo from the installation deletes that repo's traffic.

The app's private key, client secret and database URL are the sensitive values. Keep them only in `.env` locally and in your host's secret settings.

## Stack

| Part | Technology |
|---|---|
| Frontend | HTML, CSS and vanilla JavaScript (`public/`), charts with Plotly.js (CSP-safe build) |
| Server | Node.js + Express (`server.js`) |
| Collector | Node.js (`src/collector.js`), run by GitHub Actions every 6 hours |
| Database | PostgreSQL (e.g. Supabase) |

## Running locally

Requires Node.js 20+ and a PostgreSQL database.

```bash
npm install
cp .env.example .env        # set DATABASE_URL (and optionally GITHUB_PUBLIC_TOKEN)
npm run init-db             # creates or updates tables; safe to re-run
npm start                   # http://localhost:8600
```

Username lookups work straight away. A `GITHUB_PUBLIC_TOKEN` (a GitHub token with no scopes) raises GitHub's limit from 60 to 5,000 requests per hour.

### Enabling sign-in

```bash
npm run create-app
```

This opens GitHub with the app's name, URLs and read-only permissions filled in. Confirm, and the script saves the app's credentials to `.env`. Restart `npm start`.

It uses `PUBLIC_URL` from `.env` for the sign-in callback, so set that to your real address before creating the app for production. You can add more callback URLs later in the app's settings on GitHub.

## Deploying

1. **Database:** create a PostgreSQL database and run `npm run init-db` against it. Re-run it after upgrading.
2. **Web server:** deploy to any Node host (Render, Railway, Fly.io, AWS App Runner…) with `npm start`, or build the
   `Dockerfile`. Set:
   - `DATABASE_URL`
   - `PUBLIC_URL` (your `https://` address)
   - `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`
   - `GITHUB_PUBLIC_TOKEN` (a token with **no scopes**; never reuse a personal token with repo access)
   - `NODE_ENV=production`
3. **GitHub App:** make sure its *Callback URL* is `https://<your-domain>/auth/callback` and its *Setup URL* is `https://<your-domain>/auth/installed`.
4. **Scheduled collection:** add the repository secrets `DATABASE_URL`, `APP_ID` and `APP_PRIVATE_KEY`. The workflow in `.github/workflows/collect.yml` then collects every installation every six hours.

### Production checklist

- **Health checks:** point the host's health check at `/healthz` (process is up). `/readyz` also checks the database.
- **Proxies:** rate limits need each visitor's real IP. With one proxy in front (Render, Railway, Fly, an AWS load
  balancer) the default works. With two (e.g. Cloudflare in front of Render) set `TRUST_PROXY=2`.
- **Database TLS:** connections are encrypted but the certificate isn't verified unless you set `DATABASE_SSL_CA`
  (path or PEM; Supabase publishes its CA under *Database settings → SSL*).
- **One instance:** rate limits and lookup progress live in memory, so run a single web instance. That is plenty:
  see *Capacity* below.
- **Keep the schedule alive:** GitHub pauses scheduled workflows in public repositories after 60 days without
  activity. If collection stops, any commit (or re-enabling the workflow in the Actions tab) restarts it. Traffic
  older than 14 days can't be recovered, so check it now and then.
- **Shutdown:** the server finishes in-flight requests on `SIGTERM`, so rolling deploys don't drop requests.

### Optional settings

| Variable | Default | What it does |
|---|---|---|
| `TRUST_PROXY` | `1` if `PUBLIC_URL` is https | Number of proxies in front of the app |
| `DATABASE_SSL_CA` | unset | CA certificate to verify the database's TLS |
| `PG_POOL_MAX` | `10` | Database connections per server |
| `RATE_LIMIT_API_PER_MIN` | `600` | API requests per client network per minute |
| `RATE_LIMIT_LOOKUPS_PER_HOUR` | `30` | New username lookups per client network per hour |
| `PUBLIC_LOOKUP_CONCURRENCY` | `3` | Lookups running at once; others wait their turn |
| `PUBLIC_PROFILE_TTL_DAYS` | `30` | Delete cached lookups not opened for this long |
| `PUBLIC_MAX_PROFILES` | `200` | Most cached lookups kept (≈0.2–0.7 MB each) |
| `COLLECT_CONCURRENCY` | `4` | Installations the collector reads in parallel |
| `GITHUB_TIMEOUT_MS` | `20000` | Give up on a GitHub request after this long |

## Capacity

Measured on one Node process (Intel i5-12500H laptop, local PostgreSQL 18) with a year of data for 100 owners × 30
repositories and 500 cached lookups. Every request came from a different IP, as real visitors would.

| Request | Throughput | Median latency |
|---|---|---|
| Landing page | ~4,100 req/s | 10 ms |
| Public profile (cached) | ~1,100 req/s | 43 ms |
| Public profile data, 30 days | ~260 req/s | 190 ms at 50 concurrent |
| Owner dashboard data, 30 days × 30 repos | ~110 req/s | 450 ms at 50 concurrent |
| Owner dashboard data, 1 year × 30 repos | ~10 req/s | 1.8 s at 20 concurrent |
| Realistic mix (above, weighted) | ~105 req/s | 24 ms at 5 concurrent, 550 ms at 50 |

No request failed at any load up to 200 concurrent connections; past saturation, responses slow down instead of
erroring. Memory peaked at ~470 MB.

What that means in people, assuming an active visitor makes an API request every 10–20 seconds:

- **The web server** handles roughly **1,000–2,000 people using it at the same moment**, or several hundred thousand
  page views a day. It is not the first limit you'll hit.
- **New username lookups** are limited by GitHub, not the server. Estimate: a lookup costs ~7–15 GitHub requests
  per repository, so the 5,000/hour token budget covers roughly **10–20 new medium-sized accounts per hour**. Cached
  lookups (6 hours) are free.
- **Database storage** is the main limit on a free database. Measured: each tracked repository uses **~200 KB per
  year**. A 500 MB free database holds about **1,500–1,800 repository-years** of traffic (e.g. 50–60 owners × 30
  repositories for a year) next to the capped lookup cache (≤ ~140 MB). An 8 GB database holds about 40,000.
- **Collection** runs in GitHub Actions with a 60-minute limit. Estimate: at ~3–5 seconds per repository and 4
  installations in parallel, one run covers roughly **3,000 repositories**. Raise `COLLECT_CONCURRENCY` beyond that.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the web server |
| `npm run collect` | Collect stats for every installation once |
| `npm run init-db` | Create or update the database schema |
| `npm run create-app` | Create the GitHub App and save its credentials |
| `npm test` | Run the test suite (set `TEST_DATABASE_URL` to a database named `*test*` to include database tests) |
