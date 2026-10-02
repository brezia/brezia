import type { ServerResponse } from "node:http";

// Minimal Server-Sent Events hub. The inbox opens one GET /v1/stream; the daemon
// pushes deltas (request.created/resolved, stats.updated, policy.error). No new
// dependency — SSE is a text framing over the raw response. Parallel inboxes are
// just multiple clients in the set; a write to a dead socket drops that client.
//
// The event NAMES are an internal daemon↔inbox contract (not the versioned Events
// API); the inbox's EventSource listens for exactly these.
export type SseEvent =
  | "request.created"
  | "request.resolved"
  | "stats.updated"
  | "policy.error";

export class SseHub {
  private readonly clients = new Set<ServerResponse>();

  add(res: ServerResponse): void {
    this.clients.add(res);
  }

  remove(res: ServerResponse): void {
    this.clients.delete(res);
  }

  count(): number {
    return this.clients.size;
  }

  // Broadcast one event to every connected inbox. This method NEVER throws into its
  // caller — callers sit on the decision path, and a UI concern must not perturb a
  // decision. A non-serializable payload is skipped; a failed write means the socket
  // is gone, so that client is dropped.
  broadcast(event: SseEvent, data: unknown): void {
    let frame: string;
    try {
      frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch {
      return; // payload could not be serialized — skip rather than throw
    }
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  // End every stream (daemon shutdown).
  closeAll(): void {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }
}
