# Event format

Every feed (Claude Code, routines, future adapters) sends the collector the
same shape. This is the one contract everything agrees on.

## The endpoint

```
POST http://127.0.0.1:4317/event
Content-Type: application/json
```

## The body

```json
{
  "agent_id": "string  — who is this? stable id, same id = same character",
  "source":   "string  — where from? e.g. claude-code | cowork | routine",
  "state":    "working | idle | done | needs_review",
  "task":     "string  — short human label of what they're doing (optional)",
  "timestamp": 1718600000000
}
```

### Field rules

| field      | required | notes |
|------------|----------|-------|
| `agent_id` | yes      | non-empty string. Two events with the same id update the same character. |
| `source`   | yes      | non-empty string. Identifies the feed (shown as the chest emblem + nameplate stripe + tag). Known types: `claude-code`, `cowork`, `routine`, `research`, `data`, `design`. Unknown sources fall back to a generated look. The t-shirt color is unique **per agent** (from its id), not per type. |
| `state`    | yes      | MUST be one of `working`, `idle`, `done`, `needs_review`. Anything else is rejected. |
| `task`     | no       | free text; shown under the character. Defaults to "" if missing. |
| `timestamp`| no       | epoch milliseconds. If missing, the server stamps it on arrival. |
| `meta`     | no       | optional JSON object of context, passed through untouched and **never** affecting state. Merged across events (a later event without `meta` won't wipe earlier context). |

### Lifecycle (`meta.lifecycle`)

- `meta.lifecycle: "end"` — the session is over. The character is **archived to
  the lounge (breakroom · done) tray** with a short summary (it no longer walks
  out and vanishes). Archived agents linger until you dismiss them from the UI
  (bounded by a high safety cap).
- `meta.type: "cowork"` and `meta.goal: "<title>"` — set by the Cowork watcher;
  `goal` is shown in the tooltip and detail panel. `meta.entrypoint` records
  `cli` vs `claude-desktop`.

## Customization API (used by the UI)

A custom name is persisted to `data/overrides.json` and survives refreshes
**and** restarts (keyed by `agent_id`). (Each agent's look — skin, hair,
accessory, t-shirt color — is generated uniquely from its id, so there's no
color picker; an older `shirt` override is still honored if present.)

```
POST /agent/:id/override   { "name": "Report Bot" }
                           # pass null/"" for a field to clear it
POST /agent/:id/dismiss    # remove a finished agent from the lounge/Done tray
```

### `meta` (optional context)

```json
"meta": {
  "cwd": "/Users/you/projects/foo",   // project folder — powers "Copy cd path"
  "session_id": "abc123…",            // which session this is
  "transcript_path": "…",             // optional
  "terminal": "iTerm.app",            // TERM_PROGRAM
  "iterm_session": "w0t0p0:UUID"      // ITERM_SESSION_ID — enables precise focus
}
```

The Claude Code hook fills these in automatically. Routines may set `meta` too
(e.g. `"cwd"`), but it's entirely optional.

### Responses

- `200 {"ok":true, "agent":{...}}` — accepted, character updated, pushed to UI.
- `400 {"ok":false, "error":"..."}` — malformed; nothing changed.

## Quick test from Terminal

```bash
curl -s -X POST http://127.0.0.1:4317/event \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"test","source":"test","state":"working","task":"demo","timestamp":'"$(date +%s000)"'}'
```
