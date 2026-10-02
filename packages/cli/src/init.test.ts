import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, runRemove, resolvePaths } from "./init";
import { BREZIA_HOOK_URL } from "./settings";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "brezia-init-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const PACK = "version: 1\ndefaults:\n  unmatched: ask\ntiers: []\n";
const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

// A settings.json that already contains someone else's hook + unrelated settings.
const FOREIGN = {
  permissions: { allow: ["Bash(git status:*)"] },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }] },
};
function writeSettings(cwd: string, obj: unknown): string {
  const file = join(cwd, ".claude", "settings.json");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return file;
}

describe("runInit — project scope", () => {
  it("creates settings + starter policy when nothing exists", () => {
    const cwd = tmp();
    runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    const { settingsFile, policyFile } = resolvePaths("project", { cwd });
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].url).toBe(BREZIA_HOOK_URL);
    expect(readFileSync(policyFile, "utf8")).toBe(PACK);
    // no backup — there was no prior file
    expect(readdirSync(join(cwd, ".claude")).some((f) => f.includes("backup"))).toBe(false);
  });

  it("adds our hook and backs up, without disturbing foreign hooks/settings", () => {
    const cwd = tmp();
    const file = writeSettings(cwd, FOREIGN);
    const before = readFileSync(file, "utf8");
    runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    const settings = JSON.parse(readFileSync(file, "utf8"));
    expect(settings.permissions).toEqual(FOREIGN.permissions);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("audit.sh"); // foreign kept
    expect(settings.hooks.PreToolUse.at(-1).hooks[0].url).toBe(BREZIA_HOOK_URL); // ours appended
    // a timestamped backup of the original exists, byte-identical to the original
    const bak = readdirSync(join(cwd, ".claude")).find((f) => f.includes("brezia-backup"));
    expect(bak).toBeDefined();
    expect(readFileSync(join(cwd, ".claude", bak!), "utf8")).toBe(before);
  });

  it("is idempotent — a second init makes no change and no second backup", () => {
    const cwd = tmp();
    writeSettings(cwd, FOREIGN);
    runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    const msgs = runInit({ scope: "project", cwd, now: NOW + 1000, packContent: PACK });
    expect(msgs.some((m) => m.includes("already present"))).toBe(true);
    const backups = readdirSync(join(cwd, ".claude")).filter((f) => f.includes("brezia-backup"));
    expect(backups).toHaveLength(1); // only the first init backed up
  });

  it("does not overwrite an existing policy file", () => {
    const cwd = tmp();
    const { policyFile } = resolvePaths("project", { cwd });
    writeFileSync(policyFile, "version: 1\n# my custom policy\ntiers: []\n", "utf8");
    const msgs = runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    expect(readFileSync(policyFile, "utf8")).toContain("my custom policy");
    expect(msgs.some((m) => m.includes("kept your existing policy"))).toBe(true);
  });

  it("refuses to touch a settings file that is not valid JSON", () => {
    const cwd = tmp();
    const file = join(cwd, ".claude", "settings.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(file, "{ this is not json", "utf8");
    expect(() => runInit({ scope: "project", cwd, now: NOW, packContent: PACK })).toThrow(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ this is not json"); // untouched
  });
});

describe("runRemove — surgical", () => {
  it("removes only our hook and preserves everything else", () => {
    const cwd = tmp();
    const file = writeSettings(cwd, FOREIGN);
    runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    runRemove({ scope: "project", cwd, now: NOW + 5000 });
    const settings = JSON.parse(readFileSync(file, "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("audit.sh");
    expect(settings.hooks.PreToolUse.some((g: any) => g.hooks.some((h: any) => h.url === BREZIA_HOOK_URL))).toBe(false);
  });

  it("init then remove restores the settings file BYTE-IDENTICALLY", () => {
    const cwd = tmp();
    const file = writeSettings(cwd, FOREIGN);
    const before = readFileSync(file, "utf8");
    runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    runRemove({ scope: "project", cwd, now: NOW + 5000 });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("no-op when the hook is not installed", () => {
    const cwd = tmp();
    writeSettings(cwd, FOREIGN);
    const msgs = runRemove({ scope: "project", cwd, now: NOW });
    expect(msgs.some((m) => m.includes("nothing to remove"))).toBe(true);
  });

  it("no-op when there is no settings file", () => {
    const msgs = runRemove({ scope: "project", cwd: tmp(), now: NOW });
    expect(msgs.some((m) => m.includes("nothing to remove"))).toBe(true);
  });
});

describe("preserves the original file's formatting (byte-identical for non-canonical files)", () => {
  function roundTrip(cwd: string, raw: string): string {
    const file = join(cwd, ".claude", "settings.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(file, raw, "utf8");
    runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    runRemove({ scope: "project", cwd, now: NOW + 5000 });
    return readFileSync(file, "utf8");
  }

  it("4-space indent + CRLF + trailing newline restores byte-identical", () => {
    const raw = JSON.stringify(FOREIGN, null, 4).replace(/\n/g, "\r\n") + "\r\n";
    expect(roundTrip(tmp(), raw)).toBe(raw);
  });

  it("tab indent + LF + no trailing newline restores byte-identical", () => {
    const raw = JSON.stringify(FOREIGN, null, "\t"); // no trailing newline
    expect(roundTrip(tmp(), raw)).toBe(raw);
  });

  it("init preserves indent+EOL when it edits (adds our hook keeping the file's style)", () => {
    const cwd = tmp();
    const file = join(cwd, ".claude", "settings.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify(FOREIGN, null, 4).replace(/\n/g, "\r\n") + "\r\n", "utf8");
    runInit({ scope: "project", cwd, now: NOW, packContent: PACK });
    const out = readFileSync(file, "utf8");
    expect(out.includes("\r\n")).toBe(true); // CRLF kept
    expect(out.includes('\r\n    "hooks"')).toBe(true); // 4-space depth-1 indent kept
    expect(out.includes(BREZIA_HOOK_URL)).toBe(true); // and our hook was added
  });
});
