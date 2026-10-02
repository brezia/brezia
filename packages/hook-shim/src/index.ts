// brezia-shim — fallback command hook.
//
// Protocol: read the Claude Code PreToolUse JSON from stdin, POST it to the daemon,
// write the decision JSON to stdout, exit 0.
//
// On ANY error — daemon down, timeout, parse failure, anything — print nothing to
// stdout and exit 0. Exit 0 with no stdout is "no decision", so the runtime's native
// permission flow proceeds untouched. This is the never-brick guarantee
// (decisions.md 006). The empty catch is deliberate, not missing error handling.
//
// Only used if the A2 spike disqualifies HTTP hooks. Phase A verifies the exact
// field names and timeout against the installed version — nothing here is coded
// from memory beyond the transport shape.

import * as http from "node:http";

const DAEMON_HOST = "127.0.0.1";
const DAEMON_PORT = 4747;
const HOOK_PATH = "/v1/hook";
// Under the installed hook timeout so the shim resolves before the runtime kills it.
// `brezia init` installs a 300s hook timeout; 290s fires just under it.
const REQUEST_TIMEOUT_MS = 290_000;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function postToDaemon(body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: DAEMON_HOST,
        port: DAEMON_PORT,
        path: HOOK_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("brezia-shim: request timed out"));
    });
    req.on("error", reject);
    req.write(body, "utf8");
    req.end();
  });
}

async function main(): Promise<void> {
  try {
    const rawStdin = await readStdin();
    JSON.parse(rawStdin); // malformed stdin → no decision
    const rawResponse = await postToDaemon(rawStdin);
    JSON.parse(rawResponse); // corrupt response → no decision
    process.stdout.write(rawResponse, "utf8");
  } catch {
    // No decision → native flow proceeds. Never write to stdout on error.
  }
  process.exit(0);
}

void main();
