/**
 * Public username lookups: public repos only, no traffic.
 * Results are cached in the database and refreshed in the background when stale.
 */

const config = require("./config");
const db = require("./db");
const log = require("./log");
const github = require("./github");
const { collectRepo } = require("./collect-repo");

const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const MAX_CONCURRENT = 3;
const KEEP_RESULT_MS = 60 * 1000;
const MIN_RATE_BUDGET = 300;

const jobs = new Map(); // login -> { state, done, total, finishedAt, message }

const isValidLogin = (login) => typeof login === "string" && LOGIN_RE.test(login);

function status(login) {
  const key = login.toLowerCase();
  const job = jobs.get(key);
  if (job && job.state !== "running" && Date.now() - job.finishedAt > KEEP_RESULT_MS) {
    jobs.delete(key);
    return null;
  }
  return job || null;
}

const running = () => [...jobs.values()].filter((j) => j.state === "running").length;

function isStale(profile) {
  if (!profile || !profile.fetched_at) return true;
  return Date.now() - new Date(profile.fetched_at).getTime() > config.PUBLIC_CACHE_HOURS * 3600 * 1000;
}

async function refreshProfile(login, job) {
  if (github.publicRateRemaining() < MIN_RATE_BUDGET) {
    const e = new Error("busy");
    e.code = "busy";
    throw e;
  }
  const gh = github.publicClient();
  const user = await gh.json(`/users/${encodeURIComponent(login)}`);
  const all = await gh.paginate(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&per_page=100`, null, {
    maxPages: 5,
  });
  const repos = all.filter((r) => !r.fork && !r.private).slice(0, config.PUBLIC_MAX_REPOS);
  job.total = repos.length;

  const removed = await db.replaceProfile(user, repos);
  if (removed.length) await db.purgeRepos(removed);

  // A few repos at a time keeps lookups quick without hammering the API.
  let next = 0;
  async function worker() {
    while (next < repos.length) {
      const repo = repos[next++];
      try {
        await collectRepo(gh, repo, { traffic: false });
      } catch (e) {
        log.error(`Public lookup ${login}: ${repo.full_name} failed: ${e.message}`);
      }
      job.done++;
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  await db.markProfileFetched(user.login);
}

/** Start a background refresh. Returns false when too many are already running. */
function start(login) {
  const key = login.toLowerCase();
  if (status(key)?.state === "running") return true;
  if (running() >= MAX_CONCURRENT) return false;
  const job = { state: "running", done: 0, total: 0, finishedAt: 0, message: "" };
  jobs.set(key, job);
  refreshProfile(login, job)
    .then(() => {
      job.state = "done";
    })
    .catch(async (e) => {
      if (e.status === 404) {
        job.state = "not_found";
        await db.deleteProfile(key).then(db.purgeRepos).catch(() => {});
      } else {
        job.state = "error";
        job.message =
          e.code === "busy" || e.status === 403 || e.status === 429
            ? "GitHub's rate limit was reached. Try again in a few minutes."
            : "Couldn't reach GitHub. Try again shortly.";
        log.error(`Public lookup ${login} failed: ${e.message}`);
      }
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return true;
}

module.exports = { isValidLogin, status, start, isStale };
