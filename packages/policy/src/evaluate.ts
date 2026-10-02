import picomatch from "picomatch";
import type {
  ApprovalEvent,
  Flags,
  Matcher,
  Policy,
  PolicyResult,
  PolicyTier,
} from "@brezia/shared";
import { classifyBash, UNCLASSIFIABLE } from "./bash";
import { breachedLimit, type AllowCounter } from "./limits";

// Tool matching: exact string or picomatch glob. Tool names contain no "/".
function matchTool(pattern: string, tool: string): boolean {
  return pattern === tool || picomatch(pattern)(tool);
}

// Argument matching per key. Values are picomatch globs by default; a value
// prefixed "re:" is a regular expression (regex only where declared).
// A missing or non-string argument never matches — fail toward not-allowing.
function matchArg(pattern: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (pattern.startsWith("re:")) {
    try {
      return new RegExp(pattern.slice(3)).test(value);
    } catch {
      return false; // a malformed regex never matches
    }
  }
  return picomatch(pattern)(value);
}

function matchArgs(
  patterns: Record<string, string>,
  args: Record<string, unknown>,
): boolean {
  for (const [key, pattern] of Object.entries(patterns)) {
    if (!matchArg(pattern, args[key])) return false;
  }
  return true;
}

// Flags: every listed flag must be active (AND) — decided policy semantics.
function matchFlags(required: string[], flags: Flags): boolean {
  const active = flags as Record<string, boolean | undefined>;
  return required.every((f) => active[f] === true);
}

// Bash: the command must classify into one of the listed classes. An
// unclassifiable command (compound/expansion/redirect/parse-failure/unknown)
// never matches, even if "unclassifiable" is somehow listed — the parser fails
// toward ask, never allow.
function matchBash(classes: string[], args: Record<string, unknown>): boolean {
  const klass = classifyBash(args.command);
  if (klass === UNCLASSIFIABLE) return false;
  return classes.includes(klass);
}

// A matcher matches when ALL its present conditions hold. An empty matcher ({})
// matches everything — permitted but discouraged.
function matchesMatcher(
  matcher: Matcher,
  event: ApprovalEvent,
  flags: Flags,
): boolean {
  if (matcher.tool !== undefined && !matchTool(matcher.tool, event.tool)) {
    return false;
  }
  if (matcher.args !== undefined && !matchArgs(matcher.args, event.arguments)) {
    return false;
  }
  if (matcher.bash !== undefined && !matchBash(matcher.bash, event.arguments)) {
    return false;
  }
  if (matcher.flags !== undefined && !matchFlags(matcher.flags, flags)) {
    return false;
  }
  return true;
}

// A tier matches when ANY of its matchers matches (OR).
function matchesTier(
  tier: PolicyTier,
  event: ApprovalEvent,
  flags: Flags,
): boolean {
  return tier.match.some((m) => matchesMatcher(m, event, flags));
}

export interface EvaluationContext {
  /** Flags computed before policy runs. Matchers may require them. */
  flags?: Flags;
  /** Clock as an input (keeps evaluate pure). Required to enforce aggregation limits. */
  now?: number;
  /** Prior-auto-allow counter for aggregation limits. Required to enforce them. */
  allowCounter?: AllowCounter;
}

// Ordered tiers, first match wins (firewall model). Never throws: any error
// resolves to ask, never allow. An auto_allowed result always names its tier
// (invariant 1). The unmatched default is the floor and never allows.
export function evaluate(
  event: ApprovalEvent,
  policy: Policy,
  context: EvaluationContext = {},
): PolicyResult {
  try {
    const flags = context.flags ?? {};
    const tiers = policy?.tiers ?? [];

    for (const tier of tiers) {
      if (!matchesTier(tier, event, flags)) continue;
      switch (tier.action) {
        case "allow": {
          // Aggregation limits (anti-splitting): a would-be allow escalates to
          // ask when a per-key ceiling is already reached. Needs both the clock
          // and the counter as inputs; without them, limits are not enforced.
          if (context.now !== undefined && context.allowCounter !== undefined) {
            const breach = breachedLimit(policy, event, context.now, context.allowCounter);
            if (breach !== null) {
              return {
                decision: "ask",
                tierName: tier.name,
                reason: `aggregation limit ${breach}`,
              };
            }
          }
          return {
            decision: "auto_allowed",
            tierName: tier.name,
            reason: `tier '${tier.name}'`,
          };
        }
        case "deny":
          return {
            decision: "auto_denied",
            tierName: tier.name,
            reason: `tier '${tier.name}'`,
          };
        case "ask":
          return {
            decision: "ask",
            tierName: tier.name,
            reason: `tier '${tier.name}'`,
          };
      }
    }

    const unmatched = policy?.defaults?.unmatched ?? "ask";
    return unmatched === "deny"
      ? { decision: "auto_denied", reason: "unmatched default" }
      : { decision: "ask", reason: "unmatched default" };
  } catch {
    return { decision: "ask", reason: "policy evaluation error" };
  }
}
