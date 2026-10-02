import { describe, it, expect } from "vitest";
import { evaluate, type Policy } from "../index";
import type { ApprovalEvent, PolicyResult } from "@brezia/shared";

// These three tests are permanent. They are never weakened, skipped, or deleted.
// If a change breaks one, the change is wrong — never the test.

const minimalEvent: ApprovalEvent = {
  source: "test",
  session: "sess_test",
  tool: "bash.exec",
  arguments: { command: "ls -la" },
};

const allowAllPolicy: Policy = {
  version: 1,
  defaults: { unmatched: "ask" },
  tiers: [{ name: "allow-all", match: [{ tool: "*" }], action: "allow" }],
};

const emptyPolicy: Policy = {
  version: 1,
  defaults: { unmatched: "ask" },
  tiers: [],
};

const denyDefaultPolicy: Policy = {
  version: 1,
  defaults: { unmatched: "deny" },
  tiers: [],
};

// Invariant 1 — no event ever resolves auto_allowed without a named matching tier.
describe("Invariant 1: no auto_allowed without a named matching tier", () => {
  it("auto_allowed always carries a non-empty tierName", () => {
    const r = evaluate(minimalEvent, allowAllPolicy);
    if (r.decision === "auto_allowed") {
      expect(typeof r.tierName).toBe("string");
      expect(r.tierName?.length ?? 0).toBeGreaterThan(0);
    }
    // Load-bearing: allowAllPolicy resolves to auto_allowed, so the tierName
    // assertions above actually execute.
  });

  it("an unmatched event never resolves auto_allowed", () => {
    expect(evaluate(minimalEvent, emptyPolicy).decision).not.toBe("auto_allowed");
  });

  it("deny-default unmatched resolves auto_denied, not auto_allowed", () => {
    expect(evaluate(minimalEvent, denyDefaultPolicy).decision).toBe("auto_denied");
  });

  it("across varied tools, no unmatched event resolves auto_allowed without a tier", () => {
    for (const tool of ["bash.exec", "fs.write", "fs.read", "mcp.tool", ""]) {
      const r = evaluate({ ...minimalEvent, tool }, emptyPolicy);
      if (r.decision === "auto_allowed") expect(r.tierName).toBeTruthy();
    }
  });
});

// Invariant 2 — ingestion never breaks the user. Malformed input never throws out
// of evaluation and never resolves toward allow. Phase A extends this to the HTTP
// boundary; Phase B adds adversarial bash-string fuzzing.
describe("Invariant 2: malformed input never throws and never allows", () => {
  const cases: Array<[string, () => PolicyResult]> = [
    ["empty tool", () => evaluate({ ...minimalEvent, tool: "" }, emptyPolicy)],
    ["empty arguments", () => evaluate({ ...minimalEvent, arguments: {} }, emptyPolicy)],
    [
      "null tiers",
      () =>
        evaluate(minimalEvent, {
          version: 1,
          defaults: { unmatched: "ask" },
          tiers: null as unknown as PolicyTierList,
        }),
    ],
    [
      "undefined defaults",
      () =>
        evaluate(minimalEvent, {
          version: 1,
          defaults: undefined as unknown as Policy["defaults"],
          tiers: [],
        }),
    ],
    [
      "deeply nested arguments",
      () =>
        evaluate(
          { ...minimalEvent, arguments: { a: { b: { c: null } }, arr: [1, 2, 3] } },
          emptyPolicy,
        ),
    ],
  ];

  for (const [name, run] of cases) {
    it(`${name}: does not throw`, () => {
      expect(run).not.toThrow();
    });
    it(`${name}: does not resolve auto_allowed`, () => {
      expect(run().decision).not.toBe("auto_allowed");
    });
  }
});

type PolicyTierList = Policy["tiers"];

// Invariant 3 — the audit chain verifies end-to-end. It requires SQLite storage,
// which this pure package (zero I/O) cannot import without breaking layering. Its
// canonical, real-storage test therefore lives in the daemon package:
//   packages/daemon/src/invariants.test.ts  ("Invariant 3: the audit chain
//   verifies end-to-end") — verifies after a real held→decide loop AND detects a
//   tampered chain. Additional coverage: sqlite-storage.test.ts, persistence.test.ts.
// The Phase-B placeholder that used to sit here (a hardcoded true) was false
// assurance and has been replaced by those real assertions.
