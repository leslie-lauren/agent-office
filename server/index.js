// Agent Office — local server.
// Starts three things on one port:
//   1. serves the office UI (the /public folder)
//   2. the collector HTTP endpoint (POST /event)  -- see collector.js
//   3. a WebSocket server that live-pushes updates to open browser tabs
//
// Local-only: binds to 127.0.0.1 so nothing is exposed to your network.

const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");

const { registerCollector } = require("./collector");
const state = require("./state");
const overrides = require("./overrides");
const coworkWatcher = require("../adapters/cowork/watcher");
const claudeWatcher = require("../adapters/claude-code/watcher");

// By default the server binds to localhost only (nothing reaches the network).
// To use the phone remote control over Tailscale, the office script sets
// AGENT_OFFICE_HOST=0.0.0.0 and a shared AGENT_OFFICE_TOKEN — see
// `./scripts/office remote on`. The token is required for any NON-localhost
// request; localhost (the watchers/hooks and the desktop UI) is always allowed.
const HOST = process.env.AGENT_OFFICE_HOST || "127.0.0.1";
const TOKEN = process.env.AGENT_OFFICE_TOKEN || "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;
// "Jump to the Claude window" runs AppleScript locally, so it is OFF unless you
// explicitly opt in:  AGENT_OFFICE_ALLOW_FOCUS=1 npm start
const ALLOW_FOCUS = process.env.AGENT_OFFICE_ALLOW_FOCUS === "1";
// Cowork JSONL watcher is ON by default (local-only, read-only). Turn it off
// with AGENT_OFFICE_COWORK=0 if you don't use Cowork.
const WATCH_COWORK = process.env.AGENT_OFFICE_COWORK !== "0";
// Claude Code session backfill is ON by default (so recent/finished code
// sessions appear, not just live ones). Turn it off with AGENT_OFFICE_CLAUDE=0.
const WATCH_CLAUDE = process.env.AGENT_OFFICE_CLAUDE !== "0";

const app = express();
app.use(express.json({ limit: "256kb" }));

// --- Auth (only matters when bound beyond localhost for the phone remote) ----
// A request is allowed if it comes from localhost (watchers, hooks, desktop UI)
// OR no token is configured OR it carries the right token (header or ?token=).
function clientIsLocal(req) {
  const ip = (req.socket && req.socket.remoteAddress) || req.ip || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function tokenFromReq(req) {
  const h = req.headers && req.headers["x-office-token"];
  if (h) return String(h);
  try {
    return new URL(req.url, "http://x").searchParams.get("token") || "";
  } catch {
    return "";
  }
}
function authed(req) {
  if (clientIsLocal(req)) return true; // local feeds + desktop UI always allowed
  if (!TOKEN) return true; // no token set → open (relies on Tailscale as the boundary)
  return tokenFromReq(req) === TOKEN;
}

// Serve the browser UI. Static assets (the office + the phone remote page and its
// JS) are open so the page can load and then present/store the token; the data
// and mutation routes registered AFTER this are what the gate below protects.
app.use(express.static(path.join(__dirname, "..", "public")));

// Gate everything past the static assets for non-localhost callers.
app.use((req, res, next) => {
  if (authed(req)) return next();
  res.status(401).json({ ok: false, error: "Unauthorized: missing or bad token" });
});

// Simple health check (handy for the README troubleshooting steps).
app.get("/health", (_req, res) =>
  res.json({ ok: true, agents: state.list().length, focusEnabled: ALLOW_FOCUS })
);

// Optional, opt-in: bring the agent's Terminal/iTerm window to the front.
// Local-only and gated behind AGENT_OFFICE_ALLOW_FOCUS=1. Never runs the
// agent's own text — only AppleScript to *activate* a window by its session id.
app.post("/focus", (req, res) => {
  if (!ALLOW_FOCUS) {
    return res.status(403).json({
      ok: false,
      error:
        "Window focus is disabled. Restart with AGENT_OFFICE_ALLOW_FOCUS=1 to enable.",
    });
  }
  const meta = (req.body && req.body.meta) || {};
  const script = buildFocusScript(meta);
  if (!script) {
    return res.status(400).json({ ok: false, error: "Not enough context to locate a window." });
  }
  execFile("osascript", ["-e", script], { timeout: 4000 }, (err, stdout) => {
    if (err) return res.status(500).json({ ok: false, error: String(err.message || err) });
    res.json({ ok: true, result: String(stdout).trim() || "activated" });
  });
});

// Build AppleScript to focus the right window from captured context.
function buildFocusScript(meta) {
  // iTerm2: ITERM_SESSION_ID looks like "w0t0p0:<UUID>"; the UUID matches a
  // session's id, so we can select that exact tab.
  const iterm = meta.iterm_session && String(meta.iterm_session);
  if (iterm) {
    const uuid = iterm.includes(":") ? iterm.split(":").pop() : iterm;
    const safe = uuid.replace(/[^a-zA-Z0-9\-]/g, "");
    return [
      'tell application "iTerm2"',
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      repeat with s in sessions of t",
      `        if (id of s) is "${safe}" then`,
      "          select w",
      "          tell t to select",
      "          tell s to select",
      "          activate",
      '          return "focused"',
      "        end if",
      "      end repeat",
      "    end repeat",
      "  end repeat",
      "  activate",
      '  return "iterm-activated"',
      "end tell",
    ].join("\n");
  }
  // Apple Terminal: precise tab targeting isn't reliable, so best-effort bring
  // Terminal to the front.
  if (meta.terminal === "Apple_Terminal") {
    return 'tell application "Terminal" to activate\nreturn "terminal-activated"';
  }
  return null;
}

const server = http.createServer(app);

// --- WebSocket: live push to browsers -------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  }
}

