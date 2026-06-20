# Routine status snippet (copy-paste)

Add the block below to a routine's prompt. It tells the routine to report its
own status to Agent Office at the start, while working, and when it finishes —
no settings changes required. The routine just runs a `curl` command, which it
can do as a normal shell step.

> **Note:** the routine must run somewhere that can reach `127.0.0.1:4317` —
> i.e. on this same Mac with the Agent Office server running. A routine running
> in the cloud cannot reach your local machine.

---

## Paste this into the routine's prompt

```
You are also reporting your status to my local Agent Office dashboard.
Pick a short, stable AGENT_ID for yourself (e.g. "nightly-report") and reuse it.
At each stage below, run this exact shell command, changing only STATE and TASK:

  curl -s -X POST http://127.0.0.1:4317/event \
    -H 'Content-Type: application/json' \
    -d '{"agent_id":"AGENT_ID","source":"routine","state":"STATE","task":"TASK","timestamp":'"$(date +%s000)"'}'

Report status as follows:
- When you START, send STATE="working", TASK="starting <one-line description>".
- While doing long steps, send STATE="working" with a TASK describing the step.
- If you need me to review or approve something, send STATE="needs_review",
  TASK="<what you need from me>".
- When you FINISH successfully, send STATE="done", TASK="finished <description>".

If the curl command fails, ignore the error and continue your real work —
status reporting is best-effort and must never block the task.
```

---

## Try one line by hand first

To confirm the office is reachable before trusting a routine with it, paste
this into Terminal (server must be running):

```bash
curl -s -X POST http://127.0.0.1:4317/event \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"nightly-report","source":"routine","state":"working","task":"manual test","timestamp":'"$(date +%s000)"'}'
```

You should see a `{"ok":true,...}` response and a character appear in the office.
