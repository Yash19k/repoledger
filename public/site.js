/* RepoLedger: shared behaviour for the static pages (How it works, Deploy on AWS). */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";

  function icon(d, size) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("d", d);
    s.append(p);
    return s;
  }

  // ---- Theme toggle (same storage key and icons as the app) ----

  const theme = () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const SUN = "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";
  const MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";

  const toggle = $("theme-toggle");
  if (toggle) {
    const label = () => {
      const dark = theme() === "dark";
      const text = dark ? "Switch to light mode" : "Switch to dark mode";
      toggle.replaceChildren(icon(dark ? SUN : MOON, 18));
      toggle.setAttribute("aria-label", text);
      toggle.title = text;
    };
    label();
    toggle.addEventListener("click", () => {
      const next = theme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("rl-theme", next);
      } catch {
        /* storage unavailable */
      }
      label();
    });
  }

  // ---- Header: "Sign in" for visitors, a link back to the dashboard when signed in ----

  const actions = $("masthead-actions");
  if (actions) {
    fetch("/api/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (!me || !me.user) return;
        const a = document.createElement("a");
        a.className = "account-btn";
        a.href = "/";
        if (me.user.avatar_url) {
          const img = document.createElement("img");
          img.className = "avatar";
          img.alt = "";
          try {
            const u = new URL(me.user.avatar_url);
            u.searchParams.set("s", "56");
            img.src = u.href;
          } catch {
            img.src = me.user.avatar_url;
          }
          a.append(img);
        }
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = "Dashboard";
        a.append(who);
        a.setAttribute("aria-label", `Your dashboard (signed in as @${me.user.login})`);
        actions.replaceChildren(a);
      })
      .catch(() => {
        /* offline: keep the sign-in button */
      });
  }

  // ---- Tables stack on phones: label each cell with its column header ----

  for (const table of document.querySelectorAll(".doc-table table")) {
    const heads = Array.from(table.querySelectorAll("thead th"), (th) => th.textContent.trim());
    for (const tr of table.querySelectorAll("tbody tr")) {
      Array.from(tr.children).forEach((td, i) => {
        if (heads[i]) td.dataset.label = heads[i];
      });
    }
  }

  // ---- Diagrams wider than the screen scroll sideways: say so ----

  const diagrams = document.querySelectorAll(".diagram");
  if (diagrams.length && "ResizeObserver" in window) {
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const d = en.target;
        d.previousElementSibling.hidden = !(d.clientWidth && d.scrollWidth > d.clientWidth + 2);
      }
    });
    for (const d of diagrams) {
      const hint = document.createElement("p");
      hint.className = "scroll-hint";
      hint.hidden = true;
      hint.textContent = "Scroll sideways to see the whole diagram.";
      d.before(hint);
      ro.observe(d);
    }
  }

  // ---- "On this page" rail: highlight the section being read ----

  const rail = document.querySelector("[data-rail]");
  if (rail && "IntersectionObserver" in window) {
    const links = new Map();
    for (const a of rail.querySelectorAll('a[href^="#"]')) links.set(a.getAttribute("href").slice(1), a);
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting || !links.has(en.target.id)) continue;
          for (const a of links.values()) a.removeAttribute("aria-current");
          links.get(en.target.id).setAttribute("aria-current", "true");
        }
      },
      { rootMargin: "-25% 0px -65% 0px" }
    );
    for (const id of links.keys()) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
  }
})();
