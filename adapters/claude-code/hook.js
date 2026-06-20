#!/usr/bin/env node
// Agent Office — Claude Code hook adapter.
//
// Claude Code runs this on lifecycle/tool events and pipes a JSON object to it
// on stdin. We translate that into an Agent Office status event and POST it to
// the local collector. Dependency-free (Node built-ins only) and local-only.
//
// It NEVER throws back into Claude Code: any failure is swallowed so your
// Claude session is never blocked by the office being down.

const http = require("http");

const PORT = process.env.AGENT_OFFICE_PORT
  ? Number(process.env.AGENT_OFFICE_PORT)
  : 4317;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  send(toEvent(input));
});
// If stdin never closes (edge case), don't hang forever.
setTimeout(() => process.exit(0), 4000).unref();

// Map a Claude Code hook payload to a status event.
function toEvent(input) {
  const hook = input.hook_event_name || process.env.CLAUDE_HOOK_EVENT || "";
  const sessionId = input.session_id || "claude-session";

  // state by hook type
  let state = "working";
  let task = "";
  let lifecycle = ""; // "end" tells the office to remove this session's character

  switch (hook) {
    case "SessionStart":
      state = "idle";
      task = "session started";
      break;
    case "UserPromptSubmit":
      state = "working";
      task = "thinking";
      break;
    case "PreToolUse":
      state = "working";
      task = "using " + (input.tool_name || "a tool");
      break;
    case "PostToolUse":
      state = "working";
      task = "ran " + (input.tool_name || "a tool");
      break;
    case "Notification":
      // Claude Code notifies when it needs your attention (e.g. permission).
      state = "needs_review";
      task = input.message || "needs your attention";
      break;
    case "Stop":
    case "SubagentStop":
      state = "done";
      task = "finished a turn";
      break;
    case "SessionEnd":
      state = "idle";
      task = "session ended";
      lifecycle = "end"; // session is over → office removes the character
      break;
    default:
      state = "working";
      task = hook || "active";
  }

  return {
    agent_id: "claude:" + String(sessionId).slice(0, 8),
    source: "claude-code",
    state,
    task,
    timestamp: Date.now(),
    // Context so the office can offer "jump to this session's window".
    meta: {
      cwd: input.cwd || process.cwd(),
      session_id: sessionId,
      transcript_path: input.transcript_path || "",
      terminal: process.env.TERM_PROGRAM || "",
      iterm_session: process.env.ITERM_SESSION_ID || "",
      lifecycle,
    },
  };
}

function send(event) {
  const payload = JSON.stringify(event);
  const req = http.request(
    {
      host: "127.0.0.1",
      port: PORT,
      path: "/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    (res) => {
      res.on("data", () => {});
      res.on("end", () => process.exit(0));
    }
  );
  // Swallow all errors so Claude Code is never disrupted.
  req.on("error", () => process.exit(0));
  req.setTimeout(1500, () => {
    req.destroy();
    process.exit(0);
  });
  req.write(payload);
  req.end();
}
