# Testing — the testing and review process

> How Brezia is kept correct: a test pyramid weighted toward the pure policy engine, three
> permanent invariant tests that are never weakened, a bash property test, the fixtures
> ritual that turns real payloads into regressions, and a read-only review discipline that
> runs before changes to any failure path.

This page is about *process*, not any single component. It explains where the tests live,
why they are shaped the way they are, and the review gates that guard the invariants. Read
[internals/failure-semantics.md](internals/failure-semantics.md) for what the invariants
*mean* and [concepts.md](concepts.md) for the vocabulary.

## Contents

- [How to run it](#how-to-run-it)
- [The testing pyramid](#the-testing-pyramid)
- [The permanent invariant tests](#the-permanent-invariant-tests)
- [The bash property test](#the-bash-property-test)
- [The fixtures ritual](#the-fixtures-ritual)
- [Both-ways secrets testing](#both-ways-secrets-testing)
- [The review discipline](#the-review-discipline)

---

## How to run it

One command runs the entire suite across all workspaces:

```bash
npm test          # vitest run — the whole suite, invariant tests included
npm run typecheck # tsc --noEmit per workspace
npm run build     # tsup (packages) + vite (ui), dependency order
```

`npm test` maps to `vitest run` (`package.json:18`); each package carries its own
`vitest.config.ts`. The audit chain verifies end-to-end as part of the run (invariant 3), so
a green suite is also a statement that the chain is intact. Tests use an in-memory SQLite
(`":memory:"`) and Fastify's `app.inject()` — there is no external service to stand up.

---

## The testing pyramid

The suite is weighted deliberately. The most-tested code in the repo is the pure policy
engine, because it is where a wrong answer is dangerous and where exhaustive table testing is
cheap (it is pure — zero I/O, everything injected).

| Layer | Shape | Where | Why here |
|---|---|---|---|
| **`policy` (base)** | Exhaustive **table-driven** fixtures: `(event + policy) → expected decision` | `packages/policy/src/__tests__/*` | Pure and total, so every branch is a cheap table row. The bulk of the repo's tests. |
| **`shared`** | Contract round-trip + rejection tests | `packages/shared/src/*.test.ts` | The schemas are the contract; lock their shape and their `.strict()` rejections. |
| **`daemon` (integration)** | **In-process** HTTP against `app.inject()`, real `SqliteStorage(":memory:")` | `packages/daemon/src/*.test.ts` | The pipeline, held calls, idempotency, and the audit chain only exist where I/O does. |
| **`cli`** | Real files in temp dirs (settings surgery, byte-identical round trips) | `packages/cli/src/*.test.ts` | `init`/`remove` edit real settings files; test against messy real-world shapes. |
| **`ui`** | Render-to-static-markup assertions | `packages/ui/src/*.test.tsx` | The inertness rule is a rendering property; assert on the emitted HTML. |
| **hook path** | **Golden fixtures** — captured real payloads replayed through the endpoint | `packages/daemon/src/hook-*.test.ts` + `fixtures/*.json` | The hook contract is coded from reality (decision 009), so it is tested from reality. |
| **e2e (in-process)** | The held→decide loop via `app.inject()` | `packages/daemon/src/hook-endpoint.test.ts`, `invariants.test.ts` | The full loop (hook POST → hold → human decision → chained audit) against a real store, inside the test process. |
| **e2e (over the wire)** | The loop against a **real listening daemon** over HTTP | `scripts/smoke.mjs` (`npm run smoke`) | Starts a real daemon on an ephemeral port with the default pack, then drives auto-allow / held→approve / held→deny-with-reason / idempotency replay / never-brick-on-malformed / stats / audit-chain verify over real sockets. Exits non-zero on any failure — for CI and pre-release. |

The daemon integration tests are the pyramid's middle: they POST real fixture payloads to
`/v1/hook` and assert the `hookSpecificOutput` decision, exercise the held call
(`ask → held → human approve → allow`), the hold timeout (`→ no decision`), idempotency
replay, and crash recovery — all against a real in-memory store
(`packages/daemon/src/hook-endpoint.test.ts`, `persistence.test.ts`). Because the store is
real, invariant 3 rides along on every one of them.

The over-the-wire smoke (`scripts/smoke.mjs`) is the highest-fidelity check: it runs the
*real* Fastify server on a loopback socket and drives it with an HTTP client, so it also
covers the transport and the listening path the in-process `inject()` tests bypass.

---

## The permanent invariant tests

Three tests are **permanent**: never weakened, skipped, or deleted. They encode the three
invariants, and the rule is absolute — *if a change breaks one, the change is wrong, never
the test.* Each file states this in its header.

**Invariant 1 — no event ever resolves `auto_allowed` without a named matching tier.** Tested
at two levels. In the pure engine, an allow always carries a non-empty `tierName`, an
unmatched event never resolves `auto_allowed`, and a deny-default resolves `auto_denied`:

```ts
// packages/policy/src/__tests__/invariants.test.ts:45
it("an unmatched event never resolves auto_allowed", () => {
  expect(evaluate(minimalEvent, emptyPolicy).decision).not.toBe("auto_allowed");
});
```

At the daemon boundary, an injected evaluator that returns `auto_allowed` with *no* tier (a
simulated policy bug) is downgraded and never emitted as allow — it falls through to hold and
times out to no-decision (`packages/daemon/src/invariants.test.ts:44`; the edge guard it
exercises is `packages/daemon/src/index.ts:238`).

**Invariant 2 — ingestion never breaks the user.** Malformed input never throws out of
evaluation and never resolves toward allow. In the pure layer, null tiers, undefined
defaults, empty tool, and deeply nested arguments each assert both "does not throw" and "does
not resolve `auto_allowed`" (`packages/policy/src/__tests__/invariants.test.ts:64`). At the
boundary, a malformed JSON body returns `200` with the empty no-decision body `{}`, never a
crash and never an allow (`packages/daemon/src/invariants.test.ts:54`,
`hook-endpoint.test.ts:47`).

**Invariant 3 — the audit chain verifies end-to-end after every suite run.** This one needs
real storage, so its canonical test lives in the daemon (the pure policy package cannot import
SQLite without breaking layering — a note where the placeholder used to be,
`packages/policy/src/__tests__/invariants.test.ts:108`). It verifies after a real
held→human-decide loop *and* proves detection works by corrupting a row and asserting
`verifyAuditChain()` returns `false`:

```ts
// packages/daemon/src/invariants.test.ts:67
it("verifies after a real held → human-decide loop", async () => {
  // ... event_received + policy_decision(ask) + human_decision, all chained
  expect(storage.verifyAuditChain()).toBe(true);
});
```

A companion source-scan test enforces append-only structurally: it reads
`sqlite-storage.ts` and fails if any `UPDATE`/`DELETE` against `audit_log` appears
(`packages/daemon/src/sqlite-storage.test.ts:173`). See
[internals/audit-chain.md](internals/audit-chain.md).

---

## The bash property test

Bash classification is the one place a string is parsed into a security-relevant category, so
it gets a **property test**, not just examples. The load-bearing property (decision 005): no
adversarial string may ever classify into a real, allow-able class — every compound,
expansion, or redirect construct must fall to `UNCLASSIFIABLE`, however it is dressed up.

The test generates the cross-product of safe-looking bases, injected shell constructs, and
dangerous payloads (both spaced and unspaced), plus hand-picked classics, and asserts the set
of leaks is empty:

```ts
// packages/policy/src/__tests__/bash.test.ts:105
it(`all ${adversarial.length} adversarial strings → unclassifiable`, () => {
  const leaks = adversarial.filter((c) => classifyBash(c) !== UNCLASSIFIABLE);
  expect(leaks).toEqual([]);
});
```

It is backed by example tables for the positive cases (simple commands → their class) and for
the exclusions that look read-only but are not — `rg`, `tree`, `file`, `find`, mutating git
subcommands (`bash.test.ts:37`–`:64`) — plus an integration check that a matcher listing the
`unclassifiable` sentinel still never matches (`bash.test.ts:136`). See
[internals/bash-classification.md](internals/bash-classification.md) and
[security.md](security.md#bash-classification-exclusions-as-a-security-decision).

---

## The fixtures ritual

The hook payload shape is never coded from memory — field names drift between Claude Code
versions. The ritual is **capture → scrub → test**: capture a real payload off the installed
version into `fixtures/`, scrub secrets and personal paths (keep the shape, fake the values),
and turn it into a permanent test.

Captured payloads become golden fixtures the daemon replays through `/v1/hook`
(`packages/daemon/src/hook-endpoint.test.ts:7` loads them; `pretooluse-bash.json`,
`pretooluse-read.json`, `pretooluse-mcp.json`). This is how decision 009 was verified — real
payloads revealed `tool_use_id`, `prompt_id`, and `effort` that the published docs omitted,
which is why the schema requires the fields reality carries rather than the fields the docs
listed. Observed runtime behavior outranks every doc; a captured fixture is how a mismatch is
proven and pinned.

The ritual also captures *regressions found in the wild*. A curl command carrying a bearer
credential slipped the secrets flag during a live session; the exact payload was captured to
`fixtures/pretooluse-secret-curl.json` and made a permanent test that it must now flag:

```ts
// packages/shared/src/secrets.test.ts:66
it("flags the bearer-credential curl from the live session", () => {
  const command = JSON.parse(readFileSync(path, "utf8")).tool_input.command as string;
  expect(looksLikeSecret(command)).toBe(true);
});
```

See [internals/hook-integration.md](internals/hook-integration.md) for the capture script and
the raw-vs-scrubbed distinction.

---

## Both-ways secrets testing

The `secrets_pattern` flag is tested in **both directions**, because a detector is only as
good as its false-positive rate. `looksLikeSecret` is asserted to *catch* real credentials —
PEM keys, cloud/GitHub/Slack/OpenAI/Stripe tokens, `key=value` secrets, JSON-quoted secrets,
`Authorization` headers, `.env` references (`packages/shared/src/secrets.test.ts:6`) — *and*
to *ignore* innocent strings that would be expensive false positives: git SHAs, sha256
digests, long decimal runs, and prose that merely mentions "authorization"/"bearer"/"token"
(`secrets.test.ts:37`). The ignore list is not decoration — a detector that flags every git
SHA would train the human to ignore the banner, defeating its purpose. See
[internals/flags.md](internals/flags.md).

---

## The review discipline

Beyond the automated suite, changes to failure paths and scope go through a **read-only review
discipline** before they are committed. Two subagents (defined in `.claude/agents/`) act as
gates; they *report* and never edit.

**`invariant-guardian`** — run before committing changes to policy, daemon, hook, audit, or
shared-schema code, or any change that touches a failure path. It walks each of the three
invariants and the hard rules against the diff, greps for structural violations (`UPDATE
audit_log`, non-loopback binds, `dangerouslySetInnerHTML`, catch blocks returning allow), and
returns a per-invariant PASS/FAIL with `file:line` concerns
(`.claude/agents/invariant-guardian.md`). This gate has real teeth: it caught the aggregation
counter failing *open* on an unevaluable key — the fix (a force-breach sentinel, decision 013)
and its property test landed before v0.

**`spec-guardian`** — run when a change might exceed v0 scope or contradict a settled decision.
It checks the change against the v0 out-of-scope list (MCP proxy, flood detection, batching,
delegation, multi-approver, routing, `needs_info`, auth, Postgres, webhooks, risk scoring) and
the precedence order (spec → settled decisions → build plan; observed runtime behavior
outranks every doc), and returns IN SCOPE / OUT OF SCOPE / CONFLICT with citations
(`.claude/agents/spec-guardian.md`). It knows the exceptions — the `StorageAdapter` interface
and aggregation limits are in-scope for v0 and must *not* be flagged as premature.

Both are complemented by slash-command rituals: `/check-invariants` (run the suite + chain
verify and report the three invariants' status), `/capture-fixture` (the capture→scrub→test
ritual), and `/new-decision` (draft an append-only ADR entry for approval before appending
to the settled decisions log). The rule that binds all of it: **write the invariant and
policy-semantics tests before their implementations**, and never let a green suite lull a
failure-path change past a guardian.

---

**Next:** [internals/failure-semantics.md](internals/failure-semantics.md) for the invariants
in full, or [guides/development.md](guides/development.md) for the day-to-day workflow.
