// Visual config for the office: how each state looks/behaves, and a stable,
// deterministic color per "source" so feeds are tellable apart.
//
// Pure data + tiny helpers. All actual drawing & animation lives in office.js.
// No status logic here — this never decides state, it only styles it.

const STATE_STYLE = {
  working: {
    label: "working",
    badge: "⌨",
    badgeColor: "#3fa7ff",
    glow: "#3fa7ff",
    anim: "typing", // hands tap, gentle bob, monitor glows
    screenOn: true,
  },
  idle: {
    label: "idle",
    badge: "·",
    badgeColor: "#aab2c0",
    glow: null,
    anim: "breathe", // slow breathing + occasional blink
    screenOn: false,
  },
  done: {
    label: "done",
    badge: "✓",
    badgeColor: "#37d67a",
    glow: "#37d67a",
    anim: "cheer", // small happy bounce
    screenOn: false,
  },
  needs_review: {
    label: "needs review",
    badge: "!",
    badgeColor: "#ff5252",
    glow: "#ff5252",
    anim: "alert", // bounce + flashing badge to grab attention
    screenOn: true,
  },
};

// Deterministic body color per source string (same source = same color across
// restarts; no randomness so it's stable). CC0 palette, hand-picked.
const SOURCE_COLORS = [
  "#e6b800", "#c77dff", "#4dd0e1", "#ff8a65",
  "#aed581", "#f06292", "#7986cb", "#4db6ac",
];

function colorForSource(source) {
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
  return SOURCE_COLORS[h % SOURCE_COLORS.length];
}

// Known agent TYPES get a fixed, recognizable look so feeds are tellable apart
// at a glance: a t-SHIRT color (the torso), an accent color (badge/stripe), a
// nameplate tint, a tag, and a tiny icon. The "type" is the event's `source`
// value — that's what tells a code agent from a routine from a research agent.
//
// To add a new type later, add one row here keyed by the `source` string a feed
// sends (e.g. a feed that POSTs source:"research" gets the green research shirt).
// Unknown sources fall back to a stable generated shirt color + the raw name.
const SOURCE_STYLE = {
  // `emblem` selects the pixel icon drawn on the t-shirt (see drawEmblem in
  // office.js): "code" = </> brackets, "doc" = a little document/folder.
  "claude-code": { tag: "CODE",     icon: "</>", emblem: "code", color: "#3fa7ff", shirt: "#2f6fe0", plate: "#16365a" },
  "cowork":      { tag: "COWORK",   icon: "❏",   emblem: "chat", color: "#ff9d3f", shirt: "#e8821e", plate: "#4a2c10" },
  "research":    { tag: "RESEARCH", icon: "✦",   emblem: "star", color: "#42d6a8", shirt: "#1f9d74", plate: "#15463a" },
  "routine":     { tag: "ROUTINE",  icon: "⟳",   emblem: "loop", color: "#c77dff", shirt: "#8e44d0", plate: "#3a2452" },
  "data":        { tag: "DATA",     icon: "▤",   emblem: "doc",  color: "#ffb74d", shirt: "#e08a2f", plate: "#4a3416" },
  "design":      { tag: "DESIGN",   icon: "✸",   emblem: "star", color: "#ff8ab4", shirt: "#e0598f", plate: "#4a1f33" },
};

function sourceStyle(source) {
  return (
    SOURCE_STYLE[source] || {
      tag: String(source).toUpperCase().slice(0, 8),
      icon: "•",
      color: colorForSource(source),
      shirt: colorForSource(source),
      plate: "#2b3142",
    }
  );
}

// Lower number = more prominent. Drives desk placement so "needs_review"
// agents sort to the front rows. (Ordering only — never changes any state.)
const STATE_PRIORITY = { needs_review: 0, working: 1, idle: 2, done: 3 };

function styleForState(stateName) {
  return STATE_STYLE[stateName] || STATE_STYLE.idle;
}

