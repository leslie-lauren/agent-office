// Cowork adapter — SUPERSEDED STUB. Intentionally does nothing.
//
// The real Cowork adapter now lives in ./watcher.js (a JSONL tailer that the
// server starts automatically). This file is kept only as a historical marker
// and is NOT imported anywhere. See README.md in this folder.

const ENABLED = false;

function start() {
  if (!ENABLED) {
    console.log("[cowork] adapter is disabled (stub). See adapters/cowork/README.md");
    return;
  }
  throw new Error("Cowork adapter is not implemented.");
}

module.exports = { ENABLED, start };
