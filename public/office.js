// The office view. Connects over WebSocket, keeps a local map of agents, and
// renders each as an animated pixel character.
//
// FLOOR PLAN (see DESKS in characters.js): three fixed areas. Two of them —
// CODING and KNOWLEDGE WORK — hold a row of STATIC desks. Agents are routed to a
// cluster by TYPE (Claude Code → coding, Cowork → knowledge), walk there
// carrying a laptop, and sit down. The full-width LOUNGE (merged breakroom +
// done) holds both idle agents (resting) and finished sessions, which linger
// there with a summary until you dismiss them (they no longer vanish).
//
// This file is purely presentational: it never decides state, it only
// places/animates/labels what the server tells it. Notes:
//   • Cowork agents (document emblem, routed to Knowledge Work)
//   • persistent lounge/Done tray + dismiss
//   • click/double-click to rename (persisted server-side)
//   • each agent's look (incl. t-shirt color) is unique, generated from its id
//   • static desks + walk-to-desk movement with a carried laptop
//   • bigger, outlined text everywhere for legibility

(function () {
  const { styleForState, sourceStyle, appearance, DESKS, deskClusterFor } = window.AgentChars;

  const canvas = document.getElementById("office");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const connDot = document.getElementById("conn-dot");
  const connText = document.getElementById("conn-text");
  const countEl = document.getElementById("count");
  const reviewPill = document.getElementById("review-pill");
  const emptyHint = document.getElementById("empty-hint");
  const tooltip = document.getElementById("tooltip");
  const panel = document.getElementById("panel");

  const agents = new Map();
  let order = 0;
  let hoveredId = null;
  let selectedId = null;
  let focusEnabled = false;

  // Per-cluster desk occupancy, rebuilt every reflow(): deskMap[clusterKey][i]
  // = the agent sitting at desk i (or undefined). Drives where static desk
  // furniture lights up.
  let deskMap = { coding: [], knowledge: [] };

  // --- canvas sizing --------------------------------------------------------
  let W = 0, H = 0;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    reflow(); // layout depends on canvas size
  }
  window.addEventListener("resize", resize);

  const DOOR = () => ({ x: 24, y: H - 24 });

  // --- AREAS: three labeled regions of the floor ----------------------------
  // Two desk clusters across the top row; one full-width LOUNGE (merged
  // breakroom + done) across the bottom, with room for both resting and
  // finished agents.
  function areas() {
    const pad = 16, topY = 48;
    const colW = (W - pad * 3) / 2;
    const rowH = (H - topY - pad * 2) / 2;
    return {
      coding:    { ...DESKS.coding,    x: pad,            y: topY,              w: colW,        h: rowH },
      knowledge: { ...DESKS.knowledge, x: pad * 2 + colW, y: topY,              w: colW,        h: rowH },
      lounge:    { ...DESKS.lounge,    x: pad,            y: topY + rowH + pad,  w: W - pad * 2, h: rowH },
    };
  }

  // A shared grid inside an area. Desks AND agent slots use the same metric so a
  // seated agent lines up exactly with the static desk drawn at that index.
  function gridPos(area, i) {
    const cellW = 124, cellH = 116;
    const cols = Math.max(1, Math.floor((area.w - 24) / cellW));
    const c = i % cols, r = Math.floor(i / cols);
    return {
      x: area.x + 30 + c * cellW + cellW / 2,
      y: area.y + 78 + r * cellH, // feet baseline
    };
  }

  // Which AREA an agent currently belongs in (the heart of the movement logic).
  function areaKeyFor(a) {
    if (a.archived || a.state === "done") return "lounge"; // finished → parked in lounge
    if (a.state === "idle") return "lounge";               // quiet → lounge
    return deskClusterFor(a);                               // working/needs_review → a desk
  }

  // Group agents into areas, sort by first-seen, assign each a slot/desk, and
  // set the walk target. A state/type change moves the agent to a new area — so
  // it walks there. Also rebuilds deskMap for desk rendering.
  function reflow() {
    const A = areas();
    const buckets = { coding: [], knowledge: [], lounge: [] };
    Array.from(agents.values())
      .sort((a, b) => a.order - b.order)
      .forEach((a) => { if (!a.leaving) buckets[areaKeyFor(a)].push(a); });

    deskMap = { coding: [], knowledge: [] };
    for (const key of Object.keys(buckets)) {
      const area = A[key];
      buckets[key].forEach((a, i) => {
        const p = gridPos(area, i);
        a.seat = p; a.tx = p.x; a.ty = p.y; a.areaKey = key; a.slotIndex = i;
        // Seated at a real desk only in a cluster area within its desk count.
        a.atDesk = area.kind === "cluster" && i < area.count;
        if (a.atDesk) deskMap[key][i] = a;
      });
    }
  }

  function ensureAgent(rec) {
    const prev = agents.get(rec.agent_id);
    if (prev) {
      const wasDone = prev.state === "done" || prev.archived;
      prev.state = rec.state; prev.task = rec.task; prev.source = rec.source;
      prev.timestamp = rec.timestamp;
      prev.archived = !!rec.archived; prev.summary = rec.summary;
      prev.completedAt = rec.completedAt;
      prev.meta = Object.assign({}, prev.meta, rec.meta || {});
      if (rec.override !== undefined) prev.override = rec.override;
      if ((rec.state === "done" || rec.archived) && !wasDone) prev.cheerT = 0;
    } else {
      const door = DOOR();
      agents.set(rec.agent_id, {
        ...rec, meta: rec.meta || {}, order: order++,
        seat: { x: door.x, y: door.y }, rx: door.x, ry: door.y, tx: door.x, ty: door.y,
        facing: 1, walking: true, walkPhase: 0,
        blink: 0, nextBlink: 1.5 + Math.random() * 3, cheerT: 0,
        appearance: appearance(rec.agent_id),
        box: null,
      });
    }
    reflow(); updateHud();
    if (rec.agent_id === selectedId) renderPanel();
  }

  // Update an agent's override locally (after a rename/recolor) without waiting
  // for the server echo, so the UI feels instant.
  function applyOverride(id, override) {
    const a = agents.get(id);
    if (!a) return;
    a.override = override || {};
    reflow();
    if (id === selectedId) renderPanel();
  }

  // A character walks to the door, then is removed (capped/dismissed Done items
  // or stale ghosts). Robust to rapid open/close via server tombstones.
  function beginLeave(id) {
    const a = agents.get(id);
    if (!a) return;
    a.leaving = true;
    const door = DOOR();
    a.tx = door.x; a.ty = door.y; a.atDesk = false;
  }

  // The project-folder name, IF it carries a useful signal. The bare home
  // directory (/Users/<name>) and generic roots don't — they'd just label every
  // local session after the username, so we skip them.
  function projectName(cwd) {
    const path = String(cwd);
    // Cowork runs in a sandboxed store path, not a real project folder.
    if (path.includes("local-agent-mode-sessions") || path.includes("claude-code-sessions")) return "";
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 2) return "";                          // /Users/<name> → home, no project
    const seg = parts[parts.length - 1] || "";
    if (/^(desktop|documents|downloads|projects|outputs)$/i.test(seg)) return "";
    return seg;
  }

  // A short, human label pulled from what the agent is working on — used when
  // there's no project folder to name it after. Cowork titles often read
  // "TOPIC: detail" (keep TOPIC); otherwise take the first couple of words.
  function shortLabel(text) {
    if (!text) return "";
    let s = String(text).replace(/^[^\p{L}\p{N}]+/u, "").trim();  // strip leading emoji/symbols
    if (s.includes(":")) s = s.split(":")[0].trim();
    else s = s.split(/\s+/).slice(0, 2).join(" ");
    s = s.replace(/^(using|ran|running|use)\s+/i, "").trim();     // drop filler verbs
    return s.slice(0, 18).trim();
  }

  // Pick a stable base name for an agent: a real project folder first, then the
  // Cowork goal / current task, then a neutral fallback. Never the username.
  function deriveBase(a, m) {
    const goal = shortLabel(m.goal);
    // Cowork/chat title/goal is the most meaningful label (cwd is a sandbox).
    if ((a.source === "cowork" || a.source === "chat") && goal) return goal;
    const proj = m.cwd ? projectName(m.cwd) : "";
    if (proj) return proj;
    if (goal) return goal;
    const task = shortLabel(a.task);
    if (task && !/^(session|thinking|active|finished|demo|waiting)$/i.test(task)) return task;
    return a.source === "cowork" ? "cowork"
      : a.source === "chat" ? "chat"
      : a.source === "claude-code" ? "session" : "";
  }

  // Friendly per-agent label. A user-set custom name always wins; otherwise we
  // build one from a relevant base (project / what it's working on) + short
  // session id so sessions are distinct ("freefrom·b67a", "Drink menu·9c2d").
  // The base is computed once and cached so the label doesn't flicker as the
  // current task changes.
  function displayName(a) {
    if (a.override && a.override.name) return a.override.name;
    const m = a.meta || {};
    if (!a.nameBase) a.nameBase = deriveBase(a, m);
    if (!a.nameBase) return a.agent_id;
    // Short unique tag. agent_id is already a clean short id ("cowork:0798fc54",
    // "claude:3283615d"); use the part after the colon so Cowork ids don't all
    // collapse to "loca" (from the "local_" session-id prefix).
    const rawId = a.agent_id.includes(":")
      ? a.agent_id.split(":").pop()
      : String(m.session_id || a.agent_id).replace(/^local_/, "");
    const suffix = String(rawId).replace(/[^a-z0-9]/gi, "").slice(0, 4);
    // Keep the whole label compact: base capped so base + "·" + tag fits the
    // small name plate without truncating the unique tag away.
    const base = a.nameBase.length > 9 ? a.nameBase.slice(0, 9).trim() : a.nameBase;
    return suffix ? `${base}·${suffix}` : base;
  }

  // T-shirt color. Code agents wear blue and Cowork agents wear orange (their
  // type's shirt); every other source gets a unique-per-agent color from its id.
  // A legacy saved override still wins.
  function shirtColor(a) {
    if (a.override && a.override.shirt) return a.override.shirt;
    if (a.source === "claude-code" || a.source === "cowork" || a.source === "chat")
      return sourceStyle(a.source).shirt;
    return (a.appearance || appearance(a.agent_id)).shirt;
  }

  function reviewCount() { let n = 0; for (const a of agents.values()) if (a.state === "needs_review") n++; return n; }
  function doneCount() { let n = 0; for (const a of agents.values()) if (a.archived) n++; return n; }
  function updateHud() {
    countEl.textContent = agents.size === 1 ? "1 agent" : `${agents.size} agents`;
    const n = reviewCount();
    reviewPill.textContent = `${n} need${n === 1 ? "s" : ""} review`;
    reviewPill.classList.toggle("hidden", n === 0);
    emptyHint.classList.toggle("hidden", agents.size > 0);
    const clr = document.getElementById("clear-done");
    if (clr) clr.classList.toggle("hidden", doneCount() === 0);
  }

  // --- movement + animation -------------------------------------------------
  const SPEED = 165; // pixels/sec — brisk walk across the floor
  function update(dt) {
    const gone = [];
    for (const a of agents.values()) {
      const dx = a.tx - a.rx, dy = a.ty - a.ry, dist = Math.hypot(dx, dy);
      if (dist > 1.5) {
        a.walking = true;
        const step = Math.min(dist, SPEED * dt);
        a.rx += (dx / dist) * step; a.ry += (dy / dist) * step;
        a.facing = dx >= 0 ? 1 : -1; a.walkPhase += dt * 13; // quicker stride to match
      } else { a.walking = false; a.rx = a.tx; a.ry = a.ty; a.facing = 1; }
      a.nextBlink -= dt;
      if (a.nextBlink <= 0) { a.blink = 0.12; a.nextBlink = 1.5 + Math.random() * 3.5; }
      if (a.blink > 0) a.blink -= dt;
      a.cheerT += dt;
      if (a.leaving && !a.walking) gone.push(a.agent_id); // reached the door
    }
    for (const id of gone) {
      agents.delete(id);
      if (selectedId === id) { selectedId = null; panel.classList.add("hidden"); }
    }
    if (gone.length) { reflow(); updateHud(); }
  }

  function px(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(x | 0, y | 0, w, h); }

  // Text with a dark outline — the single biggest legibility win on the busy
  // pixel floor. Used for every canvas label and title.
  function outlineText(txt, x, y, fill, font, align, lw) {
    ctx.font = font; ctx.textAlign = align || "left"; ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round"; ctx.lineWidth = lw || 3; ctx.strokeStyle = "rgba(8,10,16,0.9)";
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = fill; ctx.fillText(txt, x, y);
  }

  // --- room + areas ---------------------------------------------------------
  function drawRoom(t) {
    // wall + floor
    px(0, 0, W, 38, "#3b4660"); px(0, 34, W, 4, "#2b3347");
    const plank = 26;
    for (let y = 38; y < H; y += plank) {
      px(0, y, W, plank, ((y / plank) | 0) % 2 === 0 ? "#caa06a" : "#c0975f");
      px(0, y, W, 2, "#b78a52");
    }
    const A = areas();
    for (const key of Object.keys(A)) drawArea(A[key], key, t);
    drawFurniture(A, t);
    drawBreakroomLife(A.lounge, t);
  }

  function drawArea(z, key, t) {
    // rug/fill (a touch stronger than before for contrast)
    ctx.fillStyle = hexA(z.accent, 0.08); ctx.fillRect(z.x, z.y, z.w, z.h);
    // pulsing border if anyone here needs review (catches the eye)
    const alert = key !== "lounge" && Array.from(agents.values())
      .some((a) => !a.leaving && areaKeyFor(a) === key && a.state === "needs_review");
    let a = 0.7;
    if (alert) a = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t / 160));
    ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = alert ? "#ff5252" : z.accent;
    ctx.lineWidth = alert ? 3 : 2; ctx.setLineDash(alert ? [] : [6, 5]);
    ctx.strokeRect(z.x + 1, z.y + 1, z.w - 2, z.h - 2);
    ctx.restore(); ctx.setLineDash([]);
    // title bar — dark underlay + outlined text for max legibility
    const label = z.title;
    ctx.font = "bold 15px ui-monospace, monospace";
    const tw = ctx.measureText(label).width;
    px(z.x + 8, z.y + 6, tw + 16, 22, "rgba(10,13,20,0.66)");
    outlineText(label, z.x + 16, z.y + 22, z.accent, "bold 15px ui-monospace, monospace", "left");
    // static desks for cluster areas (drawn even when empty)
    if (z.kind === "cluster") drawClusterDesks(z, t, false);
  }

  function hexA(hex, alpha) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  // Static desks for a cluster: a desk at every grid index up to `count`,
  // occupied or not. `front` toggles back (legs/top) vs front (monitor) pass so
  // seated characters tuck in behind the monitor like the original look.
  function drawClusterDesks(z, t, front) {
    for (let i = 0; i < z.count; i++) {
      const p = gridPos(z, i);
      const occ = deskMap[z.key][i];
      const lit = occ && !occ.walking && (occ.state === "working" || occ.state === "needs_review");
      if (!front) drawDeskBack(p);
      else {
        const s = lit ? styleForState(occ.state) : { glow: "#1d2433", screenOn: false };
        drawDeskFront(p, lit, lit ? s.glow : "#22304a", t);
      }
    }
  }

  function drawWatercooler(x, y, t) {
    px(x - 8, y - 30, 16, 22, "#bfe3ff"); // bottle
    px(x - 8, y - 30, 16, 6, "#9fd0f2");
    px(x - 10, y - 8, 20, 14, "#dfe6ee"); // dispenser
    px(x - 6, y - 4, 5, 4, "#3fa7ff"); px(x + 1, y - 4, 5, 4, "#ff5252"); // taps
    const b = (Math.sin(t / 300) + 1) * 4;
    px(x - 2, y - 24 + b, 2, 2, "#ffffff");
  }

  function drawPlant(x, y, t, seed) {
    px(x - 9, y, 18, 12, "#9b5a2b"); px(x - 9, y, 18, 3, "#b06a34");
    const sway = Math.sin(t / 700 + seed) * 1.5;
    px(x - 2, y - 14, 4, 16, "#2f7d34");
    px(x - 10 + sway, y - 20, 9, 9, "#3fa047");
    px(x + 2 + sway, y - 24, 9, 11, "#46b350");
    px(x - 4 - sway, y - 28, 9, 9, "#3fa047");
  }

  // --- a head with per-character hair/skin/accessories (shared) -------------
  function drawHead(cx, y, app, blink) {
    px(cx - 9, y, 18, 18, app.skin); // face
    const hc = app.hairColor;
    switch (app.hairStyle) {
      case "bald": px(cx - 9, y, 3, 5, hc); px(cx + 6, y, 3, 5, hc); break;
      case "spiky":
        px(cx - 9, y, 18, 4, hc);
        for (let i = 0; i < 4; i++) px(cx - 8 + i * 5, y - 3, 3, 4, hc);
        break;
      case "bun": px(cx - 9, y, 18, 5, hc); px(cx - 3, y - 5, 6, 5, hc); break;
      case "long": px(cx - 9, y, 18, 5, hc); px(cx - 9, y, 3, 17, hc); px(cx + 6, y, 3, 17, hc); break;
      case "cap": px(cx - 10, y - 1, 20, 5, hc); px(cx - 10, y + 3, 9, 3, hc); break;
      case "mohawk": px(cx - 9, y, 18, 3, hc); px(cx - 2, y - 5, 4, 7, hc); break;
      case "ponytail": px(cx - 9, y, 18, 5, hc); px(cx + 7, y + 2, 3, 11, hc); px(cx + 6, y + 12, 4, 3, hc); break;
      case "afro": px(cx - 11, y - 4, 22, 9, hc); px(cx - 9, y, 4, 6, hc); px(cx + 5, y, 4, 6, hc); break;
      case "curly":
        px(cx - 10, y - 1, 20, 5, hc);
        for (let i = 0; i < 5; i++) px(cx - 10 + i * 4, y - 3, 4, 4, hc);
        break;
      default: px(cx - 9, y, 18, 5, hc); // short
    }
    if (blink > 0) { px(cx - 6, y + 9, 4, 2, "#11151f"); px(cx + 2, y + 9, 4, 2, "#11151f"); }
    else { px(cx - 6, y + 8, 3, 3, "#11151f"); px(cx + 3, y + 8, 3, 3, "#11151f"); }
    if (app.accessory === "glasses") {
      const c = "#1b2330";
      px(cx - 8, y + 7, 6, 1, c); px(cx - 8, y + 11, 6, 1, c); px(cx - 8, y + 7, 1, 5, c); px(cx - 3, y + 7, 1, 5, c);
      px(cx + 2, y + 7, 6, 1, c); px(cx + 2, y + 11, 6, 1, c); px(cx + 2, y + 7, 1, 5, c); px(cx + 7, y + 7, 1, 5, c);
      px(cx - 2, y + 8, 4, 1, c);
    } else if (app.accessory === "headphones") {
      px(cx - 11, y + 4, 3, 8, "#222"); px(cx + 8, y + 4, 3, 8, "#222"); px(cx - 9, y - 3, 18, 3, "#222");
    } else if (app.accessory === "beanie") {
      px(cx - 10, y - 3, 20, 6, "#c0392b"); px(cx - 10, y + 2, 20, 2, "#9a2d22"); px(cx - 2, y - 6, 4, 3, "#e0594c");
    } else if (app.accessory === "visor") {
      px(cx - 10, y + 2, 20, 3, "#1b2330"); px(cx - 11, y + 5, 22, 2, "#11161f");
    } else if (app.accessory === "earring") {
      px(cx + 8, y + 11, 2, 3, "#ffd54a");
    }
  }

  // --- type emblem on the t-shirt (pixel art, crisp at any zoom) -------------
  // Code agents wear </> brackets; Cowork agents wear a little document. This is
  // the at-a-glance "what kind of agent is this" cue.
  function drawEmblem(cx, cy, kind, color) {
    const c = color || "#ffffff";
    switch (kind) {
      case "code": // </>  brackets
        px(cx - 6, cy - 1, 2, 2, c); px(cx - 8, cy + 1, 2, 2, c); px(cx - 6, cy + 3, 2, 2, c);
        px(cx + 4, cy - 1, 2, 2, c); px(cx + 6, cy + 1, 2, 2, c); px(cx + 4, cy + 3, 2, 2, c);
        px(cx - 1, cy - 2, 2, 8, c); // slash
        break;
      case "chat": { // speech bubble (Cowork / collaboration) — small + clean
        const b = c, dot = "#5c3210";
        px(cx - 6, cy - 5, 12, 8, b);   // bubble body
        px(cx - 5, cy + 3, 4, 3, b);    // tail
        px(cx - 4, cy - 2, 2, 2, dot); px(cx - 1, cy - 2, 2, 2, dot); px(cx + 2, cy - 2, 2, 2, dot); // "…"
        break;
      }
      case "doc": // a sheet with text lines
        px(cx - 5, cy - 4, 10, 12, "#f4f7fb"); px(cx - 5, cy - 4, 10, 1, c);
        px(cx - 3, cy - 1, 6, 1, c); px(cx - 3, cy + 1, 6, 1, c); px(cx - 3, cy + 3, 4, 1, c);
        px(cx + 2, cy - 4, 3, 3, c); // folded corner
        break;
      case "loop": // routine
        px(cx - 4, cy - 4, 8, 2, c); px(cx + 2, cy - 4, 2, 5, c); px(cx - 4, cy + 2, 8, 2, c); px(cx - 4, cy - 2, 2, 5, c);
        break;
      case "star":
        px(cx - 1, cy - 5, 2, 10, c); px(cx - 5, cy - 1, 10, 2, c); px(cx - 3, cy - 3, 6, 6, c);
        break;
      case "pen":
        px(cx - 4, cy + 3, 3, 3, c); px(cx - 2, cy + 1, 3, 3, c); px(cx, cy - 1, 3, 3, c); px(cx + 2, cy - 3, 3, 3, c);
        break;
      default:
        px(cx - 2, cy - 2, 4, 4, c);
    }
  }

  // --- furniture & decor ----------------------------------------------------
  function drawRug(x, y, w, h, c) {
    px(x, y, w, h, c); px(x, y, w, 2, "rgba(255,255,255,.18)"); px(x, y + h - 2, w, 2, "rgba(0,0,0,.18)");
  }
  function drawBookshelf(x, y) {
    px(x, y, 38, 52, "#6b4a2b");
    const books = ["#c0392b", "#2980b9", "#27ae60", "#f1c40f", "#8e44ad", "#e67e22", "#16a085"];
    for (let r = 0; r < 3; r++) {
      const sy = y + 4 + r * 16;
      px(x + 3, sy + 12, 32, 3, "#5b3a1a");
      let bx = x + 4, i = r;
      while (bx < x + 34) {
        const bw = 3 + ((i * 7) % 3), bh = 9 + ((i * 5) % 4);
        px(bx, sy + 12 - bh, bw, bh, books[i % books.length]);
        bx += bw + 1; i++;
      }
    }
  }
  function drawWhiteboard(x, y) {
    px(x - 1, y - 1, 56, 36, "#8a8f99"); px(x + 1, y + 1, 52, 32, "#eef2f7");
    px(x + 6, y + 7, 26, 2, "#e74c3c"); px(x + 6, y + 13, 34, 2, "#3498db");
    px(x + 6, y + 19, 20, 2, "#2ecc71"); px(x + 30, y + 19, 12, 2, "#9b59b6");
    px(x + 6, y + 25, 30, 2, "#34495e"); px(x + 16, y + 34, 24, 3, "#cfd4db");
  }
  function drawCouch(x, y) {
    px(x, y - 12, 58, 14, "#3f5b8a"); px(x, y, 58, 12, "#4a6aa0");
    px(x - 4, y - 10, 6, 22, "#37507a"); px(x + 56, y - 10, 6, 22, "#37507a");
    px(x + 6, y, 22, 4, "#5a7cb8"); px(x + 30, y, 22, 4, "#5a7cb8");
  }
  function drawCoffee(x, y, t) {
    px(x, y, 22, 26, "#cfd6e0"); px(x + 2, y + 2, 18, 8, "#11151f"); px(x + 4, y + 4, 4, 4, "#37d67a");
    px(x + 7, y + 16, 8, 7, "#ffffff");
    const s = (Math.sin(t / 300) + 1) * 2;
    px(x + 10, y + 10 - s, 2, 3, "rgba(255,255,255,.5)");
    px(x - 1, y + 26, 24, 3, "#9aa3b2");
  }
  function drawTV(x, y, t) {
    px(x, y, 46, 28, "#11151f");
    const bars = ["#e74c3c", "#f1c40f", "#2ecc71", "#3498db", "#9b59b6"];
    for (let i = 0; i < 5; i++) px(x + 3 + i * 8, y + 3, 7, 22, bars[(i + Math.floor(t / 500)) % bars.length]);
    px(x + 18, y + 28, 10, 4, "#444");
  }
  function drawFramedPic(x, y) {
    px(x, y, 26, 20, "#caa46a"); px(x + 2, y + 2, 22, 16, "#bfe3ff");
    px(x + 4, y + 12, 18, 4, "#3fa047"); px(x + 14, y + 5, 5, 5, "#ffd27f");
  }
  function drawPingPongTable(cx, cy) {
    px(cx - 42, cy, 84, 8, "#1e7a4a"); px(cx - 42, cy, 84, 2, "#2a9d62");
    px(cx - 1, cy - 8, 2, 8, "#ffffff"); px(cx - 40, cy - 5, 80, 1, "#ffffff");
    px(cx - 38, cy + 8, 4, 14, "#176038"); px(cx + 34, cy + 8, 4, 14, "#176038");
  }

  function drawFurniture(A, t) {
    const c = A.coding, k = A.knowledge, l = A.lounge;
    drawBookshelf(c.x + c.w - 44, c.y + 30);
    drawWhiteboard(k.x + k.w - 64, k.y + 32);
    drawPlant(k.x + 18, k.y + k.h - 8, t, 3);
    // Merged lounge: breakroom comforts spread along the left, the "done"
    // corner (couch + framed photo) on the right.
    drawTV(l.x + 14, l.y + 42, t);
    drawCoffee(l.x + 66, l.y + 48, t);
    drawWatercooler(l.x + 120, l.y + l.h - 22, t);
    drawCouch(l.x + l.w - 78, l.y + l.h - 26);
    drawFramedPic(l.x + l.w - 44, l.y + 30);
    drawPlant(l.x + 16, l.y + l.h - 8, t, 7);
    drawPlant(l.x + l.w - 120, l.y + l.h - 8, t, 5);
  }

  // --- breakroom mascots: always-there interns rallying a ping-pong ball ----
  const PONG_PERIOD = 1500;
  const mascotL = { shirt: "#ff8a65", app: { skin: "#f3d2b3", hairColor: "#2b2320", hairStyle: "spiky", accessory: "none" } };
  const mascotR = { shirt: "#4dd0e1", app: { skin: "#c98a5e", hairColor: "#5b3a1a", hairStyle: "bun", accessory: "none" } };
  const mascotC = { shirt: "#aed581", app: { skin: "#e8b98f", hairColor: "#7a5230", hairStyle: "long", accessory: "glasses" } };

  function drawSimplePerson(cx, feetY, shirt, app, opts) {
    opts = opts || {};
    const top = feetY - 42, yo = opts.bob || 0;
    px(cx - 7, feetY - 12 + yo, 5, 12, "#33405e"); px(cx + 2, feetY - 12 + yo, 5, 12, "#33405e");
    px(cx - 8, feetY - 1 + yo, 7, 3, "#222"); px(cx + 1, feetY - 1 + yo, 7, 3, "#222");
    px(cx - 11, top + 18 + yo, 22, 22, shirt); px(cx - 11, top + 18 + yo, 22, 3, "rgba(255,255,255,.15)");
    if (opts.paddle) {
      const side = opts.side === "L" ? -1 : 1, raise = opts.raise || 0;
      const ax = cx + side * 13, ay = top + 22 + yo - raise * 9;
      px(cx - side * 13 - 2, top + 22 + yo, 4, 12, shirt);
      px(ax - 2, ay, 4, 12 - raise * 4, shirt);
      px(ax - 4 + side * 3, ay - 7, 9, 9, "#c0392b");
    } else if (opts.cup) {
      px(cx - 14, top + 20 + yo, 4, 12, shirt); px(cx + 10, top + 22 + yo, 4, 10, shirt);
      px(cx + 11, top + 19 + yo, 5, 5, "#ffffff");
    } else {
      px(cx - 14, top + 20 + yo, 4, 12, shirt); px(cx + 10, top + 20 + yo, 4, 12, shirt);
    }
    drawHead(cx, top + yo, app, opts.blink || 0);
  }

  function drawBreakroomLife(z, t) {
    if (!z) return;
    const tableCx = z.x + z.w * 0.44, tableCy = z.y + z.h * 0.7, feetY = tableCy + 20;
    drawPingPongTable(tableCx, tableCy);
    const p = (t % PONG_PERIOD) / PONG_PERIOD;
    const goingRight = p < 0.5;
    const seg = goingRight ? p / 0.5 : (p - 0.5) / 0.5;
    const bx = goingRight ? (tableCx - 40) + seg * 80 : (tableCx + 40) - seg * 80;
    const by = tableCy - 6 - Math.sin(Math.PI * seg) * 20;
    const leftRaise = goingRight ? Math.max(0, 1 - seg * 4) : 0;
    const rightRaise = !goingRight ? Math.max(0, 1 - seg * 4) : 0;
    drawSimplePerson(tableCx - 60, feetY, mascotL.shirt, mascotL.app, { paddle: true, side: "R", raise: leftRaise });
    drawSimplePerson(tableCx + 60, feetY, mascotR.shirt, mascotR.app, { paddle: true, side: "L", raise: rightRaise });
    px(bx - 1, tableCy - 1, 3, 1, "rgba(0,0,0,.25)");
    px(bx - 2, by - 2, 4, 4, "#ffffff");
    drawSimplePerson(z.x + z.w - 30, z.y + 74, mascotC.shirt, mascotC.app, { cup: true, bob: Math.sin(t / 800) });
  }

  function drawDeskBack(d) { px(d.x - 14, d.y - 6, 28, 8, "#444b5e"); px(d.x - 14, d.y - 6, 28, 2, "#566079"); }
  function drawDeskFront(d, screenOn, glow, t) {
    const top = d.y + 14;
    px(d.x - 46, top, 92, 11, "#7a5230"); px(d.x - 46, top, 92, 3, "#8c5f38");
    px(d.x - 42, top + 11, 6, 18, "#5e3f24"); px(d.x + 36, top + 11, 6, 18, "#5e3f24");
    px(d.x + 12, top - 22, 28, 20, "#11151f");
    px(d.x + 15, top - 19, 22, 14, screenOn ? (glow || "#0a84ff") : (glow || "#1d2433"));
    if (screenOn) px(d.x + 17, top - 17 + (Math.floor(t / 220) % 3) * 4, 14, 2, "rgba(255,255,255,.5)");
    px(d.x - 28, top + 2, 24, 5, "#cfd4df");
  }

  // A laptop the character carries while walking between desks.
  function drawLaptop(cx, y, color) {
    px(cx - 9, y, 18, 3, "#8c93a3");     // base
    px(cx - 8, y - 8, 16, 8, "#2b3346"); // lid
    px(cx - 6, y - 6, 12, 5, color || "#3fa7ff"); // screen glow tinted by type
  }

  // --- character ------------------------------------------------------------
  function drawCharacter(a, t) {
    const style = styleForState(a.state);
    const src = sourceStyle(a.source);
    const body = shirtColor(a);
    const seated = !a.walking && a.atDesk;
    const cx = a.rx, feetY = a.ry;
    let bob = 0, squash = 0, armPump = 0;

    if (a.walking) bob = Math.abs(Math.sin(a.walkPhase)) * 1.5;
    else if (style.anim === "typing") { bob = Math.sin(t / 170) * 1.2; armPump = Math.sin(t / 90); }
    else if (style.anim === "breathe") squash = Math.sin(t / 900) * 0.8;
    else if (style.anim === "cheer") bob = -Math.abs(Math.sin(a.cheerT * 6)) * Math.max(0, 1 - a.cheerT / 2) * 7;
    else if (style.anim === "alert") bob = -Math.abs(Math.sin(t / 160)) * 3;

    const top = feetY - 42, yo = bob - squash;

    // selection/hover ring
    if (a.agent_id === selectedId || a.agent_id === hoveredId) {
      ctx.save(); ctx.globalAlpha = a.agent_id === selectedId ? 0.9 : 0.5;
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(cx, feetY + 2, 22, 7, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    if (style.glow) {
      let alpha = 0.32;
      if (style.anim === "alert") alpha = 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t / 150));
      ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = style.glow;
      ctx.beginPath(); ctx.ellipse(cx, feetY + 2, 20, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }

    if (!seated) {
      const swing = Math.sin(a.walkPhase) * (a.walking ? 4 : 0);
      px(cx - 7, feetY - 12 + yo, 5, 12 + swing * a.facing * 0.3, "#33405e");
      px(cx + 2, feetY - 12 + yo, 5, 12 - swing * a.facing * 0.3, "#33405e");
      px(cx - 8, feetY - 1 + yo + swing, 7, 3, "#222");
      px(cx + 1, feetY - 1 + yo - swing, 7, 3, "#222");
    }
    px(cx - 11, top + 18 + yo, 22, 22 + squash, body);
    px(cx - 11, top + 18 + yo, 22, 3, "rgba(255,255,255,.15)");

    const app = a.appearance || appearance(a.agent_id);
    if (a.walking) {
      // arms forward, holding a laptop (carrying it to the desk)
      px(cx - 13, top + 22 + yo, 4, 10, body); px(cx + 9, top + 22 + yo, 4, 10, body);
      drawLaptop(cx, top + 30 + yo, src.color);
    } else if (style.anim === "typing") {
      const tap = armPump > 0 ? 2 : 0;
      px(cx - 14, top + 22 + yo, 4, 10, body); px(cx + 10, top + 22 + yo, 4, 10, body);
      px(cx - 12, top + 30 + yo + tap, 5, 4, app.skin); px(cx + 8, top + 30 + yo + (2 - tap), 5, 4, app.skin);
    } else {
      px(cx - 14, top + 20 + yo, 4, 14, body); px(cx + 10, top + 20 + yo, 4, 14, body);
    }

    // type emblem on the chest (skip while walking so the laptop reads clearly)
    if (!a.walking) drawEmblem(cx, top + 28 + yo, src.emblem, "#ffffff");

    drawHead(cx, top + yo, app, a.blink);

    // state badge above the head
    const flash = style.anim === "alert" ? 0.5 + 0.5 * Math.sin(t / 150) : 1;
    ctx.save(); ctx.globalAlpha = flash;
    outlineText(style.badge, cx, top - 6 + yo, style.badgeColor, "bold 16px ui-monospace, monospace", "center", 3);
    ctx.restore();

    a.box = { x: cx - 18, y: top - 16 + yo, w: 36, h: 64 - yo };
  }

  // Label PINNED TO THE AGENT — travels with the character (below the feet).
  // Header = name; subheader = status. The plate BORDER is the status color
  // (green=done, blue=working, red=needs review, gray=idle) — no type stripe.
  function drawLabel(a) {
    const cx = a.rx, y = a.ry + 10;
    const style = styleForState(a.state);
    const bc = style.badgeColor || "#cdd4e0";
    const w = 96, h = 24;
    px(cx - w / 2, y, w, h, "#0c0f17");
    ctx.strokeStyle = bc; ctx.lineWidth = 1;
    ctx.strokeRect(cx - w / 2 + 0.5, y + 0.5, w - 1, h - 1);
    outlineText(truncate(displayName(a), 14), cx, y + 10, "#ffffff", "bold 9px ui-monospace, monospace", "center", 2);
    outlineText(style.label, cx, y + 19, bc, "8px ui-monospace, monospace", "center", 2);
    a.labelBox = { x: cx - w / 2, y, w, h };
  }

  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // --- loop -----------------------------------------------------------------
  let last = 0;
  function frame(t) {
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 0; last = t;
    update(dt);
    drawRoom(t); // includes static desk BACKS + furniture + breakroom life
    drawPlant(W - 22, 36, t, 2);

    const list = Array.from(agents.values()).sort((p, q) => p.ry - q.ry);
    for (const a of list) drawCharacter(a, t);
    // desk FRONTS over seated characters so they tuck behind the monitor
    const A = areas();
    drawClusterDesks(A.coding, t, true);
    drawClusterDesks(A.knowledge, t, true);
    for (const a of list) drawLabel(a); // labels on top, pinned to each agent
    requestAnimationFrame(frame);
  }

  // --- interaction ----------------------------------------------------------
  function agentAt(mx, my) {
    const list = Array.from(agents.values()).sort((p, q) => q.ry - p.ry);
    for (const a of list) {
      const b = a.box, l = a.labelBox;
      if (b && mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return a;
      if (l && mx >= l.x && mx <= l.x + l.w && my >= l.y && my <= l.y + l.h) return a;
    }
    return null;
  }

  function relTime(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 2) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
  function clockTime(ts) { try { return new Date(ts).toLocaleTimeString(); } catch { return ""; } }

  // Exactly three things: name (header), status, and a brief task description.
  function showTooltip(a, clientX, clientY) {
    const style = styleForState(a.state);
    const desc = (a.meta && a.meta.goal) || a.task || "(no task text)";
    tooltip.innerHTML =
      `<div class="tt-name">${escapeHtml(displayName(a))}</div>` +
      `<div class="tt-src" style="color:${style.badgeColor}">${style.badge} ${escapeHtml(style.label)}</div>` +
      `<div>${escapeHtml(desc)}</div>`;
    tooltip.classList.remove("hidden");
    const pad = 14; let x = clientX + pad, y = clientY + pad;
    const r = tooltip.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = clientY - r.height - pad;
    tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
  }
  function hideTooltip() { tooltip.classList.add("hidden"); }

  const $ = (id) => document.getElementById(id);

  function renderPanel() {
    const a = selectedId && agents.get(selectedId);
    if (!a) { panel.classList.add("hidden"); return; }
    const src = sourceStyle(a.source), style = styleForState(a.state);
    const srcEl = $("panel-source");
    srcEl.textContent = `${src.icon} ${src.tag}`; srcEl.style.background = src.plate; srcEl.style.color = src.color;
    $("panel-name").textContent = displayName(a);
    const st = $("panel-state"); st.textContent = `${style.badge} ${style.label}`; st.style.color = style.badgeColor;
    $("panel-srctext").textContent = a.source;
    $("panel-updated").textContent = `${relTime(a.timestamp)} (${clockTime(a.timestamp)})`;
    $("panel-task").textContent = a.task || "(no task text)";

    // session goal (Cowork) row
    const goal = a.meta && a.meta.goal;
    $("panel-goal-row").style.display = goal ? "flex" : "none";
    if (goal) $("panel-goal").textContent = goal;

    // rename field reflects current custom name (if any)
    const nameInput = $("rename-input");
    nameInput.value = (a.override && a.override.name) || "";
    nameInput.placeholder = displayName(a);

    // dismiss is offered for finished agents (clear from Done) and for idle
    // ones resting in the lounge (send them home so the floor stays tidy).
    const canDismiss = a.archived || a.state === "idle";
    const dismissBtn = $("btn-dismiss");
    dismissBtn.style.display = canDismiss ? "inline-block" : "none";
    dismissBtn.textContent = a.archived ? "Dismiss from Done" : "Dismiss idle agent";

    const m = a.meta || {};
    const hasWindow = !!(m.cwd || m.session_id || m.iterm_session);
    $("panel-where").style.display = hasWindow ? "flex" : "none";
    $("panel-actions").style.display = hasWindow ? "flex" : "none";
    if (hasWindow) {
      $("panel-project").textContent =
        m.cwd ||
        (a.source === "cowork" ? "(Cowork desktop session)"
          : a.source === "chat" ? "(Claude desktop chat)"
          : "(unknown project)");
      const term = m.terminal ? ` · ${m.terminal.replace("Apple_", "")}` : (m.entrypoint ? ` · ${m.entrypoint}` : "");
      $("panel-session").textContent = `session ${String(m.session_id || "").slice(0, 8)}${term}`;
      $("btn-cd").disabled = !m.cwd;
      const canFocus = !!(m.iterm_session || m.terminal === "Apple_Terminal");
      $("btn-focus").disabled = !canFocus;
      $("btn-focus").title = canFocus
        ? (focusEnabled ? "Bring this session's window to the front"
                        : "Needs the focus helper enabled (see feedback when clicked)")
        : "No terminal info captured for this agent";
    }
    panel.classList.remove("hidden");
  }

  function feedback(msg, warn) {
    const el = $("panel-feedback");
    el.textContent = msg; el.classList.toggle("warn", !!warn);
  }

  // POST a rename/recolor to the server; optimistically apply locally too.
  async function setOverride(id, patch) {
    applyOverrideLocalMerge(id, patch);
    try {
      const res = await fetch(`/agent/${encodeURIComponent(id)}/override`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { applyOverride(id, d.override); feedback("Saved."); }
      else feedback("Couldn't save: " + (d.error || res.status), true);
    } catch (err) { feedback("Couldn't reach the server: " + err.message, true); }
  }
  function applyOverrideLocalMerge(id, patch) {
    const a = agents.get(id); if (!a) return;
    const next = Object.assign({}, a.override || {});
    for (const k of Object.keys(patch)) {
      if (patch[k] === null || patch[k] === "") delete next[k]; else next[k] = patch[k];
    }
    applyOverride(id, next);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const a = agentAt(e.clientX - r.left, e.clientY - r.top);
    hoveredId = a ? a.agent_id : null;
    canvas.style.cursor = a ? "pointer" : "default";
    if (a) showTooltip(a, e.clientX, e.clientY); else hideTooltip();
  });
  canvas.addEventListener("mouseleave", () => { hoveredId = null; hideTooltip(); });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const a = agentAt(e.clientX - r.left, e.clientY - r.top);
    selectedId = a ? a.agent_id : null; feedback(""); renderPanel();
  });
  // Double-click jumps straight into renaming.
  canvas.addEventListener("dblclick", (e) => {
    const r = canvas.getBoundingClientRect();
    const a = agentAt(e.clientX - r.left, e.clientY - r.top);
    if (!a) return;
    selectedId = a.agent_id; feedback(""); renderPanel();
    const inp = $("rename-input"); inp.focus(); inp.select();
  });
  canvas.addEventListener("touchstart", (e) => {
    const tch = e.touches[0]; if (!tch) return;
    const r = canvas.getBoundingClientRect();
    const a = agentAt(tch.clientX - r.left, tch.clientY - r.top);
    if (a) { selectedId = a.agent_id; feedback(""); renderPanel(); showTooltip(a, tch.clientX, tch.clientY); }
  }, { passive: true });

  $("panel-close").addEventListener("click", () => { selectedId = null; panel.classList.add("hidden"); });

  // Rename: commit on button or Enter.
  function commitRename() {
    if (!selectedId) return;
    const v = $("rename-input").value.trim();
    setOverride(selectedId, { name: v || null }); // empty → revert to auto name
  }
  $("btn-rename").addEventListener("click", commitRename);
  $("rename-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") $("rename-input").blur();
  });

  // Dismiss a finished agent from Done.
  $("btn-dismiss").addEventListener("click", async () => {
    if (!selectedId) return;
    const id = selectedId;
    try {
      await fetch(`/agent/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
      beginLeave(id); selectedId = null; panel.classList.add("hidden");
    } catch (err) { feedback("Couldn't dismiss: " + err.message, true); }
  });

  // Clear all finished agents at once (topbar button).
  const clearDoneBtn = $("clear-done");
  if (clearDoneBtn) clearDoneBtn.addEventListener("click", async () => {
    const ids = Array.from(agents.values()).filter((a) => a.archived).map((a) => a.agent_id);
    for (const id of ids) {
      try { await fetch(`/agent/${encodeURIComponent(id)}/dismiss`, { method: "POST" }); beginLeave(id); }
      catch {}
    }
  });

  // Copy a "cd <project>" command to the clipboard (always available locally).
  $("btn-cd").addEventListener("click", async () => {
    const a = selectedId && agents.get(selectedId);
    if (!a || !a.meta || !a.meta.cwd) return;
    const cmd = `cd ${JSON.stringify(a.meta.cwd)}`;
    try { await navigator.clipboard.writeText(cmd); feedback("Copied: " + cmd); }
    catch { feedback("Copy this: " + cmd, true); }
  });

  // Ask the local server to bring the session's window to the front (opt-in).
  $("btn-focus").addEventListener("click", async () => {
    const a = selectedId && agents.get(selectedId);
    if (!a) return;
    feedback("Focusing…");
    try {
      const res = await fetch("/focus", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta: a.meta || {} }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) feedback("Brought terminal to the front (" + (d.result || "ok") + ")");
      else if (res.status === 403) feedback("Focus is off. Restart server with AGENT_OFFICE_ALLOW_FOCUS=1, then retry.", true);
      else feedback("Couldn't focus: " + (d.error || res.status), true);
    } catch (err) { feedback("Couldn't reach the server: " + err.message, true); }
  });

  setInterval(() => { if (selectedId) renderPanel(); }, 1000);

  // --- websocket ------------------------------------------------------------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { connDot.classList.remove("offline"); connDot.classList.add("online"); connText.textContent = "live"; };
    ws.onclose = () => {
      connDot.classList.remove("online"); connDot.classList.add("offline");
      connText.textContent = "disconnected — retrying…"; setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "snapshot") {
        const ids = new Set(msg.agents.map((a) => a.agent_id));
        for (const id of Array.from(agents.keys())) {
          if (!ids.has(id)) {
            agents.delete(id);
            if (selectedId === id) { selectedId = null; panel.classList.add("hidden"); }
          }
        }
        msg.agents.forEach(ensureAgent);
        updateHud();
      } else if (msg.type === "agent_update") {
        ensureAgent(msg.agent);
      } else if (msg.type === "agent_remove") {
        beginLeave(msg.agent_id);
      } else if (msg.type === "override_update") {
        applyOverride(msg.agent_id, msg.override); // rename/recolor for an off-floor agent
      }
    };
  }

  resize();
  fetch("/health").then((r) => r.json()).then((d) => { focusEnabled = !!d.focusEnabled; }).catch(() => {});
  fetch("/agents").then((r) => r.json()).then((d) => { if (d.ok) d.agents.forEach(ensureAgent); }).catch(() => {});
  connect();
  requestAnimationFrame(frame);
})();
