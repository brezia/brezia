import type { ApprovalEvent, Policy, PolicyLimit } from "@brezia/shared";

// Counter of prior auto-allows, supplied as an input so the policy layer stays
// pure (in-memory this phase, SQLite next). Answers: how many auto-allows were
// recorded for `key` within the last `windowMs`, as of `now`.
export interface AllowCounter {
  countInWindow(key: string, windowMs: number, now: number): number;
}

const WINDOW_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseWindowMs(window: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(window);
  if (m === null) return null;
  return Number(m[1]) * WINDOW_UNITS[m[2]!]!;
}

// Aggregation key for a limit dimension. `agent` uses the owner when present,
// else the session — the hook has no distinct agent id for the main session, so
// session is the v0 proxy.
export function aggregationKey(per: PolicyLimit["per"], event: ApprovalEvent): string {
  switch (per) {
    case "tool":
      return `tool:${event.tool}`;
    case "session":
      return `session:${event.session}`;
    case "agent":
      return `agent:${event.context?.owner ?? event.session}`;
  }
}

// The first breached limit's descriptor, or null. A limit is breached when the
// count of prior auto-allows for its key within its window has already reached
// max_asks_auto_allowed — the next would-be allow must escalate to ask. This is
// the anti-splitting rule (many small allows that collectively shouldn't pass).
export function breachedLimit(
  policy: Policy,
  event: ApprovalEvent,
  now: number,
  counter: AllowCounter,
): string | null {
  for (const limit of policy.limits ?? []) {
    const windowMs = parseWindowMs(limit.window);
    if (windowMs === null) continue; // schema guards the format; skip if somehow bad
    const key = aggregationKey(limit.per, event);
    if (counter.countInWindow(key, windowMs, now) >= limit.max_asks_auto_allowed) {
      return `${limit.per}/${limit.window}`;
    }
  }
  return null;
}
