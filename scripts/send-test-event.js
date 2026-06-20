// Sends one fake status event to the collector, using only Node's built-in http
// (no extra dependencies, no external network — talks to 127.0.0.1 only).
//
// Usage:
//   npm run send-test-event
//   node scripts/send-test-event.js working "writing the report"
//   PORT=4318 node scripts/send-test-event.js needs_review "please check"

const http = require("http");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;
const state = process.argv[2] || "working";
const task = process.argv[3] || "demo";

const payload = JSON.stringify({
  agent_id: process.env.AGENT_ID || "test",
  source: process.env.SOURCE || "test",
  state,
  task,
  timestamp: Date.now(),
});

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
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      console.log(`HTTP ${res.statusCode}`);
      console.log(body);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  }
);

req.on("error", (err) => {
  console.error("Could not reach the collector:", err.message);
  console.error(`Is the server running? Try:  npm start   (expecting port ${PORT})`);
  process.exit(1);
});

req.write(payload);
req.end();
