# Getting started

> From zero to a governed Claude Code session in two commands. What auto-clears, what
> waits for you, and how to decide it.

This guide takes you from install to your first held request. It assumes you have Claude
Code installed and Node ≥ 20 (`package.json:14`). By the end you will have Brezia's hook
registered, the daemon running, and the inbox open — with your agent's routine tool calls
clearing themselves and the handful that matter waiting for a keystroke.

## Contents

- [What you are setting up](#what-you-are-setting-up)
- [Step 1 — init](#step-1--init)
- [Step 2 — up](#step-2--up)
- [Step 3 — use Claude Code as usual](#step-3--use-claude-code-as-usual)
- [The inbox](#the-inbox)
- [What auto-clears vs. what holds](#what-auto-clears-vs-what-holds)
- [If something looks wrong](#if-something-looks-wrong)
- [Where to go next](#where-to-go-next)

---

## What you are setting up

Brezia sits in Claude Code's tool-call path as a **PreToolUse hook**. Every time your agent
is about to run a tool, Claude Code POSTs the call to the local Brezia daemon, which
consults your policy:

- an [`auto_allowed`](../concepts.md#the-decision-vocabulary) call runs with no prompt;
- an `auto_denied` call is blocked;
- anything else resolves to **`ask`** and waits as a [held request](../concepts.md#request--the-held-human-review-item)
  in the inbox until you decide.

Everything runs on `127.0.0.1` — no account, no cloud, no telemetry. And because Brezia is
just a hook, a daemon that is down, slow, or timed out changes nothing: Claude Code falls
back to its native permission flow. Degraded Brezia is normal Claude Code
([README.md:20](../../README.md)). That is the never-brick guarantee; the failure model is
in [../internals/failure-semantics.md](../internals/failure-semantics.md).

---

## Step 1 — init

```sh
npx brezia init
```

`brezia init` registers the hook and writes a starter policy. It is one of the two
**high-stakes** commands because it edits a real Claude Code `settings.json`. The
guardrails are built in (`packages/cli/src/init.ts`):

- **It backs up first.** If a settings file already exists, it is copied to a timestamped
  `*.brezia-backup-*` before any write (`init.ts:122`).
- **It never clobbers your hooks.** Brezia manages its own matcher group, so your existing
  hooks are untouched; a re-run is idempotent and reports "already present"
  (`init.ts:119`, `settings.ts:56`).
- **It writes atomically.** The new settings are written to a temp file and renamed over
  the target, so a crash mid-write cannot corrupt the file (`init.ts:95`).
- **It never overwrites your policy.** If `brezia.yaml` already exists it is kept as-is
  (`init.ts:133`).

The hook entry it adds is exactly this shape, verified live against the installed Claude
Code (decision 008):

```jsonc
// under hooks.PreToolUse[].hooks in .claude/settings.json — packages/cli/src/settings.ts:20
{ "type": "http", "url": "http://127.0.0.1:4747/v1/hook", "timeout": 300 }
```

### Scope: this repo vs. every project

`init` defaults to **project** scope — the current repo's `.claude/settings.json` and a
`./brezia.yaml` starter policy (`init.ts:21`). To govern every project instead, use
`--user`, which targets `~/.claude/settings.json` and `~/.brezia/brezia.yaml`:

```sh
npx brezia init            # this repo only (default)
npx brezia init --user     # all projects for your user
```

Passing both `--project` and `--user` is an error (`packages/cli/src/index.ts:94`).

---

## Step 2 — up

```sh
npx brezia up
```

`brezia up` starts the daemon in the foreground on `http://127.0.0.1:4747`, prints where
everything lives, and streams a line per decision until you press Ctrl-C
(`packages/cli/src/up.ts:89`). Typical output:

```
Brezia is up: http://127.0.0.1:4747   (open the inbox in your browser)
  policy:    /home/you/project/brezia.yaml
  audit log: /home/you/.brezia/brezia.db
  log:       /home/you/.brezia/brezia.log
  auto-resolved (7d): 0% (0/0)

Streaming decisions (Ctrl-C to stop):
```

A few things happen under the hood:

- **Policy resolution.** `up` loads the first policy that exists: `./brezia.yaml`, then
  `~/.brezia/brezia.yaml`, then the bundled default pack (`up.ts:22`). This matches where
  `init` writes for `--project` and `--user`.
- **Single instance.** A PID file at `~/.brezia/brezia.pid` prevents a second daemon; a
  stale file (from a crashed run, or a PID the OS has since reused) is detected — not just
  by whether the PID exists, but by confirming the daemon actually answers on its port —
  and cleaned up automatically (`up.ts:113`, `isDaemonRunningAt` at `up.ts:42`).
- **The port is fixed.** The daemon binds `127.0.0.1:4747` only, asserted at startup and
  never configurable (`packages/daemon/src/index.ts:39`). If the port is taken, `up`
  tells you so plainly (`up.ts:131`).

Leave this terminal running and open `http://127.0.0.1:4747` in a browser.

> **Note.** The daemon must be started separately from Claude Code — the hook only reaches
> it while `brezia up` is running. If the daemon is down, your agent simply uses its native
> prompts; nothing breaks.

---

## Step 3 — use Claude Code as usual

Start a Claude Code session in the governed repo and work normally. You do not change how
you use the agent. As it calls tools:

- Reads, searches, and safe shell commands clear silently — no prompt, no card.
- Edits, writes, mutating commands, and anything carrying a credential appear as cards in
  the inbox and wait for you.

In the `brezia up` terminal you will see a compact stream: `HELD` lines when a call is
waiting, and `APPROVED` / `DENIED` lines as you decide (`up.ts:72`). Agent-supplied text in
that stream is stripped of control characters first, so a crafted command cannot rewrite
your terminal (`up.ts:41`).

---

## The inbox

`http://127.0.0.1:4747` is a live queue of held requests, grouped by session so parallel
agents share one screen. You drive it from the keyboard:

| Key | Action |
|---|---|
| `j` / `k` | Move the cursor down / up the queue |
| `a` | Approve the selected card — its tool call runs |
| `d` | Deny the selected card — type a reason, **Enter** submits, **Esc** cancels |

Each card shows the tool, its arguments, the project, the matched [policy tier](../concepts.md#the-policy-format-breziayaml)
(or `unmatched`), and any anomaly [flags](../concepts.md#flags--anomaly--context-signals)
such as `secrets_pattern`. Decisions are **optimistic**: the card leaves the queue the
instant you act, so approving is as fast as the native prompt was. Every field that came
from the agent renders inert — never interpreted as HTML, a link, markdown, or terminal
escapes ([../internals/frontend.md](../internals/frontend.md#the-one-hard-rule-untrusted-input-renders-inert)).

The header shows your **auto-resolved rate** over a rolling 7 days — the share of calls
policy cleared without you (`packages/daemon/src/index.ts:119`). It starts at 0% and climbs
as Brezia learns your session's routine shape through the default policy.

---

## What auto-clears vs. what holds

With the shipped default policy (`policy-packs/claude-code-default.yaml`), a fresh install
clears the routine and holds the rest:

**Auto-clears (`auto_allowed`):**

- Read-only tools: `Read`, `Grep`, `Glob`.
- Classified-safe shell reads: `ls`, `cat`, `head`, `tail`, `grep`, `which`, `echo`, `wc`,
  `stat`, `pwd`, and read-only git (`git status`/`diff`/`log`/`show`) — the `read` and
  `vcs-read` bash classes.
- Routine dev: running tests and builds (`npm test`, `pytest`, `vitest`; `npm run build`,
  `tsc`) — the `test` and `build` classes.

**Holds for you (`ask`):**

- `Write` and `Edit`.
- Mutating or network shell: `rm`, `mv`, `curl`, `git push`/`commit`, `npm install`,
  `chmod`.
- **Anything with a secrets-shaped argument** — this tier is checked *first*, so `cat .env`
  is a read but still stops for you.
- **Anything unclassifiable** — a compound or expansion command like `ls && curl …` or
  `cat $(…)` never matches a safe class and falls through to `ask`. Brezia fails toward
  asking, never toward allowing.

The default pack is heavily commented and doubles as the format reference. To tune what
clears for your own work, see [writing-policy.md](writing-policy.md).

---

## If something looks wrong

Run the read-only diagnostic:

```sh
npx brezia status
```

It reports whether the daemon is up, whether the hook is installed (project and user
scope), and prints actionable next steps — e.g. "start the daemon: brezia up" or "install
the hook: brezia init" (`packages/cli/src/status.ts`). It exits `0` when the daemon is up,
`1` otherwise, so it is script-friendly. Full troubleshooting is in
[operations.md](operations.md).

---

## Where to go next

- **Tune your policy:** [writing-policy.md](writing-policy.md) — author `brezia.yaml` from
  scratch, read the annotated default, and test changes.
- **Run it day to day:** [operations.md](operations.md) — the log, `verify`/`export` for
  the audit chain, and uninstalling.
- **Understand the model:** [../overview.md](../overview.md) and
  [../architecture.md](../architecture.md).
- **Every command in full:** [../reference/cli.md](../reference/cli.md).
