# Operations

> Running Brezia day to day: the daemon lifecycle, the files it owns, reading the log,
> verifying and exporting the audit chain, diagnosing problems, and uninstalling cleanly.

This guide is for keeping Brezia running and trustworthy over time. It assumes you have
already installed it ([getting-started.md](getting-started.md)). For every command's full
flag set see [../reference/cli.md](../reference/cli.md).

## Contents

- [Running the daemon](#running-the-daemon)
- [The files Brezia owns](#the-files-brezia-owns)
- [The diagnostics log](#the-diagnostics-log)
- [Verifying the audit chain](#verifying-the-audit-chain)
- [Exporting the audit log](#exporting-the-audit-log)
- [Troubleshooting with status](#troubleshooting-with-status)
- [Uninstalling](#uninstalling)
- [Backups](#backups)

---

## Running the daemon

`brezia up` runs the daemon in the **foreground** and holds the terminal until Ctrl-C
(`packages/cli/src/up.ts:105`). It prints the inbox URL, the resolved policy path, the DB
path, the log path, and the current auto-resolved rate, then streams a compact line per
decision.

- **One instance at a time.** A PID file at `~/.brezia/brezia.pid` guards against a second
  daemon; starting a second `up` while one is alive fails with `already running (pid …)`
  (`up.ts:113`). A stale PID file is cleared automatically — but "stale" means more than a
  signal-0 liveness check on the PID: `isDaemonRunningAt()` (`up.ts:42`) also confirms the
  daemon actually answers on its port (`GET /v1/stats`, 800ms timeout) before refusing to
  start. PID existence alone isn't proof of anything — an unclean exit (crash, force-kill,
  machine sleep) leaves the file behind without removing it, and the OS can later hand that
  same PID to an unrelated process, which would otherwise block every future `up` until
  someone found and deleted the file by hand. Either way, recovery needs no manual cleanup.
- **Fixed address.** It always binds `127.0.0.1:4747`; the address is not configurable and
  is asserted at startup (`packages/daemon/src/index.ts:39`). If the port is taken, `up`
  says so with the fix (`up.ts:131`).
- **Clean shutdown.** SIGINT/SIGTERM trigger a graceful close — the server closes, the PID
  file is removed, and the process exits 0 (`up.ts:167`). Ctrl-C is the normal way to stop.
- **Crash recovery.** On startup the daemon resolves any request left `pending` by a
  previous process to **`deferred`** and chains it, so the audit log stays truthful about
  what Brezia did *not* decide (`packages/daemon/src/index.ts:139`). You do not do anything
  for this; it is automatic.

The decision stream in the terminal is defensive: agent-supplied text is passed through
`inert()`, which strips C0/C1 control bytes (including the ESC that begins ANSI sequences)
so a crafted command cannot spoof or rewrite lines in your terminal (`up.ts:41`). The
stream itself is a nicety — if it drops, the daemon keeps running (`up.ts:84`).

---

## The files Brezia owns

Everything lives under your home directory and the governed repo. Nothing else is touched.

| Path | What it is | Written by |
|---|---|---|
| `.claude/settings.json` (project) or `~/.claude/settings.json` (user) | The Claude Code hook entry | `brezia init` / `remove` |
| `./brezia.yaml` (project) or `~/.brezia/brezia.yaml` (user) | Your policy | `brezia init` (starter); you thereafter |
| `~/.brezia/brezia.db` | The SQLite audit database (WAL mode) | the daemon |
| `~/.brezia/brezia.pid` | The single-instance guard | `brezia up` |
| `~/.brezia/brezia.log` | The human-readable diagnostics log | the daemon |
| `*.brezia-backup-*` | Timestamped settings backups | `init` / `remove` before each write |

Policy resolution at `up` time tries, in order: `./brezia.yaml`, then
`~/.brezia/brezia.yaml`, then the bundled default pack (`up.ts:22`). The `up` banner prints
which one it loaded, so you are never guessing which policy is live.

---

## The diagnostics log

`~/.brezia/brezia.log` is a plain, append-only diagnostics log — the "what happened / why"
view. It is distinct from the audit chain: the audit chain is the tamper-evident *record*
of decisions; the log is for operators (`packages/daemon/src/logger.ts:5`). It records
daemon up/down, policy reloads and rejections, and crash-recovery deferrals.

Two operational properties:

- **It self-rotates.** Once past ~5 MB the current file is renamed to `brezia.log.old`
  (one prior file kept), so it can never grow without bound (`logger.ts:11`).
- **It never perturbs a decision.** Every write is best-effort in a `try/catch`; a logging
  failure is swallowed rather than thrown, because a log write must never affect the
  tool-call path (`logger.ts:25`). If the log directory can't even be created, the logger
  becomes a no-op instead of failing.

To watch it live on Unix: `tail -f ~/.brezia/brezia.log`.

---

## Verifying the audit chain

Every state change Brezia makes is recorded as a hash-chained, append-only audit entry:
`hash = sha256(prev_hash + entry_json)`, genesis at seq 1
([../internals/audit-chain.md](../internals/audit-chain.md)). `brezia verify` walks that
chain end to end and reports whether it holds:

```sh
brezia verify
```

- On an intact chain: `✓ audit chain verified — N entries intact` and exit `0`.
- On a broken chain: `✗ audit chain FAILED verification — the log has been altered or
  corrupted.` and exit `1` (`packages/cli/src/commands.ts:7`).

By default it opens `~/.brezia/brezia.db`; pass `--db <path>` to verify a different
database (e.g. an archived copy). If no database exists yet, `verify` tells you to run the
daemon first (which creates it) or to pass `--db` (`packages/cli/src/index.ts:44`).

Verification re-hashes the stored `entry_json` string exactly as written — it does not
re-serialize — so re-ordering, editing, or deleting any row breaks the chain and is caught.
This is what makes the log tamper-*evident*: you cannot quietly rewrite history.

The non-zero exit on failure makes `verify` suitable for a cron check or CI gate:
`brezia verify || alert`.

---

## Exporting the audit log

`brezia export` dumps the full chain for archival or external review:

```sh
brezia export                       # JSON to stdout (default)
brezia export --format csv          # CSV to stdout
brezia export --format json --out audit.json   # write to a file
```

The two formats serve different needs (`packages/cli/src/audit.ts`):

- **JSON** keeps each entry parsed inline alongside its `seq`, `ts`, `prevHash`, and `hash`
  — a reader sees the semantic record plus its chain linkage (`audit.ts:8`).
- **CSV** flattens to one row per entry with the **raw `entry_json` preserved verbatim**,
  so the export can itself be re-verified. Every field is unconditionally quoted
  (RFC-4180), which keeps commas, newlines, and quotes inside agent-supplied text inert
  (`audit.ts:26`).

An unknown `--format` is rejected with the valid options (`packages/cli/src/index.ts:72`).
Like `verify`, `export` reads `~/.brezia/brezia.db` unless `--db` points elsewhere.

---

## Troubleshooting with status

`brezia status` is the first thing to run when something looks off. It is read-only and
defensive — a broken settings file is *reported*, never thrown (`packages/cli/src/status.ts:1`):

```sh
brezia status
```

It answers three questions and prints actionable next steps:

- **Is the daemon up?** It probes `GET /v1/stats` on `127.0.0.1:4747` with a 2-second
  timeout; up prints the auto-resolved rate, down prints `nothing answering` (`status.ts:38`).
- **Is the hook installed?** It checks both the project and user `settings.json` and
  reports `installed`, `present but Brezia hook absent`, `no settings file`, or
  `unreadable (not valid JSON)` (`status.ts:13`).
- **What should I do?** It appends tips like `start the daemon: brezia up`, `install the
  hook: brezia init`, or a warning to fix a non-JSON settings file before running
  `init`/`remove` (`status.ts:56`).

It exits `0` when the daemon is up and `1` otherwise, so it works in scripts
(`status.ts:66`).

Common situations:

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent prompts you natively, no cards | daemon down | `brezia up` |
| `port 4747 already in use` | another daemon/process holds it | stop it, or free the port |
| `already running (pid …)` | a live daemon already up | use the existing one, or stop it |
| Inbox shows a red policy banner | your `brezia.yaml` failed to reload | fix the file; the previous policy is still in force |
| `verify` fails | the DB was altered/corrupted | investigate; the chain is tamper-evident by design |

---

## Uninstalling

Removing Brezia is as clean as installing it:

```sh
brezia remove              # this repo (default)
brezia remove --user       # the user-scope hook
```

`remove` is the second **high-stakes** command. It backs up the settings file first, then
surgically drops *only* Brezia's hook entry, leaving every other hook and setting in place
(`packages/cli/src/init.ts:145`). For standard-formatted files the result is
**byte-identical** to the pre-install state: it detects and preserves the original indent,
line endings, and trailing newline, drops the matcher group it added, and removes the now-
empty `PreToolUse`/`hooks` scaffolding if Brezia was the only occupant (`init.ts:48`,
`settings.ts:72`). If the hook isn't present, it says so and changes nothing (`init.ts:153`).

`remove` deliberately leaves your `brezia.yaml` and `~/.brezia/` (the audit log, config)
in place — your evidence log is yours to keep. Delete them by hand if you want them gone:

```sh
rm -rf ~/.brezia            # audit DB, log, pid, user policy
rm brezia.yaml              # project policy, if you used --project
```

Stop the daemon with Ctrl-C in the `brezia up` terminal before or after removing the hook —
order doesn't matter, since a running daemon with no hook simply receives no calls.

---

## Backups

Two things are worth backing up:

- **`~/.brezia/brezia.db`** — the audit log. It is append-only and hash-chained; a copied
  database re-verifies with `brezia verify --db <copy>`, so backups are self-proving. Copy
  it while the daemon is stopped, or rely on SQLite's WAL for a consistent read.
- **`brezia.yaml`** — your policy. Keep it in version control alongside the repo it governs;
  that also gives you a change history for the rules that decide your tool calls.

Settings backups are automatic: `init` and `remove` each write a timestamped
`*.brezia-backup-*` before touching `settings.json` (`init.ts:86`), so you can always
restore the exact pre-edit file.

---

**Next:** [../reference/cli.md](../reference/cli.md) for every command and flag,
[../internals/audit-chain.md](../internals/audit-chain.md) for how the chain is built and
verified, or [writing-policy.md](writing-policy.md) to tune what gets held.
