import {
  GENESIS_HASH,
  type AuditEntry,
  type Decision,
  type StorageAdapter,
} from "@brezia/shared";

// Builds and links audit entries over a StorageAdapter. Owns entry construction
// and prev-hash sequencing (decisions.md 007); the adapter owns only the raw
// append + hash. Every append is one synchronous better-sqlite3 call preceded by
// a synchronous read of the last hash — with no await between, the read+append is
// atomic against other requests, so the chain never interleaves.
export class AuditChain {
  constructor(private readonly storage: StorageAdapter) {}

  private append(entry: AuditEntry): void {
    const prevHash = this.storage.getLastAuditEntry()?.hash ?? GENESIS_HASH;
    // entry_json is stored verbatim and re-hashed on verify — never re-serialized.
    this.storage.appendAuditEntry(JSON.stringify(entry), prevHash);
  }

  eventReceived(e: {
    eventId: string;
    source: string;
    session: string;
    tool: string;
    idempotencyKey?: string;
  }): void {
    this.append({ kind: "event_received", ts: Date.now(), ...e });
  }

  policyDecision(e: {
    eventId: string;
    decision: Decision;
    tierName?: string;
    reason?: string;
  }): void {
    this.append({ kind: "policy_decision", ts: Date.now(), ...e });
  }

  humanDecision(e: {
    requestId: string;
    eventId: string;
    status: "approved" | "denied";
    reason?: string;
  }): void {
    this.append({ kind: "human_decision", ts: Date.now(), ...e });
  }

  deferral(e: {
    requestId: string;
    eventId: string;
    cause: "hold_timeout" | "crash_recovery";
  }): void {
    this.append({ kind: "deferral", ts: Date.now(), ...e });
  }

  policyReload(ok: boolean, error?: string): void {
    this.append({ kind: "policy_reload", ts: Date.now(), ok, error });
  }
}
