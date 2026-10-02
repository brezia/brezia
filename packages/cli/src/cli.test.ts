import { describe, it, expect, afterEach } from "vitest";
import { SqliteStorage } from "@brezia/daemon";
import { GENESIS_HASH } from "@brezia/shared";
import { auditToCsv, auditToJson } from "./audit";
import { runVerify, runExport } from "./commands";

const stores: SqliteStorage[] = [];
function chained(entries: string[]): SqliteStorage {
  const s = new SqliteStorage(":memory:");
  stores.push(s);
  let prev = GENESIS_HASH;
  for (const e of entries) {
    prev = s.appendAuditEntry(e, prev).hash;
  }
  return s;
}
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

describe("brezia verify", () => {
  it("reports an intact chain with the entry count", () => {
    const s = chained(['{"kind":"event_received","ts":1}', '{"kind":"policy_decision","ts":2}']);
    const { ok, count, output } = runVerify(s);
    expect(ok).toBe(true);
    expect(count).toBe(2);
    expect(output).toContain("verified");
    expect(output).toContain("2 entries");
  });

  it("reports a broken chain as failed", () => {
    const s = new SqliteStorage(":memory:");
    stores.push(s);
    s.appendAuditEntry('{"a":1}', GENESIS_HASH);
    s.appendAuditEntry('{"a":2}', "wrong-prev-hash"); // breaks the link
    const { ok, output } = runVerify(s);
    expect(ok).toBe(false);
    expect(output).toContain("FAILED");
  });

  it("an empty chain verifies (vacuously) with a singular-entry message", () => {
    const s = new SqliteStorage(":memory:");
    stores.push(s);
    const { ok, count } = runVerify(s);
    expect(ok).toBe(true);
    expect(count).toBe(0);
  });
});

describe("brezia export", () => {
  it("emits JSON with the parsed entry and chain linkage", () => {
    const s = chained(['{"kind":"policy_reload","ts":5,"ok":true}']);
    const json = JSON.parse(runExport(s, "json"));
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ seq: 1, prevHash: GENESIS_HASH, entry: { kind: "policy_reload", ok: true } });
    expect(json[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits CSV with a header and one row per entry", () => {
    const s = chained(['{"kind":"event_received","ts":1}', '{"kind":"policy_decision","ts":2}']);
    const csv = runExport(s, "csv");
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("seq,ts,kind,prev_hash,hash,entry_json");
    expect(lines).toHaveLength(3); // header + 2
    expect(lines[1]).toContain('"event_received"');
  });
});

describe("CSV escaping keeps agent-supplied strings inert", () => {
  it("doubles quotes and keeps commas/newlines inside a single field", () => {
    // A raw entry_json carrying a comma, a double-quote, AND a real newline —
    // exactly the characters that would otherwise forge new CSV columns/rows.
    const raw = 'a,"b"\nc';
    const s = chained([raw]);
    const csv = auditToCsv(s.allAuditEntries());

    const header = csv.split("\n")[0];
    expect(header).toBe("seq,ts,kind,prev_hash,hash,entry_json");
    // The inner quote is doubled and the whole payload — comma, quotes, and the
    // embedded newline — sits inside one quoted field, so it forges no new column
    // or row. This exact substring is only producible by correct RFC-4180 quoting.
    expect(csv).toContain('"a,""b""\nc"');
  });

  it("auditToJson round-trips the entries array", () => {
    const s = chained(['{"kind":"policy_decision","ts":9,"decision":"ask"}']);
    expect(auditToJson(s.allAuditEntries())).toContain('"decision": "ask"');
  });
});
