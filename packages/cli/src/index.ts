// brezia — CLI entry point.
//
//   init    Register the Brezia hook in Claude Code settings. HIGH-STAKES: backs up
//           the file, deep-merges, never clobbers, idempotent. [--project|--user]
//   up      Start the daemon (foreground); print the inbox URL + counter, stream
//           decisions, Ctrl-C to stop.
//   remove  Surgically remove Brezia's hook entry; restore byte-identical.
//   export  Export the audit log to JSON/CSV. [--db, --format json|csv, --out]
//   verify  Walk the audit chain end to end and report integrity. [--db]
//   status  Diagnose common failures (daemon down, hook missing, port taken).

import { writeFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteStorage, defaultDbPath } from "@brezia/daemon";
import { runVerify, runExport } from "./commands";
import { runInit, runRemove, type Scope } from "./init";
import { runUp } from "./up";
import { runStatus } from "./status";

// Minimal flag parser: --key value and --flag. Positional args are ignored here;
// v0 commands are flag-driven.
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function fail(message: string): never {
  process.stderr.write(`brezia: ${message}\n`);
  process.exit(1);
}

// A silently-ignored typo is a real footgun here, not just noise: `--user`
// mistyped as `--uesr` would otherwise fall back to `--project` (the default)
// with zero indication anything was wrong — the wrong settings file gets edited
// and nothing says so. Every command's accepted flags are listed explicitly,
// `up`/`status` included (they take none), so a stray flag anywhere is caught.
const KNOWN_FLAGS: Record<string, readonly string[]> = {
  init: ["project", "user"],
  remove: ["project", "user"],
  export: ["db", "format", "out"],
  verify: ["db"],
  up: [],
  status: [],
};

function checkKnownFlags(command: string, flags: Record<string, string>): void {
  const known = KNOWN_FLAGS[command] ?? [];
  const unknown = Object.keys(flags).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    const list = unknown.map((f) => `--${f}`).join(", ");
    fail(`unknown flag${unknown.length > 1 ? "s" : ""} ${list} for '${command}'. Run 'brezia ${command} --help' for usage.`);
  }
}

// `--help`/`-h` must never fall through to the flag parser: init/remove edit a
// real settings.json, up starts a real background daemon, and verify/export read
// and print the real audit log — none of those should run because someone was
// trying to learn what the command does. Checked before any command dispatch.
const HELP_FLAGS = new Set(["--help", "-h"]);

const USAGE = "Usage: brezia <init|up|remove|export|verify|status> [--help]";

const COMMAND_HELP: Record<string, string> = {
  init:
    "brezia init [--project|--user]\n\n" +
    "  Register the Brezia hook in Claude Code settings. Backs up the settings\n" +
    "  file first (timestamped), deep-merges (never touches other hooks or\n" +
    "  settings), and is idempotent — running it again makes no change.\n\n" +
    "  --project   .claude/settings.json in the current directory (default)\n" +
    "  --user      ~/.claude/settings.json, applies to every project",
  up:
    "brezia up\n\n" +
    "  Start the daemon in the foreground. Prints the inbox URL and the\n" +
    "  auto-resolved counter, then streams a line per decision. Ctrl-C stops it\n" +
    "  cleanly. Refuses to start a second instance while one is already up.\n\n" +
    "  Binds 127.0.0.1:4747 only — not configurable (the v0 security model).",
  remove:
    "brezia remove [--project|--user]\n\n" +
    "  Remove Brezia's hook entry from Claude Code settings. Surgical: only the\n" +
    "  group identified by the Brezia daemon URL is dropped, everything else in\n" +
    "  the file is restored byte-identical to before init.\n\n" +
    "  --project   .claude/settings.json in the current directory (default)\n" +
    "  --user      ~/.claude/settings.json",
  export:
    "brezia export [--db PATH] [--format json|csv] [--out FILE]\n\n" +
    "  Export the audit log. Prints to stdout unless --out is given.\n\n" +
    "  --db PATH        defaults to ~/.brezia/brezia.db\n" +
    "  --format FORMAT  json (default) or csv\n" +
    "  --out FILE       write to a file instead of stdout",
  verify:
    "brezia verify [--db PATH]\n\n" +
    "  Walk the audit chain end to end and report whether it verifies intact.\n" +
    "  Exit code 0 if it does, 1 if it doesn't.\n\n" +
    "  --db PATH   defaults to ~/.brezia/brezia.db",
  status:
    "brezia status\n\n" +
    "  Diagnose the common failures: daemon not running, hook not installed in\n" +
    "  either settings file, port already taken. Exit code 0 if the daemon is\n" +
    "  up, 1 otherwise (safe to use in a script).",
};

