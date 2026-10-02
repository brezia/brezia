// File I/O for `brezia init` / `brezia remove`. The dangerous part — it edits a
// real settings.json. Guardrails: parse defensively (never clobber a file we can't
// read), back up (timestamped) before every write, and delegate the actual surgery
// to the pure, exhaustively-tested settings.ts. Paths are injectable so tests drive
// real files in temp dirs.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { addBreziaHook, removeBreziaHook, isInstalled } from "./settings";

export type Scope = "project" | "user";

export interface Paths {
  settingsFile: string;
  policyFile: string;
}

// project → repo-local .claude/settings.json + ./brezia.yaml
// user    → ~/.claude/settings.json + ~/.brezia/brezia.yaml
export function resolvePaths(scope: Scope, env: { cwd?: string; home?: string } = {}): Paths {
  const cwd = env.cwd ?? process.cwd();
  const home = env.home ?? homedir();
  return scope === "user"
    ? { settingsFile: join(home, ".claude", "settings.json"), policyFile: join(home, ".brezia", "brezia.yaml") }
    : { settingsFile: join(cwd, ".claude", "settings.json"), policyFile: join(cwd, "brezia.yaml") };
}

// The bundled default policy pack, resolved relative to this package (works from
// src and from the tsup build; packaging includes policy-packs in Phase F).
export function defaultPackPath(): string {
  return fileURLToPath(new URL("../../../policy-packs/claude-code-default.yaml", import.meta.url));
}
export function readDefaultPack(): string {
  return readFileSync(defaultPackPath(), "utf8");
}

// The original file's byte-level formatting, so a rewrite preserves indent, line
// endings, and trailing newline — this is what makes remove byte-identical for
// non-canonical files (tabs, 4-space, CRLF on Windows, no trailing newline).
interface Format {
  indent: string | number;
  eol: string;
  finalNewline: boolean;
}
const DEFAULT_FORMAT: Format = { indent: 2, eol: "\n", finalNewline: true };

function detectFormat(raw: string): Format {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/.test(raw);
  // First indented line reveals one indent unit (tabs or N spaces).
  const m = /^([ \t]+)\S/m.exec(raw);
  const indent = m ? (m[1]!.includes("\t") ? "\t" : m[1]!.length) : 2;
  return { indent, eol, finalNewline };
}

function serialize(obj: unknown, fmt: Format): string {
  let s = JSON.stringify(obj, null, fmt.indent);
  if (fmt.eol !== "\n") s = s.replace(/\n/g, fmt.eol);
  if (fmt.finalNewline) s += fmt.eol;
  return s;
}

function parseSettings(file: string): { settings: Record<string, unknown>; raw: string | null } {
  if (!existsSync(file)) return { settings: {}, raw: null };
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Never clobber a file we can't understand — bail with a clear, actionable error.
    throw new Error(
      `${file} is not valid JSON (${(e as Error).message}). Refusing to touch it — ` +
        `fix or move the file, then re-run.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed;
    throw new Error(
      `${file} contains JSON that is not an object (found ${kind}). Refusing to touch it.`,
    );
  }
  return { settings: parsed as Record<string, unknown>, raw };
}

function backup(file: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const bak = `${file}.brezia-backup-${stamp}`;
  copyFileSync(file, bak);
  return bak;
}

// Atomic write: a crash mid-write must not corrupt settings.json. Write a sibling
// temp file, then rename over the target (atomic on the same filesystem).
function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.brezia-tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export interface RunOptions {
  scope: Scope;
  cwd?: string;
  home?: string;
  now?: number;
  packContent?: string; // injectable for tests; defaults to the bundled pack
}

export function runInit(opts: RunOptions): string[] {
  const { settingsFile, policyFile } = resolvePaths(opts.scope, opts);
  const now = opts.now ?? Date.now();
  const msgs: string[] = [];

  const { settings, raw } = parseSettings(settingsFile);
  const existed = raw !== null;
  const format = raw !== null ? detectFormat(raw) : DEFAULT_FORMAT;

  if (isInstalled(settings)) {
    msgs.push(`✓ Brezia hook already present in ${settingsFile} (no change).`);
  } else {
    if (existed) msgs.push(`  backed up ${settingsFile} → ${backup(settingsFile, now)}`);
    const { settings: next } = addBreziaHook(settings);
    writeAtomic(settingsFile, serialize(next, format));
    msgs.push(
      existed
        ? `✓ added the Brezia PreToolUse hook to ${settingsFile} (existing hooks untouched).`
        : `✓ created ${settingsFile} with the Brezia PreToolUse hook.`,
    );
  }

  // Starter policy — never overwrite a policy the user already has.
  if (existsSync(policyFile)) {
    msgs.push(`  kept your existing policy at ${policyFile}.`);
  } else {
    mkdirSync(dirname(policyFile), { recursive: true });
    writeFileSync(policyFile, opts.packContent ?? readDefaultPack(), "utf8");
    msgs.push(`✓ wrote a starter policy to ${policyFile}.`);
  }

  msgs.push(``, `Next: run 'brezia up' to start the daemon, then use Claude Code as usual.`);
  return msgs;
}

export function runRemove(opts: RunOptions): string[] {
  const { settingsFile } = resolvePaths(opts.scope, opts);
  const now = opts.now ?? Date.now();

  if (!existsSync(settingsFile)) {
    return [`No settings file at ${settingsFile} — nothing to remove.`];
  }
  const { settings, raw } = parseSettings(settingsFile);
  if (!isInstalled(settings)) {
    return [`The Brezia hook is not in ${settingsFile} — nothing to remove.`];
  }

  const bak = backup(settingsFile, now);
  const { settings: next } = removeBreziaHook(settings);
  writeAtomic(settingsFile, serialize(next, detectFormat(raw!)));
  return [
    `  backed up ${settingsFile} → ${bak}`,
    `✓ removed the Brezia hook from ${settingsFile} (all other hooks/settings preserved).`,
    `  note: your policy file was left in place — delete it by hand if you want it gone.`,
  ];
}
