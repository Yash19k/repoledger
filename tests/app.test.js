const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

// An unreachable database, and no GitHub App configured, unless a test sets one up.
process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/nonexistent";
process.env.PUBLIC_URL = "http://localhost:8600";
for (const k of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]) {
  delete process.env[k];
}

const config = require("../src/config");
const db = require("../src/db");
const github = require("../src/github");

// Snapshot real db functions so each test can stub freely.
const realDb = { ...db };
const failingPool = {
  query: async () => {
    throw new Error("Simulated connection failure");
  },
  connect: async () => {
    throw new Error("Simulated connection failure");
  },
};

beforeEach(() => {
  Object.assign(db, realDb);
  db.getPool = () => failingPool;
  for (const k of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]) {
    config[k] = null;
  }
});

after(() => Object.assign(db, realDb));

async function withServer(fn) {
  const { createApp } = require("../server");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

/** Pretend the request carries a valid session for user 1 (@me). */
function signIn(repos = ["me/alpha"]) {
  db.getSessionUser = async () => ({ id: 1, login: "me", avatar_url: null });
  db.visibleReposForUser = async () => repos;
  return { cookie: "rl_session=test-token" };
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

test("stats queries return [] when the database is offline", async () => {
  const d = "2026-01-01";
  assert.deepEqual(await db.fetchAll("SELECT 1"), []);
  assert.deepEqual(await db.getViews(["a/b"], d, d), []);
  assert.deepEqual(await db.getClones(["a/b"], d, d), []);
  assert.deepEqual(await db.getCommitActivity(["a/b"], d, d), []);
  assert.deepEqual(await db.getStarStats(["a/b"], d, d), []);
  assert.deepEqual(await db.getIssuePrStats(["a/b"], d, d), []);
  assert.deepEqual(await db.getReferrers(["a/b"]), []);
  assert.deepEqual(await db.getPopularPaths(["a/b"]), []);
  assert.deepEqual(await db.getContributors(["a/b"]), []);
  assert.deepEqual(await db.visibleReposForUser(1), []);
});

// ---------------------------------------------------------------------------
// GitHub App authentication
// ---------------------------------------------------------------------------

test("app JWT is RS256-signed with the app id as issuer", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  config.GITHUB_APP_ID = "12345";
  config.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" });

  const now = 1_800_000_000;
  const [header, payload, signature] = github.appJwt(now).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iat: now - 60, exp: now + 540, iss: "12345" });
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
});

test("collector refuses to run without GitHub App credentials", async () => {
  const collector = require("../src/collector");
  await assert.rejects(collector.run(), /GitHub App is not configured/);
});

// ---------------------------------------------------------------------------
// Pages, headers, sign-in
// ---------------------------------------------------------------------------

test("landing page and public profile URLs serve the app with security headers", async () => {
  await withServer(async (base) => {
    const home = await fetch(base + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Sign in with GitHub/);
    assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");

    const profile = await fetch(base + "/u/octocat");
    assert.equal(profile.status, 200);
    assert.match(await profile.text(), /RepoLedger/);

    assert.equal((await fetch(base + "/vendor/plotly.min.js")).status, 200);
  });
});

test("owner endpoints require sign-in", async () => {
  db.getSessionUser = async () => null;
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/api/me")).status, 401);
    assert.equal((await fetch(base + "/api/repos")).status, 401);
    assert.equal((await fetch(base + "/api/data?start=2026-01-01&end=2026-01-31")).status, 401);
  });
});

test("sign-in redirects to GitHub with a state cookie", async () => {
  Object.assign(config, {
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "repoledger",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY: "unused",
  });
  await withServer(async (base) => {
    const res = await fetch(base + "/auth/login", { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(loc.searchParams.get("client_id"), "Iv1.test");
    assert.equal(loc.searchParams.get("redirect_uri"), "http://localhost:8600/auth/callback");
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /rl_oauth_state=[a-f0-9]{32}/);
    assert.match(cookie, /HttpOnly/);
    assert.equal(loc.searchParams.get("state"), cookie.match(/rl_oauth_state=([a-f0-9]+)/)[1]);
  });
});

test("sign-in callback rejects a mismatched state", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/auth/callback?code=abc&state=evil", {
      redirect: "manual",
      headers: { cookie: "rl_oauth_state=expected" },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/?error=state");
  });
});