wss.on("connection", (socket, req) => {
  // Same gate as the HTTP routes: a remote (non-localhost) socket must carry the
  // token in its ?token= query, or we close it before sending any state.
  if (!authed(req)) {
    socket.close(4001, "unauthorized");
    return;
  }
  // On connect, send the current roster (with saved overrides) so the office is
  // in sync immediately.
  socket.send(JSON.stringify({ type: "snapshot", agents: overrides.decorateList(state.list()) }));
});

// --- Collector routes ------------------------------------------------------
registerCollector(app, broadcast);

// Manual clear — wipe the office (e.g. to drop leftover/stale characters).
app.post("/reset", (_req, res) => {
  state.clear();
  broadcast({ type: "snapshot", agents: [] }); // tells open tabs to clear
  console.log("[reset] cleared all agents");
  res.json({ ok: true, cleared: true });
});

// Self-cleaning safety net: prune characters that haven't reported in a while.
// A normal session is removed instantly on SessionEnd; this only catches ghosts
// left behind by a crash / kill -9 (where SessionEnd never fired) or stray test
// data. Generous TTL so a genuinely open-but-idle session isn't culled early.
const STALE_MS = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  const removed = state.pruneStale(STALE_MS);
  for (const id of removed) {
    console.log(`[sweep] pruned stale agent ${id}`);
    broadcast({ type: "agent_remove", agent_id: id });
  }
}, 60 * 1000).unref();

// --- Boot ------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Agent Office is running");
  console.log(`  UI:        http://${HOST}:${PORT}`);
  console.log(`  Collector: POST http://${HOST}:${PORT}/event`);
  console.log(`  WebSocket: ws://${HOST}:${PORT}/ws`);
  if (HOST !== "127.0.0.1") {
    console.log(`  Remote:    bound to ${HOST} (phone control via /remote.html)`);
    if (TOKEN) console.log("  Auth:      token required for non-localhost requests");
    else console.warn("  Auth:      WARNING bound beyond localhost with NO token set");
  }
  // Start tailing ~/.claude/projects for Cowork (desktop) sessions. Runs in the
  // same process; reads only, posts to our own collector like any other feed.
  if (WATCH_COWORK) {
    try { coworkWatcher.start(); }
    catch (err) { console.warn("  [cowork] watcher failed to start:", err.message); }
  } else {
    console.log("  Cowork:    watcher disabled (AGENT_OFFICE_COWORK=0)");
  }
  if (WATCH_CLAUDE) {
    try { claudeWatcher.start(); }
    catch (err) { console.warn("  [claude] backfill failed to start:", err.message); }
  } else {
    console.log("  Claude:    session backfill disabled (AGENT_OFFICE_CLAUDE=0)");
  }
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use.\n` +
        `  Another copy may be running. Stop it, or start on another port:\n` +
        `      PORT=4318 npm start\n`
    );
  } else {
    console.error("  Server error:", err);
  }
  process.exit(1);
});
