/**
 * Scheduled collector — runs for every account that installed the GitHub App.
 * Run standalone:  npm run collect
 */

const db = require("./db");
const log = require("./log");
const github = require("./github");
const { collectRepo } = require("./collect-repo");

function fromApi(inst) {
  return {
    id: inst.id,
    account_id: inst.account.id,
    account_login: inst.account.login,
    account_type: inst.account.type,
    suspended: !!inst.suspended_at,
  };
}

// Installations whose owner deleted their data while a collection was running.
const cancelled = new Set();
/** Stop any running collection for this installation and clean up whatever it writes afterwards. */
const cancel = (installationId) => cancelled.add(installationId);

/** Refresh one installation's repo list and collect stats for each repo. */
async function syncInstallation(inst) {
  const row = fromApi(inst);
  await db.upsertInstallation(row);
  if (row.suspended) {
    log.info(`Skipping suspended installation ${row.id} (${row.account_login})`);
    return;
  }

  const gh = github.installationClient(row.id);
  const repos = await gh.paginate("/installation/repositories?per_page=100", "repositories");
  const removed = await db.replaceInstallationRepos(
    row.id,
    repos.map((r) => ({ repo: r.full_name, private: r.private }))
  );
  if (removed.length) {
    log.info(`  ${removed.length} repo(s) removed from installation ${row.id}; deleting their stats`);
    await db.purgeRepos(removed);
  }

  log.info(`Installation ${row.id} (${row.account_login}): ${repos.length} repos`);
  for (const repo of repos) {
    if (cancelled.has(row.id)) break;
    try {
      await collectRepo(gh, repo, { traffic: true });
    } catch (e) {
      log.error(`Unexpected error collecting ${repo.full_name}: ${e.message}`);
    }
  }
  if (cancelled.has(row.id)) {
    // The owner deleted their data mid-run: remove anything this run wrote after that.
    cancelled.delete(row.id);
    await db.purgeRepos(repos.map((r) => r.full_name));
    return;
  }
  await db.markInstallationCollected(row.id);
}

async function collectInstallationById(installationId) {
  const inst = await github.appClient().json(`/app/installations/${installationId}`);
  await syncInstallation(inst);
}

async function run() {
  const installs = await github.appClient().paginate("/app/installations?per_page=100");
  log.info(`Found ${installs.length} installation(s)`);

  // Accounts that uninstalled the app: delete their data.
  const live = new Set(installs.map((i) => i.id));
  for (const id of await db.listInstallationIds()) {
    if (live.has(id)) continue;
    log.info(`Installation ${id} was removed; deleting its data`);
    const repos = await db.deleteInstallation(id);
    await db.purgeRepos(repos);
  }

  for (const inst of installs) {
    try {
      await syncInstallation(inst);
    } catch (e) {
      log.error(`Installation ${inst.id} (${inst.account?.login}) failed: ${e.message}`);
    }
  }
  log.info("Collection complete.");
}

module.exports = { run, collectInstallationById, syncInstallation, cancel };

if (require.main === module) {
  run()
    .catch((e) => {
      log.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => db.closePool());
}
