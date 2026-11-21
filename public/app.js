/* RepoLedger — vanilla JS frontend */
(() => {
  "use strict";

  const APP = "RepoLedger";
  const MONO = '"Geist Mono", ui-monospace, monospace';
  const SANS = '"Geist", system-ui, sans-serif';
  const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

  // Series colours per theme. A repo keeps the same colour everywhere.
  const PALETTE = {
    light: ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#ea580c", "#65a30d", "#e11d48", "#64748b"],
    dark: ["#60a5fa", "#fbbf24", "#34d399", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c", "#a3e635", "#fb7185", "#94a3b8"],
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function svg(d, size = 14) {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("d", d);
    s.append(p);
    return s;
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const pad = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const prettyDate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };
  function timeAgo(ts) {
    const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} days ago`;
  }

  const codepointCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const uniqueInOrder = (arr) => [...new Set(arr)];
  const fmt = (n) => Math.trunc(n).toLocaleString("en-US");
  const shortName = (repo) => repo.slice(repo.indexOf("/") + 1);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sum = (rows, key) => rows.reduce((acc, r) => (r[key] == null ? acc : acc + Number(r[key])), 0);

  function sortBy(rows, key, desc = false) {
    return rows
      .map((r, i) => [r, i])
      .sort(([a, ia], [b, ib]) => {
        const va = a[key];
        const vb = b[key];
        if (va == null && vb == null) return ia - ib;
        if (va == null) return 1;
        if (vb == null) return -1;
        const c = va < vb ? -1 : va > vb ? 1 : 0;
        return (desc ? -c : c) || ia - ib;
      })
      .map(([r]) => r);
  }

  function withCumulative(rows, dateKey, pairs) {
    const totals = {};
    return sortBy(rows, dateKey).map((r) => {
      const out = { ...r };
      const t = (totals[r.repo] ||= {});
      for (const [src, dst] of pairs) {
        if (r[src] == null) out[dst] = null;
        else {
          t[src] = (t[src] || 0) + Number(r[src]);
          out[dst] = t[src];
        }
      }
      return out;
    });
  }

  function latestPerRepo(rows, dateKey, cols) {
    const latest = {};
    for (const r of sortBy(rows, dateKey)) {
      const l = (latest[r.repo] ||= {});
      for (const c of cols) if (r[c] != null) l[c] = r[c];
    }
    return Object.values(latest);
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      ...opts,
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  let toastTimer = null;
  function toast(message) {
    let el = $("toast");
    if (!el) {
      el = h("div", { id: "toast", class: "toast", role: "status" });
      document.body.append(el);
    }
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 5000);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const PRESETS = [
    { id: "7d", label: "7D", days: 7 },
    { id: "30d", label: "30D", days: 30 },
    { id: "90d", label: "90D", days: 90 },
    { id: "1y", label: "1Y", days: 365 },
    { id: "all", label: "All" },
    { id: "custom", label: "Custom" },
  ];

  const state = {
    config: { sign_in: false, source_url: null },
    me: null, // signed-in user summary or null
    mode: "owner", // "owner" | "public"
    login: null, // public profile being viewed
    profile: null,
    visibleRepos: [],
    sortedRepos: [],
    selected: [],
    preset: "30d",
    customFrom: isoDate(addDays(today(), -30)),
    customTo: isoDate(today()),
    data: null,
    active: null,
    rendered: new Set(),
    muted: new Set(),
  };

  const theme = () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

  function colorFor(repo) {
    const pal = PALETTE[theme()];
    const i = state.sortedRepos.indexOf(repo);
    return pal[(i < 0 ? 0 : i) % pal.length];
  }

  function currentFilters() {
    const useAll = !state.selected.length;
    const repos = useAll ? state.visibleRepos : state.selected;
    const t = isoDate(today());
    let start = t;
    let end = t;
    if (state.preset === "custom") {
      start = state.customFrom;
      end = state.customTo;
    } else if (state.preset === "all") {
      start = "2000-01-01";
    } else {
      start = isoDate(addDays(today(), -PRESETS.find((p) => p.id === state.preset).days));
    }
    return { repos, useAll, start, end };
  }

  // -------------------------------------------------------------------------
  // Charts
  // -------------------------------------------------------------------------

  function layout({ xDate = true, barmode, tickangle } = {}) {
    const ink = cssVar("--text");
    const rule = cssVar("--border");
    const ruleStrong = cssVar("--border-strong");
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: SANS, size: 11, color: cssVar("--text-3") },
      margin: { t: 10, r: 6, b: 8, l: 6 },
      showlegend: false,
      hovermode: "closest",
      hoverlabel: { bgcolor: cssVar("--surface"), bordercolor: ruleStrong, font: { family: SANS, size: 12, color: ink }, align: "left" },
      xaxis: {
        type: xDate ? "date" : "category",
        tickformat: xDate ? "%b %d" : undefined,
        showgrid: false,
        zeroline: false,
        showline: true,
        linecolor: rule,
        ticks: "",
        automargin: true,
        fixedrange: true,
        ...(tickangle != null ? { tickangle } : {}),
      },
      yaxis: {
        gridcolor: rule,
        zeroline: true,
        zerolinecolor: rule,
        showline: false,
        tickformat: ",~r",
        automargin: true,
        fixedrange: true,
        rangemode: "tozero",
      },
      bargap: 0.3,
      ...(barmode ? { barmode } : {}),
    };
  }

  const PLOT_CONFIG = { responsive: true, displayModeBar: false };
  const visibleRepoList = (rows) => uniqueInOrder(rows.map((r) => r.repo)).filter((r) => !state.muted.has(r));

  function lineTraces(rows, x, series) {
    return visibleRepoList(rows).flatMap((repo) => {
      const rr = rows.filter((r) => r.repo === repo);
      const color = colorFor(repo);
      return series.map((s) => ({
        type: "scatter",
        mode: rr.length < 2 ? "markers" : "lines",
        cliponaxis: false,
        name: repo,
        x: rr.map((r) => r[x]),
        y: rr.map((r) => r[s.key]),
        line: { color, width: 2, dash: s.dash || "solid", shape: s.shape || "linear" },
        marker: { color, size: 6, symbol: s.dash ? "circle-open" : "circle" },
        hovertemplate: `<b>${escapeHtml(shortName(repo))}</b><br>%{x|%b %d, %Y}<br>${escapeHtml(s.label)}: %{y:,}<extra></extra>`,
      }));
    });
  }

  function barTraces(rows, x, key, label, xDate) {
    return visibleRepoList(rows).map((repo) => {
      const rr = rows.filter((r) => r.repo === repo);
      return {
        type: "bar",
        name: repo,
        x: rr.map((r) => r[x]),
        y: rr.map((r) => r[key]),
        marker: { color: colorFor(repo), line: { width: 0 } },
        hovertemplate: `<b>${escapeHtml(shortName(repo))}</b><br>${xDate ? "%{x|%b %d, %Y}" : "%{x}"}<br>${escapeHtml(label)}: %{y:,}<extra></extra>`,
      };
    });
  }

  function divergingTraces(rows) {
    return visibleRepoList(rows).flatMap((repo) => {
      const rr = rows.filter((r) => r.repo === repo);
      const color = colorFor(repo);
      const name = escapeHtml(shortName(repo));
      return [
        {
          type: "bar",
          name: repo,
          x: rr.map((r) => r.week_start),
          y: rr.map((r) => r.additions),
          marker: { color },
          hovertemplate: `<b>${name}</b><br>Week of %{x|%b %d, %Y}<br>Added: %{y:,}<extra></extra>`,
        },
        {
          type: "bar",
          name: repo,
          x: rr.map((r) => r.week_start),
          y: rr.map((r) => (r.deletions == null ? null : -r.deletions)),
          customdata: rr.map((r) => r.deletions),
          marker: { color, opacity: 0.45 },
          hovertemplate: `<b>${name}</b><br>Week of %{x|%b %d, %Y}<br>Removed: %{customdata:,}<extra></extra>`,
        },
      ];
    });
  }

  // -------------------------------------------------------------------------
  // Section building blocks
  // -------------------------------------------------------------------------

  function sheetHead(sheet, title, lede) {
    sheet.append(
      h("header", { class: "sheet-head" }, h("h2", {}, title), lede ? h("p", {}, lede) : null)
    );
  }

  function ledger(sheet, items, note) {
    sheet.append(
      h(
        "dl",
        { class: "ledger" },
        items.map(([label, value]) => h("div", {}, h("dt", {}, label), h("dd", {}, fmt(value)))),
        note ? h("div", { class: "ledger-note" }, note) : null
      )
    );
  }

  function emptyState(sheet) {
    sheet.append(
      h("div", { class: "empty" }, h("strong", {}, "No records for this period."), "Try a longer time period or a different set of repositories.")
    );
  }

  let keyTimer = null;
  function seriesKey(sheet, rows) {
    const repos = uniqueInOrder(rows.map((r) => r.repo)).sort(codepointCompare);
    if (repos.length < 2) return;
    const wrap = h("div", { class: "key" }, h("span", { class: "key-hint" }, "Click to hide · double-click to show only one"));
    for (const repo of repos) {
      const off = state.muted.has(repo);
      wrap.append(
        h(
          "button",
          {
            type: "button",
            class: `key-item${off ? " off" : ""}`,
            "aria-pressed": String(!off),
            title: repo,
            onclick: () => {
              clearTimeout(keyTimer);
              keyTimer = setTimeout(() => {
                if (state.muted.has(repo)) state.muted.delete(repo);
                else state.muted.add(repo);
                rerenderActive();
              }, 220);
            },
            ondblclick: () => {
              clearTimeout(keyTimer);
              state.muted = new Set(state.sortedRepos.filter((r) => r !== repo));
              rerenderActive();
            },
          },
          h("span", { class: "swatch", style: `--c:${colorFor(repo)}` }),
          shortName(repo)
        )
      );
    }
    if (repos.some((r) => state.muted.has(r))) {
      wrap.append(
        h("button", { type: "button", class: "text-btn", onclick: () => { state.muted.clear(); rerenderActive(); } }, "Show all")
      );
    }
    sheet.append(wrap);
  }

  function figs(sheet) {
    const grid = h("div", { class: "figs" });
    sheet.append(grid);
    return grid;
  }

  function figure(grid, { title, unit, wide, traces, opts }) {
    const plot = h("div", { class: "plot" });
    grid.append(
      h(
        "figure",
        { class: `fig${wide ? " wide" : ""}` },
        h(
          "figcaption",
          {},
          h("span", { class: "fig-title" }, title),
          unit ? h("span", { class: "fig-unit" }, unit) : null
        ),
        plot
      )
    );
    if (!traces.length) {
      plot.append(h("div", { class: "plot-empty" }, "All repositories are hidden."));
      return;
    }
    const lay = layout(opts);
    // With only a few days of data Plotly zooms into hours; widen to at least a week.
    if (lay.xaxis.type === "date") {
      const xs = traces.flatMap((t) => t.x).filter(Boolean).map(String).sort();
      if (xs.length) {
        const toDate = (s) => {
          const [y, m, d] = s.slice(0, 10).split("-").map(Number);
          return new Date(y, m - 1, d);
        };
        const lo = toDate(xs[0]);
        const hi = toDate(xs[xs.length - 1]);
        const spanDays = Math.round((hi - lo) / 86400000);
        if (spanDays < 6) {
          const padDays = Math.ceil((6 - spanDays) / 2);
          lay.xaxis.range = [isoDate(addDays(lo, -padDays)), isoDate(addDays(hi, padDays))];
          lay.xaxis.dtick = 86400000;
        }
      }
    }
    Plotly.newPlot(plot, traces, lay, PLOT_CONFIG);
  }

  function table(sheet, rows, columns) {
    const wrap = h("div", { class: "table-wrap" });
    let sortKey = null;
    let desc = false;
    function draw() {
      const data = sortKey ? sortBy(rows, sortKey, desc) : rows;
      wrap.replaceChildren(
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              columns.map((c) =>
                h(
                  "th",
                  { class: c.num ? "num" : null, "aria-sort": sortKey === c.key ? (desc ? "descending" : "ascending") : null },
                  h(
                    "button",
                    {
                      type: "button",
                      onclick: () => {
                        if (sortKey === c.key) desc = !desc;
                        else {
                          sortKey = c.key;
                          desc = !!c.num;
                        }
                        draw();
                      },
                    },
                    c.label,
                    sortKey === c.key ? h("span", { class: "arrow" }, desc ? "↓" : "↑") : null
                  )
                )
              )
            )
          ),
          h(
            "tbody",
            {},
            data.map((r) =>
              h(
                "tr",
                {},
                columns.map((c) => {
                  const v = r[c.key];
                  if (c.repo) {
                    return h("td", { title: v }, h("span", { class: "cell-repo" }, h("span", { class: "swatch", style: `--c:${colorFor(v)}` }), shortName(v)));
                  }
                  return h("td", { class: c.num ? "num" : null }, v == null ? "—" : c.num ? fmt(v) : v);
                })
              )
            )
          )
        )
      );
    }
    draw();
    sheet.append(wrap);
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  const CUMULATIVE_NOTE = (what, verb) =>
    `* Adds up each day's unique ${what} count. Someone who ${verb} on several days is counted once per day, ` +
    "so this total can be higher than the number of distinct people.";

  const SECTIONS = {
    traffic: {
      label: "Traffic",
      render(sheet, data) {
        sheetHead(sheet, "Page views", "Daily views and unique visitors across the selected repositories.");
        const rows = data.views;
        if (!rows.length) return emptyState(sheet);
        ledger(sheet, [["Total views", sum(rows, "total_views")], ["Unique visitors", sum(rows, "unique_visitors")]]);
        seriesKey(sheet, rows);
        const cum = withCumulative(rows, "date", [["total_views", "cumulative_views"], ["unique_visitors", "cumulative_unique"]]);
        const g = figs(sheet);
        figure(g, { title: "Views", unit: "per day", traces: lineTraces(rows, "date", [{ key: "total_views", label: "Views" }]) });
        figure(g, { title: "Unique visitors", unit: "per day", traces: lineTraces(rows, "date", [{ key: "unique_visitors", label: "Unique visitors" }]) });
        figure(g, { title: "Cumulative views", unit: "running total", traces: lineTraces(cum, "date", [{ key: "cumulative_views", label: "Cumulative views" }]) });
        figure(g, { title: "Cumulative unique visitors*", unit: "running total", traces: lineTraces(cum, "date", [{ key: "cumulative_unique", label: "Cumulative unique visitors" }]) });
        sheet.append(h("p", { class: "footnote" }, CUMULATIVE_NOTE("visitor", "visits")));
      },
    },
    clones: {
      label: "Clones",
      render(sheet, data) {
        sheetHead(sheet, "Clones", "Daily clones and unique cloners across the selected repositories.");
        const rows = data.clones;
        if (!rows.length) return emptyState(sheet);
        ledger(sheet, [["Total clones", sum(rows, "total_clones")], ["Unique cloners", sum(rows, "unique_cloners")]]);
        seriesKey(sheet, rows);
        const cum = withCumulative(rows, "date", [["total_clones", "cumulative_clones"], ["unique_cloners", "cumulative_unique"]]);
        const g = figs(sheet);
        figure(g, { title: "Clones", unit: "per day", traces: lineTraces(rows, "date", [{ key: "total_clones", label: "Clones" }]) });
        figure(g, { title: "Unique cloners", unit: "per day", traces: lineTraces(rows, "date", [{ key: "unique_cloners", label: "Unique cloners" }]) });
        figure(g, { title: "Cumulative clones", unit: "running total", traces: lineTraces(cum, "date", [{ key: "cumulative_clones", label: "Cumulative clones" }]) });
        figure(g, { title: "Cumulative unique cloners*", unit: "running total", traces: lineTraces(cum, "date", [{ key: "cumulative_unique", label: "Cumulative unique cloners" }]) });
        sheet.append(h("p", { class: "footnote" }, CUMULATIVE_NOTE("cloner", "clones")));
      },
    },
    commits: {
      label: "Commits",
      render(sheet, data) {
        sheetHead(sheet, "Commit activity", "Weekly commits and lines changed, as reported by GitHub's statistics API.");
        const rows = data.commits;
        if (!rows.length) return emptyState(sheet);
        ledger(sheet, [["Commits", sum(rows, "total_commits")], ["Lines added", sum(rows, "additions")], ["Lines removed", sum(rows, "deletions")]]);
        seriesKey(sheet, rows);
        const g = figs(sheet);
        figure(g, { title: "Commits", unit: "per week", traces: lineTraces(rows, "week_start", [{ key: "total_commits", label: "Commits" }]) });
        figure(g, { title: "Weekly commits", unit: "stacked by repo", traces: barTraces(rows, "week_start", "total_commits", "Commits", true), opts: { barmode: "stack" } });
        figure(g, { title: "Lines added", unit: "per week", traces: lineTraces(rows, "week_start", [{ key: "additions", label: "Lines added" }]) });
        figure(g, { title: "Lines removed", unit: "per week", traces: lineTraces(rows, "week_start", [{ key: "deletions", label: "Lines removed" }]) });
        figure(g, { title: "Additions and deletions", unit: "added above the line · removed below", wide: true, traces: divergingTraces(rows), opts: { barmode: "relative" } });
      },
    },
    issues: {
      label: "Issues & PRs",
      render(sheet, data) {
        sheetHead(sheet, "Issues and pull requests", "Snapshots of issue and pull-request counts, taken each time the data is collected.");
        const rows = data.issues;
        if (!rows.length) return emptyState(sheet);
        const latest = latestPerRepo(rows, "snapshot_date", ["open_issues", "closed_issues", "open_prs", "merged_prs"]);
        ledger(
          sheet,
          [
            ["Open issues", sum(latest, "open_issues")],
            ["Closed issues", sum(latest, "closed_issues")],
            ["Open PRs", sum(latest, "open_prs")],
            ["Merged PRs", sum(latest, "merged_prs")],
          ],
          "Totals use the latest snapshot for each repository."
        );
        seriesKey(sheet, rows);
        const g = figs(sheet);
        figure(g, {
          title: "Issues",
          unit: "solid open · dashed closed",
          traces: lineTraces(rows, "snapshot_date", [{ key: "open_issues", label: "Open issues" }, { key: "closed_issues", label: "Closed issues", dash: "dot" }]),
        });
        figure(g, {
          title: "Pull requests",
          unit: "solid open · dashed merged",
          traces: lineTraces(rows, "snapshot_date", [{ key: "open_prs", label: "Open PRs" }, { key: "merged_prs", label: "Merged PRs", dash: "dot" }]),
        });
      },
    },
    stars: {
      label: "Stars",
      render(sheet, data) {
        sheetHead(
          sheet,
          "Stars",
          "Star counts over time. Earlier history is rebuilt from when each current stargazer starred the repository, so stars that were later removed don't appear."
        );
        const rows = data.stars;
        if (!rows.length) return emptyState(sheet);
        const latest = latestPerRepo(rows, "snapshot_date", ["stars"]);
        ledger(sheet, [["Total stars", sum(latest, "stars")]], "Uses the latest count for each repository.");
        seriesKey(sheet, rows);
        const g = figs(sheet);
        figure(g, { title: "Stars", unit: "total per repo", wide: true, traces: lineTraces(rows, "snapshot_date", [{ key: "stars", label: "Stars", shape: "hv" }]) });
      },
    },
    referrers: {
      label: "Referrers",
      render(sheet, data) {
        sheetHead(sheet, "Referring sites", "Where visitors came from. Shows the latest snapshot for each repository, whatever period is selected.");
        if (!data.referrers.length) return emptyState(sheet);
        const rows = sortBy(data.referrers, "total_count", true);
        seriesKey(sheet, rows);
        const g = figs(sheet);
        figure(g, {
          title: "Views by referrer",
          unit: "latest snapshot",
          wide: true,
          traces: barTraces(rows, "referrer", "total_count", "Views", false),
          opts: { xDate: false, barmode: "group", tickangle: rows.length > 6 ? -35 : 0 },
        });
        table(sheet, rows, [
          { key: "repo", label: "Repository", repo: true },
          { key: "referrer", label: "Referrer" },
          { key: "total_count", label: "Views", num: true },
          { key: "unique_count", label: "Unique", num: true },
        ]);
      },
    },
    contributors: {
      label: "Contributors",
      render(sheet, data) {
        sheetHead(sheet, "Contributors", "Commits per author. Shows the latest snapshot for each repository, whatever period is selected.");
        if (!data.contributors.length) return emptyState(sheet);
        const rows = sortBy(data.contributors, "total_commits", true);
        seriesKey(sheet, rows);
        const g = figs(sheet);
        figure(g, {
          title: "Commits by contributor",
          unit: "latest snapshot",
          wide: true,
          traces: barTraces(rows, "author", "total_commits", "Commits", false),
          opts: { xDate: false, barmode: "group", tickangle: rows.length > 6 ? -35 : 0 },
        });
        table(sheet, rows, [
          { key: "repo", label: "Repository", repo: true },
          { key: "author", label: "Author" },
          { key: "total_commits", label: "Commits", num: true },
        ]);
      },
    },
  };

  const SECTION_ORDER = {
    owner: ["traffic", "clones", "commits", "issues", "stars", "referrers", "contributors"],
    public: ["stars", "commits", "issues", "contributors"],
  };
  const sectionIds = () => SECTION_ORDER[state.mode];

  // -------------------------------------------------------------------------
  // Masthead: account menu / sign-in link
  // -------------------------------------------------------------------------

  function renderMastheadActions() {
    const root = $("masthead-actions");
    if (!state.me) {
      root.replaceChildren(h("a", { class: "btn btn-primary btn-sm", href: "/auth/login" }, "Sign in with GitHub"));
      return;
    }
    const { user, installations, install_url } = state.me;
    const btn = h(
      "button",
      { type: "button", class: "account-btn", "aria-haspopup": "true", "aria-expanded": "false" },
      user.avatar_url ? h("img", { class: "avatar", src: `${user.avatar_url}&s=56`, alt: "" }) : null,
      h("span", { class: "who" }, `@${user.login}`),
      svg("M6 9l6 6 6-6")
    );
    const manage = installations[0] ? installations[0].manage_url : install_url;
    const menu = h(
      "ul",
      { class: "account-menu", hidden: true },
      h("li", { class: "meta" }, `Signed in as @${user.login}`),
      h("li", {}, h("a", { href: "/" }, "Your dashboard")),
      h("li", {}, h("a", { href: `/u/${encodeURIComponent(user.login)}` }, "Your public profile")),
      manage ? h("li", {}, h("a", { href: manage, target: "_blank", rel: "noopener" }, "Choose repositories on GitHub ↗")) : null,
      installations.length ? h("li", {}, h("button", { type: "button", onclick: collectNow }, "Collect now")) : null,
      h("li", { class: "sep", role: "separator" }),
      h("li", {}, h("button", { type: "button", onclick: signOut }, "Sign out")),
      h("li", {}, h("button", { type: "button", class: "danger", onclick: () => { close(); openDeleteDialog(); } }, "Delete my data…"))
    );
    const wrap = h("div", { class: "account" }, btn, menu);
    root.replaceChildren(wrap);

    function close() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("mousedown", (e) => {
      if (!wrap.contains(e.target)) close();
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        close();
        btn.focus();
      }
    });
  }

  async function signOut() {
    try {
      await api("/auth/logout", { method: "POST", body: "{}" });
    } finally {
      location.href = "/";
    }
  }

  async function collectNow() {
    try {
      await api("/api/collect", { method: "POST", body: "{}" });
      toast("Collecting now. New numbers appear in a minute or two.");
    } catch (e) {
      toast(e.message);
    }
  }

  function openDeleteDialog() {
    $("delete-error").hidden = true;
    $("delete-dialog").showModal();
  }

  function wireDeleteDialog() {
    $("delete-confirm").addEventListener("click", async () => {
      const btn = $("delete-confirm");
      btn.disabled = true;
      btn.textContent = "Deleting…";
      try {
        await api("/api/account/delete", { method: "POST", body: "{}" });
        location.href = "/?notice=deleted";
      } catch (e) {
        const err = $("delete-error");
        err.replaceChildren(e.message);
        if (e.body && e.body.manage_url) {
          err.append(" ", h("a", { href: e.body.manage_url, target: "_blank", rel: "noopener" }, "Open GitHub settings ↗"));
        }
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Delete everything";
      }
    });
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------

  function wireTheme() {
    const btn = $("theme-toggle");
    const SUN = "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";
    const MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";
    const label = () => {
      const dark = theme() === "dark";
      const text = dark ? "Switch to light mode" : "Switch to dark mode";
      btn.replaceChildren(svg(dark ? SUN : MOON, 18));
      btn.setAttribute("aria-label", text);
      btn.title = text;
    };
    label();
    btn.addEventListener("click", () => {
      const next = theme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("rl-theme", next);
      } catch {
        /* storage unavailable */
      }
      label();
      picker.redraw();
      renderDemo();
      if (state.data) rerenderActive(true);
    });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  function showOnly(id) {
    for (const v of ["landing", "onboard", "dashboard"]) $(v).hidden = v !== id;
    $("nav-links").hidden = id !== "landing";
    $("boot").hidden = true;
    $("masthead").hidden = false;
    $("colophon").hidden = false;
  }

  const NOTICES = {
    not_configured: "Sign-in isn't set up on this server yet. Username lookups still work.",
    state: "Sign-in was interrupted or took too long. Please try again.",
    signin: "GitHub sign-in didn't complete. Please try again.",
    denied: "Sign-in was cancelled.",
    deleted: "Your data has been deleted and RepoLedger was uninstalled from your GitHub account.",
  };

  // -------------------------------------------------------------------------
  // Landing demo: what GitHub keeps (14 days) vs what RepoLedger keeps
  // -------------------------------------------------------------------------

  const demo = { mode: "ledger", data: null };

  function demoData() {
    if (demo.data) return demo.data;
    let seed = 7;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const DAYS = 120;
    const SPIKE = 41; // days ago: well outside GitHub's 14-day window
    const rows = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = addDays(today(), -i);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      let v = (120 + (DAYS - i) * 0.9) * (weekend ? 0.6 : 1) * (0.82 + rand() * 0.36);
      const since = SPIKE - i;
      if (since >= 0 && since < 6) v += 1250 * Math.pow(0.42, since);
      const views = Math.round(v);
      rows.push({
        date: isoDate(d),
        views,
        unique: Math.round(views * (0.34 + rand() * 0.08)),
        clones: Math.round(views * (0.09 + rand() * 0.05)),
        hn: since >= 0 && since < 6,
      });
    }
    const spike = rows.reduce((a, b) => (b.views > a.views ? b : a));
    demo.data = { rows, spike, cutoff: rows[rows.length - 14].date };
    return demo.data;
  }

  function renderDemo() {
    const plot = $("demo-plot");
    if (!plot || $("landing").hidden) return;
    const { rows, spike, cutoff } = demoData();
    const ledgerMode = demo.mode === "ledger";
    const shown = ledgerMode ? rows : rows.filter((r) => r.date >= cutoff);
    const lost = rows.filter((r) => r.date <= cutoff);
    const accent = cssVar("--accent");
    const lostColor = cssVar("--lost");

    $("demo-toggle").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === demo.mode)));

    const stat = (label, value, note, cls) =>
      h("div", {}, h("dt", {}, label), h("dd", { class: cls || null }, value, note ? h("small", { class: note.cls || null }, note.text) : null));
    $("demo-stats").replaceChildren(
      stat("Views", fmt(sum(shown, "views")), { text: ledgerMode ? `${rows.length} days` : "14 days" }),
      stat("Unique visitors", fmt(sum(shown, "unique"))),
      stat("Clones", fmt(sum(shown, "clones"))),
      stat("Top referrer", ledgerMode ? "Hacker News" : "github.com", null, ledgerMode ? null : "muted")
    );

    const spikeDay = prettyDate(spike.date).replace(/, \d{4}$/, "");
    const caption = $("demo-caption");
    caption.replaceChildren(
      ...(ledgerMode
        ? [h("strong", {}, `${spikeDay}: ${fmt(spike.views)} views`), " from a Hacker News post. Still here, months later."]
        : [h("strong", {}, "Everything before the last 14 days is gone,"), ` including the ${fmt(spike.views)}-view spike on ${spikeDay}.`])
    );

    const lay = layout();
    lay.margin = { t: 8, r: 4, b: 4, l: 4 };
    lay.hovermode = "x";
    lay.xaxis.range = [rows[0].date, rows[rows.length - 1].date];
    lay.yaxis.range = [0, spike.views * 1.12];
    lay.yaxis.rangemode = undefined;
    const traces = [];
    if (!ledgerMode) {
      lay.shapes = [
        { type: "rect", xref: "x", yref: "paper", x0: rows[0].date, x1: cutoff, y0: 0, y1: 1, fillcolor: lostColor, opacity: 0.12, line: { width: 0 }, layer: "below" },
      ];
      lay.annotations = [
        { xref: "x", yref: "paper", x: lost[Math.floor(lost.length / 2)].date, y: 0.55, text: "Deleted by GitHub", showarrow: false, font: { family: SANS, size: 13, color: cssVar("--text-3") } },
      ];
      traces.push({
        type: "scatter", mode: "lines", x: lost.map((r) => r.date), y: lost.map((r) => r.views),
        line: { color: lostColor, width: 1.5, dash: "dot" }, opacity: 0.5, hoverinfo: "skip",
      });
    } else {
      lay.annotations = [
        {
          x: spike.date, y: spike.views, xref: "x", yref: "y", text: plot.clientWidth < 560 ? "← Hacker News" : "← Posted on Hacker News", showarrow: false, xanchor: "left", xshift: 10,
          font: { family: SANS, size: 12, color: cssVar("--text-2") },
        },
      ];
    }
    traces.push({
      type: "scatter", mode: "lines", x: shown.map((r) => r.date), y: shown.map((r) => r.views),
      line: { color: accent, width: 2, shape: "spline", smoothing: 0.4 },
      fill: "tozeroy", fillcolor: theme() === "dark" ? "rgba(59,130,246,0.14)" : "rgba(37,99,235,0.08)",
      hovertemplate: "%{x|%b %d}<br><b>%{y:,} views</b><extra></extra>",
    });
    Plotly.react(plot, traces, lay, PLOT_CONFIG);
  }

  function wireDemo() {
    const toggle = $("demo-toggle");
    toggle.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (!b || b.dataset.mode === demo.mode) return;
      demo.mode = b.dataset.mode;
      renderDemo();
    });
    toggle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      demo.mode = demo.mode === "ledger" ? "github" : "ledger";
      renderDemo();
      toggle.querySelector(`[data-mode="${demo.mode}"]`).focus();
    });
    $("cta-lookup").addEventListener("click", (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      $("lookup-input").focus({ preventScroll: true });
    });
  }

  function showLanding() {
    showOnly("landing");
    renderDemo();
    document.title = APP;
    const params = new URLSearchParams(location.search);
    const code = params.get("error") || params.get("notice");
    if (code && NOTICES[code]) {
      $("landing-notice").textContent = NOTICES[code];
      $("landing-notice").hidden = false;
      history.replaceState(null, "", "/");
    }
    if (state.config.source_url) {
      const p = $("source-link");
      p.replaceChildren("RepoLedger is open source. ", h("a", { href: state.config.source_url, rel: "noopener" }, "Read the code ↗"));
      p.hidden = false;
    }
  }

  function normaliseLogin(raw) {
    return String(raw)
      .trim()
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/^github\.com\//i, "")
      .replace(/^@/, "")
      .split(/[/?#]/)[0];
  }

  function wireLookupForm() {
    $("lookup-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const login = normaliseLogin($("lookup-input").value);
      if (!LOGIN_RE.test(login)) {
        $("landing-notice").textContent = "That doesn't look like a GitHub username.";
        $("landing-notice").hidden = false;
        return;
      }
      location.href = `/u/${encodeURIComponent(login)}`;
    });
  }

  function onboard(...children) {
    showOnly("onboard");
    $("onboard").replaceChildren(...children);
  }

  const meter = (done, total) => {
    const indeterminate = !total;
    return [
      h("div", { class: `meter${indeterminate ? " indeterminate" : ""}` }, h("span", { style: indeterminate ? null : `width:${Math.round((done / total) * 100)}%` })),
      h("p", { class: "meter-label" }, indeterminate ? "Working…" : `${done} of ${total} repositories`),
    ];
  };

  const PERMISSIONS = [
    ["Administration · read", "Required by GitHub for traffic: views, clones and referring sites."],
    ["Issues · read", "Issue counts."],
    ["Pull requests · read", "Pull-request counts."],
    ["Metadata · read", "Repository names. Every GitHub App has this."],
    ["Contents · not requested", "RepoLedger can't read your code or files."],
  ];

  // ---- Owner flow ----

  async function fetchMe() {
    try {
      return await api("/api/me");
    } catch (e) {
      if (e.status === 401) return null;
      throw e;
    }
  }

  async function startOwner() {
    const me = state.me;
    const login = me.user.login;
    document.title = `Your dashboard · ${APP}`;

    if (!me.installations.length) {
      return onboard(
        h("p", { class: "eyebrow" }, "One more step"),
        h("h1", {}, `Welcome, @${login}.`),
        h(
          "p",
          {},
          "Next, choose which repositories RepoLedger may read. GitHub shows you the exact permissions first, and lets you pick all repositories or only some."
        ),
        h(
          "div",
          { class: "actions" },
          me.install_url ? h("a", { class: "btn btn-primary", href: me.install_url }, "Choose repositories on GitHub") : null,
          h("a", { class: "text-btn", href: `/u/${encodeURIComponent(login)}` }, "See your public profile instead")
        ),
        h(
          "div",
          { class: "perm-list" },
          h("h2", { class: "section-label" }, "What RepoLedger asks for"),
          h("ul", {}, PERMISSIONS.map(([a, b]) => h("li", {}, h("span", {}, a), h("span", {}, b))))
        ),
        h("p", { class: "fine" }, "Installing on an organisation isn't supported yet. Install it on your personal account.")
      );
    }

    if (me.installations.every((i) => i.suspended)) {
      return onboard(
        h("h1", {}, "RepoLedger is suspended on your account."),
        h("p", {}, "Unsuspend it in your GitHub settings to resume collecting."),
        h("div", { class: "actions" }, h("a", { class: "btn btn-primary", href: me.installations[0].manage_url, target: "_blank", rel: "noopener" }, "Open GitHub settings ↗"))
      );
    }

    if (me.has_data) return startDashboard("owner");

    if (me.collecting) {
      onboard(
        h("p", { class: "eyebrow" }, "Almost there"),
        h("h1", {}, "Collecting your first numbers."),
        h("p", {}, "RepoLedger is reading your repositories from GitHub. This usually takes a minute or two, so keep this page open."),
        ...meter(0, 0),
        h("p", { class: "fine" }, "GitHub only keeps the last 14 days of traffic, so your history starts there and grows from today.")
      );
      await sleep(4000);
      state.me = await fetchMe();
      if (!state.me) return (location.href = "/");
      return startOwner();
    }

    const manage = me.installations[0].manage_url;
    return onboard(
      h("h1", {}, me.repo_count ? "No numbers yet." : "No repositories selected."),
      h(
        "p",
        {},
        me.repo_count
          ? "RepoLedger hasn't collected anything for your repositories yet. Start a collection now, or wait for the next scheduled run (every six hours)."
          : "RepoLedger is installed but can't see any repositories. Choose some on GitHub, then collect."
      ),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            onclick: async () => {
              await collectNow();
              state.me = await fetchMe();
              startOwner();
            },
          },
          "Collect now"
        ),
        h("a", { class: "text-btn", href: manage, target: "_blank", rel: "noopener" }, "Choose repositories on GitHub ↗")
      )
    );
  }

  // ---- Public flow ----

  async function startPublic(rawLogin) {
    const login = rawLogin;
    document.title = `@${login} · ${APP}`;
    if (!LOGIN_RE.test(login)) return publicNotFound(login, "That isn't a valid GitHub username.");

    for (;;) {
      let res;
      try {
        res = await api(`/api/public/${encodeURIComponent(login)}`);
      } catch (e) {
        if (e.status === 404) return publicNotFound(login);
        if (e.status === 400) return publicNotFound(login, "That isn't a valid GitHub username.");
        return onboard(
          h("h1", {}, `Couldn't look up @${login}.`),
          h("p", {}, e.message),
          h("div", { class: "actions" }, h("button", { type: "button", class: "btn btn-primary", onclick: () => startPublic(login) }, "Try again"))
        );
      }
      if (res.status === "ready") {
        state.profile = res.profile;
        state.login = res.profile.login;
        return startDashboard("public", res.repos.map((r) => r.repo));
      }
      onboard(
        h("p", { class: "eyebrow" }, "Public lookup"),
        h("h1", {}, `Reading @${login}'s public repositories.`),
        h("p", {}, "This happens once. The results are cached, so the next visit is instant."),
        ...meter(res.progress ? res.progress.done : 0, res.progress ? res.progress.total : 0)
      );
      await sleep(2000);
    }
  }

  function publicNotFound(login, message) {
    onboard(
      h("h1", {}, message || `No GitHub user called @${login}.`),
      h("p", {}, "Check the spelling and try again."),
      h("div", { class: "actions" }, h("a", { class: "btn btn-primary", href: "/" }, "Look up someone else"))
    );
  }

  function renderProfileHead() {
    const head = $("profile-head");
    if (state.mode !== "public") {
      head.hidden = true;
      return;
    }
    const p = state.profile;
    const mine = state.me && state.me.user.login.toLowerCase() === p.login.toLowerCase();
    head.replaceChildren(
      p.avatar_url ? h("img", { src: `${p.avatar_url}${p.avatar_url.includes("?") ? "&" : "?"}s=128`, alt: "" }) : h("span"),
      h("h1", {}, p.name || p.login),
      h(
        "div",
        { class: "meta" },
        h("span", {}, `@${p.login}`),
        h("span", {}, `${state.visibleRepos.length} public ${state.visibleRepos.length === 1 ? "repository" : "repositories"}`),
        p.fetched_at ? h("span", {}, `updated ${timeAgo(p.fetched_at)}`) : null,
        h("a", { href: p.html_url, target: "_blank", rel: "noopener" }, "github.com ↗")
      ),
      h(
        "div",
        { class: "profile-callout" },
        mine
          ? h("span", {}, "This is your public view. Your dashboard also shows views, clones and referring sites.")
          : h("span", {}, "Views, clones and referring sites are private to the owner."),
        mine
          ? h("a", { class: "text-btn", href: "/" }, "Open your dashboard")
          : state.config.sign_in && !state.me
          ? h("a", { class: "text-btn", href: "/auth/login" }, "Is this you? Sign in to see your traffic")
          : null
      )
    );
    head.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  function buildPeriod() {
    const root = $("period");
    const draw = () => root.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === state.preset)));
    root.replaceChildren(
      ...PRESETS.map((p) =>
        h("button", { type: "button", role: "radio", "data-id": p.id, onclick: () => { state.preset = p.id; draw(); refresh(); } }, p.label)
      )
    );
    root.onkeydown = (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = PRESETS.findIndex((p) => p.id === state.preset);
      const next = PRESETS[(i + (e.key === "ArrowRight" ? 1 : PRESETS.length - 1)) % PRESETS.length];
      state.preset = next.id;
      draw();
      root.querySelector(`[data-id="${next.id}"]`).focus();
      refresh();
    };
    draw();

    const from = $("from-date");
    const to = $("to-date");
    from.value = state.customFrom;
    to.value = state.customTo;
    from.onchange = () => {
      if (from.value) {
        state.customFrom = from.value;
        refresh();
      } else from.value = state.customFrom;
    };
    to.onchange = () => {
      if (to.value) {
        state.customTo = to.value;
        refresh();
      } else to.value = state.customTo;
    };
  }

  const picker = { redraw: () => {} };

  function buildPicker() {
    const root = $("repo-picker");
    const btn = h("button", { type: "button", class: "picker-btn", "aria-haspopup": "true", "aria-expanded": "false" });
    const search = h("input", { type: "search", class: "picker-search", placeholder: "Filter repositories", "aria-label": "Filter repositories" });
    const list = h("ul", { class: "picker-list" });
    const panel = h(
      "div",
      { class: "picker-panel", hidden: true },
      search,
      list,
      h(
        "div",
        { class: "picker-foot" },
        h("button", { type: "button", class: "text-btn", onclick: () => setSelection([]) }, "Select all"),
        h("button", { type: "button", class: "text-btn", onclick: () => close(true) }, "Done")
      )
    );
    root.replaceChildren(btn, panel);

    const effective = () => (state.selected.length ? state.selected : state.sortedRepos);

    function setSelection(next) {
      if (next.length === state.visibleRepos.length) next = [];
      state.selected = next;
      drawButton();
      drawList();
      refresh();
    }

    function drawButton() {
      const n = state.selected.length;
      const total = state.visibleRepos.length;
      const name = !n ? "All repositories" : n === 1 ? shortName(state.selected[0]) : `${n} repositories`;
      btn.replaceChildren(h("span", { class: "name" }, name), h("span", { class: "count" }, n ? `${n}/${total}` : String(total)), svg("M6 9l6 6 6-6"));
    }

    function drawList() {
      const q = search.value.trim().toLowerCase();
      const items = state.sortedRepos.filter((r) => r.toLowerCase().includes(q));
      const on = new Set(effective());
      list.replaceChildren(
        ...(items.length
          ? items.map((repo) =>
              h(
                "li",
                {},
                h(
                  "label",
                  { class: "picker-item", title: repo },
                  h("input", {
                    type: "checkbox",
                    checked: on.has(repo),
                    onchange: (e) => {
                      const cur = effective();
                      setSelection(e.target.checked ? state.sortedRepos.filter((r) => r === repo || cur.includes(r)) : cur.filter((r) => r !== repo));
                    },
                  }),
                  h("span", { class: "swatch", style: `--c:${colorFor(repo)}` }),
                  h("span", { class: "name" }, shortName(repo)),
                  h("button", { type: "button", class: "text-btn only", onclick: (e) => { e.preventDefault(); setSelection([repo]); } }, "only")
                )
              )
            )
          : [h("li", { class: "picker-empty" }, "No matching repositories")])
      );
    }

    function open() {
      panel.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      drawList();
      search.focus();
    }
    function close(focusBtn) {
      if (panel.hidden) return;
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      search.value = "";
      if (focusBtn) btn.focus();
    }

    btn.addEventListener("click", () => (panel.hidden ? open() : close()));
    search.addEventListener("input", drawList);
    document.addEventListener("mousedown", (e) => {
      if (!root.contains(e.target)) close();
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(true);
    });

    drawButton();
    picker.redraw = () => {
      drawButton();
      drawList();
    };
  }

  function updateSummary(f) {
    $("custom-range").hidden = state.preset !== "custom";
    const period = state.preset === "all" ? "all time" : `${prettyDate(f.start)} – ${prettyDate(f.end)}`;
    $("summary").textContent = `${f.repos.length} ${f.repos.length === 1 ? "repo" : "repos"} · ${period}`;
  }

  // -------------------------------------------------------------------------
  // Dashboard (owner + public)
  // -------------------------------------------------------------------------

  async function startDashboard(mode, publicRepos) {
    state.mode = mode;
    let repos = publicRepos || [];
    if (mode === "owner") {
      try {
        repos = await api("/api/repos");
      } catch (e) {
        if (e.status === 401) return (location.href = "/");
        repos = [];
      }
    }
    state.visibleRepos = repos;
    state.sortedRepos = [...repos].sort(codepointCompare);
    state.selected = [];
    state.muted.clear();

    const fromHash = location.hash.slice(1);
    state.active = sectionIds().includes(fromHash) ? fromHash : sectionIds()[0];

    showOnly("dashboard");
    renderProfileHead();

    if (!repos.length) {
      $("toolbar").hidden = true;
      $("panels").replaceChildren(
        h(
          "div",
          { class: "empty", style: "margin-top:32px" },
          h("strong", {}, mode === "public" ? `@${state.login} has no public repositories of their own.` : "No repositories yet."),
          mode === "public" ? "Forks and private repositories aren't included in public lookups." : "Choose some on GitHub from the account menu."
        )
      );
      return;
    }

    $("toolbar").hidden = false;
    buildPeriod();
    buildPicker();
    buildIndex();
    refresh();
  }

  function buildIndex() {
    const ids = sectionIds();
    $("tabs").replaceChildren(
      ...ids.map((id) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            id: `tab-${id}`,
            "aria-controls": `panel-${id}`,
            "aria-selected": String(id === state.active),
            onclick: () => selectSection(id),
          },
          SECTIONS[id].label
        )
      )
    );
    $("panels").replaceChildren(
      ...ids.map((id) => h("section", { class: "sheet", role: "tabpanel", id: `panel-${id}`, "aria-labelledby": `tab-${id}`, hidden: id !== state.active }))
    );
  }

  function selectSection(id) {
    state.active = id;
    if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
    for (const s of sectionIds()) {
      $(`tab-${s}`).setAttribute("aria-selected", String(s === id));
      $(`panel-${s}`).hidden = s !== id;
    }
    renderActive();
    $(`panel-${id}`).querySelectorAll(".js-plotly-plot").forEach((p) => Plotly.Plots.resize(p));
  }

  function renderActive() {
    if (!state.data || state.rendered.has(state.active)) return;
    const id = state.active;
    const sheet = $(`panel-${id}`);
    if (!sheet) return;
    sheet.querySelectorAll(".js-plotly-plot").forEach((p) => Plotly.purge(p));
    sheet.replaceChildren();
    SECTIONS[id].render(sheet, state.data);
    state.rendered.add(id);
  }

  function rerenderActive(all = false) {
    if (all) state.rendered.clear();
    else state.rendered.delete(state.active);
    renderActive();
  }

  const EMPTY_DATA = { views: [], clones: [], commits: [], issues: [], stars: [], referrers: [], contributors: [] };

  let inflight = null;
  async function refresh() {
    const f = currentFilters();
    updateSummary(f);

    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;

    const qs = new URLSearchParams({ start: f.start, end: f.end });
    if (!f.useAll) f.repos.forEach((r) => qs.append("repo", r));
    const url = state.mode === "owner" ? `/api/data?${qs}` : `/api/public/${encodeURIComponent(state.login)}/data?${qs}`;

    $("progress").hidden = false;
    try {
      const data = await api(url, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      state.data = { ...EMPTY_DATA, ...data };
    } catch (e) {
      if (e.name === "AbortError") return;
      if (e.status === 401) return (location.href = "/");
      console.error(e);
      state.data = { ...EMPTY_DATA };
    } finally {
      if (inflight === ctrl) {
        inflight = null;
        $("progress").hidden = true;
      }
    }
    rerenderActive(true);
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async function init() {
    wireTheme();
    wireLookupForm();
    wireDemo();
    wireDeleteDialog();

    try {
      state.config = await api("/api/config");
    } catch {
      /* defaults */
    }
    try {
      state.me = await fetchMe();
    } catch {
      state.me = null;
    }
    renderMastheadActions();

    const m = location.pathname.match(/^\/u\/([^/]+)\/?$/);
    if (m) return startPublic(decodeURIComponent(m[1]));
    if (!state.me) return showLanding();
    return startOwner();
  }

  init();
})();
