/**
 * Collects stats for one repository and stores them.
 * Traffic (views, clones, referrers, paths) needs an installation token, so it only runs when `traffic` is set.
 */

const config = require("./config");
const db = require("./db");
const log = require("./log");
const { GithubError } = require("./github");

/** Today's date in UTC, matching the dates GitHub uses for traffic and weekly stats. */
const localDate = (d = new Date()) => d.toISOString().slice(0, 10);

const weekToDate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** Runs one step; GitHub API errors are logged and skipped, anything else propagates. */
async function step(label, fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof GithubError) log.warning(`  ${label} failed: ${e.message}`);
    else throw e;
  }
}

/** Rebuild star history from stargazer timestamps (only the first time we see a repo). */
async function backfillStars(gh, repo) {
  const name = repo.full_name;
  if (!repo.stargazers_count || repo.stargazers_count > config.STAR_HISTORY_MAX) return;
  if (await db.hasStarHistory(name)) return;
  const stargazers = await gh.paginate(`/repos/${name}/stargazers?per_page=100`, null, {
    accept: "application/vnd.github.star+json",
    maxPages: Math.ceil(config.STAR_HISTORY_MAX / 100),
  });
  const perDay = new Map();
  for (const s of stargazers) {
    if (!s.starred_at) continue;
    const d = s.starred_at.slice(0, 10);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  let total = 0;
  const rows = [...perDay.keys()].sort().map((date) => {
    total += perDay.get(date);
    return { date, stars: total };
  });
  await db.insertStarHistory(name, rows);
  log.info(`  star history: ${rows.length} days`);
}

async function collectRepo(gh, repo, { traffic = false } = {}) {
  const name = repo.full_name;
  const base = `/repos/${name}`;
  log.info(`Collecting ${name}${traffic ? "" : " (public)"}`);

  if (traffic) {
    await step("views", async () => {
      const t = await gh.json(`${base}/traffic/views?per=day`);
      const rows = (t?.views || []).map((v) => ({ date: v.timestamp.slice(0, 10), total: v.count, uniques: v.uniques }));
      await db.upsertViews(name, rows);
      log.info(`  views: ${rows.length} rows`);
    });

    await step("clones", async () => {
      const t = await gh.json(`${base}/traffic/clones?per=day`);
      const rows = (t?.clones || []).map((c) => ({ date: c.timestamp.slice(0, 10), total: c.count, uniques: c.uniques }));
      await db.upsertClones(name, rows);
      log.info(`  clones: ${rows.length} rows`);
    });

    await step("referrers", async () => {
      const list = (await gh.json(`${base}/traffic/popular/referrers`)) || [];
      const rows = list.map((r) => ({ referrer: r.referrer, total: r.count, uniques: r.uniques }));
      await db.upsertReferrers(name, rows);
      log.info(`  referrers: ${rows.length} rows`);
    });

    await step("popular paths", async () => {
      const list = (await gh.json(`${base}/traffic/popular/paths`)) || [];
      const rows = list.map((p) => ({ path: p.path, total: p.count, uniques: p.uniques }));
      await db.upsertPopularPaths(name, rows);
      log.info(`  popular paths: ${rows.length} rows`);
    });
  }

  await step("commit activity", async () => {
    const activity = await gh.json(`${base}/stats/commit_activity`, { retry202: true });
    if (!activity || !activity.length) return;
    const rows = activity.map((w) => ({ week_start: weekToDate(w.week), total: w.total, additions: 0, deletions: 0 }));
    try {
      const freq = await gh.json(`${base}/stats/code_frequency`, { retry202: true });
      if (Array.isArray(freq) && freq.length) {
        const byWeek = new Map(freq.map(([week, add, del]) => [weekToDate(week), { add, del }]));
        for (const row of rows) {
          const f = byWeek.get(row.week_start);
          if (f) {
            row.additions = f.add;
            row.deletions = Math.abs(f.del);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof GithubError)) throw e;
    }
    await db.upsertCommitActivity(name, rows);
    log.info(`  commit activity: ${rows.length} rows`);
  });

  await step("contributors", async () => {
    const contribs = await gh.json(`${base}/stats/contributors`, { retry202: true });
    if (!Array.isArray(contribs) || !contribs.length) return;
    const rows = contribs.map((c) => ({ author: c.author ? c.author.login : "unknown", total: c.total }));
    await db.upsertContributors(name, rows);
    log.info(`  contributors: ${rows.length} rows`);
  });

  await step("star history", () => backfillStars(gh, repo));

  await step("stars", async () => {
    await db.upsertStarStats(name, localDate(), repo.stargazers_count);
    log.info(`  stars: ${repo.stargazers_count}`);
  });

  await step("issues/PRs", async () => {
    // GitHub's issue counts include pull requests, so subtract the PRs to get real issues.
    const openPrs = await gh.totalCount(`${base}/pulls?state=open`);
    const closedPrs = await gh.totalCount(`${base}/pulls?state=closed`);
    const closedIssuesAndPrs = await gh.totalCount(`${base}/issues?state=closed`);
    const openIssues = Math.max(0, (repo.open_issues_count || 0) - openPrs);
    const closedIssues = Math.max(0, closedIssuesAndPrs - closedPrs);
    // Stored in the merged_prs column: closed PRs (merged or not). GitHub has no cheap merged-only count.
    await db.upsertIssuePrStats(name, localDate(), openIssues, closedIssues, openPrs, closedPrs);
    log.info("  issues/PRs: done");
  });
}

module.exports = { collectRepo, localDate };
