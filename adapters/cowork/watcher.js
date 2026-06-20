// Agent Office — Cowork watcher adapter.
//
// Claude Cowork ("cowork-enabled-cli-ops" in the desktop app) does NOT store its
// runs in ~/.claude/projects. It keeps a small metadata file per session under:
//
//   ~/Library/Application Support/Claude/local-agent-mode-sessions/
//       <accountId>/<workspaceId>/local_<uuid>.json
//
// (Older desktop builds used .../claude-code-sessions/ — we watch both so a
// rename in the app doesn't make Cowork agents silently disappear.)
//
// Each file has everything the office needs:
//   { sessionId, title, cwd, createdAt, lastActivityAt, isArchived,
//     completedTurns, model, permissionMode, ... }
//
// We poll those files, derive a live state from how recently `lastActivityAt`
// moved, and POST a normalized event to the local collector — same event shape
// as every other feed (docs/event-format.md), with source "cowork".
//
// Why metadata, not the transcript: the metadata file is tiny, always present,
// and updated as the session runs, so it's a robust, cheap liveness signal. (The
// full per-turn transcript lives nested much deeper and isn't needed here.)
//
// Local-first & best-effort: reads only, swallows every error, never blocks.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const PORT = process.env.AGENT_OFFICE_PORT
  ? Number(process.env.AGENT_OFFICE_PORT)
  : process.env.PORT
  ? Number(process.env.PORT)
  : 4317;

// The Cowork session store(s). Newer desktop builds use
// "local-agent-mode-sessions"; older ones used "claude-code-sessions". We watch
// every one that exists. Override with AGENT_OFFICE_COWORK_DIR (single path) if
// your desktop app keeps it somewhere else.
const CLAUDE_SUPPORT = path.join(
  os.homedir(), "Library", "Application Support", "Claude"
);
const COWORK_DIRS = process.env.AGENT_OFFICE_COWORK_DIR
  ? [process.env.AGENT_OFFICE_COWORK_DIR]
  : [
      path.join(CLAUDE_SUPPORT, "local-agent-mode-sessions"),
      path.join(CLAUDE_SUPPORT, "claude-code-sessions"),
    ];

// Tunables (env-overridable so the heuristic is easy to tighten).
const POLL_MS = num(process.env.AGENT_OFFICE_COWORK_POLL_MS, 2000);
// Recently-moved lastActivityAt → the session is actively working.
const WORKING_MS = num(process.env.AGENT_OFFICE_COWORK_WORKING_MS, 90 * 1000);
// Quiet for longer than this → the session is considered finished (→ Done).
const END_MS = num(process.env.AGENT_OFFICE_COWORK_END_MS, 30 * 60 * 1000);
// At startup (and first sight of a file) only adopt sessions whose last activity
// is within this window, so we don't replay weeks-old sessions. Default 8h
// (AGENT_OFFICE_FINISHED_MS — the shared "how long finished agents linger"
// setting, also used by the Claude watcher) so recently-finished Cowork sessions
// stay parked in the lounge/Done tray as a record of what you've completed. The
// Cowork-specific AGENT_OFFICE_COWORK_ACTIVE_MS still overrides it.
const ACTIVE_WINDOW_MS = num(
  process.env.AGENT_OFFICE_COWORK_ACTIVE_MS,
  num(process.env.AGENT_OFFICE_FINISHED_MS, 8 * 60 * 60 * 1000)
);

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// filepath -> { sessionId, agentId, mtime, emittedState, ended, adopted }
const files = new Map();

function activeDirs() {
  return COWORK_DIRS.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

function start() {
  const dirs = activeDirs();
  if (dirs.length === 0) {
    console.log(`[cowork] no session store found (looked in: ${COWORK_DIRS.join(", ")}); watcher idle`);
    return { stop() {} };
  }
  console.log(`[cowork] watching for Cowork sessions in:\n    ${dirs.join("\n    ")}`);
  const timer = setInterval(poll, POLL_MS);
  timer.unref && timer.unref();
  poll();
  return { stop() { clearInterval(timer); } };
}

// Recursively collect local_*.json session files (depth-bounded for safety).
function listSessionFiles(dir, depth, out) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listSessionFiles(p, depth + 1, out);
    else if (/^local_.*\.json$/.test(e.name)) out.push(p);
  }
}

function poll() {
  const found = [];
  for (const dir of activeDirs()) {
    try { listSessionFiles(dir, 0, found); }
    catch (err) { console.warn("[cowork] scan error:", err.message); }
  }

  const now = Date.now();
  for (const fp of found) {
    let t = files.get(fp);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }

    if (!t) {
      // First sight: only adopt if it was active recently enough to matter.
      if (now - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
      t = { sessionId: "", agentId: "", mtime: 0, emittedState: "", ended: false, adopted: true };
      files.set(fp, t);
    }

    let meta;
    if (st.mtimeMs !== t.mtime || !t.sessionId) {
      try { meta = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { continue; }
      t.mtime = st.mtimeMs;
      if (meta.sessionId && !t.sessionId) {
        t.sessionId = meta.sessionId;
        t.agentId = "cowork:" + String(meta.sessionId).replace(/^local_/, "").slice(0, 8);
      }
      t.meta = meta;
    } else {
      meta = t.meta; // unchanged file — reuse last read, just re-evaluate timers
    }
    if (!meta) continue;

    const last = Number(meta.lastActivityAt || meta.createdAt || st.mtimeMs);
    const quiet = now - last;

    // Finished: explicitly archived in Cowork, or quiet past END_MS.
    if (meta.isArchived || quiet > END_MS) {
      if (!t.ended) {
        emit(t, meta, { state: "idle", end: true });
        t.ended = true;
      }
      continue;
    }
    t.ended = false;

    const state = quiet <= WORKING_MS ? "working" : "idle";
    emit(t, meta, { state });
  }
}

// Strip a leading emoji/symbol so the short task label reads cleanly.
function cleanTitle(title) {
  return String(title || "").replace(/^[\s\p{Extended_Pictographic}←-➿]+/u, "").trim();
}

function emit(t, meta, a) {
  const title = meta.title || "";
  const short = cleanTitle(title);
  const task = a.end
    ? (short ? clip(short, 40) : "session ended")
    : (a.state === "working" ? (short ? clip(short, 40) : "working") : "waiting");

  const sig = a.state + "|" + task + (a.end ? "|end" : "");
  if (sig === t.emittedState && !a.end) return; // dedupe; only emit on change
  t.emittedState = a.end ? "" : sig;

  post({
    agent_id: t.agentId || "cowork:" + String(meta.sessionId || "unknown").slice(0, 8),
    source: "cowork",
    state: a.state,
    task,
    timestamp: Date.now(),
    meta: {
      cwd: (meta.cwd || meta.originCwd || "").trim(),
      session_id: meta.sessionId || t.sessionId,
      entrypoint: "cowork",
      type: "cowork",
      goal: title,                       // full title (with emoji) for tooltip/panel
      turns: meta.completedTurns,
      lifecycle: a.end ? "end" : "",
    },
  });
}

function clip(s, n) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function post(event) {
  const payload = JSON.stringify(event);
  const req = http.request(
    {
      host: "127.0.0.1", port: PORT, path: "/event", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    (res) => { res.on("data", () => {}); res.on("end", () => {}); }
  );
  req.on("error", () => {});
  req.setTimeout(1500, () => req.destroy());
  req.write(payload);
  req.end();
}

module.exports = { start, COWORK_DIRS };

// Allow running standalone: `node adapters/cowork/watcher.js`
if (require.main === module) start();
