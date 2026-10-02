import type { StorageAdapter, StoredEvent } from "@brezia/shared";
import { hookDecision, NO_DECISION } from "./hook-adapter";

// Reconstruct the original hook response for a replayed idempotency key, so a
// retried tool_use_id returns the same outcome it got the first time (the
// idempotency rule). The DECISION is always faithful; the reason string is
// reconstructed (auto decisions from the recorded tier, human decisions from the
// request row) and may read slightly more generic than the original.
//
// If the original event was held (ask) and is not yet resolved — or was deferred —
// there is no terminal outcome to replay, so we return no-decision (native flow).
// A duplicate mid-hold is a pathological retry; never-brick beats guessing.
export function replayResponse(
  storage: StorageAdapter,
  stored: StoredEvent,
): unknown {
  const autoReason = stored.policyTier ? `brezia: tier '${stored.policyTier}'` : "brezia";

  switch (stored.decision) {
    case "auto_allowed":
      return hookDecision("allow", autoReason);
    case "auto_denied":
      return hookDecision("deny", autoReason);
    case "ask": {
      const request = storage.getRequestByEventId(stored.id);
      if (request?.status === "approved") {
        return hookDecision("allow", `brezia: ${request.reason ?? "approved"}`);
      }
      if (request?.status === "denied") {
        return hookDecision("deny", `brezia: ${request.reason ?? "denied"}`);
      }
      return NO_DECISION; // pending / deferred / expired / unknown → native flow
    }
    default:
      return NO_DECISION;
  }
}
