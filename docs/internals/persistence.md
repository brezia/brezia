# Persistence — SQLite and the storage layer

> Durability for a single-process localhost daemon: one embedded SQLite database
> (`better-sqlite3`, WAL, synchronous by design), three tables, and every read the policy
> layer needs *derived* from the events table — no in-memory shadow that could drift.

Brezia persists to one file, `~/.brezia/brezia.db`, behind a single `StorageAdapter`
interface. This page covers the engine choice and its consequences, the derived reads
(first-time history, the aggregation counter, rolling stats), idempotency, crash recovery,
and why SQLite is the only implementation at v0. The field-by-field schema is in
[reference/storage-adapter.md](../reference/storage-adapter.md); the append-only audit
table has its own page, [audit-chain.md](audit-chain.md).

Read [concepts.md](../concepts.md) first for `StoredEvent`, `Request`, `StorageAdapter`,
and `AggregationDim`.

## Contents

- [better-sqlite3, synchronous by design](#better-sqlite3-synchronous-by-design)
- [The three tables](#the-three-tables)
- [The StorageAdapter boundary](#the-storageadapter-boundary)
- [Derived reads — Option A](#derived-reads--option-a)
- [Idempotency via the unique key](#idempotency-via-the-unique-key)
- [Compute-before-persist ordering](#compute-before-persist-ordering)
- [Why SQLite is the only implementation](#why-sqlite-is-the-only-implementation)

---

## better-sqlite3, synchronous by design

SQLite via `better-sqlite3` is the correct engine for a single-process localhost daemon,
not a placeholder (decision 003). Three properties matter, and the code leans on all three:

- **Synchronous API.** Every storage method is a plain function call with no `await`. This
  removes async races and makes the append-and-chain transaction trivial — the read of the
  last audit hash and the append happen with nothing between them, so they cannot
  interleave (see [audit-chain.md](audit-chain.md#the-auditchain-helper--read-last-then-append)).
  The project rule is explicit: *don't wrap it in async ceremony.*
- **WAL mode.** Write-Ahead Logging lets the UI's concurrent SSE/`GET` reads proceed
  alongside the hook path's writes.
- **Embedded.** A zero-config install (`npx brezia init`) cannot ask a stranger to stand
  up Postgres; the DB is a local file that doubles as a portable evidence artifact.

```ts
// packages/daemon/src/sqlite-storage.ts:29
constructor(path: string) {
  this.db = new Database(path);
  this.db.pragma("journal_mode = WAL");
  this.db.pragma("foreign_keys = ON");
  this.migrate();
}
```

The default location is `~/.brezia/brezia.db`; tests use `":memory:"`. `start()` ensures
the directory exists before opening it.

```ts
// packages/daemon/src/index.ts:44
export function defaultDbPath(): string {
  return join(homedir(), ".brezia", "brezia.db");
}
```

## The three tables

The schema is created idempotently in `migrate()` — three tables, no ORM (the whole schema
is small enough to read at a glance). `foreign_keys = ON` links `requests.event_id` to
`events.id`.

| Table | Role | Mutability |
|---|---|---|
| `events` | One row per accepted `ApprovalEvent` + its computed flags and **effective** decision. Also *the* source for derived history, the counter, and stats. | Insert-only in practice; `idempotency_key` is `UNIQUE`. |
| `requests` | The lifecycle record of an event that resolved to `ask`. | Mutable: `pending → approved/denied/deferred` via `updateRequestStatus`. |
| `audit_log` | The hash-chained state-change log. | **Append-only** — no UPDATE/DELETE anywhere (see [audit-chain.md](audit-chain.md#append-only-enforcement)). |

```sql
-- packages/daemon/src/sqlite-storage.ts:37
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL,
  session_id TEXT, tool TEXT NOT NULL, arguments_json TEXT NOT NULL,
  context_json TEXT, flags_json TEXT, policy_tier TEXT,
  decision TEXT NOT NULL, idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_decision_ts ON events(decision, ts);
```

The three indexes on `events` are exactly the derived-read access paths: `tool` (first-time
tool + the tool counter dimension), `session_id` (grouping + the session dimension), and
the composite `(decision, ts)` (the counter and stats both filter `decision = ... AND ts >=
...`). `requests` is indexed by `status` (crash recovery lists all `pending`) and
`event_id` (idempotency replay looks up a request by its event).

> **The persisted `decision` is the effective decision.** A tierless `auto_allowed` is
> stored as `ask`, never `auto_allowed` (`packages/daemon/src/index.ts:242`), so the
> counter and stats — which both read this column — never credit an allow that Brezia
> never emitted. See [failure-semantics.md](failure-semantics.md#the-invariant-1-edge-guard).

## The StorageAdapter boundary

All persistence sits behind one interface in the contract, `StorageAdapter`
(`packages/shared/src/index.ts:315`). `SqliteStorage` is its only implementation. The
methods group into events, derived reads, requests, and the audit chain:

```ts
// packages/shared/src/index.ts:315 (abbreviated)
export interface StorageAdapter {
  insertEvent(event: StoredEvent): void;
  getEventByIdempotencyKey(key: string): StoredEvent | undefined;
  hasSeenTool(tool: string): boolean;                    // derived history
  hasSeenCommand(command: string): boolean;              // derived history
  countAutoAllows(dim: AggregationDim, value: string, sinceTs: number): number; // derived counter
  statsSince(sinceTs: number): { total: number; autoResolved: number };
  insertRequest(request: Request): void;
  getRequest(id): Request | undefined;
  getRequestByEventId(eventId): Request | undefined;
  listRequestsByStatus(status): Request[];
  updateRequestStatus(id, status, resolvedTs, reason?): void;
  appendAuditEntry(entryJson, prevHash): { seq; hash };  // no update/delete for audit_log
  getLastAuditEntry(): { seq; hash } | undefined;
  allAuditEntries(): AuditRow[];
  verifyAuditChain(): boolean;
}
```

The daemon owns the storage lifecycle when it opens the DB itself, but accepts an injected
`storage` (tests pass a `":memory:"` instance they close themselves). `createServer`
tracks ownership so it only closes what it opened:

```ts
// packages/daemon/src/index.ts:90
const ownsStorage = opts.storage === undefined;
const storage: StorageAdapter = opts.storage ?? new SqliteStorage(opts.dbPath ?? ":memory:");
```

The CLI reuses the *same* `SqliteStorage` — `packages/daemon` re-exports it so `brezia
verify`/`export` open the database through one implementation and share the single source
of chain-verification logic (`packages/daemon/src/index.ts:26`).

## Derived reads — Option A

The policy engine needs three facts that depend on history: has this tool been seen before,
has this exact command been seen before, and how many auto-allows already exist for an
aggregation key. All three are **derived from the `events` table via SQL**, not kept in an
in-memory shadow rehydrated on boot (decision 012, "Option A").

> **Why derive, not shadow.** The `events` table is already the durable record, so
> deriving from it is a single source of truth that *cannot drift* from what the audit log
> says happened; it adds no unbounded in-memory growth to a long-lived dogfood daemon; and
> it needs no tables beyond the three. The cost — accepted — is that `StorageAdapter` grew
> read-only derivation methods (`hasSeenTool`, `hasSeenCommand`, `countAutoAllows`,
> `statsSince`).

### First-time history

"Seen" means a *prior persisted event* exists. Because the current event is inserted only
*after* flags are computed (see [below](#compute-before-persist-ordering)), first-time
status is always relative to the past.

```ts
// packages/daemon/src/sqlite-storage.ts:116
hasSeenTool(tool: string): boolean {
  const row = this.db.prepare(`SELECT 1 FROM events WHERE tool = ? LIMIT 1`).get(tool);
  return row !== undefined;
}
hasSeenCommand(command: string): boolean {
  const row = this.db
    .prepare(`SELECT 1 FROM events WHERE json_extract(arguments_json, '$.command') = ? LIMIT 1`)
    .get(command);
  return row !== undefined;
}
```

`hasSeenCommand` uses SQLite's `json_extract` to reach into the stored `arguments_json` for
`$.command` — the same field Bash classification reads. The daemon wraps these in
`SqliteHistory`, which implements the pure policy layer's `HistoryLookup` interface
(`packages/daemon/src/derived.ts:7`), so `packages/policy` touches no storage.

### The aggregation counter

`countAutoAllows` powers aggregation limits (anti-splitting). It counts only
`auto_allowed` rows, in the window, matching the dimension's column — and the `agent`
dimension resolves to `owner` when present, else `session`, mirroring the policy layer's key:

```ts
// packages/daemon/src/sqlite-storage.ts:134
countAutoAllows(dim: AggregationDim, value: string, sinceTs: number): number {
  const column =
    dim === "tool" ? "tool"
    : dim === "session" ? "session_id"
    : "COALESCE(json_extract(context_json, '$.owner'), session_id)"; // agent
  const row = this.db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE decision = 'auto_allowed' AND ts >= ? AND ${column} = ?`,
  ).get(sinceTs, value) as { n: number };
  return row.n;
}
```

The daemon's `SqliteAllowCounter` adapts this to the policy layer's `AllowCounter`
interface. The policy layer passes an *opaque* key (`"tool:X"` / `"session:Y"` /
`"agent:Z"`); the counter splits it back into a dimension + value. The failure direction is
the load-bearing part:

```ts
// packages/daemon/src/derived.ts:23
const FORCE_BREACH = Number.MAX_SAFE_INTEGER;
// ...
countInWindow(key: string, windowMs: number, now: number): number {
  const i = key.indexOf(":");
  if (i < 0) return FORCE_BREACH;
  const dim = key.slice(0, i);
  const value = key.slice(i + 1);
  if (!DIMS.has(dim)) return FORCE_BREACH;
  return this.storage.countAutoAllows(dim as AggregationDim, value, now - windowMs);
}
```

> **Failure direction — fail toward ask.** A malformed key or an unrecognized dimension is
> an *unevaluable limit*. The count is consumed as *"breach when count ≥
> `max_asks_auto_allowed`"*, so returning `0` would silently disable the cap and let the
> would-be allow through — fail-open. Instead the counter returns
> `Number.MAX_SAFE_INTEGER`, which trips any positive ceiling → the limit registers as
> breached → the event escalates to `ask` (decision 013). This is defensive against
> `brezia.yaml`'s additive-only `per` dimension outgrowing `DIMS` here without a matching
> update. Detail:
> [aggregation-limits.md](aggregation-limits.md).

### Rolling stats

`statsSince` backs `/v1/stats` — the auto-resolved counter shown in the inbox and by
`brezia up`/`status`. "Auto-resolved" is `auto_allowed + auto_denied` (policy decided
without a human):

```ts
// packages/daemon/src/sqlite-storage.ts:153
statsSince(sinceTs: number): { total: number; autoResolved: number } {
  const row = this.db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN decision IN ('auto_allowed','auto_denied') THEN 1 ELSE 0 END) AS autoResolved
     FROM events WHERE ts >= ?`,
  ).get(sinceTs) as { total: number; autoResolved: number | null };
  return { total: row.total, autoResolved: row.autoResolved ?? 0 };
}
```

The daemon computes the ratio over a 7-day window and guards against divide-by-zero
(empty history reports `ratio: 0`, not `NaN`) (`packages/daemon/src/index.ts:117`,
`persistence.test.ts:165`).

## Idempotency via the unique key

`events.idempotency_key` is `UNIQUE`. The hook adapter sets it from Claude Code's
`tool_use_id` (`packages/daemon/src/hook-adapter.ts:17`). A replayed tool call is caught
two ways:

1. **Pre-check.** Before evaluating, the handler looks up the key; a hit replays the
   original outcome without re-inserting or re-chaining (`packages/daemon/src/index.ts:219`).
2. **Race backstop.** If two duplicates arrive concurrently and both pass the pre-check,
   the second `insertEvent` throws on the `UNIQUE` collision; the handler catches it and
   replays the now-persisted winner:

```ts
// packages/daemon/src/index.ts:267
try {
  storage.insertEvent(stored);
} catch {
  const raced = storage.getEventByIdempotencyKey(key);
  return reply.code(200).send(raced ? replayResponse(storage, raced) : NO_DECISION);
}
```

`NULL` idempotency keys do not collide (SQLite treats `NULL`s as distinct in a `UNIQUE`
index), so events with no key coexist freely (`packages/daemon/src/sqlite-storage.test.ts:58`).
Replay reconstructs the original hook response from the stored decision — an auto decision
from the recorded tier, a human decision from the request row; a still-`pending`,
`deferred`, or `expired` event has no terminal outcome and replays as `NO_DECISION`
(native flow) (`packages/daemon/src/replay.ts`). The idempotency contract and its wire
semantics are in [reference/events-api.md](../reference/events-api.md).

## Compute-before-persist ordering

Both derived reads that the pipeline uses — first-time flags and the counter — must reflect
*prior* events, not the one being processed. The hook handler therefore computes flags and
evaluates policy **before** inserting the current event:

```ts
// packages/daemon/src/index.ts:229
// Both flags and limits read PRIOR events — compute/evaluate before
// persisting this one, so first-time and counts are always vs. the past.
const flags = computeFlags(event, history);
const now = Date.now();
const result = evaluatePolicy(event, policy, { flags, now, allowCounter });
// ...later: storage.insertEvent(stored);
```

This ordering is why a command's *first* occurrence trips `first_time_command` and its
*next* occurrence does not, and why the Nth auto-allow (not the N+1th) is the one the
ceiling catches.

## Why SQLite is the only implementation

The `StorageAdapter` interface is the single piece of v1 foresight allowed in v0 (decision
003): storage sits behind an interface so a later Postgres for a hosted control plane is an
*implementation*, not a rewrite. But at v0 there is exactly one implementation,
`SqliteStorage`, and building a second would be scope creep the project rules forbid. The
interface earns its keep another way — it is what makes the daemon injectable for tests
(in-memory storage) and what lets the CLI share one storage class with the daemon.

The audit chain is the one place the interface is deliberately *asymmetric*: it exposes
`appendAuditEntry` / `getLastAuditEntry` / `allAuditEntries` / `verifyAuditChain` but **no
update or delete** — append-only is encoded in the contract itself
(`packages/shared/src/index.ts:345`).

---

**Next:** [reference/storage-adapter.md](../reference/storage-adapter.md) for the full
schema, [audit-chain.md](audit-chain.md) for the append-only log,
[aggregation-limits.md](aggregation-limits.md) for the counter's consumer.
