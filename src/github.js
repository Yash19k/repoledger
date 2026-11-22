/**
 * GitHub REST client plus GitHub App authentication.
 *
 * - App JWT (signed with the app's private key) -> short-lived installation tokens for collection.
 * - User sign-in via the app's OAuth flow; the user token is used once and then revoked.
 * - Public lookups use an optional no-scope token (GITHUB_PUBLIC_TOKEN).
 */

const crypto = require("crypto");
const config = require("./config");

const API = "https://api.github.com";

class GithubError extends Error {
  constructor(status, body, url) {
    super(`${status} ${String(body).slice(0, 300)}`);
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAppConfigured() {
  return !!(
    config.GITHUB_APP_ID &&
    config.GITHUB_APP_PRIVATE_KEY &&
    config.GITHUB_APP_CLIENT_ID &&
    config.GITHUB_APP_CLIENT_SECRET &&
    config.GITHUB_APP_SLUG
  );
}

function requireAppKey() {
  const missing = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"].filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`GitHub App is not configured: set ${missing.join(", ")} (run \`npm run create-app\`).`);
  }
}

/** JWT that authenticates as the GitHub App itself (valid ~9 minutes). */
function appJwt(now = Math.floor(Date.now() / 1000)) {
  requireAppKey();
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iat: now - 60,
    exp: now + 540,
    iss: String(config.GITHUB_APP_ID),
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), config.GITHUB_APP_PRIVATE_KEY);
  return `${unsigned}.${signature.toString("base64url")}`;
}

function parseLink(header) {
  const links = {};
  for (const part of (header || "").split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) links[m[2]] = m[1];
  }
  return links;
}

/** Abort a request that takes too long, so a stuck connection can't hang a lookup, a sign-in or a collection. */
const timeoutSignal = () => AbortSignal.timeout(config.GITHUB_TIMEOUT_MS);

/**
 * A REST client. `getToken` returns the bearer token (or null for anonymous requests).
 * `onRateLimit({ remaining, limit, reset })` receives GitHub's rate-limit headers after each call.
 */
function client(getToken, { onRateLimit } = {}) {
  async function request(pathOrUrl, { method = "GET", body, accept } = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
    // Pagination follows URLs from GitHub's Link header. Never send a token anywhere but the API.
    if (!url.startsWith(`${API}/`)) throw new Error(`Refusing to call a non-GitHub URL: ${url}`);
    const token = await getToken();
    const res = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: accept || "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `${config.APP_NAME}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutSignal(),
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (onRateLimit && remaining != null) {
      onRateLimit({
        remaining: Number(remaining),
        limit: Number(res.headers.get("x-ratelimit-limit")) || null,
        reset: Number(res.headers.get("x-ratelimit-reset")) || null,
      });
    }
    if (!res.ok) throw new GithubError(res.status, await res.text(), url);
    return res;
  }

  /** GET JSON. Statistics endpoints answer 202 while GitHub computes them; retry a few times. */
  async function json(path, opts = {}) {
    const attempts = opts.retry202 ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      const res = await request(path, opts);
      if (res.status === 202) {
        if (i < attempts - 1) await sleep(2000);
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    return null;
  }

  async function paginate(path, key, opts = {}) {
    const items = [];
    let url = path;
    let pages = 0;
    while (url) {
      const res = await request(url, opts);
      const data = await res.json();
      items.push(...(key ? data[key] : data));
      url = parseLink(res.headers.get("link")).next || null;
      if (opts.maxPages && ++pages >= opts.maxPages) break;
    }
    return items;
  }

  async function totalCount(path) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await request(`${path}${sep}per_page=1`);
    const data = await res.json();
    const last = parseLink(res.headers.get("link")).last;
    if (!last) return data.length;
    return parseInt(new URL(last).searchParams.get("page"), 10);
  }

  return { request, json, paginate, totalCount };
}

// ---- App & installation clients ----

const appClient = () => client(async () => appJwt());

const tokenCache = new Map(); // installationId -> { token, expiresAt }

async function installationToken(installationId) {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
  const data = await appClient().json(`/app/installations/${installationId}/access_tokens`, { method: "POST" });
  tokenCache.set(installationId, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
  return data.token;
}

const installationClient = (installationId) => client(() => installationToken(installationId));

async function uninstall(installationId) {
  await appClient().request(`/app/installations/${installationId}`, { method: "DELETE" });
  tokenCache.delete(installationId);
}

// ---- Public lookups ----

// The public lookup budget, from GitHub's headers. `reset` is when GitHub refills it (unix seconds).
const publicRate = { remaining: Infinity, limit: null, reset: null };
const publicClient = () =>
  client(async () => config.GITHUB_PUBLIC_TOKEN, {
    onRateLimit: ({ remaining, limit, reset }) => Object.assign(publicRate, { remaining, limit, reset }),
  });

/** Requests left in the current window. Once GitHub's reset time passes, the budget is full again. */
function publicRateRemaining(now = Date.now()) {
  if (publicRate.reset && now >= publicRate.reset * 1000) return publicRate.limit || Infinity;
  return publicRate.remaining;
}
/** The hourly limit (60 without a token, 5,000 with one), or null before the first request. */
const publicRateLimit = () => publicRate.limit;
/** Test hook. */
const resetPublicRate = (value = { remaining: Infinity, limit: null, reset: null }) => Object.assign(publicRate, value);

// ---- User sign-in ----

const callbackUrl = () => `${config.PUBLIC_URL}/auth/callback`;

function authorizeUrl(state) {
  const qs = new URLSearchParams({
    client_id: config.GITHUB_APP_CLIENT_ID,
    redirect_uri: callbackUrl(),
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${qs}`;
}

async function exchangeOAuthCode(code) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": config.APP_NAME },
    body: JSON.stringify({
      client_id: config.GITHUB_APP_CLIENT_ID,
      client_secret: config.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(),
    }),
    signal: timeoutSignal(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new GithubError(res.status, data.error_description || data.error || "OAuth exchange failed");
  }
  return data.access_token;
}

const userClient = (token) => client(async () => token);

/** Invalidate a user token as soon as we're done with it. */
async function revokeUserToken(token) {
  const basic = Buffer.from(`${config.GITHUB_APP_CLIENT_ID}:${config.GITHUB_APP_CLIENT_SECRET}`).toString("base64");
  await fetch(`${API}/applications/${config.GITHUB_APP_CLIENT_ID}/token`, {
    method: "DELETE",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": config.APP_NAME,
    },
    body: JSON.stringify({ access_token: token }),
    signal: timeoutSignal(),
  });
}

const installUrl = () => `https://github.com/apps/${config.GITHUB_APP_SLUG}/installations/new`;
const manageUrl = (installationId) => `https://github.com/settings/installations/${installationId}`;

module.exports = {
  GithubError,
  isAppConfigured,
  appJwt,
  client,
  appClient,
  installationClient,
  installationToken,
  uninstall,
  publicClient,
  publicRateRemaining,
  publicRateLimit,
  resetPublicRate,
  authorizeUrl,
  exchangeOAuthCode,
  userClient,
  revokeUserToken,
  installUrl,
  manageUrl,
};
