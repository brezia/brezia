import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogger } from "./logger";
import { createServer } from "./index";
import type { Policy } from "@brezia/policy";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "brezia-log-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("makeLogger", () => {
  it("is a no-op (and never throws) with no path", () => {
    const log = makeLogger(undefined);
    expect(() => log("anything")).not.toThrow();
  });

  it("appends timestamped lines to the file", () => {
    const file = join(tmp(), "brezia.log");
    const log = makeLogger(file);
    log("first");
    log("second");
    const contents = readFileSync(file, "utf8");
    const lines = contents.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT.* first$/);
    expect(lines[1]).toContain("second");
  });
});

describe("daemon logs decisions to the log file", () => {
  const denyPolicy: Policy = { version: 1, defaults: { unmatched: "deny" }, tiers: [] };
  function bash(command: string, id: string): Record<string, unknown> {
    return { session_id: "sess-log", transcript_path: "t", cwd: "c", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id };
  }

  it("writes a per-decision line for an auto decision", async () => {
    const file = join(tmp(), "brezia.log");
    const app = await createServer({ policy: denyPolicy, logPath: file });
    await app.inject({ method: "POST", url: "/v1/hook", payload: bash("whatever", "toolu_log1") });
    await app.close();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("hook sess-log Bash -> auto_denied");
  });
});
