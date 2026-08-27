// Agent Office — Claude Code session BACKFILL watcher.
//
// The hook (hook.js) only reports a Claude Code session while it's LIVE and
// firing events. So a session that finished — or was running before the office
// started — never shows up. This watcher fills that gap: it scans the local
// session transcripts and posts the same status events as every other feed, so
// recent/completed code sessions appear too (parked in the lounge/Done tray).
//
// Transcripts live at:
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// One project directory == one cwd. We pick the MOST RECENT session per project
// (so a busy project doesn't spawn a dozen characters), read it once to learn
// its cwd + a human title, and derive a live state from the file's mtime.
//
// agent_id matches the hook EXACTLY ("claude:" + first 8 of sessionId), so a
// live session driven by the hook and this watcher's view of it MERGE into one
// character instead of duplicating.
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

const PROJECTS_DIR =
  process.env.AGENT_OFFICE_CLAUDE_DIR ||
  path.join(os.homedir(), ".claude", "projects");

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

const POLL_MS = num(process.env.AGENT_OFFICE_CLAUDE_POLL_MS, 2500);
// Recently-touched transcript → the session is actively working.
const WORKING_MS = num(process.env.AGENT_OFFICE_CLAUDE_WORKING_MS, 90 * 1000);
// Quiet for longer than this → the session is considered finished (→ Done).
const END_MS = num(process.env.AGENT_OFFICE_CLAUDE_END_MS, 30 * 60 * 1000);
// Backfill window: adopt a project's latest session if it was active within
// this long, so a just-FINISHED code project still appears in the lounge.
// Default 1h (AGENT_OFFICE_FINISHED_MS — the shared "how long finished agents
// linger" setting, also used by the Cowork watcher), keeping the office to
// what's live now plus the last hour of completed work. The Claude-specific
// AGENT_OFFICE_CLAUDE_ACTIVE_MS still overrides it if you want finer control.
const ACTIVE_WINDOW_MS = num(
  process.env.AGENT_OFFICE_CLAUDE_ACTIVE_MS,
  num(process.env.AGENT_OFFICE_FINISHED_MS, 60 * 60 * 1000)
);

// proj dir -> { fp, sessionId, agentId, cwd, title, mtime, emittedState, ended, read }
const projects = new Map();

function start() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log(`[claude] projects dir not found (${PROJECTS_DIR}); backfill idle`);
    return { stop() {} };
  }
  console.log(`[claude] backfilling recent sessions from ${PROJECTS_DIR}`);
  const timer = setInterval(poll, POLL_MS);
  timer.unref && timer.unref();
  poll();
  return { stop() { clearInterval(timer); } };
}

// The single most-recent top-level *.jsonl in a project dir (ignores nested
// subagent transcripts). Returns { fp, mtime } or null.
function latestSession(projDir) {
  let entries;
  try { entries = fs.readdirSync(projDir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    if (!e.isFile() || !/\.jsonl$/.test(e.name)) continue;
    const fp = path.join(projDir, e.name);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (!best || st.mtimeMs > best.mtime) best = { fp, mtime: st.mtimeMs };
  }
  return best;
}

function poll() {
  let projDirs;
  try { projDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); }
  catch (err) { console.warn("[claude] scan error:", err.message); return; }

  const now = Date.now();
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(PROJECTS_DIR, d.name);
    const rep = latestSession(projDir);
    if (!rep) continue;

    let t = projects.get(d.name);
    if (!t) {
      // First sight: only adopt if it was active recently enough to matter.
      if (now - rep.mtime > ACTIVE_WINDOW_MS) continue;
      t = { fp: "", sessionId: "", agentId: "", cwd: "", title: "", mtime: 0, emittedState: "", ended: false, read: false };
      projects.set(d.name, t);
    }

    // A newer session file became the project's representative → re-read it.
    if (rep.fp !== t.fp) { t.fp = rep.fp; t.read = false; }
    t.mtime = rep.mtime;

    if (!t.read || !t.cwd) readMeta(t);
    if (!t.cwd) continue; // couldn't learn where it lives yet

    const quiet = now - t.mtime;

    if (quiet > END_MS) {
      if (!t.ended) { emit(t, { state: "idle", end: true }); t.ended = true; }
      continue;
    }
    t.ended = false;
    emit(t, { state: quiet <= WORKING_MS ? "working" : "idle" });
  }
}

// Read a transcript once to learn its cwd, sessionId, and a human title.
function readMeta(t) {
  t.read = true;
  let raw;
  try { raw = fs.readFileSync(t.fp, "utf8"); } catch { return; }
  t.sessionId = path.basename(t.fp, ".jsonl");
  t.agentId = "claude:" + String(t.sessionId).slice(0, 8);
  const cwd = raw.match(/"cwd":"([^"]+)"/);
  if (cwd) t.cwd = cwd[1];
  // Prefer the latest AI-generated title; fall back to the last user prompt.
  let title = "";
  const titles = raw.match(/"aiTitle":"((?:[^"\\]|\\.)*)"/g);
  if (titles && titles.length) {
    const m = titles[titles.length - 1].match(/"aiTitle":"((?:[^"\\]|\\.)*)"/);
    if (m) title = unescapeJson(m[1]);
  }
  if (!title) {
    const lp = raw.match(/"lastPrompt":"((?:[^"\\]|\\.)*)"/);
    if (lp) title = unescapeJson(lp[1]);
  }
  t.title = title;
}

function unescapeJson(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
}

function emit(t, a) {
  const task = a.end
    ? (t.title ? clip(t.title, 48) : "session ended")
    : (a.state === "working" ? (t.title ? clip(t.title, 48) : "working")
                             : (t.title ? clip(t.title, 48) : "idle"));

  const sig = a.state + "|" + task + (a.end ? "|end" : "");
  if (sig === t.emittedState && !a.end) return; // dedupe; only emit on change
  t.emittedState = a.end ? "" : sig;

  post({
    agent_id: t.agentId,
    source: "claude-code",
    state: a.state,
    task,
    timestamp: Date.now(),
    meta: {
      cwd: t.cwd,
      session_id: t.sessionId,
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

module.exports = { start, PROJECTS_DIR };

// Allow running standalone: `node adapters/claude-code/watcher.js`
if (require.main === module) start();
