/**
 * RepoLedger server.
 *   - Static frontend (./public)
 *   - GitHub sign-in (GitHub App user authorization) with server-side sessions
 *   - Owner API: traffic + stats for the signed-in user's installed repos
 *   - Public API: non-traffic stats for any GitHub username
 *
 *     npm start
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");
const config = require("./src/config");
const db = require("./src/db");
const github = require("./src/github");
const collector = require("./src/collector");
const lookup = require("./src/public-lookup");

const SESSION_COOKIE = "rl_session";
const STATE_COOKIE = "rl_oauth_state";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SECURE = config.PUBLIC_URL.startsWith("https://");
const PUBLIC_ORIGIN = new URL(config.PUBLIC_URL).origin;
const MANUAL_COLLECT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_LIMITER_KEYS = 100000;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cookie(name, value, { maxAge, path: p = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, "HttpOnly", "SameSite=Lax"];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  if (SECURE) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Wrap async handlers so rejected promises reach the error handler. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Rate-limit key for a client: its IPv4 address, or its IPv6 /56 network. One customer or VM usually gets a whole
 * IPv6 block, so keying by full address would let anyone dodge the limits by rotating addresses.
 */
function clientKey(ip = "") {
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) return ip.slice(7);
  if (!net.isIPv6(ip)) return ip;
  const [head, tail] = ip.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - left.length - right.length)).fill("0");
  const g = [...left, ...fill, ...right].map((x) => parseInt(x, 16) || 0);
  return `${g[0].toString(16)}:${g[1].toString(16)}:${g[2].toString(16)}:${(g[3] & 0xff00).toString(16)}::/56`;
}

/** Fixed-window limiter. Keys are client networks (see clientKey) unless the caller passes its own. */
function limiter(limit, windowMs) {
  const hits = new Map();
  function allow(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) {
      // Hard cap on memory: under a flood of new keys, forget the oldest window first.
      if (!e && hits.size >= MAX_LIMITER_KEYS) hits.delete(hits.keys().next().value);
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.count++;
    return e.count <= limit ? 0 : Math.ceil((e.reset - now) / 1000);
  }
  // Drop expired windows so memory stays bounded (clearing everything would reset every client's limit).
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, Math.min(windowMs, 5 * 60 * 1000)).unref();
  const middleware = (req, res, next) => {
    const retry = allow(clientKey(req.ip));
    if (!retry) return next();
    res.set("Retry-After", String(retry));
    res.status(429).json({ error: "Too many requests. Try again shortly." });
  };
  return { allow, middleware };
}

function securityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://avatars.githubusercontent.com",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self' https://github.com",
      "object-src 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (SECURE) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

/** API and sign-in responses hold private data: never let a browser or proxy cache store them. */
function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

/** Block state-changing requests that come from other sites. */
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin && origin !== PUBLIC_ORIGIN) return res.status(403).json({ error: "Cross-site request blocked." });
  if (!origin) {
    const ref = req.headers.referer;
    if (!ref || !ref.startsWith(`${PUBLIC_ORIGIN}/`)) {
      return res.status(403).json({ error: "Cross-site request blocked." });
    }
  }
  next();
}

const loadSession = ah(async (req, res, next) => {
  req.user = null;
  req.sessionHash = null;
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    req.sessionHash = sha256(token);
    try {
      req.user = await db.getSessionUser(req.sessionHash);
    } catch (e) {
      console.error("Session lookup failed:", e.message);
      return res.status(503).json({ error: "The database is unavailable. Try again shortly." });
    }
  }
  next();
});

function requireUser(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: "Sign in required." });
}

