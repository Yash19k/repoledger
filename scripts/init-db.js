/**
 * Creates or updates the database schema. Safe to run more than once:
 * it only adds what is missing and never deletes data.
 *
 *     npm run init-db
 */

const db = require("../src/db");

const SCHEMA = `
-- ---- Collected stats ----

CREATE TABLE IF NOT EXISTS traffic_views (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    date DATE NOT NULL,
    total_views INT,
    unique_visitors INT,
    collected_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(repo, date)
);

CREATE TABLE IF NOT EXISTS traffic_clones (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    date DATE NOT NULL,
    total_clones INT,
    unique_cloners INT,
    collected_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(repo, date)
);

CREATE TABLE IF NOT EXISTS referrers (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    referrer TEXT NOT NULL,
    total_count INT,
    unique_count INT,
    collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS popular_paths (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    total_count INT,
    unique_count INT,
    collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commit_activity (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    week_start DATE NOT NULL,
    total_commits INT,
    additions INT,
    deletions INT,
    UNIQUE(repo, week_start)
);

CREATE TABLE IF NOT EXISTS contributors (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    author TEXT NOT NULL,
    total_commits INT,
    collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issue_pr_stats (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    open_issues INT,
    closed_issues INT,
    open_prs INT,
    merged_prs INT,
    UNIQUE(repo, snapshot_date)
);

CREATE TABLE IF NOT EXISTS star_stats (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    stars INT,
    UNIQUE(repo, snapshot_date)
);

CREATE INDEX IF NOT EXISTS referrers_repo_idx ON referrers(repo, collected_at);
CREATE INDEX IF NOT EXISTS contributors_repo_idx ON contributors(repo, collected_at);
CREATE INDEX IF NOT EXISTS popular_paths_repo_idx ON popular_paths(repo, collected_at);

-- ---- Accounts (GitHub sign-in) ----

CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    login TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS installations (
    id BIGINT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL,
    suspended BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_collected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS installations_account_idx ON installations(account_id);

CREATE TABLE IF NOT EXISTS installation_repos (
    installation_id BIGINT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    private BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (installation_id, repo)
);
CREATE INDEX IF NOT EXISTS installation_repos_repo_idx ON installation_repos(repo);

-- ---- Public username lookups ----

CREATE TABLE IF NOT EXISTS profiles (
    login TEXT PRIMARY KEY,
    github_id BIGINT,
    display_login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    html_url TEXT,
    account_type TEXT,
    public_repos INT,
    fetched_at TIMESTAMPTZ,
    last_viewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS profile_repos (
    login TEXT NOT NULL REFERENCES profiles(login) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    description TEXT,
    stars INT,
    pushed_at TIMESTAMPTZ,
    PRIMARY KEY (login, repo)
);
CREATE INDEX IF NOT EXISTS profile_repos_repo_idx ON profile_repos(repo);
`;

/** Create or update the schema. */
const migrate = () => db.getPool().query(SCHEMA);

module.exports = { SCHEMA, migrate };

if (require.main === module) {
  (async () => {
    try {
      await migrate();
      console.log("Database schema is up to date.");
    } catch (e) {
      console.error("Schema update failed:", e.message);
      process.exitCode = 1;
    } finally {
      await db.closePool();
    }
  })();
}
