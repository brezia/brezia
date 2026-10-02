import type { AggregationDim, StorageAdapter } from "@brezia/shared";
import type { HistoryLookup, AllowCounter } from "@brezia/policy";

// First-time history, derived from the persisted events table (Option A — no
// in-memory shadow). "Seen" = a prior event exists; the current event is inserted
// only after flags are computed, so first-time status is always vs. the past.
export class SqliteHistory implements HistoryLookup {
  constructor(private readonly storage: StorageAdapter) {}

  hasSeenTool(tool: string): boolean {
    return this.storage.hasSeenTool(tool);
  }

  hasSeenCommand(command: string): boolean {
    return this.storage.hasSeenCommand(command);
  }
}

const DIMS = new Set<string>(["tool", "session", "agent"]);

// A count that always trips any positive `max_asks_auto_allowed` ceiling, so an
// unresolvable key registers as breached → the would-be allow escalates to ask.
const FORCE_BREACH = Number.MAX_SAFE_INTEGER;

// Aggregation counter, derived from the events table. The policy layer supplies an
// opaque key ("tool:X" | "session:Y" | "agent:Z" from aggregationKey); we split it
// back into a dimension + value and count auto-allowed events in the window.
//
// A malformed key or a dimension we don't recognize is an UNEVALUABLE limit. It
// must fail toward ask, never toward allow: because a count is consumed as "breach
// when count >= max", returning 0 would silently disable the cap and let the allow
// through. So we return a forced-breach sentinel — the limit escalates to ask. This
// is defensive against `brezia.yaml`'s additive-only `per` dimension outgrowing this
// set without a matching update here.
export class SqliteAllowCounter implements AllowCounter {
  constructor(private readonly storage: StorageAdapter) {}

  countInWindow(key: string, windowMs: number, now: number): number {
    const i = key.indexOf(":");
    if (i < 0) return FORCE_BREACH;
    const dim = key.slice(0, i);
    const value = key.slice(i + 1);
    if (!DIMS.has(dim)) return FORCE_BREACH;
    return this.storage.countAutoAllows(dim as AggregationDim, value, now - windowMs);
  }
}
