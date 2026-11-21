/**
 * RepoLedger server.
 *   - Static frontend (./public)
 *   - GitHub sign-in (GitHub App user authorization) with server-side sessions
 *   - Owner API: traffic + stats for the signed-in user's installed repos
 *   - Public API: non-traffic stats for any GitHub username
 *
 *     npm start
 */

const path = require("path");
const crypto = require("crypto");
const express = require("express");
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

/** Fixed-window limiter keyed by client IP. */
function limiter(limit, windowMs) {
  const hits = new Map();
  function allow(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) {
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
    const retry = allow(req.ip);
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
  });
  if (SECURE) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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

const requestedRepos = (req, allowed) => {
  const requested = [].concat(req.query.repo || []).map(String);
  return requested.length ? requested.filter((r) => allowed.includes(r)) : allowed;
};

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
  if (SECURE) app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: "10kb" }));

  const authLimit = limiter(30, 60 * 1000);
  const apiLimit = limiter(240, 60 * 1000);
  const lookupStarts = limiter(20, 60 * 60 * 1000); // new public lookups per IP per hour

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
      const [views, clones, commits, issues, stars, referrers, contributors] = await Promise.all([
        db.getViews(repos, start, end),
        db.getClones(repos, start, end),
        db.getCommitActivity(repos, start, end),
        db.getIssuePrStats(repos, start, end),
        db.getStarStats(repos, start, end),
        db.getReferrers(repos),
        db.getContributors(repos),
      ]);
      res.json({ views, clones, commits, issues, stars, referrers, contributors });
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
          const retryAfter = lookupStarts.allow(req.ip); // 0 = allowed
          if (retryAfter === 0) {
            if (!lookup.start(login) && !cached) {
              return res.status(503).json({ status: "busy", error: "Lots of lookups right now. Try again in a minute." });
            }
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

  app.get("/vendor/plotly.min.js", (req, res) => {
    res.sendFile(require.resolve("plotly.js-strict-dist-min/plotly-strict.min.js"));
  });
  app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
  app.get(/^\/u\/[^/]+\/?$/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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

module.exports = { createApp };

if (require.main === module) {
  const cleanup = () => db.deleteExpiredSessions().catch(() => {});
  cleanup();
  setInterval(cleanup, 6 * 3600 * 1000).unref();

  createApp().listen(config.PORT, () => {
    console.log(`\n  ${config.APP_NAME} is running.\n`);
    console.log(`  Local URL: http://localhost:${config.PORT}`);
    if (!github.isAppConfigured()) {
      console.log("\n  GitHub sign-in is not set up yet. Run `npm run create-app` to create the GitHub App.");
    }
    console.log("");
  });
}
