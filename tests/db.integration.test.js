/**
 * Integration tests against a real PostgreSQL database. Skipped unless TEST_DATABASE_URL is set:
 *
 *     TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/repoledger_test npm test
 *
 * The database is wiped first, so its name must contain "test".
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run database tests" : false;

if (url) {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("TEST_DATABASE_URL must name a database containing 'test'.");
  process.env.DATABASE_URL = url;
  process.env.PUBLIC_URL = "http://localhost:8600";
  // Never reach GitHub from these tests, whatever .env says.
  for (const k of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_PUBLIC_TOKEN", "GH_TOKEN"]) {
    process.env[k] = "";
  }
}

const db = url ? require("../src/db") : null;
const sql = (text, params) => db.getPool().query(text, params);
const count = async (table, repo) => Number((await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE repo = $1`, [repo])).rows[0].n);

before(async () => {
  if (skip) return;
  await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await require("../scripts/init-db").migrate();
});

after(async () => {
  if (!skip) await db.closePool();
});

/** A signed-in owner with one installation covering `repos`. Returns their session token. */
async function seedOwner(userId, login, repos) {
  await db.upsertUser({ id: userId, login, avatar_url: null });
  await db.upsertInstallation({ id: userId * 10, account_id: userId, account_login: login, account_type: "User", suspended: false });
  await db.replaceInstallationRepos(userId * 10, repos.map((r) => ({ repo: r, private: false })));
  const token = crypto.randomBytes(16).toString("hex");
  await db.createSession(userId, crypto.createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 86400000));
  return token;
}

test("the schema script is safe to run again", { skip }, async () => {
  await require("../scripts/init-db").migrate();
  await require("../scripts/init-db").migrate();
});

test("sessions: valid ones load, expired ones don't and get cleaned up", { skip }, async () => {
  await db.upsertUser({ id: 1, login: "alice", avatar_url: null });
  await db.createSession(1, "live", new Date(Date.now() + 60000));
  await db.createSession(1, "dead", new Date(Date.now() - 60000));
  assert.equal((await db.getSessionUser("live")).login, "alice");
  assert.equal(await db.getSessionUser("dead"), null);
  await db.deleteExpiredSessions();
  assert.equal((await sql("SELECT COUNT(*)::int AS n FROM sessions WHERE token_hash = 'dead'")).rows[0].n, 0);
  await db.deleteUser(1);
  assert.equal(await db.getSessionUser("live"), null, "deleting a user removes their sessions");
});

test("removing a repo deletes its traffic but keeps public stats a lookup still lists", { skip }, async () => {
  await seedOwner(2, "bob", ["bob/kept", "bob/listed"]);
  for (const r of ["bob/kept", "bob/listed"]) {
    await db.upsertViews(r, [{ date: "2026-01-01", total: 5, uniques: 2 }]);
    await db.upsertStarStats(r, "2026-01-01", 3);
  }
  await db.replaceProfile({ login: "bob", id: 2, type: "User", public_repos: 1 }, [{ full_name: "bob/listed", stargazers_count: 3 }]);

  const removed = await db.replaceInstallationRepos(20, []);
  assert.deepEqual(removed.sort(), ["bob/kept", "bob/listed"]);
  await db.purgeRepos(removed);

  assert.equal(await count("traffic_views", "bob/kept"), 0);
  assert.equal(await count("traffic_views", "bob/listed"), 0, "traffic is private: gone once untracked");
  assert.equal(await count("star_stats", "bob/kept"), 0);
  assert.equal(await count("star_stats", "bob/listed"), 1, "public stats stay while a lookup lists the repo");
});

test("a scheduled run and 'Collect now' can write the repo list at the same time", { skip }, async () => {
  await db.upsertInstallation({ id: 30, account_id: 3, account_login: "cat", account_type: "User", suspended: false });
  const repos = Array.from({ length: 50 }, (_, i) => ({ repo: `cat/r${i}`, private: i % 2 === 0 }));
  await Promise.all(Array.from({ length: 6 }, () => db.replaceInstallationRepos(30, repos)));
  assert.equal((await sql("SELECT COUNT(*)::int AS n FROM installation_repos WHERE installation_id = 30")).rows[0].n, 50);
});

test("snapshots show only each repo's latest collection", { skip }, async () => {
  await db.upsertReferrers("d/x", [{ referrer: "old.example", total: 1, uniques: 1 }]);
  await sql("UPDATE referrers SET collected_at = NOW() - INTERVAL '1 day' WHERE repo = 'd/x'");
  await db.upsertReferrers("d/x", [{ referrer: "news.ycombinator.com", total: 9, uniques: 7 }]);
  const rows = await db.getReferrers(["d/x"]);
  assert.deepEqual(rows.map((r) => r.referrer), ["news.ycombinator.com"]);
  await db.upsertPopularPaths("d/x", [{ path: "/d/x/blob/main/README.md", total: 4, uniques: 3 }]);
  assert.equal((await db.getPopularPaths(["d/x"]))[0].total_count, 4);
});

test("a repo its owner made private never appears in public lookups", { skip }, async () => {
  await db.replaceProfile({ login: "Eve", id: 5, type: "User", public_repos: 2 }, [
    { full_name: "eve/open", stargazers_count: 1 },
    { full_name: "eve/secret", stargazers_count: 1 },
  ]);
  await db.upsertInstallation({ id: 50, account_id: 5, account_login: "eve", account_type: "User", suspended: false });
  await db.replaceInstallationRepos(50, [{ repo: "eve/secret", private: true }]);
  assert.deepEqual((await db.profileRepos("eve")).map((r) => r.repo), ["eve/open"]);
});

