import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// A tiny append-only diagnostics log for the daemon — the human-readable ops view
// (the audit chain is the tamper-evident record; this is for "what happened / why").
// File-only so it doesn't double up with the `brezia up` decision stream or the
// user-facing console messages. Best-effort: a logging failure never touches the
// decision path.
export type Logger = (msg: string) => void;

const MAX_BYTES = 5 * 1024 * 1024; // rotate once past ~5 MB so it can't grow forever

export function makeLogger(logPath?: string): Logger {
  if (logPath === undefined) return () => {}; // no path → no-op

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, `${logPath}.old`); // single rotation; keeps one prior file
    }
  } catch {
    return () => {}; // can't set up the file → log nothing rather than throw
  }

  return (msg: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // A log write must never perturb a decision — swallow.
    }
  };
}
