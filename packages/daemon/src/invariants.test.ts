import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createServer } from "./index";
import { SqliteStorage } from "./sqlite-storage";
import { GENESIS_HASH } from "@brezia/shared";
import type { Policy } from "@brezia/policy";

// The three invariants, enforced at the daemon boundary — where the hook pipeline
// and storage actually exist. Permanent: never weakened, skipped, or deleted. If a
// change breaks one, the change is wrong, not the test.
//
// Invariant 3 (audit chain) cannot live in the pure policy package (zero I/O), so
// its canonical test is here. Invariants 1 and 2 are also asserted in the pure
// policy layer (packages/policy) at the evaluation level; these are the boundary
// counterparts.

const askPolicy: Policy = { version: 1, defaults: { unmatched: "ask" }, tiers: [] };

function bash(command: string, id: string): Record<string, unknown> {
  return {
    session_id: "s", transcript_path: "t", cwd: "c", permission_mode: "default",
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id,
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type App = Awaited<ReturnType<typeof createServer>>;
async function firstPendingId(app: App): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const l = (await app.inject({ method: "GET", url: "/v1/requests" })).json() as Array<{ id: string }>;
    if (l.length > 0) return l[0]!.id;
    await sleep(5);
  }
  throw new Error("no pending request appeared");
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("Invariant 1 (boundary): no allow is emitted without a named tier", () => {
  it("a tierless auto_allowed is downgraded, never emitted as allow", async () => {
    // Inject an evaluator that returns auto_allowed with no tier (a policy bug).
    const app = await createServer({ evaluate: () => ({ decision: "auto_allowed" }), holdTimeoutMs: 40 });
    const res = await app.inject({ method: "POST", url: "/v1/hook", payload: bash("ls", "toolu_inv1") });
    expect(res.json()).toEqual({}); // held → timed out → no-decision; never allow
    await app.close();
  });
});

describe("Invariant 2 (boundary): ingestion never breaks the user", () => {
  it("malformed JSON body → 200 no-decision (native flow), never allow", async () => {
    const app = await createServer();
    const res = await app.inject({
      method: "POST", url: "/v1/hook",
      headers: { "content-type": "application/json" }, payload: "{ not valid json",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    await app.close();
  });
});

describe("Invariant 3: the audit chain verifies end-to-end", () => {
  it("verifies after a real held → human-decide loop", async () => {
    const storage = new SqliteStorage(":memory:");
    const app = await createServer({ storage, policy: askPolicy, holdTimeoutMs: 5000 });
    const hookP = app.inject({ method: "POST", url: "/v1/hook", payload: bash("rm -rf x", "toolu_inv3") });
    const id = await firstPendingId(app);
    await app.inject({ method: "POST", url: `/v1/requests/${id}/decision`, payload: { action: "deny", reason: "no" } });
    await hookP;
    // event_received + policy_decision(ask) + human_decision, all chained and linked.
    expect(storage.verifyAuditChain()).toBe(true);
    await app.close();
    storage.close(); // injected storage is caller-owned
  });

  it("detects a tampered chain (verify returns false)", () => {
    const dir = mkdtempSync(join(tmpdir(), "brezia-inv3-"));
    tmpDirs.push(dir);
    const path = join(dir, "b.db");
    const s = new SqliteStorage(path);
    s.appendAuditEntry('{"a":1}', GENESIS_HASH);
    s.appendAuditEntry('{"a":2}', s.getLastAuditEntry()!.hash);
    expect(s.verifyAuditChain()).toBe(true);
    s.close();
    // Corrupt a row out-of-band (the production adapter never mutates audit_log).
    const raw = new Database(path);
    raw.prepare(`UPDATE audit_log SET entry_json = '{"a":99}' WHERE seq = 1`).run();
    raw.close();
    const reopened = new SqliteStorage(path);
    expect(reopened.verifyAuditChain()).toBe(false);
    reopened.close();
  });
});
