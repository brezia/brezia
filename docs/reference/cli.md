# CLI reference — the `brezia` command

> Complete reference for the `brezia` binary: `init`, `up`, `remove`, `status`, `verify`,
> `export`. Two of these — `init` and `remove` — edit the user's Claude Code settings and
> are flagged as **high-stakes settings surgery**.

The CLI is flag-driven (no positional args at v0). Command bodies are kept free of process
I/O so they unit-test against in-memory storage; `index.ts` wires argv → storage → the
command (`packages/cli/src/commands.ts:4`). This page documents each command's synopsis,
flags, behavior, exit codes, and output.

Read [concepts.md](../concepts.md) for the audit-chain vocabulary; the settings entry and
file locations are in [reference/configuration.md](../reference/configuration.md).

## Contents

- [Synopsis and dispatch](#synopsis-and-dispatch)
- [Flag parsing and scope resolution](#flag-parsing-and-scope-resolution)
- [`init` — install the hook (high-stakes)](#init)
- [`up` — run the daemon](#up)
- [`remove` — uninstall the hook (high-stakes)](#remove)
- [`status` — diagnose](#status)
- [`verify` — check the audit chain](#verify)
- [`export` — dump the audit log](#export)
- [Exit codes](#exit-codes-summary)
- [Files and paths](#files-and-paths)

---

## Synopsis and dispatch

```
brezia <init|up|remove|export|verify|status> [flags] [--help]
```

`main()` dispatches on `process.argv[2]` (`packages/cli/src/index.ts:143`, argv injectable
for tests). An unknown or missing command prints usage to stderr and exits `1`:

```ts
// packages/cli/src/index.ts:225
process.stderr.write(`brezia: unknown command '${shown}'\n${USAGE}\n`);
process.exit(1);
```

**`--help`/`-h` is intercepted before any command dispatch** — `brezia --help` prints the
command list; `brezia <command> --help` prints that command's synopsis and flags. This runs
before init/up/remove/verify/export ever start, specifically so it can never edit real
settings, start a real daemon, or print real audit data just because someone was trying to
learn what a command does (`packages/cli/src/index.ts:150`).

| Command | One line | Edits settings? | Needs the DB? |
|---|---|---|---|
| `init` | Register the Brezia hook in Claude Code settings. | **yes (high-stakes)** | no |
| `up` | Start the daemon (foreground); stream decisions. | no | creates/opens it |
| `remove` | Surgically remove the hook; restore byte-identical. | **yes (high-stakes)** | no |
| `status` | Diagnose daemon-down / hook-missing / port-taken. | no (read-only) | no |
| `verify` | Walk the audit chain and report integrity. | no | reads it |
| `export` | Export the audit log to JSON/CSV. | no | reads it |

## Flag parsing and scope resolution

A minimal parser reads `--key value` and bare `--flag` (which becomes `"true"`); positional
args are ignored (`packages/cli/src/index.ts:21`). **Unknown flags are rejected, not
silently ignored** — each command lists its actual accepted flags (`up`/`status` accept
none at all), and a stray or typo'd flag fails loudly before the command runs:
`brezia: unknown flag --uesr for 'init'. Run 'brezia init --help' for usage.`
(`checkKnownFlags`, `packages/cli/src/index.ts:59`). This matters beyond typo-catching for
`init`/`remove` specifically: a mistyped `--user` would otherwise silently fall back to
`--project` (the default) with no indication the wrong settings file was about to be edited.

| Flag | Commands | Meaning | Default |
|---|---|---|---|
| `--project` | `init`, `remove` | Target the repo-local `.claude/settings.json` + `./brezia.yaml`. | (this is the default scope) |
| `--user` | `init`, `remove` | Target `~/.claude/settings.json` + `~/.brezia/brezia.yaml`. | — |
| `--db <path>` | `verify`, `export` | Path to the audit database. | `~/.brezia/brezia.db` |
| `--format <json\|csv>` | `export` | Output format. | `json` |
| `--out <path>` | `export` | Write to a file instead of stdout. | stdout |

**Scope resolution** (`packages/cli/src/init.ts:21`): `--user` targets `~/.claude`;
otherwise scope is `--project` (repo-local). Passing both `--project` and `--user` is an
error (`packages/cli/src/index.ts:198`):

```ts
// packages/cli/src/init.ts:21
return scope === "user"
  ? { settingsFile: join(home, ".claude", "settings.json"),  policyFile: join(home, ".brezia", "brezia.yaml") }
  : { settingsFile: join(cwd, ".claude", "settings.json"),   policyFile: join(cwd, "brezia.yaml") };
```

**Opening the DB** for `verify`/`export`: a non-`:memory:` path that does not exist is a
clear, actionable failure — the daemon must run first to create it (`packages/cli/src/index.ts:133`).

---

## `init`

> **HIGH-STAKES — settings surgery.** `init` edits the user's real Claude Code
> `settings.json`. The safety contract: **back up before every write, deep-merge (never
> clobber), atomic temp+rename, idempotent re-runs.** All the dangerous surgery is in the
> pure, exhaustively-tested `settings.ts`; the file I/O and backup are in `init.ts`. Flag
> this file for line-by-line human review whenever touched.

**Synopsis:** `brezia init [--project | --user]`

**What it does** (`packages/cli/src/init.ts:110`):

1. Parse the settings file *defensively*. A file that is not valid JSON, or is JSON that
   isn't an object, is **refused** with an actionable error — never clobbered:

   ```ts
   // packages/cli/src/init.ts:70
   } catch (e) {
     // Never clobber a file we can't understand — bail with a clear, actionable error.
     throw new Error(`${file} is not valid JSON (${(e as Error).message}). Refusing to touch it — fix or move the file, then re-run.`);
   }
   ```

2. If the Brezia hook is **already present**, make no change and say so (idempotent).
3. Otherwise, if the file existed, **back it up first** — a timestamped, byte-identical copy
   (`settings.json.brezia-backup-<ISO>`) — then add Brezia's own PreToolUse matcher group
   and write atomically.
4. Write a **starter policy** to the scope's `brezia.yaml`, but **never overwrite** a policy
   the user already has.

**The deep-merge, never-clobber strategy.** Brezia manages its *own* matcher group — a group
whose single hook targets the daemon URL — and never merges into anyone else's group. Adding
can't disturb foreign hooks; the entry is identified solely by the daemon URL
(`packages/cli/src/settings.ts:8`, `addBreziaHook` at `:56`). The exact group written was
verified live against the installed Claude Code (decision 008):

```ts
// packages/cli/src/settings.ts:20
function breziaGroup(): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [{ type: "http", url: BREZIA_HOOK_URL, timeout: BREZIA_HOOK_TIMEOUT }],
  };
}
// BREZIA_HOOK_URL = "http://127.0.0.1:4747/v1/hook"; BREZIA_HOOK_TIMEOUT = 300
```

**Backup + atomic write.** A backup is a timestamped `copyFileSync` of the original; the
write goes to a sibling temp file, then `rename`s over the target (atomic on the same
filesystem) so a crash mid-write can't corrupt `settings.json`:

```ts
// packages/cli/src/init.ts:95
function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.brezia-tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}
```

**Formatting is preserved.** `init` detects the original file's indent (tabs or N spaces),
EOL (LF/CRLF), and trailing-newline, and re-serializes in that style — so editing a
CRLF/4-space file keeps CRLF/4-space (`packages/cli/src/init.ts:48`). This is what makes
`remove` byte-identical (see below).

**Exit codes:** `0` on success (including the idempotent no-change case); `1` on error
(bad JSON, both scope flags) via `fail()` (`packages/cli/src/index.ts:198`).

**Example output (adding to a file with foreign hooks):**

```
  backed up .claude/settings.json → .claude/settings.json.brezia-backup-2026-07-17T12-00-00-000Z
✓ added the Brezia PreToolUse hook to .claude/settings.json (existing hooks untouched).
✓ wrote a starter policy to brezia.yaml.

Next: run 'brezia up' to start the daemon, then use Claude Code as usual.
```

Tested against settings files that already contain other people's hooks, no hooks,
malformed shapes, and non-canonical formatting; idempotent re-runs make no second backup
(`packages/cli/src/init.test.ts:60`).

## `up`

**Synopsis:** `brezia up`

Starts the daemon in the **foreground**, prints the inbox URL and the auto-resolved counter,
streams one line per decision off the daemon's SSE feed, and shuts down cleanly on Ctrl-C.

**Behavior** (`packages/cli/src/up.ts:89`):

1. **Single-instance guard.** A PID file at `~/.brezia/brezia.pid` prevents a second daemon.
   `up` refuses and exits `1` only if that PID is both *alive and actually answering on the
   daemon's port* (`GET /v1/stats`, 800ms timeout) — PID existence alone isn't proof of
   anything, since an unclean exit (crash, force-kill, machine sleep) leaves the file behind
   without removing it, and the OS can later hand that same PID to an unrelated process. A
   stale file — either case — is removed and startup proceeds:

   ```ts
   // packages/cli/src/up.ts:105
   if (existsSync(pidFile)) {
     const pid = Number(readFileSync(pidFile, "utf8").trim());
     if (await isDaemonRunningAt(pid, `http://${HOST}:${PORT}`)) {
       process.stderr.write(`brezia: already running (pid ${pid}). Stop that instance first.\n`);
       process.exit(1);
     }
     rmSync(pidFile, { force: true }); // stale pid file: process gone, or alive but not our daemon
   }
   ```

2. **Policy resolution.** Loads the first policy that exists: repo-local `./brezia.yaml`,
   then `~/.brezia/brezia.yaml`, then the bundled default pack
   (`packages/cli/src/up.ts:22`). Matches where `init` writes for `--project`/`--user`.
3. **Start + bind assertion.** Calls `start({ policyPath, dbPath, logPath })`, which binds
   `127.0.0.1:4747` and asserts loopback-only. `EADDRINUSE` is translated to a
   port-in-use message; either failure exits `1`:

   ```ts
   // packages/cli/src/up.ts:112
   process.stderr.write(
     /EADDRINUSE/.test(msg)
       ? `brezia: port ${PORT} is already in use — another daemon or process has it. Stop it, or free the port.\n`
       : `brezia: failed to start — ${msg}\n`,
   );
   process.exit(1);
   ```

4. **Live decision stream.** Reads `/v1/stream` and prints a compact line per event:
   `HELD` on `request.created`, the terminal status on `request.resolved`, `POLICY ERROR`
   on `policy.error`. **Agent-supplied strings are rendered inert** — control characters
   (including the ESC that begins ANSI sequences) are stripped so a crafted command can't
   spoof or rewrite terminal lines. This is the inbox `<pre>` inertness rule applied to the
   CLI surface (`packages/cli/src/up.ts:41`, see [security.md](../security.md)):

   ```ts
   // packages/cli/src/up.ts:41
   export function inert(s: string): string {
     let out = "";
     for (const ch of s) {
       const c = ch.codePointAt(0) ?? 0;
       if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue; // C0, DEL, C1
       out += ch;
     }
     return out;
   }
   ```

5. **Clean shutdown.** SIGINT/SIGTERM close the server, remove the PID file, and exit `0`
   (`packages/cli/src/up.ts:139`). The stream and stats reads are "niceties" — their loss
   never takes the daemon down (`packages/cli/src/up.ts:84`, `:132`).

**Exit codes:** stays alive until a signal, then `0`; `1` if another instance is running or
the server fails to start.

**Example output:**

```
Brezia is up: http://127.0.0.1:4747   (open the inbox in your browser)
  policy:    /repo/brezia.yaml
  audit log: ~/.brezia/brezia.db
  log:       ~/.brezia/brezia.log
  auto-resolved (7d): 78% (312/400)

Streaming decisions (Ctrl-C to stop):
[12:00:05] HELD  Bash  rm -rf build/  ⚑ first_time_command
[12:00:11] APPROVED  01J…
```

## `remove`

> **HIGH-STAKES — settings surgery.** `remove` must leave everything except Brezia's own
> entry **byte-identical**. Same review requirement as `init`.

**Synopsis:** `brezia remove [--project | --user]`

**What it does** (`packages/cli/src/init.ts:145`):

1. No settings file, or the hook not installed → a no-op message (nothing to remove).
2. Otherwise **back up**, then drop *only* Brezia's hook — removing our hook everywhere it
   appears, dropping any group thereby emptied, and cleaning up the `PreToolUse` array and
   `hooks` object **only if we left them empty** (so a file that had no hooks before `init`
   returns to having none). Foreign hooks and all other settings are untouched
   (`packages/cli/src/settings.ts:72`).
3. Re-serialize in the original file's detected format and write atomically.
4. The policy file is **left in place** — `remove` never deletes a user's policy.

**Byte-identical restore** is the load-bearing guarantee, and it is tested directly,
including for non-canonical files (4-space + CRLF + trailing newline; tabs + LF + no
trailing newline):

```ts
// packages/cli/src/init.test.ts:101
it("init then remove restores the settings file BYTE-IDENTICALLY", () => {
  const before = readFileSync(file, "utf8");
  runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
  runRemove({ scope: "project", cwd, now: NOW + 5000 });
  expect(readFileSync(file, "utf8")).toBe(before);
});
```

**Exit codes:** `0` on success or no-op; `1` on error (e.g. unreadable settings).

**Example output:**

```
  backed up .claude/settings.json → .claude/settings.json.brezia-backup-2026-07-17T12-05-00-000Z
✓ removed the Brezia hook from .claude/settings.json (all other hooks/settings preserved).
  note: your policy file was left in place — delete it by hand if you want it gone.
```

## `status`

**Synopsis:** `brezia status`

Read-only and defensive. Diagnoses the common failures — daemon not running, hook not
installed, port taken — and never throws on a broken settings file (a bad file is *reported*
as `unreadable`, not thrown) (`packages/cli/src/status.ts:13`).

It probes `/v1/stats` (2s timeout) to detect a live daemon, then reports the hook state for
both project and user scopes and prints actionable next steps:

```ts
// packages/cli/src/status.ts:45
out.push(up ? `● daemon   UP at ${url}` : `○ daemon   DOWN — nothing answering on ${url}`);
// ...hook (project) / hook (user): installed ✓ | present, but the Brezia hook is not in it
//    | no settings file | unreadable (not valid JSON)
```

**Exit codes** (script-friendly): `0` when the daemon is up, `1` when it is down
(`packages/cli/src/status.ts:66`, `index.ts:219`).

**Example output:**

```
○ daemon   DOWN — nothing answering on http://127.0.0.1:4747
  hook (project)  installed ✓
  hook (user)     no settings file

  → start the daemon:  brezia up
```

## `verify`

**Synopsis:** `brezia verify [--db <path>]`

Walks the audit chain end to end and reports integrity. This is the CLI surface over
`StorageAdapter.verifyAuditChain()` — it re-hashes each stored `entry_json` and checks every
`prev_hash` link (see [audit-chain.md](../internals/audit-chain.md#verify--re-hash-the-stored-string-never-re-serialize)).

```ts
// packages/cli/src/commands.ts:7
export function runVerify(storage: StorageAdapter): { ok: boolean; count: number; output: string } {
  const count = storage.allAuditEntries().length;
  const ok = storage.verifyAuditChain();
  const output = ok
    ? `✓ audit chain verified — ${count} ${count === 1 ? "entry" : "entries"} intact`
    : `✗ audit chain FAILED verification — the log has been altered or corrupted.\n` +
      `  The hash chain does not hold across its ${count} ${count === 1 ? "entry" : "entries"}.`;
  return { ok, count, output };
}
```

**Exit codes:** `0` when the chain verifies, `1` when it fails
(`packages/cli/src/index.ts:165`) — so `brezia verify` is usable as a CI/cron tamper check.
A missing DB exits `1` with a "run the daemon first" message
(`packages/cli/src/index.ts:133`).

**Example:**

```
$ brezia verify
✓ audit chain verified — 1284 entries intact
```

## `export`

**Synopsis:** `brezia export [--db <path>] [--format json|csv] [--out <path>]`

Dumps the entire audit log for archival and offline re-verification. `--format` defaults to
`json`; an unknown format exits `1` (`packages/cli/src/index.ts:175`). Without `--out`, the
export goes to stdout; with `--out`, it is written to that file and a confirmation is
printed.

- **JSON** keeps the parsed entry inline alongside its chain linkage
  (`packages/cli/src/audit.ts:8`).
- **CSV** flattens to `seq, ts, kind, prev_hash, hash, entry_json` with unconditional
  RFC-4180 quoting, so agent-supplied `entry_json` (commas, newlines, quotes) stays inert
  and the export can be re-verified (`packages/cli/src/audit.ts:22`).

Both formats preserve the raw `entry_json` verbatim, so an export can itself be re-hashed to
confirm the chain independently of Brezia. See
[audit-chain.md](../internals/audit-chain.md#export--json-and-csv).

**Exit codes:** `0` on success; `1` on unknown format or missing DB.

**Example:**

```
$ brezia export --format csv --out audit.csv
brezia: wrote audit.csv
```

## Exit codes summary

| Command | `0` | `1` |
|---|---|---|
| `init` | installed or already present | invalid JSON settings, both scope flags, unknown flag |
| `up` | clean shutdown (Ctrl-C) | another instance running, `EADDRINUSE`, start failure, unknown flag |
| `remove` | removed or no-op | unreadable settings, unknown flag |
| `status` | daemon up | daemon down, unknown flag |
| `verify` | chain verifies | chain fails, missing DB, unknown flag |
| `export` | wrote output | unknown format, missing DB, unknown flag |
| `--help` / `<command> --help` | always | — |
| (unknown) | — | unknown/missing command |

## Files and paths

| Path | Written/read by | Notes |
|---|---|---|
| `.claude/settings.json` (project) or `~/.claude/settings.json` (user) | `init`, `remove`, `status` | The hook entry. Backed up before every write. |
| `.claude/settings.json.brezia-backup-<ISO>` | `init`, `remove` | Timestamped, byte-identical backup of the pre-edit file. |
| `./brezia.yaml` (project) or `~/.brezia/brezia.yaml` (user) | `init` (starter), `up` (load) | Never overwritten by `init`; never deleted by `remove`. |
| `~/.brezia/brezia.db` | `up` (create/open), `verify`/`export` (read) | The SQLite audit database. Override with `--db`. |
| `~/.brezia/brezia.pid` | `up` | Single-instance guard; removed on clean shutdown. |
| `~/.brezia/brezia.log` | `up` | Human-readable diagnostics log (rotates at ~5 MB). |

Full detail on locations, resolution order, and the non-configurable bind is in
[reference/configuration.md](configuration.md).

---

**Next:** [reference/configuration.md](configuration.md) for the files and the hook entry,
[guides/operations.md](../guides/operations.md) for running/verifying/uninstalling, or
[internals/audit-chain.md](../internals/audit-chain.md) for what `verify`/`export` read.
