# Development

> Working on Brezia itself: repo setup, the workspace layout, the build and test commands,
> the package-boundary rules that keep the system honest, and the review discipline —
> agents, slash commands, and the "a new dependency is a decision" rule.

This guide is for contributors modifying Brezia, not users running it. It complements
[../architecture.md](../architecture.md) (how the packages fit) and
[../testing.md](../testing.md) (the test process) with the mechanics of getting a working
tree building and green — and the rules a change must not violate.

## Contents

- [Setup](#setup)
- [The workspace layout](#the-workspace-layout)
- [Building](#building)
- [Testing](#testing)
- [Running the UI in dev](#running-the-ui-in-dev)
- [The package-boundary rules](#the-package-boundary-rules)
- [A new dependency is a decision](#a-new-dependency-is-a-decision)
- [Review discipline: agents and slash commands](#review-discipline-agents-and-slash-commands)
- [The never-drift rules](#the-never-drift-rules)

---

## Setup

Requires Node ≥ 20 (`package.json:14`). Clone and install once from the repo root; npm
workspaces link the six packages together:

```sh
git clone <repo> brezia && cd brezia
npm install
npm run build     # build all packages in dependency order
npm test          # run the whole Vitest suite
```

The stack is **decided and fixed**: Node LTS, npm workspaces,
TypeScript strict, Vitest, tsup for packages, Vite for the UI, React with `useReducer` (no
state library), Fastify, better-sqlite3 (synchronous, WAL), zod, yaml + chokidar,
picomatch, shell-quote, ulid. No ORM — the schema is five tables. Do not substitute or add
to this list without a decision (see [below](#a-new-dependency-is-a-decision)).

---

## The workspace layout

Six packages, declared in `package.json:5`, each with one job:

| Package | Name | Role |
|---|---|---|
| `packages/shared` | `@brezia/shared` | **THE contract** — every type + zod schema. Depends only on `zod`. |
| `packages/policy` | `@brezia/policy` | **Pure** evaluation, zero I/O. The most-tested code. |
| `packages/daemon` | `@brezia/daemon` | Fastify server: `/v1/hook`, Events API, SSE, storage, serves the UI. |
| `packages/cli` | `brezia` | The `brezia` binary: `init`/`up`/`remove`/`status`/`verify`/`export`. |
| `packages/hook-shim` | `@brezia/hook-shim` | ~80-line fallback command hook. Imports nothing. |
| `packages/ui` | `@brezia/ui` | Vite + React inbox, built into the daemon's static assets. |

The dependency edges all point *toward* the contract: `daemon` imports `policy` and
`shared`; `cli` imports `daemon` and `shared`. `hook-shim` and `ui` sit apart on purpose —
see [the boundary rules](#the-package-boundary-rules). The full graph is in
[../architecture.md](../architecture.md#package-map--dependency-graph).

---

## Building

Every package except the UI builds with **tsup** to `dist/` (ESM `.js` + `.d.ts`); the UI
builds with **Vite** into the daemon's static directory. From the root:

```sh
npm run build     # builds shared → policy → daemon → hook-shim → brezia → ui, in order
```

The root `build` script names the workspaces explicitly in dependency order so downstream
packages compile against fresh upstream output (`package.json:17`). The tsup configs are
near-uniform (`format: ["esm"]`, `sourcemap`, `clean`, `target: node20`), with two
deliberate differences:

- **`cli`** injects a shebang banner (`#!/usr/bin/env node`) so `dist/index.js` is directly
  executable as the `brezia` bin, and skips `.d.ts` — it is an app, not a library
  (`packages/cli/tsup.config.ts:6`).
- **`ui`** builds with Vite straight into `../daemon/static` (`emptyOutDir: true`), so the
  daemon serves it same-origin; it is never published separately
  (`packages/ui/vite.config.ts:20`). That directory is gitignored.

`"type": "module"` is set throughout. Typecheck across all workspaces with `npm run
typecheck` (`tsc --noEmit` per package, `package.json:20`).

---

## Testing

One command runs everything from the root:

```sh
npm test          # vitest run — the entire suite, invariant tests included
npm run test:watch
```

Vitest configs alias the workspace packages to their **source** so tests run without a
prebuild — e.g. the daemon suite resolves `@brezia/shared` and `@brezia/policy` to
`../*/src/index.ts` (`packages/daemon/vitest.config.ts:5`). This means you edit and
re-test with no build step in the loop. Each package includes `src/**/*.test.ts(x)` and
sets `passWithNoTests`.

- The **UI** suite runs under `jsdom` with the React plugin and `globals` on
  (`packages/ui/vitest.config.ts`); it renders components with `renderToStaticMarkup` — no
  browser required.
- The **policy** suite is the bulk of the repo: exhaustive `(event + policy) → decision`
  tables plus adversarial property tests.
- The **invariant tests** are permanent — never weaken, skip, or delete them. If a change
  breaks one, the change is wrong, not the test.

The full testing philosophy — the pyramid, the fixtures ritual, the property tests — is in
[../testing.md](../testing.md).

---

## Running the UI in dev

The production inbox is served by the daemon, but for a fast edit loop run both dev
servers side by side from the root:

```sh
npm run dev:daemon     # the daemon on 127.0.0.1:4747
npm run dev:ui         # the Vite dev server on 127.0.0.1:5173
```

The Vite dev server proxies `/v1/*` (API + SSE) to the daemon, so the inbox's relative
`fetch`/`EventSource` calls behave exactly as they do in production, with no CORS
(`packages/ui/vite.config.ts:12`). Both bind loopback, mirroring the daemon's constraint.
UI internals are in [../internals/frontend.md](../internals/frontend.md).

---

## The package-boundary rules

Three boundaries are load-bearing. They are why the system is testable and safe; a change
that erodes one is a bug even if it compiles.

**1. `packages/shared` is THE contract.** Every domain type and zod schema lives there;
every other package imports *from* it, and nothing imports "up." The Events API schema and
the `brezia.yaml` format are versioned from commit one and **additive-only after v0** — a
breaking change to either is a red flag ([../concepts.md](../concepts.md)).

**2. `packages/policy` is pure — zero I/O.** It imports no `fs`, `net`, `db`, or `http`.
Events, flags, clock, history, and counters all arrive as *inputs*; the daemon owns the I/O
and injects the implementations ([../internals/policy-evaluation.md](../internals/policy-evaluation.md)).
This purity is what makes the engine exhaustively table-testable. `picomatch` and
`shell-quote` are pure and allowed; anything with I/O is not.

**3. Held requests are a `Map`, not a queue.** A held request is an open HTTP response
whose resolver is stored in a `Map<requestId, resolve>`; a human decision or a timeout
looks the id up and completes it. **Do not introduce a queue or worker abstraction** —
parallel sessions are just concurrent entries in the map, and the correct primitive for
I/O-bound held responses is an open connection plus a map lookup
([../architecture.md](../architecture.md#the-held-requests-model)).

Two more package-level facts follow the same spirit:

- **`hook-shim` imports nothing** — not even `@brezia/shared` — so it can never fail to
  start because a dependency did. Its only contract is the hook wire format.
- **`ui` does not import `@brezia/shared`.** It re-declares the small card shape locally in
  `types.ts`; the wire JSON on `/v1/requests` and `/v1/stream` is the real contract
  ([../internals/frontend.md](../internals/frontend.md#the-ui-does-not-import-the-contract)).
  Keeping the two card shapes in step is a review responsibility, not a compiler-enforced one.

---

## A new dependency is a decision

The stack list above is closed. **Adding a runtime dependency is an architectural decision,
not a code change** — stop and get explicit approval first. The `spec-guardian` agent
flags any new dependency as needing a decision (`.claude/agents/spec-guardian.md:23`); the
settled record of past decisions is kept internally (append-only). The single allowed
piece of forward-looking design is the `StorageAdapter` interface with SQLite as the only
v0 implementation; anything else reaching for v0.5/v1 capability is scope creep.

When a change genuinely settles a new irreversible choice, draft the ADR entry with the
`/new-decision` slash command and get approval before appending — never rewrite existing
entries, only supersede them.

---

## Review discipline: agents and slash commands

Brezia ships review automation in `.claude/`. Run the relevant reviewer before committing a
change to a failure path, a boundary, or scope.

**Subagents** (`.claude/agents/`):

| Agent | Role | Use before |
|---|---|---|
| `invariant-guardian` | Read-only. Checks a diff against the three invariants and the hard rules (failure direction, bash classification, audit append-only, loopback bind, untrusted-text inertness, zod boundaries, purity). Reports PASS/FAIL, never edits. | committing changes to policy, daemon, hook, audit, or shared-schema code |
| `spec-guardian` | Read-only. Flags v0 scope creep (building ahead) and conflicts with the spec or the settled decisions log, citing the governing doc. | a change that might exceed v0 scope or contradict a decision |
| `policy-engine` | Implementation specialist for `packages/policy` — evaluation, bash classification, flags, limits, and their tests. | any work inside the pure engine |
| `hook-verifier` | Phase A specialist — captures real Claude Code hook payloads into `fixtures/` and verifies the PreToolUse contract against the *installed* version. | fixture capture and hook-contract work |

The two guardians are **read-only** by construction (their `tools` frontmatter grants no
Write/Edit): they flag and cite `file:line`, they never fix. That separation is the point —
review is advice, not silent mutation.

**Slash commands** (`.claude/commands/`):

| Command | What it does |
|---|---|
| `/check-invariants` | Runs `npm test` and the audit-chain verify, then reports PASS/FAIL for each of the three invariants, citing the covering tests. |
| `/new-decision <topic>` | Drafts an append-only ADR-lite entry for the settled decisions log and requires your approval before appending. |
| `/capture-fixture <tool>` | Captures a real PreToolUse payload into `fixtures/`, scrubbed (shape kept, secrets faked), and turns it into a test — enforcing "never code the hook protocol from memory." |

---

## The never-drift rules

A few standing constraints that keep the codebase from rotting:

- **No drive-by refactors, no workspace-layout changes, no renaming public identifiers.**
  A change should do one thing.
- **Never code the Claude Code hook protocol from memory** — code it from captured
  `fixtures/`, re-verified against the installed version. Reality outranks every doc; a
  mismatch means capture a fixture and flag it.
- **TypeScript strict everywhere; no `any` at boundaries** — infer types from the zod
  schemas in `shared`.
- **User-facing errors and CLI output assume a stranger and name the fix** — see the
  friendly placeholder and the `status` tips as the model.
- **No telemetry, phone-home, or update checks. Ever.**

When a decided semantic seems ambiguous, ask — don't pick. This code sits in the tool-call
path of other people's agents; predictable outranks clever, and failure semantics outrank
features.

---

**Next:** [../testing.md](../testing.md) for the test process in full, or
[../architecture.md](../architecture.md) for the package graph.