function printGeneralHelp(): void {
  process.stdout.write(
    `${USAGE}\n\n` +
      "Commands:\n" +
      "  init     Register the hook in Claude Code settings\n" +
      "  up       Start the daemon in the foreground\n" +
      "  remove   Remove the hook, restoring settings byte-identical\n" +
      "  export   Export the audit log (JSON/CSV)\n" +
      "  verify   Walk the audit chain and report integrity\n" +
      "  status   Diagnose daemon/hook/port problems\n\n" +
      "Run `brezia <command> --help` for details on a specific command.\n",
  );
}

function openDb(flags: Record<string, string>): SqliteStorage {
  const path = flags.db ?? defaultDbPath();
  if (path !== ":memory:" && !existsSync(path)) {
    fail(
      `no audit database at ${path}\n` +
        `  Run the daemon first (it creates ~/.brezia/brezia.db), or pass --db <path>.`,
    );
  }
  return new SqliteStorage(path);
}

// argv is injectable (defaults to the real process.argv) so tests can drive this
// without spawning a subprocess — main() still calls process.exit() directly for
// every path, same as any CLI entry point, so tests mock that rather than avoid it.
export function main(argv: string[] = process.argv): void {
  const command = argv[2];
  const rest = argv.slice(3);
  const flags = parseFlags(rest);

  // Intercepted before any command dispatch below — none of init/up/remove/
  // verify/export should ever run because someone asked for help.
  if (command !== undefined && HELP_FLAGS.has(command)) {
    printGeneralHelp();
    process.exit(0);
  }
  if (command !== undefined && command in COMMAND_HELP && rest.some((a) => HELP_FLAGS.has(a))) {
    process.stdout.write(COMMAND_HELP[command]! + "\n");
    process.exit(0);
  }

  if (command === "verify") {
    checkKnownFlags(command, flags);
    const storage = openDb(flags);
    try {
      const { ok, count, output } = runVerify(storage);
      process.stdout.write(output + "\n");
      process.exit(ok ? 0 : 1);
    } finally {
      storage.close();
    }
  }

  if (command === "export") {
    checkKnownFlags(command, flags);
    const format = (flags.format ?? "json").toLowerCase();
    if (format !== "json" && format !== "csv") {
      fail(`unknown --format '${format}'. Use 'json' or 'csv'.`);
    }
    const storage = openDb(flags);
    try {
      const output = runExport(storage, format);
      if (flags.out !== undefined) {
        writeFileSync(flags.out, output);
        process.stdout.write(`brezia: wrote ${flags.out}\n`);
      } else {
        process.stdout.write(output);
      }
      process.exit(0);
    } finally {
      storage.close();
    }
  }

  // HIGH-STAKES: init/remove edit the user's Claude Code settings. Scope defaults to
  // --project (repo-local); --user targets ~/.claude. All the surgery is in the
  // tested settings.ts + init.ts; here we only parse the flag and print the result.
  if (command === "init" || command === "remove") {
    checkKnownFlags(command, flags);
    if (flags.project !== undefined && flags.user !== undefined) {
      fail("choose one of --project or --user, not both.");
    }
    const scope: Scope = flags.user !== undefined ? "user" : "project";
    try {
      const msgs = command === "init" ? runInit({ scope }) : runRemove({ scope });
      for (const m of msgs) process.stdout.write(m + "\n");
      process.exit(0);
    } catch (e) {
      fail((e as Error).message);
    }
  }

  if (command === "up") {
    checkKnownFlags(command, flags);
    // Long-running foreground command: it keeps the process alive (listening
    // server) until Ctrl-C, and handles its own exit on error/shutdown.
    void runUp();
    return;
  }

  if (command === "status") {
    checkKnownFlags(command, flags);
    void runStatus().then((code) => process.exit(code));
    return;
  }

  const shown = command ?? "(no command)";
  process.stderr.write(`brezia: unknown command '${shown}'\n${USAGE}\n`);
  process.exit(1);
}

// Only auto-run when this file is the process entry point (`node dist/index.js …`)
// — not when a test imports main() to drive it with injected argv. Resolve both
// sides through realpath before comparing: npm satisfies `bin` entries via a
// symlink on POSIX (node_modules/.bin/brezia -> dist/index.js), and Node's ESM
// loader resolves import.meta.url through that symlink to the real file while
// process.argv[1] stays the literal (symlinked) invoked path — a strict-equality
// check on the unresolved paths never matches under `npx brezia`/a global install
// on Mac/Linux, so main() would silently never run. Verified live with a real
// symlink during the bash/CLI hardening review.
// Parameterized (rather than reading process.argv[1]/import.meta.url internally)
// so a test can drive it with a real symlink without spawning a subprocess.
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main();
}
