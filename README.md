# Agent Office

A local, browser-based "mission control" that shows your autonomous Claude
agents as animated pixel characters in a shared office. Each character shows a
live status — **working, idle, done, or needs review** — driven by a generic
status feed, so it can show more than just Claude Code.

Everything runs on your Mac. Nothing leaves your machine.

---

## What you need

- A Mac (you have one).
- **Node.js 18 or newer.** Check by pasting this into Terminal:
  ```bash
  node --version
  ```
  If you see a version number (e.g. `v22.14.0`), you're good. If it says
  "command not found", install Node from <https://nodejs.org> (the "LTS"
  button) and try again.

---

## First-time setup (once)

Open Terminal and run:

```bash
cd ~/agent-office
npm install      # downloads the two small libraries it needs (Express, ws)
npm run build    # sanity-checks everything is in place
```

`npm run build` should end with **"Build check passed."**

---

## Always-on (recommended): start automatically at login

So the office is *just there* whenever you use Claude Code, install it as a
macOS **LaunchAgent** (the standard way to run a background login service):

```bash
cd ~/agent-office
./scripts/office install
```

This:
- writes **`~/Library/LaunchAgents/com.agentoffice.server.plist`** (pinned to
  your Node path + this folder),
- starts the server immediately, and
- restarts it automatically at **login** and if it ever **crashes**
  (`RunAtLoad` + `KeepAlive`).

It still binds only to `127.0.0.1` — local-only, nothing exposed.

### Check / control it

```bash
./scripts/office status      # is it running? where? how many agents? (also: npm run status)
./scripts/office restart      # restart it
./scripts/office stop         # stop now (it returns at next login)
./scripts/office logs         # tail the server logs (logs/agent-office.*.log)
```

### Turn it off completely (full undo)

```bash
./scripts/office uninstall    # stops it AND removes the LaunchAgent file
```

That stops the service now and deletes the plist, so it won't come back at
login. Nothing else on your system is touched.

> **Enabling "Focus terminal" under autostart:** the LaunchAgent runs with
> focus **off** by default. To turn it on, open the plist and add inside
> `EnvironmentVariables`:
> `<key>AGENT_OFFICE_ALLOW_FOCUS</key><string>1</string>`, then
> `./scripts/office restart`.
>
> **If you change Node versions (nvm):** the pinned Node path can go stale.
> `./scripts/office status` warns you if so — just run `./scripts/office install`
> again to refresh the plist.

---

## How to start the app manually (alternative)

If you'd rather not autostart, you can run it by hand:

```bash
cd ~/agent-office
npm start
```

You'll see:

```
  Agent Office is running
  UI:        http://127.0.0.1:4317
  Collector: POST http://127.0.0.1:4317/event
  WebSocket: ws://127.0.0.1:4317/ws
  Press Ctrl+C to stop.
```

Open **http://127.0.0.1:4317** in your browser. To stop the app, click back in
Terminal and press **Ctrl+C**.

### See it working immediately

With the server running, open a **second** Terminal tab and run:

```bash
cd ~/agent-office
npm run send-test-event
```

A character named `test` should pop into the office in the **working** state.
Try other states:

```bash
node scripts/send-test-event.js needs_review "please check the draft"
node scripts/send-test-event.js done "finished the report"
```

> **Port already in use?** Start on a different port:
> `PORT=4318 npm start` (and use the same `PORT=4318` for the test scripts).

---

## Design choices (plain language)

- **Stack:** Node + Express (the collector) + `ws` (live updates) + a plain
  HTML/Canvas page (the office). No framework and **no build step** — the files
  you see are the files that run, which keeps it understandable.
- **Live, not historical.** The office shows what's happening *now*. State is
  kept in memory, so **restarting the server forgets everyone**. This is on
  purpose; adding history later is possible but was deliberately left out.
- **Local-only.** The server binds to `127.0.0.1`, so it's reachable only from
  your Mac, never from your network or the internet.
- **Multiple Claude Code sessions.** Each running session is its own character,
  keyed by its session id and labeled by its **project folder** (e.g.
  `api·b67a`, `web·f6g7`) so they're easy to tell apart. When a session ends,
  its character **walks out and disappears**. A just-closed session is
  "tombstoned" for a few seconds so a late, out-of-order event can't revive a
  ghost, and the office **re-syncs from the server on every reconnect** — so it
  can't drift even if you open and close sessions quickly.

---

## Feed 1 — Claude Code hook  ⚠️ EDITS A GLOBAL SETTINGS FILE

This makes your Claude Code sessions report their status to the office. It
requires adding a `hooks` block to **`~/.claude/settings.json`**.

**This was NOT applied for you. Review the diff below and apply it yourself
when you're ready** (or tell me to apply it).

> Replace `/ABSOLUTE/PATH/TO/agent-office` below with the real path where you
> cloned this repo (run `pwd` in the project folder to get it). The hook needs
> an absolute path.

### Your file today

```json
{
  "enabledPlugins": {
    "vercel@claude-plugins-official": true
  },
  "theme": "dark"
}
```

### The diff to apply