// Per-agent looks, derived deterministically from the agent_id so a given agent
// always looks the same — but every character is visually UNIQUE. Skin tone,
// hairstyle, hair color, an optional accessory, AND the t-shirt color all vary
// per agent (the shirt is no longer a per-type uniform). Type is still tellable
// at a glance from the chest emblem + nameplate stripe + tag (see sourceStyle).
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

const SKINS = ["#f8dcc0", "#f3d2b3", "#ffe0bd", "#e8b98f", "#d89a6a", "#c98a5e", "#a86a42", "#8a5a34", "#7d4f2e", "#5e3a20"];
const HAIR_COLORS = ["#2b2320", "#3a2a1c", "#5b3a1a", "#7a5230", "#a9712f", "#c0392b", "#d9a441", "#6b6b6b", "#9b59b6", "#3a6ea5", "#2e8b57", "#e8e8e8"];
const HAIR_STYLES = ["short", "spiky", "bun", "long", "cap", "bald", "mohawk", "ponytail", "afro", "curly"];
// weighted toward "none" so accessories feel special
const ACCESSORIES = ["none", "none", "none", "glasses", "headphones", "none", "glasses", "beanie", "earring", "none", "visor"];
// Unique-per-agent t-shirt palette (hand-picked, readable on the floor).
const SHIRTS = [
  "#2f6fe0", "#1f8f8f", "#8e44d0", "#e08a2f", "#1f9d74", "#e0598f",
  "#c0392b", "#16a085", "#d35400", "#2c5fb3", "#c2185b", "#00838f",
  "#7e57c2", "#5d8a3a", "#e67e22", "#455a8c", "#ad1457", "#3aa6a6",
  "#d81b60", "#00897b", "#5e35b1", "#43a047", "#fb8c00", "#3949ab",
];

// Independent hashes per feature so two agents rarely share a whole "look".
function appearance(agent_id) {
  const s = String(agent_id);
  const h = hashStr(s);
  const h2 = hashStr(s + "~look");
  return {
    skin: SKINS[h % SKINS.length],
    hairColor: HAIR_COLORS[(h >> 4) % HAIR_COLORS.length],
    hairStyle: HAIR_STYLES[(h >> 9) % HAIR_STYLES.length],
    accessory: ACCESSORIES[(h2) % ACCESSORIES.length],
    shirt: SHIRTS[(h2 >> 6) % SHIRTS.length],
  };
}

// --- DESKS: the office floor plan -----------------------------------------
// Three fixed areas. The two "cluster" areas (coding / knowledge) hold a row of
// STATIC desks that agents walk to and sit at; agents are routed to a cluster by
// type (Code → coding, Cowork → knowledge), or by a manual `override.desk`.
// The merged LOUNGE parks both idle agents (resting) AND finished sessions —
// finished ones linger there with a summary until you dismiss them, so it
// doubles as a "what I've completed" tray.
//
// Configurable: change `count` for more/fewer desks, edit `title`, or add a new
// cluster row (office.js lays them out automatically from this table).
const DESKS = {
  coding:    { key: "coding",    kind: "cluster", title: "⌨ CODING DESKS",     count: 4, accent: "#3fa7ff", forCowork: false },
  knowledge: { key: "knowledge", kind: "cluster", title: "❏ KNOWLEDGE WORK",   count: 4, accent: "#ff9d3f", forCowork: true  },
  lounge:    { key: "lounge",    kind: "lounge",  title: "☕ BREAKROOM · ✓ DONE", accent: "#37d67a" },
};

// Which cluster an agent belongs at when it's actively working.
function deskClusterFor(agent) {
  const ov = agent && agent.override && agent.override.desk;
  if (ov === "coding" || ov === "knowledge") return ov; // manual assignment wins
  const cowork = agent && (agent.source === "cowork" || (agent.meta && agent.meta.type === "cowork"));
  return cowork ? "knowledge" : "coding";
}

window.AgentChars = {
  STATE_STYLE, styleForState, colorForSource, sourceStyle, STATE_PRIORITY, appearance,
  DESKS, deskClusterFor,
};
