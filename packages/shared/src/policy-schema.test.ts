import { describe, it, expect } from "vitest";
import { PolicySchema } from "./index";

const valid = {
  version: 1,
  defaults: { unmatched: "ask" },
  tiers: [
    {
      name: "allow-reads",
      match: [{ tool: "Read" }, { tool: "Bash", args: { command: "re:^git status" } }],
      action: "allow",
    },
    {
      name: "escalate-secrets",
      match: [{ tool: "Bash", flags: ["secrets_pattern"] }],
      action: "ask",
      route: "security", // v1 key — accepted and ignored at v0
      batch: { window: "15m", max: 10 }, // v1 key — accepted and ignored at v0
    },
  ],
  limits: [{ per: "agent", window: "24h", max_asks_auto_allowed: 200 }],
};

describe("PolicySchema", () => {
  it("accepts a valid policy", () => {
    expect(PolicySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(PolicySchema.safeParse({ ...valid, oops: true }).success).toBe(false);
  });

  it("rejects an unknown key inside a matcher (strict)", () => {
    const bad = structuredClone(valid);
    (bad.tiers[0]!.match[0] as Record<string, unknown>).regex = "x";
    expect(PolicySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown key inside a tier (strict)", () => {
    const bad = structuredClone(valid);
    (bad.tiers[0] as Record<string, unknown>).weight = 5;
    expect(PolicySchema.safeParse(bad).success).toBe(false);
  });

  it("accepts the v1 route and batch keys on a tier (forward-compat: ignored at v0)", () => {
    // The format is designed so a v1-ready policy runs on v0 harmlessly. Both
    // keys are accepted with any shape (a string route, an object batch) while other
    // unknown tier keys are still rejected by .strict() above.
    const ok = structuredClone(valid);
    (ok.tiers[0] as Record<string, unknown>).route = "platform-team";
    (ok.tiers[0] as Record<string, unknown>).batch = { window: "5m", max: 3 };
    expect(PolicySchema.safeParse(ok).success).toBe(true);
  });

  it("rejects an unknown key inside defaults (strict)", () => {
    const bad = structuredClone(valid);
    (bad.defaults as Record<string, unknown>).fallthrough = "allow";
    expect(PolicySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a version other than 1", () => {
    expect(PolicySchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });

  it("rejects an unknown action", () => {
    const bad = structuredClone(valid);
    (bad.tiers[0] as Record<string, unknown>).action = "permit";
    expect(PolicySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unmatched default of allow (no allow-by-omission at the schema level)", () => {
    const bad = structuredClone(valid);
    (bad.defaults as Record<string, unknown>).unmatched = "allow";
    expect(PolicySchema.safeParse(bad).success).toBe(false);
  });
});
