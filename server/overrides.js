// Per-agent user overrides — the ONLY thing in this project that survives a
// restart. Everything else is intentionally in-memory ("show what's happening
// NOW"); but a custom name / t-shirt color the user picked should stick, so we
// persist just those to a tiny JSON sidecar.
//
// Shape on disk (data/overrides.json):
//   { "<agent_id>": { "name": "Bender", "shirt": "#ff8a65", "desk": "code-2" } }
//
// Keyed by agent_id so the same session re-adopts its look when it reappears.
// Writes are debounced and best-effort: a failed write never throws into a
// request handler (the office must keep running even if the disk is read-only).

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "overrides.json");

// Only these keys are accepted from clients, and each is sanitized — the sidecar
// is user-controlled but we never want it to carry arbitrary/huge junk.
const FIELDS = {
  name: (v) => (typeof v === "string" ? v.trim().slice(0, 40) : undefined),
  // accept #rgb / #rrggbb only, so the value is always a safe CSS/canvas color
  shirt: (v) =>
    typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())
      ? v.trim()
      : undefined,
  // a manual desk assignment id (see DESKS in public/characters.js); free string
  desk: (v) => (typeof v === "string" ? v.trim().slice(0, 40) : undefined),
};

let store = {};
let writeTimer = null;

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      store = parsed;
    }
  } catch {
    store = {}; // missing/corrupt file → start clean, no crash
  }
}

function persist() {
  // Debounce: rapid recolors/renames collapse into one disk write.
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    } catch (err) {
      console.warn("[overrides] could not persist:", err.message);
    }
  }, 250);
  writeTimer.unref && writeTimer.unref();
}

function get(agent_id) {
  return store[agent_id] || null;
}

// Apply a sanitized patch. Passing null/"" for a field clears it. Returns the
// resulting override object (or null if it ended up empty).
function set(agent_id, patch) {
  if (!agent_id || typeof patch !== "object" || patch === null) return get(agent_id);
  const cur = { ...(store[agent_id] || {}) };
  for (const key of Object.keys(FIELDS)) {
    if (!(key in patch)) continue;
    if (patch[key] === null || patch[key] === "") {
      delete cur[key]; // explicit clear → revert to the default look
    } else {
      const clean = FIELDS[key](patch[key]);
      if (clean !== undefined) cur[key] = clean;
    }
  }
  if (Object.keys(cur).length === 0) delete store[agent_id];
  else store[agent_id] = cur;
  persist();
  return store[agent_id] || null;
}

function remove(agent_id) {
  if (store[agent_id]) {
    delete store[agent_id];
    persist();
  }
}

// Attach the saved override (if any) onto an agent record for the UI. Kept as a
// nested object so the client can tell "the user set this" from defaults.
function decorate(agent) {
  if (!agent) return agent;
  const o = get(agent.agent_id);
  return o ? { ...agent, override: o } : agent;
}

function decorateList(list) {
  return list.map(decorate);
}

load();

module.exports = { get, set, remove, decorate, decorateList, FIELDS };
