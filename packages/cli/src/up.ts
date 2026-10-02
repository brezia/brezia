// `brezia up` — start the daemon in the foreground, print the inbox URL + counter,
// stream a line per decision, and shut down cleanly on Ctrl-C. A PID file under
// ~/.brezia prevents a second instance.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import http from "node:http";
import { start, defaultDbPath, HOST, PORT, makeLogger } from "@brezia/daemon";
import { defaultPackPath } from "./init";
import { getJson } from "./net";

function breziaDir(): string {
  return join(homedir(), ".brezia");
}
function pidFilePath(): string {
  return join(breziaDir(), "brezia.pid");
}

// Load the first policy that exists: repo-local ./brezia.yaml, then the user's
// ~/.brezia/brezia.yaml, then the bundled default pack. Matches where init writes
// for --project and --user.
export function resolvePolicyPath(cwd = process.cwd(), home = homedir()): string {
  const candidates = [join(cwd, "brezia.yaml"), join(home, ".brezia", "brezia.yaml"), defaultPackPath()];
  return candidates.find((p) => existsSync(p)) ?? defaultPackPath();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, kills nothing
    return true;
  } catch {
    return false;
  }
}

// A PID existing is not proof it's *our* daemon: an unclean exit (crash, force-kill,
// machine sleep) can leave the PID file behind without removing it, and the OS can
// later hand that same PID to an unrelated process. Confirm the daemon is actually
// answering before refusing to start a second instance — otherwise a ghost PID
// permanently blocks every future `up` until someone finds and deletes the file by
// hand, which is exactly the kind of thing this tool exists to not require.
export async function isDaemonRunningAt(pid: number, url: string, timeoutMs = 800): Promise<boolean> {
  if (!Number.isFinite(pid) || !isAlive(pid)) return false;
  try {
    await getJson(`${url}/v1/stats`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

// Agent-supplied strings (tool names, commands, paths) are untrusted where a human
// reads them. Drop C0/C1 control characters — including the ESC that begins ANSI
// sequences — so a crafted command can't spoof, hide, or rewrite lines in this
// terminal view (the inbox's <pre> inertness rule, applied to the CLI surface).
// Filtered by char code to keep no control bytes in this source file.
export function inert(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue; // C0, DEL, C1
    out += ch;
  }
  return out;
}

// Print a compact line for each daemon decision, off the daemon's own SSE stream.
function streamDecisions(url: string): void {
  let buf = "";
  http.get(`${url}/v1/stream`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame);
        const da = /^data: (.+)$/m.exec(frame);
        if (!ev || !da) continue;
        let data: any;
        try {
          data = JSON.parse(da[1]!);
        } catch {
          continue;
        }
        const t = new Date().toLocaleTimeString();
        if (ev[1] === "request.created") {
          const arg = inert(String(data.arguments?.command ?? data.arguments?.file_path ?? "").slice(0, 64));
          const tool = inert(String(data.tool ?? "").slice(0, 24));
          const flags = Object.keys(data.flags ?? {}).filter((k) => data.flags[k]).join(",");
          process.stdout.write(`[${t}] HELD  ${tool}  ${arg}${flags ? "  ⚑ " + flags : ""}\n`);
        } else if (ev[1] === "request.resolved") {
          process.stdout.write(`[${t}] ${inert(String(data.status ?? "")).toUpperCase()}  ${inert(String(data.id ?? ""))}\n`);
        } else if (ev[1] === "policy.error" && data.error) {
          process.stdout.write(`[${t}] POLICY ERROR: ${inert(String(data.error))}\n`);
        }
      }
    });
  }).on("error", () => {
    /* the stream is a nicety; its loss must not take the daemon down */
  });
}

export async function runUp(): Promise<void> {
  const pidFile = pidFilePath();

  // Refuse a second instance only if one is actually answering on our port — PID
  // existence alone isn't enough (see isDaemonRunningAt).
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (await isDaemonRunningAt(pid, `http://${HOST}:${PORT}`)) {
      process.stderr.write(`brezia: already running (pid ${pid}). Stop that instance first.\n`);
      process.exit(1);
    }
    rmSync(pidFile, { force: true }); // stale pid file: process gone, or alive but not our daemon
  }

  const policyPath = resolvePolicyPath();
  const dbPath = defaultDbPath();
  const logPath = join(breziaDir(), "brezia.log");
  mkdirSync(breziaDir(), { recursive: true });
  const log = makeLogger(logPath);

  let app: Awaited<ReturnType<typeof start>>;
  try {
    app = await start({ policyPath, dbPath, logPath });
  } catch (e) {
    const msg = (e as Error).message;
    process.stderr.write(
      /EADDRINUSE/.test(msg)
        ? `brezia: port ${PORT} is already in use — another daemon or process has it. Stop it, or free the port.\n`
        : `brezia: failed to start — ${msg}\n`,
    );
    process.exit(1);
  }

  writeFileSync(pidFile, String(process.pid), "utf8");
  const url = `http://${HOST}:${PORT}`;
  log(`daemon up on ${url} (pid ${process.pid}, policy ${policyPath})`);

  process.stdout.write(`\nBrezia is up: ${url}   (open the inbox in your browser)\n`);
  process.stdout.write(`  policy:    ${policyPath}\n`);
  process.stdout.write(`  audit log: ${dbPath}\n`);
  process.stdout.write(`  log:       ${logPath}\n`);
  try {
    const s = await getJson(`${url}/v1/stats`);
    process.stdout.write(`  auto-resolved (7d): ${Math.round((s.ratio ?? 0) * 100)}% (${s.autoResolved}/${s.total})\n`);
  } catch {
    /* stats are a nicety */
  }
  process.stdout.write(`\nStreaming decisions (Ctrl-C to stop):\n`);
  streamDecisions(url);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("daemon shutting down");
    process.stdout.write(`\nbrezia: shutting down…\n`);
    try {
      await app.close();
    } catch {
      /* closing best-effort */
    }
    rmSync(pidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The listening server keeps the event loop alive until a signal arrives.
}
