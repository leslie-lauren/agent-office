// In-memory store of the current state of every known agent.
// No database: restarting the server forgets everyone. This is intentional —
// the office shows what is happening NOW. See README "Design choices".
//
// One deliberate exception to "only NOW": when a session ENDS we no longer
// delete its character — we ARCHIVE it (state "done", archived:true) so it stays
// parked in the Done section with a short summary of what it did. Archived
// agents are capped (newest kept) and can be dismissed, but they survive the
// idle stale-sweep that culls live ghosts.

const agents = new Map(); // agent_id -> { agent_id, source, state, task, timestamp, meta, lastSeen, archived?, completedAt?, summary? }

// How many finished agents to keep parked in the lounge/Done tray before the
// oldest drops off. Finished agents are meant to linger until you dismiss them
// (so the tray is a record of what you've completed), so this is a high safety
// bound rather than a tight cap.
const DONE_CAP = 60;

// Short-lived record of agents that were explicitly dismissed/cleared, so a
// late/out-of-order event can't resurrect a ghost character. Keyed by
// agent_id -> expiry timestamp (ms). Cleared lazily.
const tombstones = new Map();
const TOMBSTONE_MS = 6000;

// Explicit dismissals are different from the short tombstone above: a live agent
// (e.g. an idle Claude/Cowork session) keeps getting re-POSTed by its watcher
// every couple of seconds, so a 6s window can't hold it gone. A dismissal lasts
// much longer and is checked on every event — quiet (idle/done) re-posts are
// suppressed, but genuine new activity (working/needs_review) revives the agent.
const dismissals = new Map(); // agent_id -> expiry timestamp (ms)
const DISMISS_MS = (() => {
  const raw = Number(process.env.AGENT_OFFICE_DISMISS_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000; // 24h
})();

function isTombstoned(agent_id) {
  const exp = tombstones.get(agent_id);
  if (!exp) return false;
  if (Date.now() > exp) { tombstones.delete(agent_id); return false; }
  return true;
}

function isDismissed(agent_id) {
  const exp = dismissals.get(agent_id);
  if (!exp) return false;
  if (Date.now() > exp) { dismissals.delete(agent_id); return false; }
  return true;
}

function clearDismissal(agent_id) {
  dismissals.delete(agent_id);
}

function clearTombstone(agent_id) {
  tombstones.delete(agent_id);
}

function upsert(event) {
  const existing = agents.get(event.agent_id) || {};
  const agent = {
    ...existing,
    agent_id: event.agent_id,
    source: event.source,
    state: event.state,
    task: event.task,
    timestamp: event.timestamp,
    // merge context so a later event missing meta doesn't wipe earlier context
    meta: { ...(existing.meta || {}), ...(event.meta || {}) },
    lastSeen: Date.now(),
  };
  // A fresh, non-end update on a previously-archived agent revives it as active
  // (e.g. a Cowork session the user reopened). Drop the archive flags.
  if (existing.archived) {
    delete agent.archived;
    delete agent.completedAt;
    delete agent.summary;
  }
  agents.set(event.agent_id, agent);
  return agent;
}

// Session ended → keep the character but park it in Done with a summary.
// Returns the archived agent record (or null if we never knew this agent).
function archive(event) {
  const existing = agents.get(event.agent_id);
  // Prefer the last meaningful task as the summary over a generic end label.
  const summary =
    (existing && existing.task && existing.task !== "session ended"
      ? existing.task
      : event.task) || "completed";
  const agent = {
    ...(existing || {}),
    agent_id: event.agent_id,
    source: event.source || (existing && existing.source) || "unknown",
    state: "done",
    task: summary,
    summary,
    archived: true,
    completedAt: Date.now(),
    timestamp: event.timestamp || Date.now(),
    meta: { ...((existing && existing.meta) || {}), ...(event.meta || {}) },
    lastSeen: Date.now(),
  };
  agents.set(agent.agent_id, agent);
  return agent;
}

// Keep only the newest DONE_CAP archived agents; return ids that aged out.
function trimArchived() {
  const done = Array.from(agents.values())
    .filter((a) => a.archived)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const dropped = [];
  for (const a of done.slice(DONE_CAP)) {
    agents.delete(a.agent_id);
    tombstones.set(a.agent_id, Date.now() + TOMBSTONE_MS);
    dropped.push(a.agent_id);
  }
  return dropped;
}

function remove(agent_id) {
  const existed = agents.delete(agent_id);
  tombstones.set(agent_id, Date.now() + TOMBSTONE_MS);
  // Also dismiss it long-term so a live watcher's idle re-posts don't bring it
  // straight back. New real activity (working/needs_review) clears this.
  dismissals.set(agent_id, Date.now() + DISMISS_MS);
  return existed;
}

function get(agent_id) {
  return agents.get(agent_id) || null;
}

function list() {
  return Array.from(agents.values());
}

function clear() {
  agents.clear();
}

// Remove agents whose last update is older than maxAgeMs. Returns removed ids.
// Archived (Done) agents are EXEMPT — they're meant to linger until capped or
// dismissed, not culled for being idle.
function pruneStale(maxAgeMs) {
  const now = Date.now();
  const removed = [];
  for (const [id, a] of agents) {
    if (a.archived) continue;
    if (now - (a.lastSeen || a.timestamp || 0) > maxAgeMs) {
      agents.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

module.exports = {
  upsert, archive, trimArchived, remove, get, list, clear,
  isTombstoned, clearTombstone, isDismissed, clearDismissal, pruneStale, DONE_CAP,
};
