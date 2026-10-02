# Brezia documentation

> Reference-grade internal documentation for Brezia — an open-source approval control
> plane for AI agents. This is the map: what's here, and where to start for what you're
> trying to do.

Brezia routes an AI agent's tool-call interrupts to a local daemon; a reviewed policy
auto-resolves the routine calls, a human decides the rest in a localhost inbox, and every
state change lands in a hash-chained audit log. For the one-page mental model, start with
**[overview.md](overview.md)**. For the vocabulary every page uses, read
**[concepts.md](concepts.md)**.

These docs explain the system; they do not sell it (the repo's top-level `README.md` does
that). The principle throughout: **source is truth** — every claim is cited to a real
`path:line`, and where code and comment disagree, the code wins and the discrepancy is
noted.

## The documentation tree

### Top level — start here

| Doc | What it covers |
|---|---|
| [overview.md](overview.md) | The problem, the loop (one diagram), the three invariants, and what v0 is and isn't. |
| [architecture.md](architecture.md) | The six packages + dependency graph, the localhost runtime topology, the end-to-end request lifecycle, the held-requests model, the build shape. |
| [concepts.md](concepts.md) | The canonical vocabulary and every core type (with its zod shape), the request state machine, and the glossary. **Read before any deep doc.** |

### `reference/` — the contracts and surfaces

| Doc | What it covers |
|---|---|
| [reference/http-api.md](reference/http-api.md) | Every daemon HTTP endpoint: shapes, status codes, the hook-decision response, curl examples. |
| [reference/events-api.md](reference/events-api.md) | The generic approval-events contract the hook endpoint adapts onto; idempotency and versioning. |
| [reference/policy-format.md](reference/policy-format.md) | The complete `brezia.yaml` reference: defaults, tiers, matchers, the matcher algebra, bash classes, limits. |
| [reference/cli.md](reference/cli.md) | Every command: `init`, `up`, `remove`, `status`, `verify`, `export` — flags, exit codes, output. |
| [reference/configuration.md](reference/configuration.md) | Every file and path Brezia reads or writes: the hook entry, `brezia.yaml` resolution, `~/.brezia/`, ports/bind. |
| [reference/storage-adapter.md](reference/storage-adapter.md) | The `StorageAdapter` interface and the SQLite schema, field by field. |

### `internals/` — how it actually works

| Doc | What it covers |
|---|---|
| [internals/request-lifecycle.md](internals/request-lifecycle.md) | The master flow: a tool call from hook POST to resolution, every branch. |
| [internals/policy-evaluation.md](internals/policy-evaluation.md) | The pure engine: purity, ordered tiers, the matcher algebra, never-throws. |
| [internals/bash-classification.md](internals/bash-classification.md) | How a Bash string becomes a class safely; the compound gate; the property test. |
| [internals/flags.md](internals/flags.md) | The anomaly flags computed before policy; the secrets detector. |
| [internals/aggregation-limits.md](internals/aggregation-limits.md) | The anti-splitting ceiling; fail-toward-breach on an unevaluable key. |
| [internals/audit-chain.md](internals/audit-chain.md) | The hash-chained, append-only log; `verify`; `export`. |
| [internals/persistence.md](internals/persistence.md) | SQLite (synchronous, WAL); the schema; derived reads. |
| [internals/hook-integration.md](internals/hook-integration.md) | How Brezia plugs into Claude Code; the HTTP-hook transport; the fixtures ritual. |
| [internals/failure-semantics.md](internals/failure-semantics.md) | The three invariants and every failure direction. **The process spine.** |
| [internals/frontend.md](internals/frontend.md) | The React inbox: state, rendering, and the untrusted-input rule. |

### `guides/` — task-oriented

| Doc | What it covers |
|---|---|
| [guides/getting-started.md](guides/getting-started.md) | Install → first governed session. |
| [guides/writing-policy.md](guides/writing-policy.md) | Authoring `brezia.yaml`; the annotated default; hot reload. |
| [guides/operations.md](guides/operations.md) | Running the daemon; the log; `verify`/`export`; `status`; uninstall. |
| [guides/development.md](guides/development.md) | Repo setup; the build; package-boundary rules; the review agents. |

### Cross-cutting

| Doc | What it covers |
|---|---|
| [security.md](security.md) | The threat model and security posture: localhost binding, untrusted input, tamper-evidence. |
| [testing.md](testing.md) | The testing pyramid, the permanent invariant tests, the fixtures ritual, the review discipline. |
| [perf.md](perf.md) | Performance notes: the decision→release latency budget and measurement. |

## Reading paths

**"I want the big picture."**
[overview.md](overview.md) → [architecture.md](architecture.md) →
[concepts.md](concepts.md).

**"I'm integrating a runtime / pointing a hook at Brezia."**
[overview.md](overview.md) → [reference/events-api.md](reference/events-api.md) →
[reference/http-api.md](reference/http-api.md) →
[internals/hook-integration.md](internals/hook-integration.md) →
[reference/configuration.md](reference/configuration.md).

**"I'm modifying the policy engine."**
[concepts.md](concepts.md) → [reference/policy-format.md](reference/policy-format.md) →
[internals/policy-evaluation.md](internals/policy-evaluation.md) →
[internals/bash-classification.md](internals/bash-classification.md) →
[internals/flags.md](internals/flags.md) →
[internals/aggregation-limits.md](internals/aggregation-limits.md) →
[testing.md](testing.md). (Remember: `packages/policy` is pure — zero I/O.)

**"I'm auditing security."**
[security.md](security.md) → [internals/failure-semantics.md](internals/failure-semantics.md)
→ [internals/audit-chain.md](internals/audit-chain.md) →
[internals/bash-classification.md](internals/bash-classification.md) →
[internals/frontend.md](internals/frontend.md).

**"I'm operating a running daemon."**
[guides/getting-started.md](guides/getting-started.md) →
[guides/operations.md](guides/operations.md) → [reference/cli.md](reference/cli.md) →
[reference/configuration.md](reference/configuration.md).

---

*Every claim is cited to source as `path:line`; all cross-links and ~490 citations
were checked to resolve against the current tree. When the code changes, re-verify
link resolution, citation range, and terminology against [`concepts.md`](concepts.md).*
