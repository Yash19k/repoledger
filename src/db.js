const { Pool, types } = require("pg");
const config = require("./config");

// DATE columns as plain "YYYY-MM-DD" strings; BIGINT (GitHub ids) as numbers.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));

let pool = null;

/**
 * TLS for remote databases. With DATABASE_SSL_CA set (e.g. Supabase's CA certificate) the server's certificate is
 * verified. Without it the connection is still encrypted but not verified, which is what most hosted Postgres
 * providers need out of the box. An explicit sslmode in DATABASE_URL always wins.
 */
function sslOption(url, ca = config.DATABASE_SSL_CA) {
  if (/[?&]sslmode=/.test(url)) return undefined;
  try {
    const host = new URL(url).hostname;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return undefined;
  } catch {
    /* fall through */
  }
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: sslOption(config.DATABASE_URL),
      max: config.PG_POOL_MAX,
      connectionTimeoutMillis: 15000,
      // A runaway query must not hold a connection forever.
      statement_timeout: 30000,
    });
    pool.on("error", (e) => console.warn("Idle database client error:", e.message));
  }
  return pool;
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

const query = (sql, params) => module.exports.getPool().query(sql, params);

/** Readiness check: resolves when the database answers within `ms`. */
function ping(ms = 3000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Database did not answer in time")), ms);
  });
  return Promise.race([query("SELECT 1"), timeout]).finally(() => clearTimeout(timer));
}

async function withTransaction(fn) {
  const client = await module.exports.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function values(rows) {
  const params = [];
  const groups = rows.map((row) => {
    const ph = row.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${ph.join(", ")})`;
  });
  return { clause: groups.join(", "), params };
}

async function insertMany(sqlPrefix, sqlSuffix, rows) {
  if (!rows.length) return;
  const { clause, params } = values(rows);
  await query(`${sqlPrefix} VALUES ${clause} ${sqlSuffix}`, params);
}

const TRAFFIC_TABLES = ["traffic_views", "traffic_clones", "referrers", "popular_paths"];
const PUBLIC_TABLES = ["commit_activity", "contributors", "issue_pr_stats", "star_stats"];

// ---------------------------------------------------------------------------
// Stats upserts (collector)
// ---------------------------------------------------------------------------

function upsertViews(repo, rows) {
  return insertMany(
    "INSERT INTO traffic_views (repo, date, total_views, unique_visitors)",
    `ON CONFLICT (repo, date) DO UPDATE
        SET total_views = EXCLUDED.total_views,
            unique_visitors = EXCLUDED.unique_visitors,
            collected_at = NOW()`,
    rows.map((r) => [repo, r.date, r.total, r.uniques])
  );
}

function upsertClones(repo, rows) {
  return insertMany(
    "INSERT INTO traffic_clones (repo, date, total_clones, unique_cloners)",
    `ON CONFLICT (repo, date) DO UPDATE
        SET total_clones = EXCLUDED.total_clones,
            unique_cloners = EXCLUDED.unique_cloners,
            collected_at = NOW()`,
    rows.map((r) => [repo, r.date, r.total, r.uniques])
  );
}

/**
 * Referrers, popular paths and contributors are point-in-time lists. Replace the repo's previous list so
 * entries that dropped out don't linger and the tables don't grow on every collection.
 */
function replaceSnapshot(table, columns, repo, rows) {
  return withTransaction(async (c) => {
    await c.query(`DELETE FROM ${table} WHERE repo = $1`, [repo]);
    if (!rows.length) return;
    const { clause, params } = values(rows);
    await c.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${clause}`, params);
  });
}

function upsertReferrers(repo, rows) {
  return replaceSnapshot(
    "referrers",
    ["repo", "referrer", "total_count", "unique_count"],
    repo,
    rows.map((r) => [repo, r.referrer, r.total, r.uniques])
  );
}

function upsertPopularPaths(repo, rows) {
  return replaceSnapshot(
    "popular_paths",
    ["repo", "path", "total_count", "unique_count"],
    repo,
    rows.map((r) => [repo, r.path, r.total, r.uniques])
  );
}

