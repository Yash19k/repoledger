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

// ---------------------------------------------------------------------------
// QA regressions (2026-11 hardening pass)
// ---------------------------------------------------------------------------

test("large repository selections return every selected repository", async () => {
  const all = Array.from({ length: 30 }, (_, i) => `me/r${String(i).padStart(2, "0")}`);
  const headers = signIn(all);
  const seen = [];
  db.getViews = async (repos) => (seen.push(repos), []);
  const pick = all.slice(0, 25);
  await withServer(async (base) => {
    const qs = new URLSearchParams({ start: "2026-01-01", end: "2026-01-31" });
    pick.forEach((r) => qs.append("repo", r));
    assert.equal((await fetch(`${base}/api/data?${qs}`, { headers })).status, 200);
  });
  assert.deepEqual(seen, [pick]);
});

test("rate limits key IPv6 clients by network, not by single address", () => {
  const { clientKey } = require("../server");
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("::ffff:203.0.113.9"), "203.0.113.9");
  // Rotating the low bits of an address (anything inside one /56) must not give a fresh limit.
  assert.equal(clientKey("2001:db8:1:200::1"), clientKey("2001:db8:1:2ff:ffff:ffff:ffff:ffff"));
  assert.equal(clientKey("2001:db8:1:2aa:1:2:3:4"), clientKey("2001:0db8:0001:0200::"));
  assert.notEqual(clientKey("2001:db8:1:200::1"), clientKey("2001:db8:1:300::1"));
  assert.equal(clientKey("::1"), "0:0:0:0::/56");
});

test("the public lookup budget refills when GitHub's window resets", () => {
  const now = Date.now();
  github.resetPublicRate({ remaining: 10, limit: 5000, reset: Math.floor(now / 1000) + 60 });
  assert.equal(github.publicRateRemaining(now), 10);
  // Before the fix this stayed at 10 forever, blocking every lookup until a restart.
  assert.equal(github.publicRateRemaining(now + 61 * 1000), 5000);
  github.resetPublicRate();
});

test("without a token the lookup reserve scales down to GitHub's 60-request limit", () => {
  const lookup = require("../src/public-lookup");
  github.resetPublicRate({ remaining: 50, limit: 60, reset: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(lookup.budgetLow(), false); // the old fixed 300 reserve blocked every anonymous lookup
  github.resetPublicRate({ remaining: 5, limit: 60, reset: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(lookup.budgetLow(), true);
  github.resetPublicRate();
});

test("a lookup stops when the shared GitHub budget runs low", async () => {
  const lookup = require("../src/public-lookup");
  const realPublicClient = github.publicClient;
  const reset = Math.floor(Date.now() / 1000) + 3600;
  github.resetPublicRate({ remaining: 5000, limit: 5000, reset });
  const spend = () => github.resetPublicRate({ remaining: github.publicRateRemaining() - 400, limit: 5000, reset });
  let repoCalls = 0;
  github.publicClient = () => ({
    json: async (p) => {
      if (p === "/users/bigacct") return { id: 9, login: "bigacct", name: null, avatar_url: null, html_url: "", type: "User", public_repos: 60 };
      repoCalls++;
      spend();
      return null;
    },
    paginate: async (p) =>
      p.includes("/repos?") ? Array.from({ length: 60 }, (_, i) => ({ full_name: `bigacct/r${i}`, stargazers_count: 0 })) : [],
    totalCount: async () => 0,
  });
  Object.assign(db, {
    replaceProfile: async () => [],
    purgeRepos: async () => {},
    upsertStarStats: async () => {},
    upsertIssuePrStats: async () => {},
    hasStarHistory: async () => true,
    markProfileFetched: async () => assert.fail("a lookup that ran out of budget must not be marked complete"),
  });
  try {
    assert.equal(lookup.start("bigacct"), true);
    for (let i = 0; i < 100 && lookup.status("bigacct")?.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    const job = lookup.status("bigacct");
    assert.equal(job.state, "error");
    assert.match(job.message, /rate limit/);
    assert.ok(repoCalls < 60, `stopped early (${repoCalls} stats calls for 60 repos)`);
  } finally {
    github.publicClient = realPublicClient;
    github.resetPublicRate();
  }
});

test("waiting for a free lookup slot doesn't use up the network's hourly allowance", async () => {
  const lookup = require("../src/public-lookup");
  const realStart = lookup.start;
  const started = [];
  lookup.start = (login) => (started.push(login), true);
  db.getProfile = async () => null;
  const realConcurrency = config.PUBLIC_LOOKUP_CONCURRENCY;
  try {
    await withServer(async (base) => {
      config.PUBLIC_LOOKUP_CONCURRENCY = 0; // every slot taken
      // More attempts than the hourly allowance (20 before this change, 30 now).
      for (let i = 0; i < (config.RATE_LIMIT_LOOKUPS_PER_HOUR || 20) + 5; i++) {
        const res = await fetch(`${base}/api/public/user${i}`);
        assert.equal(res.status, 503);
        assert.equal((await res.json()).status, "busy");
      }
      config.PUBLIC_LOOKUP_CONCURRENCY = realConcurrency; // a slot frees up
      assert.notEqual((await fetch(`${base}/api/public/finally`)).status, 429);
    });
  } finally {
    lookup.start = realStart;
    config.PUBLIC_LOOKUP_CONCURRENCY = realConcurrency;
  }
  assert.deepEqual(started, ["finally"]);
});

test("health and readiness endpoints", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/readyz")).status, 503); // the test database is offline
    db.ping = async () => {};
    const ready = await fetch(base + "/readyz");
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, database: "up" });
  });
});

