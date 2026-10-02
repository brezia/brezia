// A1 capture harness — logs raw Claude Code PreToolUse payloads for fixture
// creation. Reads the hook JSON from stdin and writes it verbatim to
// fixtures/raw/<tool_name>-<timestamp>.json. Prints nothing and exits 0, so it
// never blocks a tool call (exit 0 + empty stdout = no decision → native flow).
//
// Temporary dev tool: remove the hook from .claude/settings.local.json once the
// five fixtures are captured. Raw captures are gitignored (may contain secrets);
// scrubbed fixtures are promoted by hand into fixtures/.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rawDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "raw");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    let tool = "unknown";
    try {
      tool = JSON.parse(input)?.tool_name ?? "unknown";
    } catch {
      // Save the raw bytes even if it doesn't parse — the shape is the point.
    }
    const safe = String(tool).replace(/[^a-zA-Z0-9._-]/g, "_");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, `${safe}-${Date.now()}.json`), input, "utf8");
  } catch {
    // Never interfere with the tool call.
  }
  process.exit(0);
});
process.stdin.on("error", () => process.exit(0));
