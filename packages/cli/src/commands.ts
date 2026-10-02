import type { StorageAdapter } from "@brezia/shared";
import { auditToJson, auditToCsv } from "./audit";

// Command bodies kept free of process I/O (argv, exit, file writes) so they can be
// unit-tested against an in-memory storage. index.ts wires argv → storage → these.

export function runVerify(storage: StorageAdapter): {
  ok: boolean;
  count: number;
  output: string;
} {
  const count = storage.allAuditEntries().length;
  const ok = storage.verifyAuditChain();
  const output = ok
    ? `✓ audit chain verified — ${count} ${count === 1 ? "entry" : "entries"} intact`
    : `✗ audit chain FAILED verification — the log has been altered or corrupted.\n` +
      `  The hash chain does not hold across its ${count} ${count === 1 ? "entry" : "entries"}.`;
  return { ok, count, output };
}

export function runExport(storage: StorageAdapter, format: "json" | "csv"): string {
  const rows = storage.allAuditEntries();
  return format === "csv" ? auditToCsv(rows) : auditToJson(rows);
}