test("private API responses are never cached", async () => {
  const headers = signIn();
  db.installationsForUser = async () => [];
  await withServer(async (base) => {
    for (const p of ["/api/me", "/api/config", "/api/public/octocat/data?start=2026-01-01&end=2026-01-02"]) {
      assert.equal((await fetch(base + p, { headers })).headers.get("cache-control"), "no-store", p);
    }
  });
});

test("the charting library is served pre-compressed and cacheable", async () => {
  const http = require("node:http");
  const get = (url, headers) =>
    new Promise((resolve, reject) => {
      http
        .get(url, { headers }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, size: Buffer.concat(chunks).length }));
        })
        .on("error", reject);
    });
  await withServer(async (base) => {
    let br;
    for (let i = 0; i < 100; i++) {
      br = await get(base + "/vendor/plotly.min.js", { "accept-encoding": "gzip, br" });
      if (br.headers["content-encoding"] === "br") break;
      await new Promise((r) => setTimeout(r, 50)); // background compression still running
    }
    assert.equal(br.headers["content-encoding"], "br");
    assert.ok(br.size < 2_000_000, `compressed size ${br.size}`);
    assert.match(br.headers["cache-control"], /max-age=86400/);
    const plain = await get(base + "/vendor/plotly.min.js", {});
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.ok(plain.size > 4_000_000);
    const again = await get(base + "/vendor/plotly.min.js", { "if-none-match": br.headers.etag });
    assert.equal(again.status, 304);
    const page = await get(base + "/", { "accept-encoding": "gzip" });
    assert.equal(page.headers["content-encoding"], "gzip");
  });
});

test("'Collect now' can't be restarted in a loop", async () => {
  const headers = { ...signIn(), origin: "http://localhost:8600" };
  db.installationsForUser = async () => [{ id: 77, suspended: false, last_collected_at: null }];
  const collector = require("../src/collector");
  const real = collector.collectInstallationById;
  let kicks = 0;
  collector.collectInstallationById = async () => {
    kicks++;
    throw new Error("simulated failure"); // finishes at once, so the old code allowed an instant restart
  };
  try {
    await withServer(async (base) => {
      assert.equal((await fetch(base + "/api/collect", { method: "POST", headers })).status, 200);
      await new Promise((r) => setTimeout(r, 20));
      const again = await fetch(base + "/api/collect", { method: "POST", headers });
      assert.equal(again.status, 429);
      assert.ok(Number(again.headers.get("retry-after")) > 0);
    });
  } finally {
    collector.collectInstallationById = real;
  }
  assert.equal(kicks, 1);
});