/** A real calendar date in YYYY-MM-DD form (rejects things like 2026-13-45). */
function isRealDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseRange(req, res) {
  const start = String(req.query.start);
  const end = String(req.query.end);
  if (!isRealDate(start) || !isRealDate(end)) {
    res.status(400).json({ error: "start and end must be valid YYYY-MM-DD dates." });
    return null;
  }
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * The repos asked for with ?repo=a&repo=b, limited to `allowed` (in `allowed`'s order). Only plain repeated keys
 * count; bracket forms like repo[x]=y are ignored rather than parsed into objects.
 */
const requestedRepos = (req, allowed) => {
  const requested = new URLSearchParams(req.originalUrl.split("?")[1] || "").getAll("repo");
  if (!requested.length) return allowed;
  const wanted = new Set(requested);
  return allowed.filter((r) => wanted.has(r));
};

// ---------------------------------------------------------------------------
// Charting library: 5 MB, so it's compressed once (in the background) instead of on every request
// ---------------------------------------------------------------------------

let plotly = null;
function plotlyBundle() {
  if (plotly) return plotly;
  const raw = fs.readFileSync(require.resolve("plotly.js-strict-dist-min/plotly-strict.min.js"));
  plotly = { raw, br: null, gzip: null, etag: `W/"${crypto.createHash("sha1").update(raw).digest("base64url")}"` };
  const brOpts = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } };
  zlib.brotliCompress(raw, brOpts, (err, buf) => (err ? console.warn("Brotli failed:", err.message) : (plotly.br = buf)));
  zlib.gzip(raw, { level: 9 }, (err, buf) => (err ? console.warn("Gzip failed:", err.message) : (plotly.gzip = buf)));
  return plotly;
}

function sendPlotly(req, res) {
  const p = plotlyBundle();
  res.set({
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
    ETag: p.etag,
    Vary: "Accept-Encoding",
  });
  let body = p.raw;
  if (p.br && req.acceptsEncodings("br") === "br") {
    body = p.br;
    res.set("Content-Encoding", "br");
  } else if (p.gzip && req.acceptsEncodings("gzip") === "gzip") {
    body = p.gzip;
    res.set("Content-Encoding", "gzip");
  }
  res.send(body); // answers 304 when the browser's copy is current
}

// ---------------------------------------------------------------------------
// Background collection for newly installed accounts
// ---------------------------------------------------------------------------

