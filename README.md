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
  - per-IP rate limits
  - an Origin check on every state-changing request
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

1. **Database:** create a PostgreSQL database and run `npm run init-db` against it.
2. **Web server:** deploy to any Node host (Render, Railway, Fly.io…) with `npm start`, and set:
   - `DATABASE_URL`
   - `PUBLIC_URL` (your `https://` address)
   - `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`
   - `GITHUB_PUBLIC_TOKEN`
3. **GitHub App:** make sure its *Callback URL* is `https://<your-domain>/auth/callback` and its *Setup URL* is `https://<your-domain>/auth/installed`.
4. **Scheduled collection:** add the repository secrets `DATABASE_URL`, `APP_ID` and `APP_PRIVATE_KEY`. The workflow in `.github/workflows/collect.yml` then collects every installation every six hours.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the web server |
| `npm run collect` | Collect stats for every installation once |
| `npm run init-db` | Create or update the database schema |
| `npm run create-app` | Create the GitHub App and save its credentials |
| `npm test` | Run the test suite |