function upsertCommitActivity(repo, rows) {
  return insertMany(
    "INSERT INTO commit_activity (repo, week_start, total_commits, additions, deletions)",
    `ON CONFLICT (repo, week_start) DO UPDATE
        SET total_commits = EXCLUDED.total_commits,
            additions = EXCLUDED.additions,
            deletions = EXCLUDED.deletions`,
    rows.map((r) => [repo, r.week_start, r.total, r.additions, r.deletions])
  );
}

function upsertContributors(repo, rows) {
  return replaceSnapshot(
    "contributors",
    ["repo", "author", "total_commits"],
    repo,
    rows.map((r) => [repo, r.author, r.total])
  );
}

function upsertStarStats(repo, snapshotDate, stars) {
  return query(
    `INSERT INTO star_stats (repo, snapshot_date, stars)
     VALUES ($1, $2, $3)
     ON CONFLICT (repo, snapshot_date) DO UPDATE SET stars = EXCLUDED.stars`,
    [repo, snapshotDate, stars]
  );
}

/** Reconstructed history never overwrites a real snapshot. rows: [{date, stars}] */
function insertStarHistory(repo, rows) {
  return insertMany(
    "INSERT INTO star_stats (repo, snapshot_date, stars)",
    "ON CONFLICT (repo, snapshot_date) DO NOTHING",
    rows.map((r) => [repo, r.date, r.stars])
  );
}

async function hasStarHistory(repo) {
  const { rows } = await query("SELECT EXISTS (SELECT 1 FROM star_stats WHERE repo = $1) AS has", [repo]);
  return rows[0].has;
}

function upsertIssuePrStats(repo, snapshotDate, openIssues, closedIssues, openPrs, mergedPrs) {
  return query(
    `INSERT INTO issue_pr_stats
         (repo, snapshot_date, open_issues, closed_issues, open_prs, merged_prs)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (repo, snapshot_date) DO UPDATE
         SET open_issues = EXCLUDED.open_issues,
             closed_issues = EXCLUDED.closed_issues,
             open_prs = EXCLUDED.open_prs,
             merged_prs = EXCLUDED.merged_prs`,
    [repo, snapshotDate, openIssues, closedIssues, openPrs, mergedPrs]
  );
}

// ---------------------------------------------------------------------------
// Stats queries (dashboard) — return [] on failure
// ---------------------------------------------------------------------------

async function fetchAll(sql, params) {
  try {
    const res = await query(sql, params);
    return res.rows;
  } catch (e) {
    console.warn("Database query failed:", e.message);
    return [];
  }
}

const getViews = (repos, start, end) =>
  fetchAll(
    `SELECT repo, date, total_views, unique_visitors FROM traffic_views
     WHERE repo = ANY($1) AND date BETWEEN $2 AND $3 ORDER BY date`,
    [repos, start, end]
  );

const getClones = (repos, start, end) =>
  fetchAll(
    `SELECT repo, date, total_clones, unique_cloners FROM traffic_clones
     WHERE repo = ANY($1) AND date BETWEEN $2 AND $3 ORDER BY date`,
    [repos, start, end]
  );

const getCommitActivity = (repos, start, end) =>
  fetchAll(
    `SELECT repo, week_start, total_commits, additions, deletions FROM commit_activity
     WHERE repo = ANY($1) AND week_start BETWEEN $2 AND $3 ORDER BY week_start`,
    [repos, start, end]
  );

const getStarStats = (repos, start, end) =>
  fetchAll(
    `SELECT repo, snapshot_date, stars FROM star_stats
     WHERE repo = ANY($1) AND snapshot_date BETWEEN $2 AND $3 ORDER BY snapshot_date`,
    [repos, start, end]
  );

const getIssuePrStats = (repos, start, end) =>
  fetchAll(
    `SELECT repo, snapshot_date, open_issues, closed_issues, open_prs, merged_prs FROM issue_pr_stats
     WHERE repo = ANY($1) AND snapshot_date BETWEEN $2 AND $3 ORDER BY snapshot_date`,
    [repos, start, end]
  );

