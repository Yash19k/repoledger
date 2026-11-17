const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (see .env.example).");
}

const PORT = parseInt(process.env.PORT || "8600", 10);

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
  PORT,
  // The address people use to reach the site. Used for sign-in redirects and secure cookies.
  PUBLIC_URL: (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, ""),
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
};
