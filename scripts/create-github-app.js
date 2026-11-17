/**
 * Creates the RepoLedger GitHub App on your account with the right (read-only) permissions,
 * then saves its credentials into .env.
 *
 *     npm run create-app
 *
 * Uses GitHub's "app manifest" flow: a local page sends GitHub a pre-filled app definition,
 * you confirm the name on github.com, and GitHub hands back the app's id, secrets and key.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");
const config = require("../src/config");

const SETUP_PORT = 8601;
const ENV_PATH = path.join(__dirname, "..", ".env");
const state = crypto.randomBytes(16).toString("hex");
const base = config.PUBLIC_URL;

const manifest = {
  name: config.APP_NAME,
  url: base,
  description: "Keeps your GitHub traffic (views, clones, referrers) past GitHub's 14-day limit. Read-only.",
  public: true,
  redirect_url: `http://localhost:${SETUP_PORT}/created`,
  callback_urls: [`${base}/auth/callback`],
  setup_url: `${base}/auth/installed`,
  setup_on_update: true,
  request_oauth_on_install: false,
  hook_attributes: { url: `${base}/github/webhook`, active: false },
  default_events: [],
  // Read-only. "administration: read" is what GitHub requires for traffic data.
  // No "contents" permission, so the app can never read code.
  default_permissions: {
    administration: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
  },
};

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function startPage() {
  return `<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<body style="font:16px system-ui;max-width:560px;margin:80px auto;padding:0 16px">
<h1 style="font-weight:600">Create the ${escapeHtml(config.APP_NAME)} GitHub App</h1>
<p>GitHub will open with every setting filled in. Check the name, then click <b>Create GitHub App</b>.</p>
<ul>
  <li>Homepage: <code>${escapeHtml(base)}</code></li>
  <li>Permissions: Administration, Issues, Pull requests and Metadata, all <b>read-only</b></li>
  <li>No access to repository contents (code)</li>
</ul>
<form action="https://github.com/settings/apps/new?state=${state}" method="post">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <button style="font:inherit;padding:10px 18px;cursor:pointer">Continue to GitHub</button>
</form></body>`;
}

/** Set KEY=value lines in .env, replacing existing keys and appending new ones. */
function writeEnv(values) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  for (const [key, raw] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(String(raw))}`; // double-quoted; dotenv turns \n back into newlines
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${SETUP_PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(startPage());
  }

  if (url.pathname === "/created") {
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || !code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("State mismatch. Run `npm run create-app` again.");
    }
    try {
      const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "User-Agent": config.APP_NAME },
      });
      const app = await r.json();
      if (!r.ok) throw new Error(app.message || `GitHub returned ${r.status}`);

      writeEnv({
        GITHUB_APP_ID: app.id,
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_CLIENT_ID: app.client_id,
        GITHUB_APP_CLIENT_SECRET: app.client_secret,
        GITHUB_APP_PRIVATE_KEY: app.pem,
      });

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<body style="font:16px system-ui;max-width:560px;margin:80px auto;padding:0 16px">
        <h1 style="font-weight:600">Done</h1>
        <p><b>${escapeHtml(app.name)}</b> was created and its credentials were saved to <code>.env</code>.</p>
        <p>You can close this tab. Restart the server with <code>npm start</code>.</p></body>`);
      console.log(`\n  Created GitHub App "${app.name}" (${app.html_url}).`);
      console.log("  Saved GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY to .env.");
      console.log("  Keep .env private: the private key and client secret control the app.\n");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Could not finish setup: ${e.message}`);
      console.error("  Setup failed:", e.message);
      process.exitCode = 1;
    }
    setTimeout(() => server.close(), 500);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(SETUP_PORT, () => {
  const start = `http://localhost:${SETUP_PORT}/`;
  console.log(`\n  Open ${start} to create the GitHub App (opening it for you now).`);
  console.log(`  Public URL used for sign-in: ${base}\n`);
  const opener = process.platform === "win32" ? `start "" "${start}"` : process.platform === "darwin" ? `open "${start}"` : `xdg-open "${start}"`;
  exec(opener, () => {});
});
