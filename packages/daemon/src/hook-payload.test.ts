import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HookPayloadSchema } from "@brezia/shared";

// Real PreToolUse payloads captured off the installed Claude Code (A1), scrubbed.
// The fixtures ARE the contract test: the schema must accept what the tool sends.
const FIXTURES = [
  "pretooluse-bash.json",
  "pretooluse-read.json",
  "pretooluse-write.json",
  "pretooluse-subagent-bash.json",
  "pretooluse-mcp.json",
] as const;

function loadFixture(name: string): unknown {
  const path = fileURLToPath(
    new URL(`../../../fixtures/${name}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("HookPayloadSchema accepts real captured PreToolUse payloads", () => {
  for (const name of FIXTURES) {
    it(`parses ${name}`, () => {
      expect(HookPayloadSchema.safeParse(loadFixture(name)).success).toBe(true);
    });
  }

  it("exposes tool_use_id and tool_name (idempotency key + routing)", () => {
    const parsed = HookPayloadSchema.parse(loadFixture("pretooluse-bash.json"));
    expect(parsed.tool_name).toBe("Bash");
    expect(parsed.tool_use_id).toMatch(/^toolu_/);
  });

  it("carries subagent identity when present, omits it otherwise", () => {
    const sub = HookPayloadSchema.parse(
      loadFixture("pretooluse-subagent-bash.json"),
    );
    expect(sub.agent_type).toBe("Explore");
    expect(sub.agent_id).toBeDefined();

    const plain = HookPayloadSchema.parse(loadFixture("pretooluse-bash.json"));
    expect(plain.agent_id).toBeUndefined();
  });

  it("accepts MCP tool names (mcp__<server>__<tool>)", () => {
    const parsed = HookPayloadSchema.parse(loadFixture("pretooluse-mcp.json"));
    expect(parsed.tool_name).toMatch(/^mcp__/);
    expect(parsed.tool_input).toMatchObject({ message: expect.any(String) });
  });

  it("tolerates unknown future fields (passthrough) without failing", () => {
    const base = loadFixture("pretooluse-bash.json") as Record<string, unknown>;
    const result = HookPayloadSchema.safeParse({ ...base, some_new_field: 42 });
    expect(result.success).toBe(true);
  });
});