```diff
 {
   "enabledPlugins": {
     "vercel@claude-plugins-official": true
   },
-  "theme": "dark"
+  "theme": "dark",
+  "hooks": {
+    "SessionStart": [
+      { "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/agent-office/adapters/claude-code/hook.js" } ] }
+    ],
+    "UserPromptSubmit": [
+      { "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/agent-office/adapters/claude-code/hook.js" } ] }
+    ],
+    "PreToolUse": [
+      { "matcher": "*", "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/agent-office/adapters/claude-code/hook.js" } ] }
+    ],
+    "PostToolUse": [
+      { "matcher": "*", "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/agent-office/adapters/claude-code/hook.js" } ] }
+    ],
+    "Notification": [
+      { "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/agent-office/adapters/claude-code/hook.js" } ] }
+    ],
+    "Stop": [
+      { "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/agent-office/adapters/claude-code/hook.js" } ] }
+    ],
+    "SessionEnd": [
+      { "hooks": [ { "type": "command", "command": "node /ABSOLUTE/PATH/TO/agent-office/adapters/claude-code/hook.js" } ] }
+    ]
+  }
 }
```

The full block is also saved at
`adapters/claude-code/settings-snippet.json` for copy-paste.

**What each hook does:** session start → *idle*, prompts and tool use →
*working*, Claude notifications (e.g. asking permission) → *needs review*,
end of a turn → *done*, session end → *idle*. The hook script swallows all
errors, so if the office is closed it can never disrupt your Claude session.

To undo later, delete the `hooks` block you added.

---

## Jumping to an agent's window (optional)

Click an agent to open its detail panel. For Claude Code agents the panel shows
the **project folder** and **session id** the hook captured, plus two buttons:

- **Copy cd path** — copies `cd "<project folder>"` to your clipboard so you can
  paste it into a terminal. Always works; no setup.
- **Focus terminal** — asks the local server to bring that session's window to
  the front. This runs a small **AppleScript** locally, so it is **off by
  default**. Turn it on by starting the server with:
  ```bash
  AGENT_OFFICE_ALLOW_FOCUS=1 npm start
  ```
  - **iTerm2:** focuses the exact tab (matched by `ITERM_SESSION_ID`).
  - **Terminal.app:** brings Terminal to the front (per-tab targeting isn't
    reliable there).
  - Nothing leaves your machine; it only *activates* a window — it never types
    or runs anything in your session.

If the helper is off, the button tells you how to enable it. The trade-off:
enabling it lets the local web page trigger an `osascript` window-activate on
your Mac. It's local-only and limited to activating a window, but if you'd
rather not, just use **Copy cd path**.

## Feed 2 — Routines (no settings change)

Add a small snippet to a routine's prompt and it will POST its own status
(start / working / needs_review / done) to the office. The routine must run on
this Mac with the server up (a cloud routine can't reach `127.0.0.1`).

The copy-paste snippet lives in
**`adapters/routines/prompt-snippet.md`**.

---

## Feed 3 — Cowork (on by default)

Cowork (the desktop app's local agent sessions) is picked up automatically: a
read-only watcher polls the desktop session store and posts the same status
events as every other feed. It watches both the current location
(`~/Library/Application Support/Claude/local-agent-mode-sessions/`) and the
older one (`.../claude-code-sessions/`), so an app rename can't make Cowork
agents vanish. Cowork characters appear in the **Knowledge Work** cluster.

Turn it off with `AGENT_OFFICE_COWORK=0`, or point it elsewhere with
`AGENT_OFFICE_COWORK_DIR=/path/to/store`. See `adapters/cowork/README.md` for
the state heuristic and tunables.

## Settings

All settings are environment variables read at startup. The ones most worth
knowing:

| Setting | Default | What it does |
| --- | --- | --- |
| `AGENT_OFFICE_FINISHED_MS` | `3600000` (1h) | How far back the watchers look for **finished** sessions to surface in the lounge / Done tray. A session that last ran within this window is still shown; older ones are skipped. Raise it to keep a longer record (e.g. `28800000` for 8h), lower it for a tidier office. |
| `AGENT_OFFICE_DONE_TTL_MS` | `3600000` (1h) | How long a finished agent stays parked in the Done tray after completing before it leaves the office on its own. |
| `AGENT_OFFICE_INCLUDE_SCHEDULED` | off | Scheduled runs (`source: "routine"`/`"scheduled"`, and Cowork scheduled-task sessions) are hidden by default so cron-style tasks don't clutter the floor. Set to `1` to show them. |

The result out of the box: the office shows only agents that are **live right
now, or finished within the last hour** — no scheduled tasks.

Set these on the manual run (`AGENT_OFFICE_FINISHED_MS=28800000 npm start`) or
add them to the LaunchAgent plist's `EnvironmentVariables` block if you run it
always-on. The per-feed overrides `AGENT_OFFICE_CLAUDE_ACTIVE_MS` and
`AGENT_OFFICE_COWORK_ACTIVE_MS` still take precedence if you want a different
window for one feed.

## claude.ai chat

Out of scope. Not implemented.

---

## Folder map

```
agent-office/
├── server/      the local server: collector + websocket + serves the UI
├── public/      the office you see in the browser (HTML + canvas)
├── adapters/    how each feed talks to the office (claude-code, routines, cowork)
├── scripts/     build check + send-a-test-event helper
└── docs/        the event format contract + troubleshooting
```

See `docs/event-format.md` for the exact event shape every feed uses, and
`docs/troubleshooting.md` if nothing shows up.
