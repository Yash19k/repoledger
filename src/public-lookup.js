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
const KEEP_RESULT_MS = 60 * 1000;
// Requests always kept back for sign-ins and other lookups: 10% of the hourly limit, at most 300.
const MAX_RESERVE = 300;

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

const runningLogins = () => [...jobs].filter(([, j]) => j.state === "running").map(([login]) => login);
const running = () => runningLogins().length;
/** True when another lookup may start now. */
const hasCapacity = () => running() < config.PUBLIC_LOOKUP_CONCURRENCY;

// Finished jobs are normally dropped when someone asks for them again; sweep the ones nobody asked about.
setInterval(() => {
  for (const login of [...jobs.keys()]) status(login);
}, KEEP_RESULT_MS).unref();

function isStale(profile) {
  if (!profile || !profile.fetched_at) return true;
  return Date.now() - new Date(profile.fetched_at).getTime() > config.PUBLIC_CACHE_HOURS * 3600 * 1000;
}

/** True when the shared GitHub budget is down to its reserve. */
function budgetLow() {
  const limit = github.publicRateLimit();
  const reserve = limit ? Math.min(MAX_RESERVE, Math.ceil(limit * 0.1)) : MAX_RESERVE;
  return github.publicRateRemaining() < reserve;
}

function busyError() {
  const e = new Error("busy");
  e.code = "busy";
  return e;
}

async function refreshProfile(login, job) {
  if (budgetLow()) throw busyError();
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
  // Stop as soon as the budget runs low: one big account mustn't use up everyone else's lookups.
  let next = 0;
  let outOfBudget = false;
  async function worker() {
    while (next < repos.length && !outOfBudget) {
      if (budgetLow()) {
        outOfBudget = true;
        break;
      }
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
  if (outOfBudget) throw busyError();
  await db.markProfileFetched(user.login);
}

/** Start a background refresh. Returns false when too many are already running. */
function start(login) {
  const key = login.toLowerCase();
  if (status(key)?.state === "running") return true;
  if (!hasCapacity()) return false;
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

module.exports = { isValidLogin, status, start, isStale, hasCapacity, runningLogins, budgetLow };
