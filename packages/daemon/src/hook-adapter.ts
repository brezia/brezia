import type { ApprovalEvent, HookPayload, PolicyResult } from "@brezia/shared";

// Adapter at the ingestion edge: map a raw Claude Code hook payload onto the
// Events API contract (ApprovalEvent). The Events API stays the contract; this
// mapping is the only Claude-Code-specific code in the pipeline. tool_use_id is
// the idempotency key (confirmed present in A1 fixtures — decisions.md 009).
export function hookPayloadToEvent(payload: HookPayload): ApprovalEvent {
  return {
    source: "claude-code-http",
    session: payload.session_id,
    tool: payload.tool_name,
    arguments: payload.tool_input,
    context: {
      cwd: payload.cwd,
      worktree: payload.worktree,
    },
    idempotencyKey: payload.tool_use_id,
  };
}

// The hook-protocol decision response — same shape for HTTP hooks and the command
// shim (verified against the docs). We only ever emit allow or deny; a pending
// request is HELD (no response) until a human decides, and a hold timeout returns
// NO_DECISION instead.
export type EmittedDecision = "allow" | "deny";

export interface HookDecisionResponse {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: EmittedDecision;
    permissionDecisionReason: string;
  };
}

export function hookDecision(
  decision: EmittedDecision,
  reason: string,
): HookDecisionResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

// No decision → 2xx + empty body → Claude Code proceeds with its native flow.
// This is the never-brick response: ingestion errors and hold timeouts return it.
export const NO_DECISION: Record<string, never> = {};

export function reasonForPolicy(result: PolicyResult): string {
  if (result.reason) return `brezia: ${result.reason}`;
  if (result.tierName) return `brezia: tier '${result.tierName}'`;
  return "brezia";
}
