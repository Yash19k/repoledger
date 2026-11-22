const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (see .env.example).");
}

const PORT = parseInt(process.env.PORT || "8600", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

/** A positive integer from the environment, or the default when unset or invalid. */
function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Express "trust proxy" setting: how many proxies sit in front of the app.
 * Unset: one proxy when PUBLIC_URL is https (Render, Railway, Fly, a load balancer), none otherwise.
 * Getting this wrong either lets clients fake their IP (too high) or puts everyone in one rate-limit bucket (too low).
 */
function trustProxy(raw) {
  if (raw == null || raw === "") return PUBLIC_URL.startsWith("https://") ? 1 : false;
  if (/^(false|no|off)$/i.test(raw)) return false;
  if (/^(true|yes|on)$/i.test(raw)) return true;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw; // a list of trusted addresses or subnets, e.g. "loopback, 10.0.0.0/8"
}

/** CA certificate for verified database TLS: inline PEM or a file path. */
function readDatabaseCa() {
  const v = process.env.DATABASE_SSL_CA;
  if (!v) return null;
  return v.includes("-----BEGIN") ? v.replace(/\\n/g, "\n") : fs.readFileSync(v, "utf8");
}

function readPrivateKey() {
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    // Hosting dashboards often store multi-line values with literal "\n".
    return process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  }
  return null;
}

module.exports = {
  APP_NAME: "RepoLedger",

  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_SSL_CA: readDatabaseCa(),
  PG_POOL_MAX: intEnv("PG_POOL_MAX", 10),
  PORT,
  // The address people use to reach the site. Used for sign-in redirects and secure cookies.
  PUBLIC_URL,
  TRUST_PROXY: trustProxy(process.env.TRUST_PROXY),
  // Optional link to the source code, shown on the landing page.
  SOURCE_URL: process.env.SOURCE_URL || "",

  // GitHub App (created with `npm run create-app`).
  GITHUB_APP_ID: process.env.GITHUB_APP_ID || null,
  GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG || null,
  GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID || null,
  GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET || null,
  GITHUB_APP_PRIVATE_KEY: readPrivateKey(),

  // Token for public username lookups (no scopes needed). Without one, GitHub allows only 60 requests/hour.
  GITHUB_PUBLIC_TOKEN: process.env.GITHUB_PUBLIC_TOKEN || process.env.GH_TOKEN || null,

  SESSION_DAYS: 30,
  PUBLIC_CACHE_HOURS: 6,
  PUBLIC_MAX_REPOS: 60,
  STAR_HISTORY_MAX: 2000,
  // Cached lookups nobody has opened for this many days are deleted, so the database doesn't grow forever.
  PUBLIC_PROFILE_TTL_DAYS: intEnv("PUBLIC_PROFILE_TTL_DAYS", 30),
  // At most this many cached lookups (least recently opened go first). Each takes roughly 0.2-0.7 MB, so the
  // default keeps lookups under ~140 MB, leaving most of a free 500 MB database for owners' traffic.
  PUBLIC_MAX_PROFILES: intEnv("PUBLIC_MAX_PROFILES", 200),
  // Lookups that may run at once. Each one makes many GitHub requests, so keep this small.
  PUBLIC_LOOKUP_CONCURRENCY: intEnv("PUBLIC_LOOKUP_CONCURRENCY", 3),

  // Per-IP limits. Generous enough for a classroom sharing one network address.
  RATE_LIMIT_API_PER_MIN: intEnv("RATE_LIMIT_API_PER_MIN", 600),
  RATE_LIMIT_LOOKUPS_PER_HOUR: intEnv("RATE_LIMIT_LOOKUPS_PER_HOUR", 30),

  // Installations collected in parallel. Each installation has its own GitHub rate limit.
  COLLECT_CONCURRENCY: intEnv("COLLECT_CONCURRENCY", 4),
  // Give up on a GitHub request after this long, so one stuck connection can't hang a lookup or a sign-in.
  GITHUB_TIMEOUT_MS: intEnv("GITHUB_TIMEOUT_MS", 20000),
};
