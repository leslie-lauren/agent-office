# Troubleshooting — "nothing shows up"

Work down this list.

### 1. Is the server running?
The Terminal where you ran `npm start` should still be open and show the
"Agent Office is running" banner. If you closed it or pressed Ctrl+C, start it
again.

### 2. Can you reach it?
In another Terminal tab:
```bash
curl -s http://127.0.0.1:4317/health
```
Expect `{"ok":true,"agents":0}`. If you get "Connection refused", the server
isn't running (see step 1) or it's on a different port.

### 3. Does a manual test event work?
```bash
cd ~/agent-office && npm run send-test-event
```
Expect `HTTP 200` and `{"ok":true,...}`, and a character in the browser.
- If the script says "Could not reach the collector", the server is down.
- If you get `HTTP 400`, the event was malformed (check the field rules in
  `event-format.md`).

### 4. Browser shows "disconnected"?
The top-left dot turns red and says "disconnected — retrying…" when the page
can't reach the websocket. It auto-reconnects every 1.5s — just restart the
server and it'll go green ("live") on its own.

### 5. Port already in use?
If `npm start` prints "Port 4317 is already in use", another copy is running.
Either stop that one, or start on another port and use it everywhere:
```bash
PORT=4318 npm start
PORT=4318 npm run send-test-event
```

### 6. Claude Code feed not appearing?
- Confirm you applied the `hooks` block to `~/.claude/settings.json`
  (see README) and started a **new** Claude Code session afterward.
- Confirm the path in the hook command matches where this project lives.
- The hook is best-effort and silent by design; it won't show errors. Test the
  collector directly (step 3) to prove the office side works, then re-check the
  settings file.