const collecting = new Set();
function kickCollection(installationId) {
  if (collecting.has(installationId)) return;
  collecting.add(installationId);
  collector
    .collectInstallationById(installationId)
    .catch((e) => console.error(`Collection for installation ${installationId} failed:`, e.message))
    .finally(() => collecting.delete(installationId));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(securityHeaders);
  // Responses are compressed on the fly at fast settings: a year of dashboard data is ~4 MB of JSON, and the default
  // levels cost 3-4x the CPU for a few percent smaller output. The charting library has its own pre-compressed copies.
  app.use(
    compression({
      threshold: 1024,
      level: 3,
      brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 3 } },
      filter: (req, res) => !req.path.startsWith("/vendor/") && compression.filter(req, res),
    })
  );
  app.use(express.json({ limit: "10kb" }));
  app.use(["/api", "/auth"], noStore);

  const authLimit = limiter(30, 60 * 1000);
  const apiLimit = limiter(config.RATE_LIMIT_API_PER_MIN, 60 * 1000);
  const lookupStarts = limiter(config.RATE_LIMIT_LOOKUPS_PER_HOUR, 60 * 60 * 1000); // new public lookups per network
  const collectKicks = limiter(1, 60 * 1000); // "Collect now" per user

  // ---- Health checks (for load balancers and uptime monitors) ----

  app.get("/healthz", (req, res) => res.set("Cache-Control", "no-store").json({ ok: true }));
  app.get(
    "/readyz",
    apiLimit.middleware,
    ah(async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        await db.ping();
        res.json({ ok: true, database: "up" });
      } catch {
        res.status(503).json({ ok: false, database: "down" });
      }
    })
  );

  // ---- Sign-in ----

  app.get("/auth/login", authLimit.middleware, (req, res) => {
    if (!github.isAppConfigured()) return res.redirect("/?error=not_configured");
    const state = crypto.randomBytes(16).toString("hex");
    res.append("Set-Cookie", cookie(STATE_COOKIE, state, { maxAge: 600, path: "/auth" }));
    res.redirect(github.authorizeUrl(state));
  });

  // GitHub sends people here after they install or change the app; sign them in to pick it up.
  app.get("/auth/installed", (req, res) => res.redirect("/auth/login"));

  app.get(
    "/auth/callback",
    authLimit.middleware,
    ah(async (req, res) => {
      const { code, state } = req.query;
      const expected = readCookie(req, STATE_COOKIE);
      res.append("Set-Cookie", cookie(STATE_COOKIE, "", { maxAge: 0, path: "/auth" }));
      if (req.query.error === "access_denied") return res.redirect("/?error=denied");
      if (!code || !state || !expected || !safeEqual(state, expected)) return res.redirect("/?error=state");

      let token = null;
      try {
        token = await github.exchangeOAuthCode(String(code));
        const gh = github.userClient(token);
        const me = await gh.json("/user");
        await db.upsertUser({ id: me.id, login: me.login, avatar_url: me.avatar_url });

        // Record this person's installations of the app (personal accounts only for now).
        const installs = await gh.paginate("/user/installations?per_page=100", "installations");
        for (const inst of installs) {
          if (inst.account.id !== me.id) continue;
          await db.upsertInstallation({
            id: inst.id,
            account_id: inst.account.id,
            account_login: inst.account.login,
            account_type: inst.account.type,
            suspended: !!inst.suspended_at,
          });
        }

        const sessionToken = crypto.randomBytes(32).toString("base64url");
        const expires = new Date(Date.now() + config.SESSION_DAYS * 86400 * 1000);
        await db.createSession(me.id, sha256(sessionToken), expires);
        // Signing in again replaces the old session instead of leaving it valid for its remaining 30 days.
        const previous = readCookie(req, SESSION_COOKIE);
        if (previous) await db.deleteSession(sha256(previous)).catch(() => {});
        res.append("Set-Cookie", cookie(SESSION_COOKIE, sessionToken, { maxAge: config.SESSION_DAYS * 86400 }));

        for (const inst of await db.installationsForUser(me.id)) {
          if (!inst.last_collected_at && !inst.suspended) kickCollection(inst.id);
        }
        res.redirect("/");
      } catch (e) {
        console.error("Sign-in failed:", e.message);
        res.redirect("/?error=signin");
      } finally {
        if (token) github.revokeUserToken(token).catch(() => {});
      }
    })
  );

  app.post(
    "/auth/logout",
    sameOrigin,
    loadSession,
    ah(async (req, res) => {
      if (req.sessionHash) await db.deleteSession(req.sessionHash);
      res.append("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
      res.json({ ok: true });
    })
  );

  // ---- Owner API ----

  app.use("/api", apiLimit.middleware);

  app.get(
    "/api/me",
    loadSession,
    requireUser,
    ah(async (req, res) => {
      const installs = await db.installationsForUser(req.user.id);
      const repos = await db.visibleReposForUser(req.user.id);
      res.json({
        user: { login: req.user.login, avatar_url: req.user.avatar_url },
        install_url: github.isAppConfigured() ? github.installUrl() : null,
        installations: installs.map((i) => ({
          id: i.id,
          account_login: i.account_login,
          suspended: i.suspended,
          repo_count: i.repo_count,
          last_collected_at: i.last_collected_at,
          manage_url: github.manageUrl(i.id),
        })),
        repo_count: repos.length,
        has_data: repos.length ? await db.hasDataForUser(req.user.id) : false,
        collecting: installs.some((i) => collecting.has(i.id)),
      });
    })
  );

  app.get(
    "/api/repos",
    loadSession,
    requireUser,
    ah(async (req, res) => res.json(await db.visibleReposForUser(req.user.id)))
  );

  app.get(
    "/api/data",
    loadSession,
    requireUser,
    ah(async (req, res) => {
      const range = parseRange(req, res);
      if (!range) return;
      const repos = requestedRepos(req, await db.visibleReposForUser(req.user.id));
      const { start, end } = range;
      const [views, clones, commits, issues, stars, referrers, paths, contributors] = await Promise.all([
        db.getViews(repos, start, end),
        db.getClones(repos, start, end),
        db.getCommitActivity(repos, start, end),
        db.getIssuePrStats(repos, start, end),
        db.getStarStats(repos, start, end),
        db.getReferrers(repos),
        db.getPopularPaths(repos),
        db.getContributors(repos),
      ]);
      res.json({ views, clones, commits, issues, stars, referrers, paths, contributors });
    })
  );

  app.post(
    "/api/collect",
    sameOrigin,
    loadSession,
    requireUser,
    ah(async (req, res) => {
      const installs = (await db.installationsForUser(req.user.id)).filter((i) => !i.suspended);
      if (!installs.length) return res.status(400).json({ error: "Install the app on GitHub first." });
      const recent = installs.find(
        (i) => i.last_collected_at && Date.now() - new Date(i.last_collected_at).getTime() < MANUAL_COLLECT_COOLDOWN_MS
      );
      if (recent && !installs.some((i) => collecting.has(i.id))) {
        return res.status(429).json({ error: "Your data was collected in the last 10 minutes. Try again later." });
      }
      // Even when collections keep failing (so there's no "last collected" time), don't let anyone restart them
      // in a loop: each start spends the app's shared GitHub rate limit.
      const wait = collectKicks.allow(`user:${req.user.id}`);
      if (wait) {
        res.set("Retry-After", String(wait));
        return res.status(429).json({ error: "A collection was started a moment ago. Try again in a minute." });
      }
      installs.forEach((i) => kickCollection(i.id));
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/account/delete",
    sameOrigin,
    loadSession,
    requireUser,
    ah(async (req, res) => {
      const installs = await db.installationsForUser(req.user.id);
      // Uninstall first: if this fails we must not delete data that the next collection would re-create.
      for (const inst of installs) {
        try {
          await github.uninstall(inst.id);
        } catch (e) {
          if (!(e instanceof github.GithubError && e.status === 404)) {
            console.error(`Uninstall of ${inst.id} failed:`, e.message);
            return res.status(502).json({
              error: "GitHub didn't confirm the uninstall. Remove the app from your GitHub settings, then try again.",
              manage_url: github.manageUrl(inst.id),
            });
          }
        }
      }
      for (const inst of installs) {
        if (collecting.has(inst.id)) collector.cancel(inst.id);
        await db.purgeRepos(await db.deleteInstallation(inst.id));
      }
      await db.deleteUser(req.user.id); // also removes sessions
      res.append("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
      res.json({ ok: true });
    })
  );

  // ---- Public API (no sign-in, never returns traffic) ----

  app.get(
    "/api/public/:login",
    ah(async (req, res) => {
      const { login } = req.params;
      if (!lookup.isValidLogin(login)) return res.status(400).json({ status: "invalid", error: "That isn't a valid GitHub username." });

      let profile = await db.getProfile(login);
      let job = lookup.status(login);
      const cached = profile && profile.fetched_at;

      if (lookup.isStale(profile) && job?.state !== "running") {
        if (job?.state === "not_found") return res.status(404).json({ status: "not_found" });
        if (job?.state === "error" && !cached) return res.status(502).json({ status: "error", error: job.message });
        if (!job) {
          if (!lookup.hasCapacity()) {
            // Checked before the per-network allowance, so waiting for a free slot doesn't use it up.
            if (!cached) {
              res.set("Retry-After", "5");
              return res.status(503).json({ status: "busy", error: "Lots of lookups right now. Waiting for a free slot…" });
            }
          } else if (lookupStarts.allow(clientKey(req.ip)) === 0) {
            lookup.start(login);
          } else if (!cached) {
            return res.status(429).json({ status: "limited", error: "Too many lookups from your network. Try again later." });
          }
        }
        job = lookup.status(login);
        profile = await db.getProfile(login);
      }

      const publicProfile = profile && {
        login: profile.display_login,
        name: profile.name,
        avatar_url: profile.avatar_url,
        html_url: profile.html_url,
        type: profile.account_type,
        public_repos: profile.public_repos,
        fetched_at: profile.fetched_at,
      };

      if (job?.state === "running") {
        return res.json({ status: "refreshing", progress: { done: job.done, total: job.total }, profile: publicProfile });
      }
      if (!profile || !profile.fetched_at) return res.status(404).json({ status: "not_found" });

      await db.touchProfile(login).catch(() => {});
      res.json({ status: "ready", profile: publicProfile, repos: await db.profileRepos(login) });
    })
  );

  app.get(
    "/api/public/:login/data",
    ah(async (req, res) => {
      const { login } = req.params;
      if (!lookup.isValidLogin(login)) return res.status(400).json({ error: "Invalid username." });
      const range = parseRange(req, res);
      if (!range) return;
      const allowed = (await db.profileRepos(login)).map((r) => r.repo);
      const repos = requestedRepos(req, allowed);
      const { start, end } = range;
      const [commits, issues, stars, contributors] = await Promise.all([
        db.getCommitActivity(repos, start, end),
        db.getIssuePrStats(repos, start, end),
        db.getStarStats(repos, start, end),
        db.getContributors(repos),
      ]);
      res.json({ commits, issues, stars, contributors });
    })
  );

  app.get("/api/config", (req, res) =>
    res.json({ app_name: config.APP_NAME, source_url: config.SOURCE_URL || null, sign_in: github.isAppConfigured() })
  );

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  // ---- Static frontend ----

  // File names aren't versioned, so browsers revalidate (cheap 304s) instead of keeping stale copies.
  const revalidate = (res) => res.setHeader("Cache-Control", "no-cache");
  plotlyBundle();
  app.get("/vendor/plotly.min.js", sendPlotly);
  app.use(express.static(path.join(__dirname, "public"), { index: "index.html", setHeaders: revalidate }));
  const page = (file) => (req, res) =>
    res.sendFile(path.join(__dirname, "public", file), { headers: { "Cache-Control": "no-cache" } });
  app.get(/^\/u\/[^/]+\/?$/, page("index.html"));
  app.get(/^\/how-it-works\/?$/, page("how-it-works.html"));
  app.get(/^\/deploy\/?$/, page("deploy.html"));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Malformed or oversized request bodies are the client's mistake, not a server error.
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
      return res.status(err.status || 400).json({ error: "Invalid request body." });
    }
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}

/** Problems worth flagging at startup instead of at the first failed sign-in. */
function configWarnings() {
  const warnings = [];
  if (process.env.NODE_ENV === "production" && !SECURE) {
    warnings.push("PUBLIC_URL isn't https://. In production, cookies must be Secure: set PUBLIC_URL to your https address.");
  }
  if (config.GITHUB_APP_PRIVATE_KEY) {
    try {
      crypto.createPrivateKey(config.GITHUB_APP_PRIVATE_KEY);
    } catch {
      warnings.push("GITHUB_APP_PRIVATE_KEY isn't a valid PEM private key. Sign-in and collection will fail.");
    }
  }
  if (!config.GITHUB_PUBLIC_TOKEN) {
    warnings.push("GITHUB_PUBLIC_TOKEN isn't set. GitHub allows 60 lookup requests an hour without it: about one small lookup.");
  }
  return warnings;
}

/** Hourly housekeeping: expired sessions and cached lookups nobody opens any more. */
async function maintenance() {
  try {
    await db.deleteExpiredSessions();
    const pruned = await db.pruneProfiles(config.PUBLIC_PROFILE_TTL_DAYS, lookup.runningLogins(), config.PUBLIC_MAX_PROFILES);
    if (pruned) console.log(`Deleted ${pruned} old cached lookup(s).`);
  } catch (e) {
    console.warn("Maintenance failed:", e.message);
  }
}

module.exports = { createApp, clientKey, configWarnings, maintenance };

if (require.main === module) {
  maintenance();
  setInterval(maintenance, 3600 * 1000).unref();

  const server = createApp().listen(config.PORT, () => {
    console.log(`\n  ${config.APP_NAME} is running.\n`);
    console.log(`  Local URL: http://localhost:${config.PORT}`);
    if (!github.isAppConfigured()) {
      console.log("\n  GitHub sign-in is not set up yet. Run `npm run create-app` to create the GitHub App.");
    }
    for (const w of configWarnings()) console.warn(`\n  Warning: ${w}`);
    console.log("");
  });
  // Outlive load balancers' idle timeouts (60 s on AWS ALB), so they never reuse a connection Node just closed.
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;

  // Hosts send SIGTERM before replacing an instance: finish in-flight requests, then close the database pool.
  const shutdown = (signal) => {
    console.log(`${signal} received: shutting down.`);
    server.close(() => db.closePool().finally(() => process.exit(0)));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10 * 1000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
