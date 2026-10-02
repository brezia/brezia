// packages/policy — pure policy evaluation, zero I/O. Events + flags in,
// decisions out. The brezia.yaml contract (schema + types) lives in
// @brezia/shared; this package is the evaluation engine over it.
export { evaluate } from "./evaluate";
export type { EvaluationContext } from "./evaluate";
export { classifyBash, UNCLASSIFIABLE } from "./bash";
export { computeFlags } from "./flags";
export type { HistoryLookup } from "./flags";
export { aggregationKey, parseWindowMs } from "./limits";
export type { AllowCounter } from "./limits";

// Re-export the policy contract so callers import evaluation and types together.
export type {
  ApprovalEvent,
  PolicyResult,
  Policy,
  PolicyTier,
  Matcher,
  PolicyAction,
  Flags,
} from "@brezia/shared";
