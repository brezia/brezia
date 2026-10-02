import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SqliteStorage, chainHash } from "./sqlite-storage";
import { GENESIS_HASH, type StoredEvent } from "@brezia/shared";

function storage(): SqliteStorage {
  return new SqliteStorage(":memory:");
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function event(over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: over.id ?? "e1",
    ts: over.ts ?? 1000,
    source: "claude-code-http",
    session: over.session ?? "sess-a",
    tool: over.tool ?? "Bash",
    arguments: over.arguments ?? { command: "ls" },
    context: over.context,
    flags: over.flags ?? {},
    policyTier: over.policyTier,
    decision: over.decision ?? "ask",
    idempotencyKey: over.idempotencyKey,
  };
}

describe("SqliteStorage — events", () => {
  it("round-trips a stored event by idempotency key", () => {
    const s = storage();
    const e = event({
      idempotencyKey: "toolu_1",
      flags: { first_time_command: true },
      policyTier: "reads",
      decision: "auto_allowed",
      context: { cwd: "/repo", owner: "agent-7" },
    });
    s.insertEvent(e);
    expect(s.getEventByIdempotencyKey("toolu_1")).toEqual(e);
    expect(s.getEventByIdempotencyKey("missing")).toBeUndefined();
  });

  it("enforces idempotency_key uniqueness (replay collision throws)", () => {
    const s = storage();
    s.insertEvent(event({ id: "e1", idempotencyKey: "toolu_dup" }));
    expect(() => s.insertEvent(event({ id: "e2", idempotencyKey: "toolu_dup" }))).toThrow();
  });

  it("allows many events with no idempotency key (NULLs are not unique-collided)", () => {
    const s = storage();
    s.insertEvent(event({ id: "e1", idempotencyKey: undefined }));
    s.insertEvent(event({ id: "e2", idempotencyKey: undefined }));
    expect(s.statsSince(0).total).toBe(2);
  });
});

describe("SqliteStorage — derived history", () => {
  it("hasSeenTool / hasSeenCommand reflect prior events only", () => {
    const s = storage();
    expect(s.hasSeenTool("Bash")).toBe(false);
    expect(s.hasSeenCommand("git status")).toBe(false);
    s.insertEvent(event({ id: "e1", tool: "Bash", arguments: { command: "git status" } }));
    expect(s.hasSeenTool("Bash")).toBe(true);
    expect(s.hasSeenCommand("git status")).toBe(true);
    expect(s.hasSeenCommand("git push")).toBe(false);
  });
});

describe("SqliteStorage — derived auto-allow counter", () => {
  it("counts only auto_allowed events within the window, per dimension", () => {
    const s = storage();
    s.insertEvent(event({ id: "e1", tool: "Bash", session: "sess-a", ts: 100, decision: "auto_allowed" }));
    s.insertEvent(event({ id: "e2", tool: "Bash", session: "sess-b", ts: 200, decision: "auto_allowed" }));
    s.insertEvent(event({ id: "e3", tool: "Bash", session: "sess-a", ts: 300, decision: "ask" })); // not counted
    s.insertEvent(event({ id: "e4", tool: "Read", session: "sess-a", ts: 400, decision: "auto_allowed" }));

    expect(s.countAutoAllows("tool", "Bash", 0)).toBe(2); // e1, e2 (e3 is ask)
    expect(s.countAutoAllows("session", "sess-a", 0)).toBe(2); // e1, e4 (e3 is ask)
    expect(s.countAutoAllows("tool", "Bash", 150)).toBe(1); // window cutoff drops e1
  });

  it("agent dimension uses owner when present, else session", () => {
    const s = storage();
    s.insertEvent(event({ id: "e1", session: "sess-a", ts: 100, decision: "auto_allowed", context: { owner: "agent-7" } }));
    s.insertEvent(event({ id: "e2", session: "sess-a", ts: 200, decision: "auto_allowed" })); // no owner → session
    expect(s.countAutoAllows("agent", "agent-7", 0)).toBe(1);
    expect(s.countAutoAllows("agent", "sess-a", 0)).toBe(1);
  });
});