/**
 * Rows from each repo's most recent collection only. Older versions appended a new list on every run,
 * so this also hides entries that have since dropped out.
 */
const latestSnapshot = (table, key, cols) =>
  // collected_at only orders the rows; leaving it out of the result saves parsing a timestamp per row.
  `SELECT DISTINCT ON (t.repo, t.${key}) t.repo, t.${key}, ${cols.map((c) => `t.${c}`).join(", ")}
   FROM ${table} t
   WHERE t.repo = ANY($1)
     AND t.collected_at >= (SELECT MAX(x.collected_at) FROM ${table} x WHERE x.repo = t.repo) - INTERVAL '1 minute'
   ORDER BY t.repo, t.${key}, t.collected_at DESC`;

const getReferrers = (repos) => fetchAll(latestSnapshot("referrers", "referrer", ["total_count", "unique_count"]), [repos]);
const getPopularPaths = (repos) => fetchAll(latestSnapshot("popular_paths", "path", ["total_count", "unique_count"]), [repos]);
const getContributors = (repos) => fetchAll(latestSnapshot("contributors", "author", ["total_commits"]), [repos]);

// ---------------------------------------------------------------------------
// Users & sessions
// ---------------------------------------------------------------------------

function upsertUser({ id, login, avatar_url }) {
  return query(
    `INSERT INTO users (id, login, avatar_url) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url, last_login_at = NOW()`,
    [id, login, avatar_url]
  );
}

function createSession(userId, tokenHash, expiresAt) {
  return query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    tokenHash,
    userId,
    expiresAt,
  ]);
}

