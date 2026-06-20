// Validates incoming status events against the contract in docs/event-format.md.
// Returns { ok: true, event } with a normalized event, or { ok: false, error }.

const VALID_STATES = ["working", "idle", "done", "needs_review"];

function validateEvent(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }

  const { agent_id, source, state, task, timestamp } = body;

  if (typeof agent_id !== "string" || agent_id.trim() === "") {
    return { ok: false, error: "agent_id must be a non-empty string" };
  }
  if (typeof source !== "string" || source.trim() === "") {
    return { ok: false, error: "source must be a non-empty string" };
  }
  if (!VALID_STATES.includes(state)) {
    return {
      ok: false,
      error: `state must be one of: ${VALID_STATES.join(", ")}`,
    };
  }
  if (task !== undefined && typeof task !== "string") {
    return { ok: false, error: "task, if provided, must be a string" };
  }
  if (
    timestamp !== undefined &&
    (typeof timestamp !== "number" || !Number.isFinite(timestamp))
  ) {
    return { ok: false, error: "timestamp, if provided, must be a number (epoch ms)" };
  }

  // Optional freeform context, passed through untouched (never affects state).
  // Feeds use it to carry where the agent lives, e.g. for "jump to it":
  //   { cwd, session_id, transcript_path, terminal, iterm_session, url }
  const { meta } = body;
  if (meta !== undefined && (typeof meta !== "object" || meta === null || Array.isArray(meta))) {
    return { ok: false, error: "meta, if provided, must be a JSON object" };
  }

  return {
    ok: true,
    event: {
      agent_id: agent_id.trim(),
      source: source.trim(),
      state,
      task: typeof task === "string" ? task : "",
      timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
      meta: meta && typeof meta === "object" ? meta : {},
    },
  };
}

module.exports = { validateEvent, VALID_STATES };
