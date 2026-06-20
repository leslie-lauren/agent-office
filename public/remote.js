// Agent Office — phone remote control.
// A lightweight, touch-first view of the same in-memory roster the pixel office
// shows. Talks to the existing API: GET /agents, the /ws live feed,
// POST /agent/:id/dismiss, POST /agent/:id/override (rename), POST /reset.
//
// When the server is reached over Tailscale it requires a token (see
// `./scripts/office remote on`). We accept it once via ?token=… in the URL,
// stash it in localStorage, then strip it from the address bar.
(function () {
  "use strict";

  // --- token bootstrap -------------------------------------------------------
  const params = new URLSearchParams(location.search);
  let TOKEN = params.get("token") || localStorage.getItem("office_token") || "";
  if (params.get("token")) {
    localStorage.setItem("office_token", TOKEN);
    history.replaceState(null, "", location.pathname); // keep the token out of history
  }

  function authHeaders(extra) {
    return Object.assign({}, extra, TOKEN ? { "x-office-token": TOKEN } : {});
  }
  async function api(path, opts) {
    opts = opts || {};
    opts.headers = authHeaders(opts.headers);
    const res = await fetch(path, opts);
    if (res.status === 401) {
      promptToken();
      throw new Error("unauthorized");
    }
    return res;
  }
  function promptToken() {
    const t = window.prompt("Access token for Agent Office:", "");
    if (t) {
      TOKEN = t.trim();
      localStorage.setItem("office_token", TOKEN);
      location.reload();
    }
  }

  // --- agent name derivation (mirrors public/office.js so labels match) ------
  function projectName(cwd) {
    const path = String(cwd);
    if (path.includes("local-agent-mode-sessions") || path.includes("claude-code-sessions")) return "";
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 2) return "";
    const seg = parts[parts.length - 1] || "";
    if (/^(desktop|documents|downloads|projects|outputs)$/i.test(seg)) return "";
    return seg;
  }
  function shortLabel(text) {
    if (!text) return "";
    let s = String(text).replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (s.includes(":")) s = s.split(":")[0].trim();
    else s = s.split(/\s+/).slice(0, 2).join(" ");
    s = s.replace(/^(using|ran|running|use)\s+/i, "").trim();
    return s.slice(0, 18).trim();
  }
  function deriveBase(a, m) {
    const goal = shortLabel(m.goal);
    if (a.source === "cowork" && goal) return goal;
    const proj = m.cwd ? projectName(m.cwd) : "";
    if (proj) return proj;
    if (goal) return goal;
    const task = shortLabel(a.task);
    if (task && !/^(session|thinking|active|finished|demo|waiting)$/i.test(task)) return task;
    return a.source === "cowork" ? "cowork" : a.source === "claude-code" ? "session" : "";
  }
  function displayName(a) {
    if (a.override && a.override.name) return a.override.name;
    const m = a.meta || {};
    const base = a.nameBase || (a.nameBase = deriveBase(a, m));
    if (!base) return a.agent_id;
    const rawId = a.agent_id.includes(":")
      ? a.agent_id.split(":").pop()
      : String(m.session_id || a.agent_id).replace(/^local_/, "");
    const suffix = String(rawId).replace(/[^a-z0-9]/gi, "").slice(0, 4);
    return suffix ? base + "·" + suffix : base;
  }

  // --- state -----------------------------------------------------------------
  const agents = new Map(); // agent_id -> record
  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
  const connDot = $("conn-dot");

  function upsert(rec) {
    if (!rec || !rec.agent_id) return;
    const prev = agents.get(rec.agent_id) || {};
    // keep the cached nameBase so the label doesn't flicker as the task changes
    const merged = Object.assign({}, prev, rec);
    if (rec.override === undefined && prev.override !== undefined) merged.override = prev.override;
    merged.nameBase = prev.nameBase;
    agents.set(rec.agent_id, merged);
  }

  // --- rendering -------------------------------------------------------------
  const STATE_LABEL = {
    needs_review: "Needs review",
    working: "Working",
    idle: "Idle",
    done: "Done",
  };
  // urgency order, top to bottom
  const GROUPS = ["needs_review", "working", "idle", "done"];

  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function render() {
    const all = Array.from(agents.values());
    if (all.length === 0) {
      listEl.innerHTML = '<p class="empty">No agents right now. Start a Claude session and it’ll appear here.</p>';
      return;
    }
    const byState = {};
    for (const g of GROUPS) byState[g] = [];
    for (const a of all) {
      const st = GROUPS.includes(a.state) ? a.state : a.archived ? "done" : "idle";
      byState[st].push(a);
    }
    // newest activity first within a group
    for (const g of GROUPS) {
      byState[g].sort((x, y) => (y.completedAt || y.lastSeen || y.timestamp || 0) - (x.completedAt || x.lastSeen || x.timestamp || 0));
    }

    let html = "";
    for (const g of GROUPS) {
      const items = byState[g];
      if (!items.length) continue;
      html += '<section class="group"><div class="group-title">' +
        esc(STATE_LABEL[g]) + '<span class="count">' + items.length + "</span></div>";
      for (const a of items) html += card(a, g);
      html += "</section>";
    }
    listEl.innerHTML = html;
  }

  function card(a, g) {
    const m = a.meta || {};
    const name = displayName(a);
    const task = a.task && a.task !== name ? a.task : a.summary || "";
    const when = relTime(a.completedAt || a.lastSeen || a.timestamp);
    const canDismiss = g === "idle" || g === "done";
    const metaBits = [];
    if (a.source) metaBits.push('<span class="src">' + esc(a.source) + "</span>");
    if (when) metaBits.push("<span>" + esc(when) + "</span>");

    let actions = '<button class="btn rename" data-id="' + esc(a.agent_id) + '">Rename</button>';
    actions += '<button class="btn dismiss" data-id="' + esc(a.agent_id) +
      '" data-force="' + (canDismiss ? "0" : "1") + '">Dismiss</button>';

    return (
      '<div class="card s-' + g + '">' +
        '<div class="card-top">' +
          '<div class="name">' + esc(name) + "</div>" +
          '<span class="pill s-' + g + '">' + esc(STATE_LABEL[g]) + "</span>" +
        "</div>" +
        (task ? '<div class="task">' + esc(task) + "</div>" : "") +
        '<div class="meta-row">' + metaBits.join('<span class="sep">·</span>') + "</div>" +
        '<div class="actions">' + actions + "</div>" +
      "</div>"
    );
  }

  // --- actions (event delegation) -------------------------------------------
  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    if (!id) return;
    const a = agents.get(id);

    if (btn.classList.contains("dismiss")) {
      const force = btn.getAttribute("data-force") === "1";
      if (force && !confirm("Dismiss an active agent “" + displayName(a) + "”?")) return;
      btn.disabled = true;
      try {
        await api("/agent/" + encodeURIComponent(id) + "/dismiss", { method: "POST" });
        agents.delete(id); // optimistic; the WS agent_remove confirms
        render();
        toast("Dismissed");
      } catch (_) { btn.disabled = false; }
      return;
    }

    if (btn.classList.contains("rename")) {
      const cur = (a && a.override && a.override.name) || "";
      const next = window.prompt("Name for this agent:", cur);
      if (next === null) return;
      try {
        await api("/agent/" + encodeURIComponent(id) + "/override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: next.trim() }),
        });
        if (a) { a.override = Object.assign({}, a.override, { name: next.trim() || undefined }); }
        render();
        toast("Saved");
      } catch (_) {}
    }
  });

  $("btn-reset").addEventListener("click", async () => {
    if (!confirm("Clear ALL agents from the office? Active sessions reappear on their next activity.")) return;
    try {
      await api("/reset", { method: "POST" });
      agents.clear();
      render();
      toast("Cleared");
    } catch (_) {}
  });

  // --- transient status toast ------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const el = $("statusbar");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  // --- live feed -------------------------------------------------------------
  function setConn(ok) {
    connDot.classList.toggle("live", ok);
    connDot.classList.toggle("down", !ok);
  }

  async function loadRoster() {
    try {
      const res = await api("/agents");
      const data = await res.json();
      agents.clear();
      (data.agents || []).forEach(upsert);
      render();
    } catch (_) {
      listEl.innerHTML = '<p class="empty">Can’t reach the office. Check it’s running and your token is correct.</p>';
    }
  }

  let ws = null;
  let retry = 0;
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "";
    ws = new WebSocket(proto + "://" + location.host + "/ws" + q);

    ws.onopen = () => { setConn(true); retry = 0; };
    ws.onclose = () => {
      setConn(false);
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * retry); // backoff, capped at 3s
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === "snapshot") {
        agents.clear();
        (msg.agents || []).forEach(upsert);
        render();
      } else if (msg.type === "agent_update") {
        upsert(msg.agent);
        render();
      } else if (msg.type === "agent_remove") {
        agents.delete(msg.agent_id);
        render();
      } else if (msg.type === "override_update") {
        const a = agents.get(msg.agent_id);
        if (a) { a.override = msg.override || {}; render(); }
      }
    };
  }

  // periodic re-render so relative timestamps stay fresh
  setInterval(() => { if (agents.size) render(); }, 30000);

  loadRoster();
  connect();
})();
