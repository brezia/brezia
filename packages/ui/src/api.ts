import type { Card, Stats } from "./types";

// Same-origin fetch helpers — the daemon serves this bundle, so relative URLs hit
// the API on 127.0.0.1 with no CORS. Thin I/O; the interesting logic is the reducer.

export async function fetchRequests(): Promise<Card[]> {
  const res = await fetch("/v1/requests");
  return (await res.json()) as Card[];
}

export async function fetchStats(): Promise<Stats> {
  const res = await fetch("/v1/stats");
  return (await res.json()) as Stats;
}

export async function postDecision(
  id: string,
  action: "approve" | "deny",
  reason?: string,
): Promise<void> {
  await fetch(`/v1/requests/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, reason }),
  });
}

export interface StreamHandlers {
  onCreated: (card: Card) => void;
  onResolved: (id: string) => void;
  onStats: (stats: Stats) => void;
  onPolicyError: (error: string | null) => void;
  onOpen: () => void;
  onError: () => void;
}

// Subscribe to the live feed. Returns an unsubscribe. EventSource auto-reconnects,
// so onError → "connecting" is transient, not fatal.
export function subscribe(h: StreamHandlers): () => void {
  const es = new EventSource("/v1/stream");
  es.addEventListener("request.created", (e) => h.onCreated(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("request.resolved", (e) => h.onResolved(JSON.parse((e as MessageEvent).data).id));
  es.addEventListener("stats.updated", (e) => h.onStats(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("policy.error", (e) => h.onPolicyError(JSON.parse((e as MessageEvent).data).error));
  es.onopen = () => h.onOpen();
  es.onerror = () => h.onError();
  return () => es.close();
}