test("profile views are recorded at most once an hour", { skip }, async () => {
  await db.replaceProfile({ login: "fay", id: 6, type: "User", public_repos: 0 }, []);
  assert.equal((await db.touchProfile("fay")).rowCount, 1);
  assert.equal((await db.touchProfile("FAY")).rowCount, 0);
  await sql("UPDATE profiles SET last_viewed_at = NOW() - INTERVAL '2 hours' WHERE login = 'fay'");
  assert.equal((await db.touchProfile("fay")).rowCount, 1);
});

test("old cached lookups are pruned with their stats; recent and running ones stay", { skip }, async () => {
  await sql("DELETE FROM profiles"); // start clean: earlier tests leave unfinished lookups, which would be pruned too
  const mk = async (login, viewedDaysAgo, fetched = true) => {
    await db.replaceProfile({ login, id: 1, type: "User", public_repos: 1 }, [{ full_name: `${login}/r`, stargazers_count: 1 }]);
    await db.upsertStarStats(`${login}/r`, "2026-01-01", 1);
    if (fetched) await db.markProfileFetched(login);
    if (viewedDaysAgo != null) {
      await sql(`UPDATE profiles SET last_viewed_at = NOW() - make_interval(days => $2), fetched_at = NOW() - make_interval(days => $2)
                 WHERE login = $1`, [login, viewedDaysAgo]);
    }
  };
  await mk("stale", 40);
  await mk("fresh", 2);
  await mk("broken", null, false); // a lookup that never finished
  await mk("inflight", null, false); // a lookup running right now
  await mk("tracked", 40);
  await seedOwner(7, "tracked", ["tracked/r"]); // its owner signed in: stats stay for them

  const pruned = await db.pruneProfiles(30, ["InFlight"]);
  assert.equal(pruned, 3);
  const left = (await sql("SELECT login FROM profiles ORDER BY login")).rows.map((r) => r.login);
  assert.ok(left.includes("fresh") && left.includes("inflight"));
  assert.ok(!left.includes("stale") && !left.includes("broken") && !left.includes("tracked"));
  assert.equal(await count("star_stats", "stale/r"), 0);
  assert.equal(await count("star_stats", "tracked/r"), 1);
});

test("cached lookups are capped, dropping the least recently opened first", { skip }, async () => {
  await sql("DELETE FROM profiles");
  for (let i = 1; i <= 6; i++) {
    await db.replaceProfile({ login: `cap${i}`, id: i, type: "User", public_repos: 0 }, []);
    await db.markProfileFetched(`cap${i}`);
    await sql("UPDATE profiles SET last_viewed_at = NOW() - make_interval(hours => $2) WHERE login = $1", [`cap${i}`, i]);
  }
  // cap6 is the oldest but running right now, so it's skipped; the cap of 3 keeps cap1..cap3.
  assert.equal(await db.pruneProfiles(30, ["cap6"], 3), 2);
  const left = (await sql("SELECT login FROM profiles ORDER BY login")).rows.map((r) => r.login);
  assert.deepEqual(left, ["cap1", "cap2", "cap3", "cap6"]);
});

test("end to end: the owner dashboard and public lookups read real data", { skip }, async () => {
  const { createApp } = require("../server");
  const repos = Array.from({ length: 25 }, (_, i) => `gus/r${String(i).padStart(2, "0")}`);
  const token = await seedOwner(8, "gus", repos);
  for (const r of repos) {
    await db.upsertViews(r, [
      { date: "2026-03-01", total: 10, uniques: 4 },
      { date: "2026-03-02", total: 20, uniques: 6 },
    ]);
    await db.upsertStarStats(r, "2026-03-02", 7);
  }
  await db.upsertPopularPaths("gus/r00", [{ path: "/gus/r00/wiki", total: 3, uniques: 2 }]);
  await db.replaceProfile({ login: "gus", id: 8, type: "User", public_repos: 25 }, repos.map((r) => ({ full_name: r, stargazers_count: 7 })));
  await db.markProfileFetched("gus");

  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `rl_session=${token}` };
  try {
    const me = await (await fetch(`${base}/api/me`, { headers })).json();
    assert.equal(me.repo_count, 25);
    assert.equal(me.has_data, true);

    const qs = new URLSearchParams({ start: "2026-03-01", end: "2026-03-31" });
    repos.slice(0, 22).forEach((r) => qs.append("repo", r));
    const data = await (await fetch(`${base}/api/data?${qs}`, { headers })).json();
    assert.equal(new Set(data.views.map((v) => v.repo)).size, 22);
    assert.equal(data.views.length, 44);
    assert.equal(data.paths[0].path, "/gus/r00/wiki");

    const pub = await (await fetch(`${base}/api/public/GUS`)).json();
    assert.equal(pub.status, "ready");
    assert.equal(pub.repos.length, 25);
    const pubData = await (await fetch(`${base}/api/public/gus/data?start=2026-03-01&end=2026-03-31`)).json();
    assert.equal(pubData.stars.length, 25);
    assert.equal(pubData.views, undefined, "public lookups never include traffic");

    const nobody = await fetch(`${base}/api/data?start=2026-03-01&end=2026-03-31`, { headers: { cookie: "rl_session=forged" } });
    assert.equal(nobody.status, 401);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    server.close();
  }
});