/** Throws on database errors so callers can tell "signed out" from "database down". */
async function getSessionUser(tokenHash) {
  const { rows } = await query(
    `SELECT u.id, u.login, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  );
  return rows[0] || null;
}

const deleteSession = (tokenHash) => query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
const deleteExpiredSessions = () => query("DELETE FROM sessions WHERE expires_at <= NOW()");
const deleteUser = (userId) => query("DELETE FROM users WHERE id = $1", [userId]);

// ---------------------------------------------------------------------------
// GitHub App installations
// ---------------------------------------------------------------------------

function upsertInstallation({ id, account_id, account_login, account_type, suspended }) {
  return query(
    `INSERT INTO installations (id, account_id, account_login, account_type, suspended)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET account_login = EXCLUDED.account_login,
       account_type = EXCLUDED.account_type, suspended = EXCLUDED.suspended`,
    [id, account_id, account_login, account_type, suspended]
  );
}

async function listInstallationIds() {
  const { rows } = await query("SELECT id FROM installations");
  return rows.map((r) => r.id);
}

/** installation id -> when it was last collected (ms since epoch; 0 if never). */
async function installationCollectedTimes() {
  const { rows } = await query("SELECT id, last_collected_at FROM installations");
  return new Map(rows.map((r) => [r.id, r.last_collected_at ? new Date(r.last_collected_at).getTime() : 0]));
}

async function installationsForUser(userId) {
  const { rows } = await query(
    `SELECT i.id, i.account_id, i.account_login, i.account_type, i.suspended, i.last_collected_at,
            (SELECT COUNT(*)::int FROM installation_repos r WHERE r.installation_id = i.id) AS repo_count
     FROM installations i WHERE i.account_id = $1 ORDER BY i.id`,
    [userId]
  );
  return rows;
}

/** Replace an installation's repo list; returns repos that were removed. */
function replaceInstallationRepos(installationId, repos) {
  return withTransaction(async (c) => {
    const { rows } = await c.query("SELECT repo FROM installation_repos WHERE installation_id = $1", [
      installationId,
    ]);
    const next = new Set(repos.map((r) => r.repo));
    const removed = rows.map((r) => r.repo).filter((r) => !next.has(r));
    await c.query("DELETE FROM installation_repos WHERE installation_id = $1", [installationId]);
    if (repos.length) {
      const { clause, params } = values(repos.map((r) => [installationId, r.repo, !!r.private]));
      // ON CONFLICT: a scheduled run and a "Collect now" can overlap without failing each other.
      await c.query(
        `INSERT INTO installation_repos (installation_id, repo, private) VALUES ${clause}
         ON CONFLICT (installation_id, repo) DO UPDATE SET private = EXCLUDED.private`,
        params
      );
    }
    return removed;
  });
}

/** Delete an installation; returns the repos it covered. */
function deleteInstallation(installationId) {
  return withTransaction(async (c) => {
    const { rows } = await c.query("SELECT repo FROM installation_repos WHERE installation_id = $1", [
      installationId,
    ]);
    await c.query("DELETE FROM installations WHERE id = $1", [installationId]);
    return rows.map((r) => r.repo);
  });
}

const markInstallationCollected = (installationId) =>
  query("UPDATE installations SET last_collected_at = NOW() WHERE id = $1", [installationId]);

/**
 * Remove stored stats for repos nobody tracks any more.
 * Traffic is private: deleted once no installation covers the repo.
 * Public stats are kept while a public lookup still lists the repo.
 */
function purgeRepos(repos) {
  if (!repos.length) return Promise.resolve();
  return withTransaction(async (c) => {
    const { rows: untracked } = await c.query(
      `SELECT r FROM unnest($1::text[]) AS r
       WHERE NOT EXISTS (SELECT 1 FROM installation_repos ir WHERE ir.repo = r)`,
      [repos]
    );
    const noTraffic = untracked.map((x) => x.r);
    if (!noTraffic.length) return;
    for (const t of TRAFFIC_TABLES) await c.query(`DELETE FROM ${t} WHERE repo = ANY($1)`, [noTraffic]);

    const { rows: unlisted } = await c.query(
      `SELECT r FROM unnest($1::text[]) AS r
       WHERE NOT EXISTS (SELECT 1 FROM profile_repos pr WHERE pr.repo = r)`,
      [noTraffic]
    );
    const gone = unlisted.map((x) => x.r);
    if (gone.length) {
      for (const t of PUBLIC_TABLES) await c.query(`DELETE FROM ${t} WHERE repo = ANY($1)`, [gone]);
    }
  });
}

const VISIBLE_REPOS_SQL = `
  SELECT DISTINCT r.repo FROM installation_repos r
  JOIN installations i ON i.id = r.installation_id
  WHERE i.account_id = $1 AND NOT i.suspended`;

async function visibleReposForUser(userId) {
  const rows = await fetchAll(`${VISIBLE_REPOS_SQL} ORDER BY repo`, [userId]);
  return rows.map((r) => r.repo);
}

async function hasDataForUser(userId) {
  const rows = await fetchAll(
    `SELECT EXISTS (SELECT 1 FROM star_stats WHERE repo IN (${VISIBLE_REPOS_SQL})) AS has`,
    [userId]
  );
  return !!(rows[0] && rows[0].has);
}

// ---------------------------------------------------------------------------
// Public profiles (username lookups)
// ---------------------------------------------------------------------------

async function getProfile(login) {
  const { rows } = await query("SELECT * FROM profiles WHERE login = $1", [login.toLowerCase()]);
  return rows[0] || null;
}

/** Save a profile and its public repo list; returns repos no longer listed. */
function replaceProfile(profile, repos) {
  const key = profile.login.toLowerCase();
  return withTransaction(async (c) => {
    await c.query(
      `INSERT INTO profiles (login, github_id, display_login, name, avatar_url, html_url, account_type, public_repos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (login) DO UPDATE SET github_id = EXCLUDED.github_id, display_login = EXCLUDED.display_login,
         name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, html_url = EXCLUDED.html_url,
         account_type = EXCLUDED.account_type, public_repos = EXCLUDED.public_repos`,
      [key, profile.id, profile.login, profile.name, profile.avatar_url, profile.html_url, profile.type, profile.public_repos]
    );
    const { rows } = await c.query("SELECT repo FROM profile_repos WHERE login = $1", [key]);
    const next = new Set(repos.map((r) => r.full_name));
    const removed = rows.map((r) => r.repo).filter((r) => !next.has(r));
    await c.query("DELETE FROM profile_repos WHERE login = $1", [key]);
    if (repos.length) {
      const { clause, params } = values(
        repos.map((r) => [key, r.full_name, r.description, r.stargazers_count, r.pushed_at])
      );
      await c.query(
        `INSERT INTO profile_repos (login, repo, description, stars, pushed_at) VALUES ${clause}
         ON CONFLICT (login, repo) DO UPDATE SET description = EXCLUDED.description, stars = EXCLUDED.stars,
           pushed_at = EXCLUDED.pushed_at`,
        params
      );
    }
    return removed;
  });
}

const markProfileFetched = (login) =>
  query("UPDATE profiles SET fetched_at = NOW() WHERE login = $1", [login.toLowerCase()]);

/** Record a view. At most one write per profile per hour, so busy profiles don't cost a write per page view. */
const touchProfile = (login) =>
  query(
    `UPDATE profiles SET last_viewed_at = NOW()
     WHERE login = $1 AND (last_viewed_at IS NULL OR last_viewed_at < NOW() - INTERVAL '1 hour')`,
    [login.toLowerCase()]
  );

async function profileRepos(login) {
  return fetchAll(
    // Never show a repo its owner's installation reports as private (e.g. made private after it was cached).
    `SELECT pr.repo, pr.description, pr.stars, pr.pushed_at FROM profile_repos pr
     WHERE pr.login = $1
       AND NOT EXISTS (SELECT 1 FROM installation_repos ir WHERE ir.repo = pr.repo AND ir.private)
     ORDER BY pr.repo`,
    [login.toLowerCase()]
  );
}

/** Delete a cached profile; returns its repos. */
function deleteProfile(login) {
  const key = login.toLowerCase();
  return withTransaction(async (c) => {
    const { rows } = await c.query("SELECT repo FROM profile_repos WHERE login = $1", [key]);
    await c.query("DELETE FROM profiles WHERE login = $1", [key]);
    return rows.map((r) => r.repo);
  });
}

/**
 * Delete cached lookups, and their stats (unless an installation or another lookup still uses them):
 *   - lookups nobody has opened for `days` days
 *   - lookups that never finished, except the logins in `skip` (lookups running right now)
 *   - beyond the `max` most recently opened, so lookups can never fill the database (and starve owners' traffic)
 * Returns how many profiles were deleted.
 */
async function pruneProfiles(days, skip = [], max = null) {
  const { rows } = await query(
    `SELECT login FROM profiles
     WHERE NOT (login = ANY($2::text[]))
       AND (COALESCE(last_viewed_at, fetched_at) < NOW() - make_interval(days => $1::int)
            OR (last_viewed_at IS NULL AND fetched_at IS NULL)
            OR login IN (SELECT login FROM profiles
                         ORDER BY COALESCE(last_viewed_at, fetched_at) DESC NULLS LAST, login
                         OFFSET $3::int))`,
    [days, skip.map((s) => s.toLowerCase()), max ?? 2147483647]
  );
  for (const { login } of rows) await purgeRepos(await deleteProfile(login));
  return rows.length;
}

module.exports = {
  getPool,
  closePool,
  ping,
  fetchAll,
  withTransaction,
  TRAFFIC_TABLES,
  PUBLIC_TABLES,
  upsertViews,
  upsertClones,
  upsertReferrers,
  upsertPopularPaths,
  upsertCommitActivity,
  upsertContributors,
  upsertStarStats,
  insertStarHistory,
  hasStarHistory,
  upsertIssuePrStats,
  getViews,
  getClones,
  getCommitActivity,
  getStarStats,
  getIssuePrStats,
  getReferrers,
  getPopularPaths,
  getContributors,
  upsertUser,
  createSession,
  getSessionUser,
  deleteSession,
  deleteExpiredSessions,
  deleteUser,
  upsertInstallation,
  listInstallationIds,
  installationCollectedTimes,
  installationsForUser,
  replaceInstallationRepos,
  deleteInstallation,
  markInstallationCollected,
  purgeRepos,
  visibleReposForUser,
  hasDataForUser,
  getProfile,
  replaceProfile,
  markProfileFetched,
  touchProfile,
  profileRepos,
  deleteProfile,
  pruneProfiles,
  sslOption,
};
