# Cowork adapter — IMPLEMENTED (JSONL watcher)

This adapter is now live: see [`watcher.js`](./watcher.js). It is started
automatically by the server (`server/index.js`) and can be disabled with
`AGENT_OFFICE_COWORK=0`.

## How it works

IMPORTANT: this Cowork build ("cowork-enabled-cli-ops") does **not** store runs
in `~/.claude/projects`. It keeps a small metadata file per session under the
desktop app's support folder:

```
~/Library/Application Support/Claude/claude-code-sessions/
    <accountId>/<workspaceId>/local_<uuid>.json
```

Each file has everything the office needs:

```json
{ "sessionId": "local_…", "title": "📚 FABLED: Build …",
  "cwd": "/Users/you/Desktop/Fabled", "createdAt": 1775…,
  "lastActivityAt": 1781…, "isArchived": false, "completedTurns": 37 }
```

We poll those files and derive a live state from how recently `lastActivityAt`
moved, then POST a normalized event (`source:"cowork"`, `docs/event-format.md`)
to the local collector — same shape as every other feed.

We use the **metadata** file (not the per-turn transcript) because it's tiny,
always present, and updated as the session runs — a robust, cheap liveness
signal. Code (CLI) sessions live elsewhere and are handled by the hook, so
there's no double-counting.

### State derivation

- `lastActivityAt` within `WORKING_MS` (default 90s) → `working`.
- older than that but within `END_MS` → `idle`.
- `isArchived: true`, or quiet past `END_MS` (default 30m) → lifecycle `end`
  (archived to the Done section).

The session **title** is shown as the task label and carried in full (with emoji)
as `meta.goal` for the tooltip + detail panel; `meta.cwd` powers "Copy cd path".

### Tunables (env)

| var | default | meaning |
|-----|---------|---------|
| `AGENT_OFFICE_COWORK` | `1` | set `0` to disable the watcher entirely |
| `AGENT_OFFICE_COWORK_DIR` | `~/Library/Application Support/Claude/claude-code-sessions` | session store to watch |
| `AGENT_OFFICE_COWORK_POLL_MS` | `2000` | poll interval |
| `AGENT_OFFICE_COWORK_WORKING_MS` | `90000` | recent activity → working |
| `AGENT_OFFICE_COWORK_END_MS` | `1800000` | quiet → finished (archived) |
| `AGENT_OFFICE_COWORK_ACTIVE_MS` | = `END_MS` | only adopt sessions active within this window (raise it to backfill recent-but-old sessions) |

Lightweight & local-first: reads only small JSON metadata, re-reads a file only
when its mtime changes, and swallows every error so the office keeps running.

Run it standalone for debugging (the wide window surfaces older sessions too):

```bash
AGENT_OFFICE_COWORK_ACTIVE_MS=999999999999 node adapters/cowork/watcher.js
```

---

## Original design note (kept for history)

The two paths we considered were (1) an OpenTelemetry exporter and (2) reading
the local store. We shipped (2). `stub.js` remains only as a marker and is not
imported anywhere.