describe("SqliteStorage — rolling stats", () => {
  it("counts total and auto-resolved since a cutoff", () => {
    const s = storage();
    s.insertEvent(event({ id: "e1", ts: 100, decision: "auto_allowed" }));
    s.insertEvent(event({ id: "e2", ts: 200, decision: "auto_denied" }));
    s.insertEvent(event({ id: "e3", ts: 300, decision: "ask" }));
    expect(s.statsSince(0)).toEqual({ total: 3, autoResolved: 2 });
    expect(s.statsSince(150)).toEqual({ total: 2, autoResolved: 1 });
    expect(s.statsSince(9999)).toEqual({ total: 0, autoResolved: 0 });
  });
});

describe("SqliteStorage — requests", () => {
  it("insert, get, get-by-event, list-by-status, update lifecycle", () => {
    const s = storage();
    s.insertEvent(event({ id: "e1" }));
    s.insertRequest({ id: "r1", eventId: "e1", status: "pending", createdTs: 500 });
    expect(s.getRequest("r1")?.status).toBe("pending");
    expect(s.getRequestByEventId("e1")?.id).toBe("r1");
    expect(s.listRequestsByStatus("pending").map((r) => r.id)).toEqual(["r1"]);

    s.updateRequestStatus("r1", "approved", 600, "ok by human");
    expect(s.getRequest("r1")).toMatchObject({ status: "approved", resolvedTs: 600, reason: "ok by human" });
    expect(s.listRequestsByStatus("pending")).toEqual([]);
  });
});

describe("SqliteStorage — audit chain (invariant 3)", () => {
  it("links from genesis and verifies end to end", () => {
    const s = storage();
    let prev = s.getLastAuditEntry()?.hash ?? GENESIS_HASH;
    const first = s.appendAuditEntry('{"kind":"event_received"}', prev);
    expect(first.seq).toBe(1);
    expect(first.hash).toBe(chainHash(GENESIS_HASH, '{"kind":"event_received"}'));

    prev = s.getLastAuditEntry()!.hash;
    s.appendAuditEntry('{"kind":"policy_decision"}', prev);
    expect(s.verifyAuditChain()).toBe(true);
  });

  it("an empty chain verifies (vacuously true)", () => {
    expect(storage().verifyAuditChain()).toBe(true);
  });

  it("detects a tampered entry_json (stored hash no longer matches)", () => {
    // A file-backed DB so a raw handle can corrupt a row after the fact — the
    // production adapter never mutates audit_log; this simulates disk tampering.
    const dir = mkdtempSync(join(tmpdir(), "brezia-audit-"));
    tmpDirs.push(dir);
    const path = join(dir, "brezia.db");
    const s = new SqliteStorage(path);
    s.appendAuditEntry('{"a":1}', GENESIS_HASH);
    s.appendAuditEntry('{"a":2}', s.getLastAuditEntry()!.hash);
    expect(s.verifyAuditChain()).toBe(true);
    s.close();

    const raw = new Database(path);
    raw.prepare(`UPDATE audit_log SET entry_json = '{"a":99}' WHERE seq = 1`).run();
    raw.close();

    const reopened = new SqliteStorage(path);
    expect(reopened.verifyAuditChain()).toBe(false); // hash no longer matches entry
    reopened.close();
  });

  it("detects a broken prev_hash link", () => {
    const s = storage();
    s.appendAuditEntry('{"a":1}', GENESIS_HASH);
    s.appendAuditEntry('{"a":2}', "wrong-prev"); // should have been the prior hash
    expect(s.verifyAuditChain()).toBe(false);
  });
});

describe("audit_log is append-only (hard rule, enforced by source scan)", () => {
  it("has no UPDATE or DELETE statement against audit_log", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./sqlite-storage.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/\bupdate\s+audit_log\b/i);
    expect(src).not.toMatch(/\bdelete\s+from\s+audit_log\b/i);
  });
});
