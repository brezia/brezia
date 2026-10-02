import type { AuditRow } from "@brezia/shared";

// Export the audit log (decisions.md 007 — the evidence story). JSON keeps the
// parsed entry inline so a reader sees the semantic record plus its chain linkage;
// CSV flattens to one row per entry with the raw entry_json preserved verbatim so
// the export can itself be re-verified.

export function auditToJson(rows: AuditRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      prevHash: r.prevHash,
      hash: r.hash,
      entry: JSON.parse(r.entryJson),
    })),
    null,
    2,
  );
}

const CSV_COLUMNS = ["seq", "ts", "kind", "prev_hash", "hash", "entry_json"] as const;

// RFC-4180 field: quote always, double any embedded quote. Quoting unconditionally
// keeps commas, newlines, and quotes inside agent-supplied entry_json inert.
function csvField(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function auditToCsv(rows: AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    let kind = "";
    try {
      kind = String((JSON.parse(r.entryJson) as { kind?: unknown }).kind ?? "");
    } catch {
      kind = "";
    }
    lines.push(
      [
        csvField(r.seq),
        csvField(r.ts),
        csvField(kind),
        csvField(r.prevHash),
        csvField(r.hash),
        csvField(r.entryJson),
      ].join(","),
    );
  }
  // Trailing newline so the file ends cleanly and appends are line-aligned.
  return lines.join("\n") + "\n";
}
