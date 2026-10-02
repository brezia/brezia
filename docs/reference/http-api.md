# HTTP API — the daemon's complete surface

> Every HTTP endpoint the Brezia daemon exposes on `127.0.0.1:4747`: the hook
> ingestion path, the inbox's request/decision/stats endpoints, the SSE stream, and
> the static UI. What each accepts, what it returns, its status codes, and — for the
> never-brick paths — exactly how it behaves when things go wrong.

Read [concepts.md](../concepts.md) for the vocabulary (`ApprovalEvent`, **effective
decision**, **held request**, `NO_DECISION`) and [architecture.md](../architecture.md)
for how these routes sit in the runtime. Everything here is served by one Fastify
instance built in `createServer` (`packages/daemon/src/index.ts:84`), bound loopback-only
(`packages/daemon/src/index.ts:39`).

## Contents

- [The route table](#the-route-table)
- [Boundary behavior: parsing, errors, binding](#boundary-behavior-parsing-errors-binding)
- [`POST /v1/hook`](#post-v1hook) — ingestion (the spine)
- [`POST /v1/approval-events`](#post-v1approval-events) — the generic Events API (stubbed)
- [`GET /v1/requests`](#get-v1requests) — the pending queue
- [`POST /v1/requests/:id/decision`](#post-v1requestsiddecision) — human decision
- [`GET /v1/stats`](#get-v1stats) — the auto-resolved counter
- [`GET /v1/stream`](#get-v1stream) — the SSE feed
- [`GET /*`](#get--the-inbox-static-assets) — the inbox
- [The hook-decision response format](#the-hook-decision-response-format)

---

## The route table

| Method & path | Purpose | Success | Never-brick? |
|---|---|---|---|
| `POST /v1/hook` | Ingest a `HookPayload`; decide or hold. | `200` + hook-decision or `{}` | **Yes** — every error → `200 {}` |
| `POST /v1/approval-events` | Generic Events API ingestion. | — | Stubbed → `501` |
| `GET /v1/requests` | List the currently held (pending) requests. | `200` + card array | — |
| `POST /v1/requests/:id/decision` | Approve/deny a held request. | `200 {ok:true}` | — |
| `GET /v1/stats` | Rolling 7-day auto-resolved counter. | `200` + stats | — |
| `GET /v1/stream` | Server-Sent Events feed for the inbox. | `200` `text/event-stream` | — |
| `GET /*` | Serve the built inbox (same-origin). | `200` asset / `404` | — |

Routes are registered in that order; the UI catch-all is registered **last** so every
`/v1/*` route wins over the wildcard (`packages/daemon/src/index.ts:420`,
`ui-static.ts:69`).

> **Security.** There is no auth, no CORS, and no configurable bind address. Localhost
> binding *is* the v0 security model, and the inbox is served same-origin, so there is no
> legitimate cross-origin client. See [configuration.md](configuration.md#ports-and-binding)
> and [../architecture.md](../architecture.md#runtime-topology).

---

## Boundary behavior: parsing, errors, binding

Three server-wide guards shape every request before any handler runs. They exist to
satisfy **invariant 2** — ingestion never breaks the user.

**Malformed JSON never 400s.** A custom content-type parser hands the handler `undefined`
instead of throwing, so a garbage body becomes a controlled no-decision rather than a
boundary crash:

```ts
// packages/daemon/src/index.ts:188
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
    try {
      done(null, body === "" ? undefined : JSON.parse(body as string));
    } catch {
      done(null, undefined);
    }
  },
);
```

**The hook path never surfaces a 5xx as a decision.** A catch-all error handler turns any
unexpected throw on `/v1/hook` into `200 {}`; other routes get an ordinary `500`:

```ts
// packages/daemon/src/index.ts:202
app.setErrorHandler((_err, req, reply) => {
  if (req.url.startsWith("/v1/hook")) {
    return reply.code(200).send(NO_DECISION);
  }
  return reply.code(500).send({ error: "internal error" });
});
```

**The daemon binds loopback only.** `start()` asserts every bound address is `127.0.0.1`
after `listen()` and refuses to run otherwise (`packages/daemon/src/index.ts:440`) — a
test exercises the real bind (`hook-endpoint.test.ts:253`).

> **Failure direction.** Ingestion-boundary errors resolve to the hook protocol's
> no-decision response (`{}`) → Claude Code's native flow proceeds. Nothing here fails
> toward `allow`. See [../internals/failure-semantics.md](../internals/failure-semantics.md).

---

## `POST /v1/hook`

The spine. A Claude Code `PreToolUse` HTTP hook POSTs the raw `HookPayload`; the daemon
validates it, checks idempotency, normalizes it to an `ApprovalEvent`, computes flags,
evaluates policy, applies the invariant-1 guard, persists and chains, then either answers
immediately (`auto_allowed`/`auto_denied`) or **holds the HTTP response open** until a
human decides or the hold times out.

**Request body:** a `HookPayload` (`packages/shared/src/index.ts:51`). See
[events-api.md](events-api.md#the-hook-payload) for every field and
[configuration.md](configuration.md#the-claude-code-hook-entry) for how Claude Code is
pointed here.

**Responses — all `200`:**

| Effective decision | Body | Meaning to Claude Code |
|---|---|---|
| `auto_allowed` | hook-decision `allow` | tool runs, no human |
| `auto_denied` | hook-decision `deny` | tool blocked, reason surfaced to the agent |
| `ask` → approved | hook-decision `allow` | human approved (response was held) |
| `ask` → denied | hook-decision `deny` | human denied (response was held) |
| `ask` → hold timeout / crash | `{}` (`NO_DECISION`) | native permission flow proceeds |
| malformed / wrong-shape / any throw | `{}` (`NO_DECISION`) | native permission flow proceeds |
| idempotent replay | the original outcome | see below |

The handler's decision core, showing the **effective-decision guard** (invariant 1: a
tierless `auto_allowed` is a policy bug and is downgraded to `ask`, held, never allowed):

```ts
// packages/daemon/src/index.ts:238
const allowWithTier =
  result.decision === "auto_allowed" &&
  typeof result.tierName === "string" &&
  result.tierName.length > 0;
const effective: Decision = allowWithTier
  ? "auto_allowed"
  : result.decision === "auto_allowed"
    ? "ask"
    : result.decision;
```

> **Invariant 1.** No event emits `allow` without a named matching tier. The pure
> evaluator only returns `auto_allowed` from inside a matched tier
> (`packages/policy/src/evaluate.ts:128`), and this edge guard re-checks it before
> anything is emitted or persisted — the **effective** decision is what gets stored, so
> the counter and `/v1/stats` never credit a non-emitted allow
> (`packages/daemon/src/index.ts:242`). Covered by `hook-endpoint.test.ts:178` (a tierless
> allow times out to `{}`).

**Idempotency.** A replayed `tool_use_id` returns the original outcome without re-running
policy — the tool-use id is the idempotency key (see
[events-api.md](events-api.md#idempotency)):

```ts
// packages/daemon/src/index.ts:219
const key = parsed.data.tool_use_id;
const prior = storage.getEventByIdempotencyKey(key);
if (prior !== undefined) {
  return reply.code(200).send(replayResponse(storage, prior));
}
```

`replayResponse` reconstructs the terminal outcome: `auto_allowed`/`auto_denied` replay
their decision; an `ask` replays `allow`/`deny` if the human already resolved it, else
`{}` (a duplicate mid-hold is a pathological retry — never-brick beats guessing)
(`packages/daemon/src/replay.ts:13`). A concurrent duplicate that loses the
`UNIQUE(idempotency_key)` insert race also replays the now-persisted winner
(`packages/daemon/src/index.ts:267`).

**The held call.** On `ask`, a `pending` `Request` row is inserted, a `request.created`
card is broadcast over SSE, and the HTTP response is held on a promise that a human
decision or a `setTimeout` resolves — whichever fires first:

```ts
// packages/daemon/src/index.ts:316
const body = await new Promise<unknown>((resolve) => {
  const timer = setTimeout(() => {
    if (held.has(requestId)) { /* mark deferred + chain(hold_timeout) + broadcast */ }
    held.resolve(requestId, NO_DECISION); // native flow (never-brick)
  }, holdTimeoutMs);
  held.add(heldReq, (finalBody) => { clearTimeout(timer); resolve(finalBody); });
  sse.broadcast("request.created", cardPayload(heldReq));
});
```

The default hold window is 600 s (`DEFAULT_HOLD_TIMEOUT_MS`,
`packages/daemon/src/index.ts:61`), aligned with Claude Code's default HTTP-hook timeout.
On timeout the request is marked `deferred` and a `deferral` audit entry
(`cause: hold_timeout`) is chained. The held-requests model and its race-safety are in
[../architecture.md](../architecture.md#the-held-requests-model); the full pipeline with
every branch is in
[../internals/request-lifecycle.md](../internals/request-lifecycle.md).

**Example — an auto-allowed read** (against the default pack):

```bash
curl -sS -X POST http://127.0.0.1:4747/v1/hook \
  -H 'content-type: application/json' \
  -d '{"session_id":"s1","transcript_path":"t","cwd":"/repo","permission_mode":"auto",
       "hook_event_name":"PreToolUse","tool_name":"Read",
       "tool_input":{"file_path":"/repo/README.md"},"tool_use_id":"toolu_demo1"}'
# → {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#      "permissionDecision":"allow","permissionDecisionReason":"brezia: tier 'allow-reads'"}}
```

A `Bash` call the policy doesn't classify holds the connection open until you approve it
in the inbox or the window elapses.

---

## `POST /v1/approval-events`

The generic, runtime-agnostic Events API — the standard-setting surface the hook endpoint
adapts onto (decision 002). **At v0 it is a stub**: the daemon returns `501` and the hook
endpoint is the live ingestion path.

```ts
// packages/daemon/src/index.ts:416
app.post("/v1/approval-events", async (_req, reply) =>
  reply.code(501).send({ error: "not implemented — later phase" }),
);
```

The contract it will accept — the `ApprovalEvent` schema, the `Idempotency-Key` header,
and the versioning policy — is specified now (versioned from commit one, additive-only
after v0) in [events-api.md](events-api.md). Documenting the contract before the handler
is deliberate: the shape is the promise, not the stub.

---

## `GET /v1/requests`

The pending queue — the in-memory held requests, as inbox **cards**. The inbox reads this
once on load, then stays live via `/v1/stream`. Auto-resolved events never appear here (no
`Request` is created for them).

```ts
// packages/daemon/src/index.ts:342
app.get("/v1/requests", async (_req, reply) => {
  return reply.code(200).send(held.list().map(cardPayload));
});
```

**Response `200`:** an array of card objects. The card shape is shared by this endpoint and
the `request.created` SSE broadcast, so the inbox sees identical fields either way
(`cardPayload`, `packages/daemon/src/index.ts:102`):

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` (ulid) | request id — the `:id` for the decision endpoint |
| `session` | `string` | runtime session id (inbox grouping dimension) |
| `tool` | `string` | tool name, e.g. `Bash` |
| `arguments` | `object` | the raw tool input (rendered inert in the UI) |
| `flags` | `object` | computed flags, e.g. `{ "first_time_command": true }` |
| `createdTs` | `number` | epoch ms when held |
| `cwd` | `string?` | working dir (multi-session grouping) |
| `worktree` | `string?` | worktree (multi-session grouping) |
| `policyTier` | `string?` | the tier that produced the `ask`, if any |

> Agent-supplied strings in `arguments` are untrusted. The inbox renders them as inert
> text nodes in `<pre>` — never HTML, markdown, links, or interpreted ANSI. See
> [../internals/frontend.md](../internals/frontend.md) and [../security.md](../security.md).

---

## `POST /v1/requests/:id/decision`

A human's approve/deny for a held request. It completes the held HTTP response, updates the
`Request` row, and chains a `human_decision` audit entry.

**Request body:** `{ "action": "approve" | "deny", "reason"?: string }`.

**Responses:**

| Status | When |
|---|---|
| `200 {ok:true}` | resolved — the held hook response emits `allow`/`deny` |
| `400` | `action` is not exactly `approve` or `deny` |
| `404` | unknown id, or already resolved by another path (timeout/human) |

The `404`-on-already-resolved is the race guard: the held registry is the single source of
truth for "still awaiting", and `held.resolve()` returning `false` means the timeout (or a
concurrent decision) already finished it:

```ts
// packages/daemon/src/index.ts:363
const approve = body.action === "approve";
const response = approve
  ? hookDecision("allow", reason ? `brezia: ${reason}` : "brezia: approved")
  : hookDecision("deny", reason ? `brezia: ${reason}` : "brezia: denied");
if (!held.resolve(id, response)) {
  return reply.code(404).send({ error: "unknown or already-resolved request" });
}
storage.updateRequestStatus(id, approve ? "approved" : "denied", Date.now(), reason);
chain.humanDecision({ requestId: id, eventId: entry.eventId,
  status: approve ? "approved" : "denied", reason });
```

The `reason` is echoed into the hook-decision's `permissionDecisionReason`, so a denied
tool call surfaces your reason to the agent as the tool error (verified in
`hook-endpoint.test.ts:106`).

**Example:**

```bash
curl -sS -X POST http://127.0.0.1:4747/v1/requests/01J.../decision \
  -H 'content-type: application/json' \
  -d '{"action":"deny","reason":"not on prod"}'
# → {"ok":true}   (the held POST /v1/hook now returns a deny with your reason)
```

---

## `GET /v1/stats`

The rolling **auto-resolve** counter: auto-resolved ÷ total over a fixed 7-day window
(`STATS_WINDOW_MS`, `packages/daemon/src/index.ts:49`). "Auto-resolved" =
`auto_allowed` + `auto_denied` (policy decided without a human).

```ts
// packages/daemon/src/index.ts:117
function currentStats() {
  const { total, autoResolved } = storage.statsSince(Date.now() - STATS_WINDOW_MS);
  return { windowDays: 7, total, autoResolved, ratio: total > 0 ? autoResolved / total : 0 };
}
```

**Response `200`:** `{ windowDays: 7, total, autoResolved, ratio }`. `ratio` is `0` when
`total` is `0`. The same object is pushed as a `stats.updated` SSE event on connect and
after each decision. `brezia up` prints it as a percentage on startup
(`packages/cli/src/up.ts:130`).

---

## `GET /v1/stream`

Server-Sent Events — the inbox's live feed. The daemon **hijacks** the raw response (owns
the socket; Fastify sends nothing of its own), writes the SSE headers, emits a comment
keep-alive and the current stats immediately, then pushes deltas as the pipeline produces
them.

```ts
// packages/daemon/src/index.ts:389
app.get("/v1/stream", (req, reply) => {
  reply.hijack();
  try {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    sse.add(reply.raw);
    reply.raw.write(`event: stats.updated\ndata: ${JSON.stringify(currentStats())}\n\n`);
    req.raw.on("close", () => sse.remove(reply.raw));
  } catch {
    sse.remove(reply.raw); // a stream-setup failure affects only this client's socket
    try { reply.raw.end(); } catch { /* already gone */ }
  }
});
```

**Event types** (`SseEvent`, `packages/daemon/src/sse.ts:10`). These names are an internal
daemon↔inbox contract — **not** the versioned Events API:

| Event | Data | Emitted when |
|---|---|---|
| `stats.updated` | stats object | on connect, and after each decision |
| `request.created` | card (see `/v1/requests`) | an event resolves `ask` and is held |
| `request.resolved` | `{ id, status }` | human decision, or a hold-timeout `deferred` |
| `policy.error` | `{ error: string \| null }` | a bad hot-reload (banner), `null` clears it |

The frame format is `event: <name>\ndata: <json>\n\n` (`packages/daemon/src/sse.ts:35`),
verified in `sse.test.ts:13`. A write to a dead socket drops that client; a
non-serializable payload is skipped, never thrown — because these broadcasts sit on the
decision path and a UI concern must not perturb a decision (`sse.test.ts:22,29`).

---

## `GET /*` — the inbox (static assets)

The built React inbox, served **same-origin** from an in-memory map loaded at startup —
there is no `@fastify/static` dependency and no filesystem join at request time, so there
is no path-traversal surface (`registerUi`, `packages/daemon/src/ui-static.ts:61`).

- `/` and `/index.html` → the built `index.html`.
- Any other path → the asset if its exact URL key exists in the map, else `404`.
- If the UI hasn't been built, `/` serves a friendly placeholder that names the fix
  (`npm run build -w @brezia/ui`); other paths `404` (`ui-static.ts:53,74`).

Registered after all `/v1/*` routes so API routes always win the match
(`packages/daemon/src/index.ts:420`). Detail in
[../internals/frontend.md](../internals/frontend.md).

---

## The hook-decision response format

Every allow/deny answer — from the hook path and from a replay — is the same
`hookSpecificOutput` shape, verified live in the A2 spike (decision 008) and built by
`hookDecision` (`packages/daemon/src/hook-adapter.ts:35`):

```ts
// packages/daemon/src/hook-adapter.ts:27
export interface HookDecisionResponse {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "brezia: tier 'allow-reads'"
  }
}
```

The daemon emits only `allow` or `deny`. Every other outcome — a hold in progress, a hold
timeout, malformed ingestion, any thrown error — is the empty object:

```ts
// packages/daemon/src/hook-adapter.ts:50
export const NO_DECISION: Record<string, never> = {};
```

> **`no_decision` vs `NO_DECISION`.** `no_decision` is a reserved member of the `Decision`
> enum that nothing at v0 produces as a value; the never-brick outcome on the wire is the
> empty `{}` response above. Keep them distinct — see
> [../concepts.md](../concepts.md#the-decision-vocabulary).

The `permissionDecisionReason` is `brezia: `-prefixed: from the tier's `reason`/name for
auto decisions (`reasonForPolicy`, `packages/daemon/src/hook-adapter.ts:52`), or the
human's reason for a held decision. Reason strings are informational; the `permissionDecision`
is the load-bearing field.

---

**Next:** [events-api.md](events-api.md) for the contract the hook adapts onto, or
[../internals/request-lifecycle.md](../internals/request-lifecycle.md) for the pipeline in
full. For the invariants governing every branch, see
[../internals/failure-semantics.md](../internals/failure-semantics.md).
