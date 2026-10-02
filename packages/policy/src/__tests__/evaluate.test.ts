import { describe, it, expect } from "vitest";
import { evaluate } from "../evaluate";
import type { ApprovalEvent, Flags, Policy } from "@brezia/shared";

function event(over: Partial<ApprovalEvent> = {}): ApprovalEvent {
  return {
    source: "test",
    session: "sess",
    tool: "Bash",
    arguments: { command: "git status" },
    ...over,
  };
}

function policy(tiers: Policy["tiers"], unmatched: "ask" | "deny" = "ask"): Policy {
  return { version: 1, defaults: { unmatched }, tiers };
}

describe("tool matching", () => {
  it("matches an exact tool name", () => {
    const p = policy([{ name: "t", match: [{ tool: "Bash" }], action: "allow" }]);
    expect(evaluate(event(), p)).toMatchObject({ decision: "auto_allowed", tierName: "t" });
  });

  it("matches a glob tool name", () => {
    const p = policy([{ name: "mcp", match: [{ tool: "mcp__*" }], action: "allow" }]);
    const r = evaluate(event({ tool: "mcp__everything__echo" }), p);
    expect(r.decision).toBe("auto_allowed");
  });

  it("does not match a different tool → unmatched ask", () => {
    const p = policy([{ name: "t", match: [{ tool: "Read" }], action: "allow" }]);
    expect(evaluate(event({ tool: "Bash" }), p).decision).toBe("ask");
  });
});

describe("argument matching", () => {
  it("matches an arg glob", () => {
    const p = policy([
      { name: "ws", match: [{ tool: "Write", args: { file_path: "**/workspace/**" } }], action: "allow" },
    ]);
    const r = evaluate(
      event({ tool: "Write", arguments: { file_path: "/home/user/workspace/a.ts" } }),
      p,
    );
    expect(r.decision).toBe("auto_allowed");
  });

  it("matches an arg regex with the re: prefix", () => {
    const p = policy([
      { name: "gitread", match: [{ tool: "Bash", args: { command: "re:^git (status|log)\\b" } }], action: "allow" },
    ]);
    expect(evaluate(event({ arguments: { command: "git log --oneline" } }), p).decision).toBe("auto_allowed");
    expect(evaluate(event({ arguments: { command: "git push" } }), p).decision).toBe("ask");
  });

  it("a missing arg key never matches", () => {
    const p = policy([{ name: "t", match: [{ tool: "Bash", args: { path: "**" } }], action: "allow" }]);
    expect(evaluate(event({ arguments: { command: "ls" } }), p).decision).toBe("ask");
  });

  it("a malformed regex never matches (fails toward not-allowing)", () => {
    const p = policy([{ name: "t", match: [{ tool: "Bash", args: { command: "re:(" } }], action: "allow" }]);
    expect(evaluate(event(), p).decision).toBe("ask");
  });
});

describe("flag matching (AND within a matcher)", () => {
  const tier = { name: "escalate", match: [{ tool: "Bash", flags: ["secrets_pattern", "first_time_command"] }], action: "ask" as const };

  it("matches only when ALL listed flags are active", () => {
    const both: Flags = { secrets_pattern: true, first_time_command: true };
    expect(evaluate(event(), policy([tier], "ask"), { flags: both })).toMatchObject({ decision: "ask", tierName: "escalate" });
  });

  it("does not match when only one flag is active", () => {
    const p = policy([tier, { name: "allow-bash", match: [{ tool: "Bash" }], action: "allow" }]);
    const one: Flags = { secrets_pattern: true };
    // escalate needs both flags → skipped; falls through to allow-bash
    expect(evaluate(event(), p, { flags: one })).toMatchObject({ decision: "auto_allowed", tierName: "allow-bash" });
  });

  it("does not match when no flags are provided", () => {
    expect(evaluate(event(), policy([tier], "ask"), {}).decision).toBe("ask"); // unmatched default, not the escalate tier
  });
});

describe("tier match list is OR; tiers are ordered, first match wins", () => {
  it("a tier matches when ANY of its matchers matches", () => {
    const p = policy([
      { name: "reads", match: [{ tool: "Read" }, { tool: "Bash", args: { command: "re:^cat " } }], action: "allow" },
    ]);
    expect(evaluate(event({ tool: "Read", arguments: {} }), p).decision).toBe("auto_allowed");
    expect(evaluate(event({ arguments: { command: "cat x" } }), p).decision).toBe("auto_allowed");
  });

  it("an earlier deny tier wins over a later allow tier", () => {
    const p = policy([
      { name: "deny-rm", match: [{ tool: "Bash", args: { command: "re:\\brm\\b" } }], action: "deny" },
      { name: "allow-bash", match: [{ tool: "Bash" }], action: "allow" },
    ]);
    expect(evaluate(event({ arguments: { command: "rm -rf x" } }), p)).toMatchObject({ decision: "auto_denied", tierName: "deny-rm" });
    expect(evaluate(event({ arguments: { command: "ls" } }), p)).toMatchObject({ decision: "auto_allowed", tierName: "allow-bash" });
  });
});

describe("defaults / unmatched floor", () => {
  it("no matching tier resolves to ask when unmatched is ask", () => {
    expect(evaluate(event(), policy([], "ask")).decision).toBe("ask");
  });

  it("no matching tier resolves to auto_denied when unmatched is deny — never allow", () => {
    const r = evaluate(event(), policy([], "deny"));
    expect(r.decision).toBe("auto_denied");
    expect(r.decision).not.toBe("auto_allowed");
  });

  it("every allow result names its tier", () => {
    const p = policy([{ name: "the-tier", match: [{ tool: "Bash" }], action: "allow" }]);
    const r = evaluate(event(), p);
    expect(r.decision).toBe("auto_allowed");
    expect(r.tierName).toBe("the-tier");
  });
});