test("sign-in without a configured app explains itself", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/auth/login", { redirect: "manual" });
    assert.equal(res.headers.get("location"), "/?error=not_configured");
  });
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test("owners only ever get data for their own repositories", async () => {
  const headers = signIn(["me/alpha", "me/beta"]);
  const seen = [];
  db.getViews = async (repos) => (seen.push(repos), []);
  await withServer(async (base) => {
    await fetch(base + "/api/data?start=2026-01-01&end=2026-01-31&repo=someone/else&repo=me/beta", { headers });
    await fetch(base + "/api/data?start=2026-01-01&end=2026-01-31", { headers });
  });
  assert.deepEqual(seen, [["me/beta"], ["me/alpha", "me/beta"]]);
});

test("public lookups never return traffic", async () => {
  db.profileRepos = async () => [{ repo: "octocat/hello" }];
  let trafficQueried = false;
  db.getViews = db.getClones = db.getReferrers = async () => ((trafficQueried = true), []);
  await withServer(async (base) => {
    const res = await fetch(base + "/api/public/octocat/data?start=2026-01-01&end=2026-01-31");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()).sort(), ["commits", "contributors", "issues", "stars"]);
  });
  assert.equal(trafficQueried, false);
});

test("public lookups are limited to the profile's own repositories", async () => {
  db.profileRepos = async () => [{ repo: "octocat/hello" }];
  const seen = [];
  db.getStarStats = async (repos) => (seen.push(repos), []);
  await withServer(async (base) => {
    await fetch(base + "/api/public/octocat/data?start=2026-01-01&end=2026-01-31&repo=me/private-thing");
  });
  assert.deepEqual(seen, [[]]);
});

test("a first-time public lookup starts a refresh", async () => {
  const lookup = require("../src/public-lookup");
  const realStart = lookup.start;
  const started = [];
  lookup.start = (login) => (started.push(login), true);
  db.getProfile = async () => null;
  try {
    await withServer(async (base) => {
      await fetch(base + "/api/public/octocat");
    });
  } finally {
    lookup.start = realStart;
  }
  assert.deepEqual(started, ["octocat"]);
});

test("invalid usernames are rejected", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/api/public/-bad--name-")).status, 400);
    assert.equal((await fetch(base + "/api/public/a_b/data?start=2026-01-01&end=2026-01-02")).status, 400);
  });
});

test("state-changing requests from other sites are blocked", async () => {
  const headers = signIn();
  await withServer(async (base) => {
    const evil = await fetch(base + "/api/account/delete", { method: "POST", headers: { ...headers, origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    const noOrigin = await fetch(base + "/auth/logout", { method: "POST", headers });
    assert.equal(noOrigin.status, 403);
  });
});

test("an offline database is reported, not treated as signed out", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/me", { headers: { cookie: "rl_session=whatever" } });
    assert.equal(res.status, 503);
  });
});

// ---------------------------------------------------------------------------
// Input validation and data accuracy
// ---------------------------------------------------------------------------

test("impossible dates are rejected and reversed ranges are swapped", async () => {
  const headers = signIn();
  const seen = [];
  db.getViews = async (repos, start, end) => (seen.push([start, end]), []);
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/api/data?start=2026-13-45&end=2026-01-31", { headers })).status, 400);
    assert.equal((await fetch(base + "/api/data?start=2026-02-30&end=2026-03-01", { headers })).status, 400);
    assert.equal((await fetch(base + "/api/data?start=2026-03-01&end=2026-01-01", { headers })).status, 200);
  });
  assert.deepEqual(seen, [["2026-01-01", "2026-03-01"]]);
});

test("a malformed request body is a 400, not a server error", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8600" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });
});

test("issue counts don't include pull requests", async () => {
  const { collectRepo } = require("../src/collect-repo");
  const counts = { "pulls?state=open": 3, "pulls?state=closed": 10, "issues?state=closed": 25 };
  const gh = {
    json: async () => null,
    paginate: async () => [],
    totalCount: async (path) => counts[Object.keys(counts).find((k) => path.endsWith(k))],
  };
  let saved = null;
  db.hasStarHistory = async () => true;
  db.upsertStarStats = async () => {};
  db.upsertIssuePrStats = async (...args) => (saved = args.slice(2));
  await collectRepo(gh, { full_name: "me/alpha", stargazers_count: 0, open_issues_count: 8 });
  // open: 8 - 3 PRs = 5 issues; closed: 25 - 10 PRs = 15 issues; PRs: 3 open, 10 closed
  assert.deepEqual(saved, [5, 15, 3, 10]);
});
