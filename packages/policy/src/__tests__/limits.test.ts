import { describe, it, expect } from "vitest";
import { evaluate } from "../evaluate";
import { parseWindowMs, aggregationKey, type AllowCounter } from "../limits";
import type { ApprovalEvent, Policy } from "@brezia/shared";

const event: ApprovalEvent = { source: "t", session: "sess-1", tool: "Bash", arguments: { command: "ls" } };

const allowPolicy: Policy = {
  version: 1,
  defaults: { unmatched: "ask" },
  tiers: [{ name: "allow-bash", match: [{ tool: "Bash" }], action: "allow" }],
  limits: [{ per: "tool", window: "24h", max_asks_auto_allowed: 2 }],
};

function counterReturning(count: number): AllowCounter {
  return { countInWindow: () => count };
}

describe("parseWindowMs", () => {
  it("parses units", () => {
    expect(parseWindowMs("30s")).toBe(30_000);
    expect(parseWindowMs("15m")).toBe(900_000);
    expect(parseWindowMs("24h")).toBe(86_400_000);
    expect(parseWindowMs("2d")).toBe(172_800_000);
  });
  it("returns null for a bad window", () => {
    expect(parseWindowMs("soon")).toBeNull();
  });
});

describe("aggregationKey", () => {
  it("keys by dimension; agent falls back to session", () => {
    expect(aggregationKey("tool", event)).toBe("tool:Bash");
    expect(aggregationKey("session", event)).toBe("session:sess-1");
    expect(aggregationKey("agent", event)).toBe("agent:sess-1");
    expect(aggregationKey("agent", { ...event, context: { owner: "maya" } })).toBe("agent:maya");
  });
});

describe("aggregation limits downgrade allow → ask on breach", () => {
  const now = 1_000_000;

  it("allows while under the ceiling", () => {
    const r = evaluate(event, allowPolicy, { now, allowCounter: counterReturning(1) });
    expect(r).toMatchObject({ decision: "auto_allowed", tierName: "allow-bash" });
  });

  it("escalates to ask once the ceiling is reached", () => {
    const r = evaluate(event, allowPolicy, { now, allowCounter: counterReturning(2) });
    expect(r.decision).toBe("ask");
    expect(r.tierName).toBe("allow-bash");
    expect(r.reason).toContain("aggregation limit");
  });

  it("does not enforce limits without a clock or counter (allows)", () => {
    expect(evaluate(event, allowPolicy, {}).decision).toBe("auto_allowed");
    expect(evaluate(event, allowPolicy, { now }).decision).toBe("auto_allowed");
    expect(evaluate(event, allowPolicy, { allowCounter: counterReturning(99) }).decision).toBe("auto_allowed");
  });

  it("a breached limit never turns an allow into an allow — only ask (never fails toward allow)", () => {
    const r = evaluate(event, allowPolicy, { now, allowCounter: counterReturning(1000) });
    expect(r.decision).not.toBe("auto_allowed");
    expect(r.decision).toBe("ask");
  });
});
