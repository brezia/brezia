import type { ApprovalEvent, Flags } from "@brezia/shared";

export interface HeldRequest {
  id: string;
  /** The persisted event's id — links a held response back to its stored row/chain. */
  eventId: string;
  event: ApprovalEvent;
  flags: Flags;
  createdTs: number;
  /** The tier that resolved to ask (undefined when it fell through `unmatched: ask`). */
  policyTier?: string;
}

type Resolver = (body: unknown) => void;

// In-memory registry of held hook responses awaiting a human decision. Parallel
// sessions are just concurrent entries — no queue, no worker abstraction.
// In-memory only at this phase; crash recovery (pending → deferred)
// arrives in Phase C with storage.
export class HeldRequests {
  private readonly entries = new Map<
    string,
    { req: HeldRequest; resolve: Resolver }
  >();

  add(req: HeldRequest, resolve: Resolver): void {
    this.entries.set(req.id, { req, resolve });
  }

  list(): HeldRequest[] {
    return [...this.entries.values()].map((e) => e.req);
  }

  get(id: string): HeldRequest | undefined {
    return this.entries.get(id)?.req;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  // Complete a held request with a final response body. Returns false if the id is
  // unknown or already resolved — idempotent and race-safe between a human decision
  // and the hold timeout firing.
  resolve(id: string, body: unknown): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.entries.delete(id);
    entry.resolve(body);
    return true;
  }
}
