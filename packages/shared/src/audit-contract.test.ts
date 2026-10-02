import { describe, it, expect } from "vitest";
import { AuditEntrySchema, GENESIS_HASH, type AuditEntry } from "./index";

describe("audit chain contract", () => {
  it("GENESIS_HASH is a well-known 64-hex-zero constant", () => {
    expect(GENESIS_HASH).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(GENESIS_HASH).toHaveLength(64);
  });

  const valid: AuditEntry[] = [
    { kind: "event_received", ts: 1, eventId: "e1", source: "claude-code-http", session: "s", tool: "Bash", idempotencyKey: "toolu_1" },
    { kind: "policy_decision", ts: 2, eventId: "e1", decision: "auto_allowed", tierName: "reads", reason: "tier 'reads'" },
    { kind: "human_decision", ts: 3, requestId: "r1", eventId: "e1", status: "approved", reason: "looks fine" },
    { kind: "deferral", ts: 4, requestId: "r1", eventId: "e1", cause: "hold_timeout" },
    { kind: "deferral", ts: 5, requestId: "r2", eventId: "e2", cause: "crash_recovery" },
    { kind: "policy_reload", ts: 6, ok: false, error: "unknown key 'tierz'" },
  ];

  it.each(valid)("accepts a well-formed $kind entry and round-trips through JSON", (entry) => {
    expect(AuditEntrySchema.parse(entry)).toEqual(entry);
    // verify re-hashes the exact stored string; a parse of that string must equal.
    expect(AuditEntrySchema.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  it("rejects an unknown kind", () => {
    expect(AuditEntrySchema.safeParse({ kind: "nope", ts: 1 }).success).toBe(false);
  });

  it("rejects a decision entry with a bad decision value", () => {
    expect(
      AuditEntrySchema.safeParse({ kind: "policy_decision", ts: 1, eventId: "e", decision: "yes" }).success,
    ).toBe(false);
  });

  it("rejects a deferral with an out-of-set cause", () => {
    expect(
      AuditEntrySchema.safeParse({ kind: "deferral", ts: 1, requestId: "r", eventId: "e", cause: "bored" }).success,
    ).toBe(false);
  });
});
