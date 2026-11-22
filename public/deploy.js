/* RepoLedger deploy guide: live values, database/OS switches, per-step progress and copy buttons. */
(() => {
  "use strict";

  const KEY = "rl-deploy-guide";
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const all = (sel) => Array.from(document.querySelectorAll(sel));

  let state = {};
  try {
    state = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    state = {};
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private window or storage blocked: the page still works, it just won't remember */
    }
  };

  // ---- Your values: every <span class="v" data-v="..."> follows the inputs ----

  const DEFAULTS = {
    ip: "13.233.10.20",
    account: "123456789012",
    region: "ap-south-1",
    repo: "https://github.com/your-name/repoledger.git",
  };
  const inputs = {
    ip: $("val-ip"),
    endpoint: $("val-endpoint"),
    account: $("val-account"),
    region: $("val-region"),
    repo: $("val-repo"),
  };

  const validIp = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split(".").every((n) => Number(n) <= 255);
  const validRegion = (s) => /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(s);
  const validRepo = (s) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(s);

  function values() {
    const raw = (k) => inputs[k].value.trim();
    const ip = validIp(raw("ip")) ? raw("ip") : DEFAULTS.ip;
    const region = validRegion(raw("region")) ? raw("region") : DEFAULTS.region;
    let repo = validRepo(raw("repo")) ? raw("repo").replace(/\/$/, "") : DEFAULTS.repo;
    if (!repo.endsWith(".git")) repo += ".git";
    return {
      ip,
      host: `${ip.replace(/\./g, "-")}.sslip.io`,
      region,
      endpoint: raw("endpoint") || `repoledger-db.abc123xyz.${region}.rds.amazonaws.com`,
      account: /^\d{12}$/.test(raw("account")) ? raw("account") : DEFAULTS.account,
      repo,
      repoweb: repo.replace(/\.git$/, ""),
    };
  }

  function applyValues() {
    const v = values();
    for (const el of all(".v[data-v]")) el.textContent = v[el.dataset.v];
    inputs.endpoint.placeholder = `repoledger-db.abc123xyz.${v.region}.rds.amazonaws.com`;
    $("site-link").href = `https://${v.host}`;
  }

  for (const [k, el] of Object.entries(inputs)) {
    el.value = typeof state[k] === "string" ? state[k] : "";
    el.addEventListener("input", () => {
      state[k] = el.value;
      save();
      applyValues();
    });
  }
  $("values").addEventListener("submit", (e) => e.preventDefault());

  // ---- Switches: database (RDS / Supabase) and the reader's computer (Windows / macOS or Linux) ----

  const SWITCHES = { db: ["rds", "supabase"], os: ["windows", "unix"] };

  function setSwitch(name, value) {
    root.dataset[name] = value;
    for (const b of all(`[data-switch="${name}"] button`)) b.setAttribute("aria-checked", String(b.dataset.value === value));
  }

  for (const [name, options] of Object.entries(SWITCHES)) {
    const group = document.querySelector(`[data-switch="${name}"]`);
    const buttons = Array.from(group.querySelectorAll("button"));
    setSwitch(name, options.includes(state[name]) ? state[name] : options[0]);
    const choose = (value, focus) => {
      setSwitch(name, value);
      state[name] = value;
      save();
      updateProgress();
      if (focus) buttons.find((b) => b.dataset.value === value).focus();
    };
    for (const b of buttons) b.addEventListener("click", () => choose(b.dataset.value));
    // Radio-group keyboard behaviour: arrow keys move the choice.
    group.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const i = options.indexOf(root.dataset[name]);
      const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      choose(options[(i + step + options.length) % options.length], true);
    });
  }
  // Only the checked option is a tab stop.
  const syncTabStops = () => {
    for (const b of all("[data-switch] button")) b.tabIndex = b.getAttribute("aria-checked") === "true" ? 0 : -1;
  };

  // ---- Done toggles, checklist and progress ----

  const visibleSteps = () => all("section[data-step]").filter((s) => getComputedStyle(s).display !== "none");

  function updateProgress() {
    const steps = visibleSteps();
    const done = steps.filter((s) => state[`done-${s.dataset.step}`]).length;
    const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
    $("progress-text").textContent = `${done} of ${steps.length} steps`;
    $("progress-bar").style.width = `${pct}%`;
    $("progress-bar-wrap").setAttribute("aria-valuenow", String(pct));
    for (const a of all("#rail a[data-step]")) a.classList.toggle("done", !!state[`done-${a.dataset.step}`]);
    for (const s of all("section[data-step]")) s.classList.toggle("is-done", !!state[`done-${s.dataset.step}`]);
    syncTabStops();
  }

  for (const cb of all(".done-toggle input, .checks input")) {
    const label = cb.closest("label");
    cb.checked = !!state[cb.id];
    label.classList.toggle("is-checked", cb.checked);
    cb.addEventListener("change", () => {
      state[cb.id] = cb.checked;
      label.classList.toggle("is-checked", cb.checked);
      save();
      updateProgress();
    });
  }

  // ---- Copy buttons ----

  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  for (const btn of all(".copy")) {
    const text = btn.querySelector("span");
    let timer = null;
    const show = (msg, ok) => {
      text.textContent = msg;
      btn.classList.toggle("copied", ok);
      clearTimeout(timer);
      timer = setTimeout(() => {
        text.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1800);
    };
    btn.addEventListener("click", () => {
      const pre = btn.closest(".code").querySelector("pre");
      const value = pre.innerText.replace(/\n$/, ""); // innerText skips the lines hidden by the switches
      const fallback = () => {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        show(mac ? "Press Cmd+C" : "Press Ctrl+C", false);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(() => show("Copied", true), fallback);
      } else {
        fallback();
      }
    });
  }

  // ---- Link to the source code, when this server publishes one ----

  fetch("/api/config", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg || !cfg.source_url || !/^https:\/\//.test(cfg.source_url)) return;
      const link = $("source-fork-link");
      link.href = cfg.source_url;
      link.textContent = cfg.source_url.replace(/^https:\/\//, "");
      $("source-fork").hidden = false;
    })
    .catch(() => {});

  applyValues();
  updateProgress();
})();