test("signing in again ends the previous session", async () => {
  Object.assign(config, {
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "repoledger",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY: "unused",
  });
  const real = { exchange: github.exchangeOAuthCode, userClient: github.userClient, revoke: github.revokeUserToken };
  github.exchangeOAuthCode = async () => "user-token";
  github.userClient = () => ({ json: async () => ({ id: 1, login: "me", avatar_url: null }), paginate: async () => [] });
  github.revokeUserToken = async () => {};
  const deleted = [];
  Object.assign(db, {
    upsertUser: async () => {},
    createSession: async () => {},
    deleteSession: async (hash) => deleted.push(hash),
    installationsForUser: async () => [],
  });
  try {
    await withServer(async (base) => {
      const res = await fetch(base + "/auth/callback?code=c&state=s", {
        redirect: "manual",
        headers: { cookie: "rl_oauth_state=s; rl_session=old-token" },
      });
      assert.equal(res.headers.get("location"), "/");
      assert.match(res.headers.get("set-cookie"), /rl_session=[A-Za-z0-9_-]{43}/);
    });
  } finally {
    Object.assign(github, { exchangeOAuthCode: real.exchange, userClient: real.userClient, revokeUserToken: real.revoke });
  }
  assert.deepEqual(deleted, [crypto.createHash("sha256").update("old-token").digest("hex")]);
});

test("deleting an account mid-collection removes everything that collection wrote", async () => {
  const collector = require("../src/collector");
  const realClient = github.installationClient;
  const calls = [];
  github.installationClient = () => ({
    paginate: async () => [
      { full_name: "me/alpha", stargazers_count: 0 },
      { full_name: "me/beta", stargazers_count: 0 },
    ],
    json: async () => {
      collector.cancel(42); // the owner clicks "Delete my data" while the first repo is being read
      return null;
    },
    totalCount: async () => 0,
  });
  Object.assign(db, {
    upsertInstallation: async () => calls.push("upsert"),
    replaceInstallationRepos: async () => [],
    upsertViews: async () => {},
    upsertClones: async () => {},
    upsertReferrers: async () => {},
    upsertPopularPaths: async () => {},
    upsertStarStats: async () => {},
    upsertIssuePrStats: async () => {},
    hasStarHistory: async () => true,
    markInstallationCollected: async () => calls.push("marked"),
    deleteInstallation: async (id) => (calls.push(`delete ${id}`), ["me/alpha", "me/beta"]),
    purgeRepos: async (repos) => calls.push(`purge ${[...repos].sort().join(",")}`),
  });
  try {
    await collector.syncInstallation({ id: 42, account: { id: 1, login: "me", type: "User" }, suspended_at: null });
  } finally {
    github.installationClient = realClient;
  }
  assert.deepEqual(calls, ["upsert", "delete 42", "purge me/alpha,me/beta"]);
});

test("collection runs several installations at once, within the limit", async () => {
  const { eachLimit } = require("../src/collector");
  let active = 0;
  let peak = 0;
  const done = [];
  await eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    done.push(n);
    active--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test("the GitHub client never sends a token outside the API, and every request has a timeout", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, signal: opts.signal });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gh = github.client(async () => "secret-token");
    await assert.rejects(gh.request("https://evil.example/steal"), /non-GitHub URL/);
    await assert.rejects(gh.request("https://api.github.com.evil.example/x"), /non-GitHub URL/);
    await gh.json("/rate_limit");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.github.com/rate_limit");
  assert.ok(seen[0].signal instanceof AbortSignal);
});

test("database TLS is verified when a CA certificate is configured", () => {
  const remote = "postgresql://u:p@db.example.com:5432/postgres";
  assert.deepEqual(db.sslOption(remote, null), { rejectUnauthorized: false });
  assert.deepEqual(db.sslOption(remote, "PEM"), { ca: "PEM", rejectUnauthorized: true });
  assert.equal(db.sslOption(`${remote}?sslmode=verify-full`, "PEM"), undefined);
  assert.equal(db.sslOption("postgresql://u:p@localhost:5432/x", "PEM"), undefined);
});

test("startup flags a broken private key and a missing lookup token", () => {
  const { configWarnings } = require("../server");
  config.GITHUB_APP_PRIVATE_KEY = "not a key";
  const realToken = config.GITHUB_PUBLIC_TOKEN;
  config.GITHUB_PUBLIC_TOKEN = null;
  try {
    const w = configWarnings().join("\n");
    assert.match(w, /GITHUB_APP_PRIVATE_KEY/);
    assert.match(w, /GITHUB_PUBLIC_TOKEN/);
  } finally {
    config.GITHUB_PUBLIC_TOKEN = realToken;
  }
});
