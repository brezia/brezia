import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { resolvePolicyPath, inert, isDaemonRunningAt } from "./up";
import { defaultPackPath, runInit } from "./init";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "brezia-up-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("resolvePolicyPath — where `up` loads the policy from", () => {
  it("prefers a repo-local ./brezia.yaml", () => {
    const cwd = tmp();
    const home = tmp();
    writeFileSync(join(cwd, "brezia.yaml"), "version: 1\ndefaults:\n  unmatched: ask\ntiers: []\n");
    expect(resolvePolicyPath(cwd, home)).toBe(join(cwd, "brezia.yaml"));
  });

  it("falls back to ~/.brezia/brezia.yaml when there is no repo-local policy", () => {
    const cwd = tmp();
    const home = tmp();
    mkdirSync(join(home, ".brezia"), { recursive: true });
    writeFileSync(join(home, ".brezia", "brezia.yaml"), "version: 1\ndefaults:\n  unmatched: ask\ntiers: []\n");
    expect(resolvePolicyPath(cwd, home)).toBe(join(home, ".brezia", "brezia.yaml"));
  });

  it("falls back to the bundled default pack when neither exists", () => {
    expect(resolvePolicyPath(tmp(), tmp())).toBe(defaultPackPath());
  });

  it("finds the policy that `init --project` just wrote", () => {
    const cwd = tmp();
    runInit({ scope: "project", cwd, now: 0, packContent: "version: 1\ndefaults:\n  unmatched: ask\ntiers: []\n" });
    expect(resolvePolicyPath(cwd, tmp())).toBe(join(cwd, "brezia.yaml"));
  });
});

describe("isDaemonRunningAt — the stale-PID-file check", () => {
  it("is false when the PID doesn't exist at all (process gone, no network call needed)", async () => {
    // Spawn a trivial child and wait for it to exit — its PID is then guaranteed free.
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(await isDaemonRunningAt(child.pid!, "http://127.0.0.1:1")).toBe(false);
  });

  it("is false when the PID exists but nothing answers at the URL — the exact bug: an unclean exit leaves the PID file behind, and the OS later hands that PID to an unrelated process", async () => {
    // process.pid is guaranteed alive (it's us); pick a port nothing is bound to.
    expect(await isDaemonRunningAt(process.pid, "http://127.0.0.1:1", 200)).toBe(false);
  });

  it("is true only when the PID is alive AND the URL actually answers", async () => {
    const server: Server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ windowDays: 7, total: 0, autoResolved: 0, ratio: 0 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await isDaemonRunningAt(process.pid, `http://127.0.0.1:${port}`)).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("inert — strips control/ANSI chars from agent strings in the up stream", () => {
  it("removes ESC/ANSI sequences and other control chars, keeps printable text", () => {
    const ESC = String.fromCharCode(0x1b);
    const ansi = `${ESC}[31mrm -rf /${ESC}[0m`; // ANSI-colored command
    expect(inert(ansi)).toBe("[31mrm -rf /[0m"); // ESC bytes stripped, text kept
    const ctl = "a" + String.fromCharCode(0) + "b" + String.fromCharCode(7) + "cd" + String.fromCharCode(0x7f);
    expect(inert(ctl)).toBe("abcd"); // NUL, BEL, DEL dropped
    expect(inert("git status")).toBe("git status"); // ordinary text untouched
  });
});
