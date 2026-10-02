import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "./index";
import { SqliteStorage } from "./sqlite-storage";
import { AuditEntrySchema, type Policy } from "@brezia/shared";

// A named-tier allow policy so events can auto-resolve; the default is ask.
const allowReads: Policy = {
  version: 1,
  defaults: { unmatched: "ask" },
  tiers: [{ name: "allow-reads", match: [{ tool: "Bash", bash: ["read"] }], action: "allow" }],
};
const denyAll: Policy = { version: 1, defaults: { unmatched: "deny" }, tiers: [] };

function bash(command: string, id: string): Record<string, unknown> {
  return {
    session_id: "sess-a",
    transcript_path: "t",
    cwd: "/repo",
    permission_mode: "auto",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: id,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type App = Awaited<ReturnType<typeof createServer>>;

async function firstPendingId(app: App): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const list = (await app.inject({ method: "GET", url: "/v1/requests" })).json() as Array<{ id: string }>;
    if (list.length > 0) return list[0]!.id;
    await sleep(5);
  }
  throw new Error("no pending request appeared");
}

// Each test may open its own storage; track and close them.
const stores: SqliteStorage[] = [];
function store(): SqliteStorage {
  const s = new SqliteStorage(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

// Every entry_json in the log must parse against the versioned AuditEntry contract.
function assertWellFormedEntries(s: SqliteStorage): void {
  for (const row of s.allAuditEntries()) {
    expect(AuditEntrySchema.safeParse(JSON.parse(row.entryJson)).success).toBe(true);
  }
}

describe("audit chain is written and verifies through the real loop (invariant 3)", () => {
  it("auto-allow writes event_received + policy_decision and verifies", async () => {
    const s = store();
    const app = await createServer({ storage: s, policy: allowReads });
    const res = await app.inject({ method: "POST", url: "/v1/hook", payload: bash("ls", "toolu_a") });
    expect(res.json().hookSpecificOutput.permissionDecision).toBe("allow");

    const kinds = s.allAuditEntries().map((r) => JSON.parse(r.entryJson).kind);
    expect(kinds).toEqual(["event_received", "policy_decision"]);
    expect(s.verifyAuditChain()).toBe(true);
    assertWellFormedEntries(s);
    await app.close();
  });

  it("human approve chains event_received + policy_decision(ask) + human_decision", async () => {
    const s = store();
    const app = await createServer({ storage: s, holdTimeoutMs: 5000 }); // default ask
    const hookP = app.inject({ method: "POST", url: "/v1/hook", payload: bash("rm -rf x", "toolu_b") });
    const id = await firstPendingId(app);
    await app.inject({ method: "POST", url: `/v1/requests/${id}/decision`, payload: { action: "approve", reason: "fine" } });
    expect((await hookP).json().hookSpecificOutput.permissionDecision).toBe("allow");

    const kinds = s.allAuditEntries().map((r) => JSON.parse(r.entryJson).kind);
    expect(kinds).toEqual(["event_received", "policy_decision", "human_decision"]);
    expect(s.getRequestByEventId(JSON.parse(s.allAuditEntries()[0]!.entryJson).eventId)?.status).toBe("approved");
    expect(s.verifyAuditChain()).toBe(true);
    await app.close();
  });

  it("hold timeout marks the request deferred and chains a deferral", async () => {
    const s = store();
    const app = await createServer({ storage: s, holdTimeoutMs: 40 }); // default ask
    const res = await app.inject({ method: "POST", url: "/v1/hook", payload: bash("curl x", "toolu_c") });
    expect(res.json()).toEqual({}); // native flow

    const entries = s.allAuditEntries().map((r) => JSON.parse(r.entryJson));
    expect(entries.map((e) => e.kind)).toEqual(["event_received", "policy_decision", "deferral"]);
    expect(entries[2].cause).toBe("hold_timeout");
    expect(s.listRequestsByStatus("deferred")).toHaveLength(1);
    expect(s.verifyAuditChain()).toBe(true);
    await app.close();
  });
});

describe("idempotency — a replayed tool_use_id returns the original outcome", () => {
  it("replays an auto-deny without inserting a second event or chaining again", async () => {
    const s = store();
    const app = await createServer({ storage: s, policy: denyAll });
    const first = await app.inject({ method: "POST", url: "/v1/hook", payload: bash("whatever", "toolu_dup") });
    expect(first.json().hookSpecificOutput.permissionDecision).toBe("deny");
    const chainLenBefore = s.allAuditEntries().length;

    const replay = await app.inject({ method: "POST", url: "/v1/hook", payload: bash("whatever", "toolu_dup") });
    expect(replay.json().hookSpecificOutput.permissionDecision).toBe("deny");
    expect(s.statsSince(0).total).toBe(1); // no second event row
    expect(s.allAuditEntries().length).toBe(chainLenBefore); // no re-chain
    await app.close();
  });

  it("replays a human approval outcome for a resolved held request", async () => {
    const s = store();
    const app = await createServer({ storage: s, holdTimeoutMs: 5000 });
    const hookP = app.inject({ method: "POST", url: "/v1/hook", payload: bash("deploy", "toolu_held") });
    const id = await firstPendingId(app);
    await app.inject({ method: "POST", url: `/v1/requests/${id}/decision`, payload: { action: "deny", reason: "nope" } });
    expect((await hookP).json().hookSpecificOutput.permissionDecision).toBe("deny");

    const replay = await app.inject({ method: "POST", url: "/v1/hook", payload: bash("deploy", "toolu_held") });
    expect(replay.json().hookSpecificOutput.permissionDecision).toBe("deny");
    expect(replay.json().hookSpecificOutput.permissionDecisionReason).toContain("nope");
    await app.close();
  });
});

describe("crash recovery — pending requests resolve deferred on startup", () => {
  it("a request left pending by a prior process is deferred and chained on next boot", async () => {
    const s = store();
    // Simulate a prior process: an event + a pending request, no resolution.
    s.insertEvent({
      id: "ev-orphan", ts: Date.now(), source: "claude-code-http", session: "sess-a",
      tool: "Bash", arguments: { command: "sleep 999" }, flags: {}, decision: "ask",
    });
    s.insertRequest({ id: "req-orphan", eventId: "ev-orphan", status: "pending", createdTs: Date.now() });

    // Boot a fresh server over the same storage → recovery runs in createServer.
    const app = await createServer({ storage: s });
    expect(s.getRequest("req-orphan")?.status).toBe("deferred");
    const last = JSON.parse(s.allAuditEntries().at(-1)!.entryJson);
    expect(last).toMatchObject({ kind: "deferral", cause: "crash_recovery", requestId: "req-orphan" });
    expect(s.verifyAuditChain()).toBe(true);
    await app.close();
  });
});

describe("/v1/stats — the rolling auto-resolved counter", () => {
  it("reports auto-resolved ÷ total over the window", async () => {
    const s = store();
    const app = await createServer({ storage: s, policy: allowReads, holdTimeoutMs: 40 });
    await app.inject({ method: "POST", url: "/v1/hook", payload: bash("ls", "toolu_1") }); // auto-allow
    await app.inject({ method: "POST", url: "/v1/hook", payload: bash("ls", "toolu_2") }); // auto-allow
    await app.inject({ method: "POST", url: "/v1/hook", payload: bash("rm -rf /", "toolu_3") }); // ask → held → timeout

    const stats = (await app.inject({ method: "GET", url: "/v1/stats" })).json();
    expect(stats).toMatchObject({ windowDays: 7, total: 3, autoResolved: 2 });
    expect(stats.ratio).toBeCloseTo(2 / 3, 5);
    await app.close();
  });

  it("empty history reports a zero ratio, not NaN", async () => {
    const app = await createServer({ storage: store() });
    const stats = (await app.inject({ method: "GET", url: "/v1/stats" })).json();
    expect(stats).toMatchObject({ total: 0, autoResolved: 0, ratio: 0 });
    await app.close();
  });
});
