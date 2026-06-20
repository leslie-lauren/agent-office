// The collector: the HTTP route that accepts status events, validates them,
// updates in-memory state, and broadcasts the change to every connected browser.
//
// Also hosts the small write API the UI uses to customize agents (rename /
// recolor, persisted via overrides.js) and to dismiss finished ones from Done.

const { validateEvent } = require("./validate");
const state = require("./state");
const overrides = require("./overrides");

function registerCollector(app, broadcast) {
  // Accept a status event from any feed (Claude Code hook, Cowork watcher,
  // routine, a test curl).
  app.post("/event", (req, res) => {
    const result = validateEvent(req.body);
    if (!result.ok) {
      console.warn(`[collector] rejected event: ${result.error}`);
      return res.status(400).json({ ok: false, error: result.error });
    }

    const event = result.event;
    const id = event.agent_id;

    // A dismissed agent stays gone while its watcher keeps re-POSTing quiet
    // (idle/done) updates. Genuine new activity (working/needs_review) means
    // it's back in business, so clear the dismissal and let it through.
    if (state.isDismissed(id)) {
      const active = event.state === "working" || event.state === "needs_review";
      if (!active) {
        return res.json({ ok: true, ignored: "dismissed" });
      }
      state.clearDismissal(id);
      state.clearTombstone(id); // don't let the short dismissal tombstone block the revival
      console.log(`[collector] dismissed ${id} revived by ${event.state} event`);
    }

    // Lifecycle: a session that ended is ARCHIVED — it stays parked in Done with
    // a summary instead of walking out the door. (Was: removed entirely.)
    if (event.meta && event.meta.lifecycle === "end") {
      // Ignore an end for something we never tracked and that was just dismissed.
      if (!state.get(id) && state.isTombstoned(id)) {
        return res.json({ ok: true, ignored: "recently dismissed" });
      }
      const agent = state.archive(event);
      console.log(`[collector] ${agent.source}/${id} -> DONE (archived)`);
      broadcast({ type: "agent_update", agent: overrides.decorate(agent) });
      // Enforce the Done cap; tell tabs to drop any that aged out.
      for (const goneId of state.trimArchived()) {
        broadcast({ type: "agent_remove", agent_id: goneId });
      }
      return res.json({ ok: true, archived: true });
    }

    // Drop late/out-of-order events for a just-dismissed session (no revival).
    if (state.isTombstoned(id)) {
      console.log(`[collector] ignoring late event for dismissed session ${id}`);
      return res.json({ ok: true, ignored: "recently dismissed" });
    }

    const agent = state.upsert(event);
    console.log(
      `[collector] ${agent.source}/${agent.agent_id} -> ${agent.state}` +
        (agent.task ? ` (${agent.task})` : "")
    );

    // Push the live update to all open office tabs (with any saved override).
    broadcast({ type: "agent_update", agent: overrides.decorate(agent) });

    return res.json({ ok: true, agent });
  });

  // Lets the UI fetch the full current roster on first load / reconnect.
  app.get("/agents", (_req, res) => {
    res.json({ ok: true, agents: overrides.decorateList(state.list()) });
  });

  // --- customization API ----------------------------------------------------
  // Rename / recolor an agent. Persisted to the sidecar so it survives refreshes
  // AND server restarts. Works even if the agent isn't currently on the floor
  // (the look re-applies when it reappears).
  app.post("/agent/:id/override", (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing agent id" });
    const patch = (req.body && typeof req.body === "object") ? req.body : {};
    const saved = overrides.set(id, patch);

    // If the agent is live, broadcast the decorated record so every tab updates.
    const agent = state.get(id);
    if (agent) broadcast({ type: "agent_update", agent: overrides.decorate(agent) });
    else broadcast({ type: "override_update", agent_id: id, override: saved });

    res.json({ ok: true, override: saved });
  });

  // Dismiss a finished agent from the Done section (and forget its override, so
  // the sidecar doesn't accumulate entries for sessions that are gone for good).
  app.post("/agent/:id/dismiss", (req, res) => {
    const id = String(req.params.id || "").trim();
    const existed = state.remove(id);
    overrides.remove(id);
    broadcast({ type: "agent_remove", agent_id: id });
    res.json({ ok: true, dismissed: existed });
  });
}

module.exports = { registerCollector };
