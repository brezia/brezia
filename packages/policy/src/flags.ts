import { looksLikeSecret, type ApprovalEvent, type Flags } from "@brezia/shared";

// History lookup for first-time detection. Supplied as an input (in-memory this
// phase, SQLite next) so the policy layer stays pure — it never touches storage.
export interface HistoryLookup {
  hasSeenTool(tool: string): boolean;
  hasSeenCommand(command: string): boolean;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

// Compute anomaly/context flags for an event, before policy runs. Pure. Secrets
// detection scans every string in the arguments; first-time flags require a
// history lookup (omitted → those flags are simply not set).
export function computeFlags(event: ApprovalEvent, history?: HistoryLookup): Flags {
  const flags: Flags = {};

  const strings: string[] = [];
  collectStrings(event.arguments, strings);
  if (strings.some((s) => looksLikeSecret(s))) flags.secrets_pattern = true;

  if (history !== undefined) {
    if (!history.hasSeenTool(event.tool)) flags.first_time_tool = true;
    const command = event.arguments["command"];
    if (typeof command === "string" && !history.hasSeenCommand(command)) {
      flags.first_time_command = true;
    }
  }

  return flags;
}
