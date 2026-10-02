// End-to-end smoke test — runs the REAL loop against a real listening daemon over
// HTTP (not the in-process `inject` the vitest suite uses). Starts a daemon on an
// ephemeral loopback port with the default policy pack and a throwaway DB, drives
// every core path, verifies the audit chain, and exits non-zero on any failure.
//
//   npm run build && npm run smoke     (imports the built @brezia/daemon)
//
// Complements the unit/integration suite; this is the "does the whole thing actually
// work over the wire" check for CI and pre-release.
import { start, SqliteStorage } from "@brezia/daemon";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const policyPath = fileURLToPath(new URL("../policy-packs/claude-code-default.yaml", import.meta.url));
const dbDir = mkdtempSync(join(tmpdir(), "brezia-smoke-"));
const dbPath = join(dbDir, "smoke.db");

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); failed++; }
}

function request(base, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(`${base}${path}`, {
      method,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {},
    }, (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j; try { j = b ? JSON.parse(b) : undefined; } catch { j = undefined; } resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject);
    data ? req.end(data) : req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision;

function hook(tool, input, id) {
  return { session_id: "smoke", transcript_path: "/t", cwd: "/repo", permission_mode: "default",
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: id };
}
async function firstPending(base) {
  for (let i = 0; i < 200; i++) {
    const r = await request(base, "GET", "/v1/requests");
    if (Array.isArray(r.json) && r.json.length > 0) return r.json[0].id;
    await sleep(10);
  }
  throw new Error("no pending request appeared");
}

console.log("brezia end-to-end smoke\n");
const app = await start({ port: 0, dbPath, policyPath, holdTimeoutMs: 8000 });
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`daemon up on ${base} (policy: default pack, db: ${dbPath})\n`);

try {
  // 1. Read auto-allows via the allow-reads tier.
  const allow = await request(base, "POST", "/v1/hook", hook("Read", { file_path: "/repo/README.md" }, "toolu_s1"));
  check("Read → auto-allowed", decisionOf(allow) === "allow", `got ${decisionOf(allow)}`);

  // 2. A Write holds (unmatched) → approve → the held call completes with allow.
  const writeP = request(base, "POST", "/v1/hook", hook("Write", { file_path: "/repo/x.txt", content: "y" }, "toolu_s2"));
  const id2 = await firstPending(base);
  const dec2 = await request(base, "POST", `/v1/requests/${id2}/decision`, { action: "approve", reason: "looks fine" });
  check("decision endpoint returns 200", dec2.status === 200, `got ${dec2.status}`);
  const write = await writeP;
  check("held Write → approve → allow", decisionOf(write) === "allow", `got ${decisionOf(write)}`);

  // 3. A risky Bash holds → deny with reason → the held call completes with deny + reason.
  const bashP = request(base, "POST", "/v1/hook", hook("Bash", { command: "rm -rf build && deploy" }, "toolu_s3"));
  const id3 = await firstPending(base);
  await request(base, "POST", `/v1/requests/${id3}/decision`, { action: "deny", reason: "not in a smoke test" });
  const bash = await bashP;
  check("held Bash → deny → deny", decisionOf(bash) === "deny", `got ${decisionOf(bash)}`);
  check("deny reason surfaced to the agent", (bash.json?.hookSpecificOutput?.permissionDecisionReason || "").includes("not in a smoke test"));

  // 4. Idempotency: replaying a tool_use_id returns the original outcome.
  const replay = await request(base, "POST", "/v1/hook", hook("Read", { file_path: "/repo/README.md" }, "toolu_s1"));
  check("idempotency replay → original allow", decisionOf(replay) === "allow", `got ${decisionOf(replay)}`);

  // 5. Never-brick: a malformed body resolves to 200 + no decision (native flow).
  const malformed = await request(base, "POST", "/v1/hook", "{ not valid json");
  check("malformed body → 200 no-decision", malformed.status === 200 && malformed.json && Object.keys(malformed.json).length === 0);

  // 6. Stats reflect exactly the 3 events (Read + Write + Bash). The idempotency
  //    replay and the malformed body correctly add none — proving replay dedups.
  const stats = await request(base, "GET", "/v1/stats");
  check("stats: exactly 3 events (replay + malformed added none)", stats.json?.total === 3, `total=${stats.json?.total}`);

  // 7. The audit chain verifies end to end (a second connection reads the WAL db).
  const store = new SqliteStorage(dbPath);
  check("audit chain verifies", store.verifyAuditChain() === true);
  const chainLen = store.allAuditEntries().length;
  console.log(`\n  (audit chain: ${chainLen} entries)`);
  store.close();
} catch (e) {
  check(`no unexpected error`, false, e.message);
} finally {
  await app.close();
  rmSync(dbDir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "SMOKE PASS ✓" : "SMOKE FAIL ✗"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
