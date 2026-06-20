// "Build" step for a no-build-step stack.
// There is nothing to compile, so this script does the equivalent sanity work:
//   1. confirms dependencies are installed
//   2. syntax-checks every server / script / public JS file by requiring/compiling it
//   3. confirms the public UI files exist
// Exits 0 if everything is sound, non-zero (with the reason) otherwise.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let problems = 0;

function fail(msg) {
  console.error("  ✗ " + msg);
  problems++;
}
function ok(msg) {
  console.log("  ✓ " + msg);
}

console.log("\nAgent Office — build check\n");

// 1. dependencies present
for (const dep of ["express", "ws"]) {
  const p = path.join(root, "node_modules", dep);
  if (fs.existsSync(p)) ok(`dependency installed: ${dep}`);
  else fail(`missing dependency: ${dep} (run: npm install)`);
}

// 2. syntax-check JS files
function syntaxCheck(absPath, label) {
  try {
    const code = fs.readFileSync(absPath, "utf8");
    // Compiling in a VM validates syntax without executing the module.
    new vm.Script(code, { filename: absPath });
    ok(`syntax ok: ${label}`);
  } catch (err) {
    fail(`syntax error in ${label}: ${err.message}`);
  }
}

const jsFiles = [
  ["server/index.js", "server/index.js"],
  ["server/collector.js", "server/collector.js"],
  ["server/state.js", "server/state.js"],
  ["server/validate.js", "server/validate.js"],
  ["server/overrides.js", "server/overrides.js"],
  ["adapters/cowork/watcher.js", "adapters/cowork/watcher.js"],
  ["adapters/claude-code/watcher.js", "adapters/claude-code/watcher.js"],
  ["public/office.js", "public/office.js"],
  ["public/characters.js", "public/characters.js"],
  ["scripts/send-test-event.js", "scripts/send-test-event.js"],
];
for (const [rel, label] of jsFiles) {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) syntaxCheck(abs, label);
  else fail(`missing file: ${rel}`);
}

// 3. UI assets present
for (const rel of ["public/index.html", "public/style.css"]) {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) ok(`present: ${rel}`);
  else fail(`missing file: ${rel}`);
}

console.log("");
if (problems > 0) {
  console.error(`Build check FAILED with ${problems} problem(s).\n`);
  process.exit(1);
}
console.log("Build check passed.\n");
process.exit(0);
