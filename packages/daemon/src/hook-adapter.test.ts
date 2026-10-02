import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HookPayloadSchema } from "@brezia/shared";
import { hookPayloadToEvent, hookDecision, NO_DECISION } from "./hook-adapter";

function loadEvent(name: string) {
  const path = fileURLToPath(
    new URL(`../../../fixtures/${name}`, import.meta.url),
  );
  const payload = HookPayloadSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return hookPayloadToEvent(payload);
}

describe("hookPayloadToEvent maps hook fields onto the Events API contract", () => {
  it("maps a Bash payload's core fields", () => {
    const e = loadEvent("pretooluse-bash.json");
    expect(e.source).toBe("claude-code-http");
    expect(e.tool).toBe("Bash");
    expect(e.session).toBe("11111111-1111-4111-8111-111111111111");
    expect(e.idempotencyKey).toBe("toolu_01BASHfixture000000000000");
    expect(e.arguments).toMatchObject({ command: expect.any(String) });
    expect(e.context?.cwd).toContain("brezia");
  });

  it("uses tool_use_id as the idempotency key for every fixture", () => {
    for (const f of [
      "pretooluse-read.json",
      "pretooluse-write.json",
      "pretooluse-mcp.json",
      "pretooluse-subagent-bash.json",
    ]) {
      expect(loadEvent(f).idempotencyKey).toMatch(/^toolu_/);
    }
  });

  it("carries the MCP tool name through unchanged", () => {
    expect(loadEvent("pretooluse-mcp.json").tool).toBe("mcp__everything__echo");
  });
});

describe("hook decision responses match the hook protocol", () => {
  it("builds an allow decision in the hookSpecificOutput shape", () => {
    expect(hookDecision("allow", "brezia: ok")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "brezia: ok",
      },
    });
  });

  it("NO_DECISION is an empty object (native flow)", () => {
    expect(NO_DECISION).toEqual({});
  });
});
