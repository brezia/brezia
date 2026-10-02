// The inbox's view of a held request — the exact shape the daemon's /v1/requests
// and the request.created SSE event send. Agent-supplied fields (tool, arguments,
// cwd) are UNTRUSTED and must always render as inert text (see Card).
export interface Card {
  id: string;
  session: string;
  tool: string;
  arguments: Record<string, unknown>;
  flags: Record<string, boolean>;
  createdTs: number;
  cwd?: string;
  worktree?: string;
  policyTier?: string;
}

export interface Stats {
  windowDays: number;
  total: number;
  autoResolved: number;
  ratio: number;
}

export type Connection = "connecting" | "open" | "closed";
