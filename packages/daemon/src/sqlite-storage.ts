import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  GENESIS_HASH,
  type AggregationDim,
  type AuditRow,
  type Request,
  type RequestStatus,
  type StorageAdapter,
  type StoredEvent,
} from "@brezia/shared";

// The audit hash. Kept here (not in shared) because it is I/O-adjacent chain
// mechanics; shared owns only the entry shape and the genesis constant. verify
// re-hashes the exact stored entry_json string — never a re-serialization.
export function chainHash(prevHash: string, entryJson: string): string {
  return createHash("sha256").update(prevHash + entryJson).digest("hex");
}

// SQLite implementation of StorageAdapter (decisions.md 003). Synchronous by
// design — better-sqlite3 is sync, so every method here is a plain function call
// with no async ceremony. WAL mode serves the UI/SSE reads alongside writes.
//
// APPEND-ONLY AUDIT LOG (hard rule): there is no UPDATE or DELETE statement for
// audit_log anywhere in this file. Do not add one.
export class SqliteStorage implements StorageAdapter {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        tool TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        context_json TEXT,
        flags_json TEXT,
        policy_tier TEXT,
        decision TEXT NOT NULL,
        idempotency_key TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_decision_ts ON events(decision, ts);

      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id),
        status TEXT NOT NULL,
        created_ts INTEGER,
        resolved_ts INTEGER,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_event ON requests(event_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        entry_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- Events -------------------------------------------------------------

  insertEvent(event: StoredEvent): void {
    this.db
      .prepare(
        `INSERT INTO events
           (id, ts, source, session_id, tool, arguments_json, context_json,
            flags_json, policy_tier, decision, idempotency_key)
         VALUES
           (@id, @ts, @source, @session, @tool, @argumentsJson, @contextJson,
            @flagsJson, @policyTier, @decision, @idempotencyKey)`,
      )
      .run({
        id: event.id,
        ts: event.ts,
        source: event.source,
        session: event.session,
        tool: event.tool,
        argumentsJson: JSON.stringify(event.arguments),
        contextJson: event.context ? JSON.stringify(event.context) : null,
        flagsJson: JSON.stringify(event.flags),
        policyTier: event.policyTier ?? null,
        decision: event.decision,
        idempotencyKey: event.idempotencyKey ?? null,
      });
  }

  getEventByIdempotencyKey(key: string): StoredEvent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM events WHERE idempotency_key = ?`)
      .get(key) as EventRow | undefined;
    return row ? rowToStoredEvent(row) : undefined;
  }

  // ---- Derived history (first-time flags) ---------------------------------

  hasSeenTool(tool: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM events WHERE tool = ? LIMIT 1`)
      .get(tool);
    return row !== undefined;
  }

  hasSeenCommand(command: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM events WHERE json_extract(arguments_json, '$.command') = ? LIMIT 1`,
      )
      .get(command);
    return row !== undefined;
  }

  // ---- Derived counter (aggregation limits) -------------------------------

  countAutoAllows(dim: AggregationDim, value: string, sinceTs: number): number {
    // agent → owner when present, else session (mirrors aggregationKey in policy).
    const column =
      dim === "tool"
        ? "tool"
        : dim === "session"
          ? "session_id"
          : "COALESCE(json_extract(context_json, '$.owner'), session_id)";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE decision = 'auto_allowed' AND ts >= ? AND ${column} = ?`,
      )
      .get(sinceTs, value) as { n: number };
    return row.n;
  }

  // ---- Rolling stats counter ---------------------------------------------

  statsSince(sinceTs: number): { total: number; autoResolved: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN decision IN ('auto_allowed','auto_denied') THEN 1 ELSE 0 END) AS autoResolved
         FROM events WHERE ts >= ?`,
      )
      .get(sinceTs) as { total: number; autoResolved: number | null };
    return { total: row.total, autoResolved: row.autoResolved ?? 0 };
  }

  // ---- Requests -----------------------------------------------------------

  insertRequest(request: Request): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, event_id, status, created_ts, resolved_ts, reason)
         VALUES (@id, @eventId, @status, @createdTs, @resolvedTs, @reason)`,
      )
      .run({
        id: request.id,
        eventId: request.eventId,
        status: request.status,
        createdTs: request.createdTs,
        resolvedTs: request.resolvedTs ?? null,
        reason: request.reason ?? null,
      });
  }

  getRequest(id: string): Request | undefined {
    const row = this.db
      .prepare(`SELECT * FROM requests WHERE id = ?`)
      .get(id) as RequestRow | undefined;
    return row ? rowToRequest(row) : undefined;
  }

  getRequestByEventId(eventId: string): Request | undefined {
    const row = this.db
      .prepare(`SELECT * FROM requests WHERE event_id = ? ORDER BY created_ts LIMIT 1`)
      .get(eventId) as RequestRow | undefined;
    return row ? rowToRequest(row) : undefined;
  }

  listRequestsByStatus(status: RequestStatus): Request[] {
    const rows = this.db
      .prepare(`SELECT * FROM requests WHERE status = ? ORDER BY created_ts`)
      .all(status) as RequestRow[];
    return rows.map(rowToRequest);
  }

  updateRequestStatus(
    id: string,
    status: RequestStatus,
    resolvedTs: number,
    reason?: string,
  ): void {
    // requests is a mutable lifecycle table (pending → resolved); the append-only
    // rule applies to audit_log, not here.
    this.db
      .prepare(
        `UPDATE requests SET status = ?, resolved_ts = ?, reason = ? WHERE id = ?`,
      )
      .run(status, resolvedTs, reason ?? null, id);
  }

  // ---- Audit chain (append-only) -----------------------------------------

  appendAuditEntry(
    entryJson: string,
    prevHash: string,
  ): { seq: number; hash: string } {
    const ts = Date.now();
    const hash = chainHash(prevHash, entryJson);
    const info = this.db
      .prepare(
        `INSERT INTO audit_log (ts, entry_json, prev_hash, hash) VALUES (?, ?, ?, ?)`,
      )
      .run(ts, entryJson, prevHash, hash);
    return { seq: Number(info.lastInsertRowid), hash };
  }

  getLastAuditEntry(): { seq: number; hash: string } | undefined {
    const row = this.db
      .prepare(`SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`)
      .get() as { seq: number; hash: string } | undefined;
    return row;
  }

  allAuditEntries(): AuditRow[] {
    const rows = this.db
      .prepare(
        `SELECT seq, ts, entry_json AS entryJson, prev_hash AS prevHash, hash
           FROM audit_log ORDER BY seq`,
      )
      .all() as AuditRow[];
    return rows;
  }

  // Walk the chain end to end: seq 1's prev_hash is GENESIS, every prev_hash links
  // the previous hash, and every stored hash equals sha256(prev_hash + entry_json).
  verifyAuditChain(): boolean {
    let expectedPrev = GENESIS_HASH;
    for (const row of this.allAuditEntries()) {
      if (row.prevHash !== expectedPrev) return false;
      if (chainHash(row.prevHash, row.entryJson) !== row.hash) return false;
      expectedPrev = row.hash;
    }
    return true;
  }
}

// ---- Row mappers ----------------------------------------------------------

interface EventRow {
  id: string;
  ts: number;
  source: string;
  session_id: string | null;
  tool: string;
  arguments_json: string;
  context_json: string | null;
  flags_json: string | null;
  policy_tier: string | null;
  decision: string;
  idempotency_key: string | null;
}

interface RequestRow {
  id: string;
  event_id: string;
  status: string;
  created_ts: number | null;
  resolved_ts: number | null;
  reason: string | null;
}

function rowToStoredEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source,
    session: row.session_id ?? "",
    tool: row.tool,
    arguments: JSON.parse(row.arguments_json),
    context: row.context_json ? JSON.parse(row.context_json) : undefined,
    flags: row.flags_json ? JSON.parse(row.flags_json) : {},
    policyTier: row.policy_tier ?? undefined,
    decision: row.decision as StoredEvent["decision"],
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}

function rowToRequest(row: RequestRow): Request {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status as Request["status"],
    createdTs: row.created_ts ?? 0,
    resolvedTs: row.resolved_ts ?? undefined,
    reason: row.reason ?? undefined,
  };
}
