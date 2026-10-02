# Failure semantics — the invariants and failure directions

> The spine of the system. Brezia sits in the tool-call path of other people's agents, so
> failure semantics outrank features: **nothing anywhere fails toward `allow`.** This page
> states the three invariants precisely, shows where each is tested, and gives the
> component-by-component failure-direction table.

Two rules govern every failure path, and they point in different directions on purpose:

- **At the ingestion boundary** (bad stdin, malformed POST, a dead socket, a pipeline
  exception), Brezia resolves to **no decision** — the empty hook response `{}` — and
  Claude Code's native permission flow proceeds. A degraded Brezia is just normal Claude
  Code. This is the **never-brick** direction.
- **At the policy layer** (an unmatched event, an unclassifiable command, an unevaluable
  limit, a malformed regex, a policy-engine bug), Brezia resolves to **`ask`** — hold for a
  human. This is the **fail-toward-ask** direction.

Neither direction ever produces `allow`. This doc is the map of both.

Read [concepts.md](../concepts.md) for `Decision`, `RequestStatus`, `NO_DECISION`,
`deferred`. Every other internals page links here for its failure branch.

## Contents

- [The three invariants](#the-three-invariants)
- [The ingestion boundary — never-brick](#the-ingestion-boundary--never-brick)
- [The policy layer — fail toward ask](#the-policy-layer--fail-toward-ask)
- [The failure-direction table](#the-failure-direction-table)
- [The invariant-1 edge guard](#the-invariant-1-edge-guard)
- [The SSE and logger guards](#the-sse-and-logger-guards)
- [Split failure modes](#split-failure-modes-single-player-vs-enforced)
- [Reserved outcomes: no_decision and expired](#reserved-outcomes-no_decision-and-expired)

---

## The three invariants

These are **permanent tests — never weakened, skipped, or deleted.** If a change breaks an
invariant test, the change is wrong, never the test.

> **Invariant 1.** No event ever resolves `auto_allowed` without a named matching policy
> tier. `unmatched: ask`.

> **Invariant 2.** Ingestion never breaks the user: garbage stdin, malformed POSTs, dead
> sockets, and pipeline exceptions all resolve to "no decision" → native flow proceeds.
> Fuzz-tested.

> **Invariant 3.** The audit chain verifies end-to-end after every test-suite run.

Each is tested in two places — the pure policy layer and the daemon boundary — because they
guard two different surfaces:

| Invariant | Pure-layer test | Boundary test |
|---|---|---|
| 1 — no tierless allow | `packages/policy/src/__tests__/invariants.test.ts:34` | `packages/daemon/src/invariants.test.ts:44`, `hook-endpoint.test.ts:164` |
| 2 — ingestion never bricks | `packages/policy/src/__tests__/invariants.test.ts:64` | `packages/daemon/src/invariants.test.ts:54`, `hook-endpoint.test.ts:47` |
| 3 — chain verifies | (cannot — zero-I/O layer; see note) | `packages/daemon/src/invariants.test.ts:67`, `persistence.test.ts:57`, `sqlite-storage.test.ts:127` |

Invariant 3's canonical test lives in the daemon because the pure `packages/policy` has
zero I/O and cannot import SQLite without breaking layering — the placeholder that once sat
in the policy package (a hardcoded `true`) was "false assurance and has been replaced by
those real assertions" (`packages/policy/src/__tests__/invariants.test.ts:108`).

## The ingestion boundary — never-brick

The ingestion boundary is the HTTP hook endpoint (and, in fallback, the shim). Its
contract: **no input, however malformed, produces anything but a 200 with a controlled
body — and never an `allow`.** Invariant 2. Four layers enforce it:

1. **The content-type parser never 400s on bad JSON.** Malformed JSON hands the handler
   `undefined` instead of throwing at the boundary:

   ```ts
   // packages/daemon/src/index.ts:188
   app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
     try { done(null, body === "" ? undefined : JSON.parse(body as string)); }
     catch { done(null, undefined); }
   });
   ```

2. **Schema validation via `safeParse`.** A wrong-shape body resolves to `NO_DECISION`, not
   a throw:

   ```ts
   // packages/daemon/src/index.ts:213
   const parsed = HookPayloadSchema.safeParse(req.body);
   if (!parsed.success) {
     return reply.code(200).send(NO_DECISION); // malformed → native flow
   }
   ```

3. **A handler-level try/catch.** Any unexpected error inside the hook handler falls to
   `NO_DECISION` (`packages/daemon/src/index.ts:335`).

4. **A route-scoped error handler backstop.** Even an error that escapes the handler is
   caught by Fastify's error handler and, for `/v1/hook`, turned into 200 + `NO_DECISION` —
   never a 5xx surfaced as a decision:

   ```ts
   // packages/daemon/src/index.ts:202
   app.setErrorHandler((_err, req, reply) => {
     if (req.url.startsWith("/v1/hook")) {
       return reply.code(200).send(NO_DECISION);
     }
     return reply.code(500).send({ error: "internal error" });
   });
   ```

The boundary tests exercise both malformed JSON and valid-but-wrong-shape bodies, asserting
200 + `{}`:

```ts
// packages/daemon/src/hook-endpoint.test.ts:47
it("malformed JSON body → 200 with no decision (never-brick)", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/hook",
    headers: { "content-type": "application/json" }, payload: "{ not valid json" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({});
});
```

The shim mirrors this on the command transport: any error → print nothing, exit 0 → no
decision (`packages/hook-shim/src/index.ts:63`, see
[hook-integration.md](hook-integration.md#the-hook-shim-fallback)).

## The policy layer — fail toward ask

The pure evaluator (`packages/policy`) never throws out of evaluation and never resolves
toward `allow`. Its failure floor is `ask` (or `deny` under `unmatched: deny`) — never
`allow` by omission. The pure invariant-2 test fuzzes malformed inputs and asserts *both*
properties per case — does not throw, does not resolve `auto_allowed`:

```ts
// packages/policy/src/__tests__/invariants.test.ts:96
for (const [name, run] of cases) {
  it(`${name}: does not throw`, () => { expect(run).not.toThrow(); });
  it(`${name}: does not resolve auto_allowed`, () => {
    expect(run().decision).not.toBe("auto_allowed");
  });
}
```

The specific fail-toward-ask points across the policy layer, each documented on its own
page:

- **Unmatched event** → the `unmatched` floor (`ask`/`deny`, never `allow`) —
  [policy-evaluation.md](policy-evaluation.md).
- **Compound/expansion Bash command** → unclassifiable → never matches an allow class —
  [bash-classification.md](bash-classification.md). Property-tested: no adversarial or
  fuzzed string may classify into an allow-tier class.
- **Malformed regex or missing/non-string argument** → fails to match → toward `ask`
  (decision 010).
- **Unevaluable aggregation limit** → the counter returns a force-breach sentinel →
  escalates to `ask` (decision 013) — [aggregation-limits.md](aggregation-limits.md),
  [persistence.md](persistence.md#the-aggregation-counter).
- **Invalid policy file on reload** → keep the previous policy, banner + log, never crash,
  never fail open — [see below](#split-failure-modes-single-player-vs-enforced).

## The failure-direction table

Every component, its error condition, and the direction it resolves. The invariant column
names which guarantee holds it.

| Component | Error condition | Resolves to | Source | Invariant |
|---|---|---|---|---|
| JSON body parser | Unparseable JSON | `undefined` body → `NO_DECISION` | `index.ts:188` | 2 |
| Hook schema | Wrong-shape payload | `NO_DECISION` (200) | `index.ts:213` | 2 |
| Hook handler | Any thrown exception | `NO_DECISION` (200) | `index.ts:335` | 2 |
| Fastify error handler | Error escaping the handler on `/v1/hook` | `NO_DECISION` (200) | `index.ts:202` | 2 |
| hook-shim | Dead daemon / timeout / bad stdin / bad response | print nothing, exit 0 → no decision | `hook-shim/src/index.ts:63` | 2 |
| Pure evaluator | Malformed event / null tiers / missing defaults | `ask` (never throws, never `auto_allowed`) | `policy/…/invariants.test.ts:64` | 1, 2 |
| Policy — unmatched | No tier matches | `defaults.unmatched` (`ask`/`deny`) | `shared/index.ts:152` | 1 |
| Bash classification | Compound/expansion construct | unclassifiable → no allow-class match → `ask` | decision 005 | 1 |
| Matcher — arg regex | Malformed `re:` / missing arg | no match → toward `ask` | decision 010 | 1 |
| Aggregation counter | Malformed key / unknown dimension | `FORCE_BREACH` → escalate to `ask` | `derived.ts:23` | 1 |
| Invariant-1 guard | `auto_allowed` with no `tierName` | downgrade to `ask` (held) | `index.ts:242` | 1 |
| Idempotency race | Concurrent duplicate `UNIQUE` collision | replay the persisted winner, else `NO_DECISION` | `index.ts:267` | 2 |
| Held call | Hold timeout (no human in the window) | mark `deferred`, chain, return `NO_DECISION` | `index.ts:317` | 2 |
| Daemon restart | `pending` request left by a dead process | resolve `deferred`, chain `crash_recovery` | `index.ts:139` | 2, 3 |
| Policy hot reload | Invalid `brezia.yaml` | keep previous policy, banner + log, chain `policy_reload(false)` | `index.ts:158` | — |
| SSE broadcast | Non-serializable payload / dead socket | skip / drop client — never perturb a decision | `sse.ts:35` | — |
| Logger | Can't open / write the log file | no-op / swallow — never perturb a decision | `logger.ts:13` | — |
| Stats broadcast | Any error computing/pushing stats | swallowed | `index.ts:128` | — |

Read the table top to bottom as the request's journey: the top rows are the ingestion
boundary (never-brick → `NO_DECISION`); the middle rows are the policy layer (fail toward
`ask`); the bottom rows are UI/ops concerns that must never touch the decision at all.

## The invariant-1 edge guard

Invariant 1 is enforced twice. The pure evaluator only ever returns `auto_allowed` from
inside a matched tier, stamping `tierName`. But the daemon does not *trust* that — it
re-checks at the edge, because a tierless allow reaching the wire would be an allow-by-bug.
The **effective** decision is what gets persisted and emitted:

```ts
// packages/daemon/src/index.ts:238
const allowWithTier =
  result.decision === "auto_allowed" &&
  typeof result.tierName === "string" &&
  result.tierName.length > 0;
const effective: Decision = allowWithTier
  ? "auto_allowed"
  : result.decision === "auto_allowed"
    ? "ask"                 // tierless allow → downgrade, never emit
    : result.decision;
```

A downgrade also logs a warning, because reaching it means a policy-engine bug worth
diagnosing (`packages/daemon/src/index.ts:247`). The boundary test injects an evaluator
that returns `auto_allowed` with no tier and asserts it is **never** emitted as allow — it
falls through to hold, then times out to `NO_DECISION`:

```ts
// packages/daemon/src/invariants.test.ts:45
const app = await createServer({ evaluate: () => ({ decision: "auto_allowed" }), holdTimeoutMs: 40 });
const res = await app.inject({ method: "POST", url: "/v1/hook", payload: bash("ls", "toolu_inv1") });
expect(res.json()).toEqual({}); // held → timed out → no-decision; never allow
```

Because the *effective* decision is what is stored, the counter and stats never credit a
non-emitted allow (`packages/daemon/src/index.ts:242`, see
[persistence.md](persistence.md#the-three-tables)).

## The SSE and logger guards

A UI or logging concern must **never** perturb a decision. The daemon's decision path calls
into the SSE hub (broadcasts) and the logger, and both are hardened so a failure there is
swallowed rather than propagated onto the hook path.

The SSE hub's `broadcast` never throws into its caller: a non-serializable payload is
skipped, and a failed write means the socket is gone, so that one client is dropped:

```ts
// packages/daemon/src/sse.ts:35
broadcast(event: SseEvent, data: unknown): void {
  let frame: string;
  try { frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
  catch { return; } // payload could not be serialized — skip rather than throw
  for (const res of this.clients) {
    try { res.write(frame); }
    catch { this.clients.delete(res); } // socket gone — drop this client
  }
}
```

The stats broadcast, called on the hook path just before returning allow/deny, wraps even
that in its own try/catch — "a UI counter must never perturb a decision — swallow"
(`packages/daemon/src/index.ts:128`). The SSE *stream setup* handler likewise isolates a
per-client socket failure from the hook path (`packages/daemon/src/index.ts:403`).

The logger is best-effort at every step: no path → a no-op function; can't create the file
→ log nothing rather than throw; a write that fails → swallowed:

```ts
// packages/daemon/src/logger.ts:25
return (msg: string) => {
  try { appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); }
  catch { /* A log write must never perturb a decision — swallow. */ }
};
```

This log is the human-readable ops view; the *tamper-evident* record is the audit chain
(`packages/daemon/src/logger.ts:4`, see [audit-chain.md](audit-chain.md)).

## Split failure modes: single-player vs enforced

Failure semantics split by *mode*, and the two modes fail in opposite directions —
deliberately (decision 006). The mode is a property of the deployment, declared in config
and visible in the audit log, never a runtime surprise.

| Mode | Availability | On a dead/slow/timed-out daemon | Status |
|---|---|---|---|
| **Single-player** | v0 (the only mode built) | No decision → the runtime's native prompt. Degraded Brezia = normal Claude Code. | **Built.** |
| **Enforced** | v0.5+ | Held calls that expire **deny by default**, with per-tier overrides for non-security tiers. | Not built. Format room only. |

At v0 only single-player exists, so every failure direction on this page is the never-brick
one. The enforced mode leaves exactly two traces in the v0 contract, both inert:

- `defaults.on_expiry` (`deny`/`defer`) in the policy schema — accepted, validated, and
  **never read** by `evaluate()` at v0 (`packages/shared/src/index.ts:155`).
- The `expired` `RequestStatus` — reserved for the enforced-mode expiry path
  ([see below](#reserved-outcomes-no_decision-and-expired)).

Policy **hot reload** is the one place a config error is handled inline, and it fails safe
in the single-player spirit — *parse → validate → atomic swap*; an invalid file keeps the
old policy, surfaces a UI banner and a log line, and is chained as `policy_reload(false)`.
It never crashes and never fails open:

```ts
// packages/daemon/src/index.ts:158
policyStore.watch(opts.policyPath, (ok, error) => {
  console.error(ok ? "brezia: policy reloaded"
    : `brezia: policy reload rejected — ${error} — keeping the previous policy`);
  chain.policyReload(ok, ok ? undefined : (error ?? undefined));
  sse.broadcast("policy.error", { error: ok ? null : (error ?? "policy reload failed") });
});
```

And until any policy is loaded, the daemon runs the no-allow-by-omission floor — every
event is unmatched → `ask` → held. It *never* auto-allows without a policy
(`packages/daemon/src/index.ts:53`).

## Reserved outcomes: no_decision and expired

Two enum members exist in the contract but are **not produced at v0**. Treat both as
reserved forward-room:

- **`no_decision`** (a `Decision` member) — the never-brick outcome is the empty *hook
  response* `{}` (`NO_DECISION`), not a persisted `Decision` value. Nothing writes
  `no_decision` as a decision; persisted `StoredEvent.decision` is always `auto_allowed` /
  `auto_denied` / `ask` (`packages/shared/src/index.ts:8`, see
  [concepts.md](../concepts.md#the-decision-vocabulary)).
- **`expired`** (a `RequestStatus` member) — both ways Brezia declines to decide, a hold
  outliving the hook window and crash recovery on restart, resolve to **`deferred`**, never
  `expired` (`packages/daemon/src/index.ts:321` and `:140`). `expired` is room for the
  enforced-mode `on_expiry` path that is not built at v0.

Do not conflate them: a **held request** (in-memory open HTTP response) is not the persisted
**Request**; a timeout and a crash both resolve **`deferred`**; and the never-brick wire
outcome is `NO_DECISION` `{}`, not any `Decision` enum value.

---

**Next:** [audit-chain.md](audit-chain.md) for invariant 3 in depth,
[policy-evaluation.md](policy-evaluation.md) and
[bash-classification.md](bash-classification.md) for the fail-toward-ask engine, or
[hook-integration.md](hook-integration.md) for the never-brick transport. Every internals
page links back here for its failure branch.
