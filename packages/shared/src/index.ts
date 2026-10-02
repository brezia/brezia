import { z } from "zod";

// Decision outcomes a policy evaluation can produce.
export const DecisionSchema = z.enum([
  "auto_allowed",
  "auto_denied",
  "ask",
  "no_decision",
]);
export type Decision = z.infer<typeof DecisionSchema>;

// Lifecycle of a held human-review request.
export const RequestStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "deferred",
  "expired",
]);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

// The normalized internal event. The daemon's hook adapter maps raw hook fields
// onto this shape; the Events API accepts it directly.
export const ApprovalEventSchema = z.object({
  source: z.string(),
  session: z.string(),
  tool: z.string(),
  arguments: z.record(z.unknown()),
  context: z
    .object({
      task: z.string().optional(),
      workspace: z.string().optional(),
      owner: z.string().optional(),
      cwd: z.string().optional(),
      worktree: z.string().optional(),
    })
    .optional(),
  idempotencyKey: z.string().optional(),
});
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

// Raw Claude Code PreToolUse hook payload. Tightened in Phase A from payloads
// captured off the installed version into fixtures/ (pretooluse-*.json) — never
// from memory or docs. The docs at capture time omitted tool_use_id and did not
// list prompt_id/effort; the real payload has all three, so fixtures win.
//
// Version-specific fields (prompt_id, effort) and subagent-only fields (agent_id,
// agent_type, worktree) are optional; unknown future fields pass through, because
// Claude Code adds fields between versions. The daemon parses defensively
// (safeParse → no-decision on failure) so a shape change never bricks the user.
export const HookPayloadSchema = z
  .object({
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string(),
    permission_mode: z.string(),
    hook_event_name: z.literal("PreToolUse"),
    tool_name: z.string(),
    tool_input: z.record(z.unknown()),
    tool_use_id: z.string(),
    prompt_id: z.string().optional(),
    effort: z.object({ level: z.string() }).passthrough().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    worktree: z.string().optional(),
  })
  .passthrough();
export type HookPayload = z.infer<typeof HookPayloadSchema>;

// Result of policy evaluation. tierName MUST be present whenever decision is
// auto_allowed — invariant 1: no allow without a named matching tier.
export const PolicyResultSchema = z.object({
  decision: DecisionSchema,
  tierName: z.string().optional(),
  reason: z.string().optional(),
});
export type PolicyResult = z.infer<typeof PolicyResultSchema>;

// A pending human-review item.
export const RequestSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  status: RequestStatusSchema,
  createdTs: z.number(),
  resolvedTs: z.number().optional(),
  reason: z.string().optional(),
});
export type Request = z.infer<typeof RequestSchema>;

// ---------------------------------------------------------------------------
// Policy format (brezia.yaml) — a versioned contract, additive-only after v0.
// Evaluation lives in packages/policy; this is only the shape + validation.
// Semantics (decided): a matcher matches when ALL its present conditions hold
// (tool AND args AND every listed flag); a tier's `match` list is OR; tiers are
// evaluated in order, first match wins; `unmatched` is the floor (never allow).
// ---------------------------------------------------------------------------

// Anomaly/context flags computed before policy runs. Matchers may require them;
// cards always display them. The v0 set is small and grows additively.
export const FLAG_NAMES = [
  "secrets_pattern",
  "first_time_tool",
  "first_time_command",
] as const;
export type FlagName = (typeof FLAG_NAMES)[number];
export type Flags = Partial<Record<FlagName, boolean>>;

// A single matcher. Arg values are picomatch globs by default; a value prefixed
// "re:" is a regular expression (regex only where declared). `bash` lists
// curated command classes (e.g. "read", "test") that the Bash command must
// classify into; a compound/expansion command is unclassifiable and never matches.
export const MatcherSchema = z
  .object({
    tool: z.string().optional(),
    args: z.record(z.string()).optional(),
    bash: z.array(z.string()).optional(),
    flags: z.array(z.string()).optional(),
  })
  .strict();
export type Matcher = z.infer<typeof MatcherSchema>;

export const PolicyActionSchema = z.enum(["allow", "ask", "deny"]);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicyTierSchema = z
  .object({
    name: z.string().min(1),
    match: z.array(MatcherSchema),
    action: PolicyActionSchema,
    // v1 keys, accepted-and-ignored at v0 so a forward-compatible (v1-ready) policy
    // file runs on the single-player daemon harmlessly — the format reserves them:
    // the batch and route keys activate at v1, and the single-player daemon ignores
    // them. The routing and batching CAPABILITIES are NOT built at v0;
    // these keys are tolerated (any shape, since the v1 shape isn't settled) and are
    // never read by evaluate(). Every OTHER unknown tier key is still rejected by
    // .strict() (decision 010 — catch typos loudly).
    route: z.unknown().optional(),
    batch: z.unknown().optional(),
  })
  .strict();
export type PolicyTier = z.infer<typeof PolicyTierSchema>;

export const PolicyLimitSchema = z
  .object({
    per: z.enum(["agent", "tool", "session"]),
    window: z.string().regex(/^\d+[smhd]$/), // e.g. "24h", "30m"
    max_asks_auto_allowed: z.number().int().positive(),
  })
  .strict();
export type PolicyLimit = z.infer<typeof PolicyLimitSchema>;

export const PolicyDefaultsSchema = z
  .object({
    unmatched: z.enum(["ask", "deny"]),
    on_expiry: z.enum(["deny", "defer"]).optional(),
  })
  .strict();

// The whole file. `.strict()` at every level rejects unknown keys loudly, so a
// typo'd key fails validation instead of silently disabling a rule.
export const PolicySchema = z
  .object({
    version: z.literal(1),
    defaults: PolicyDefaultsSchema,
    tiers: z.array(PolicyTierSchema),
    limits: z.array(PolicyLimitSchema).optional(),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

// ---------------------------------------------------------------------------
// Secrets detection — curated here in shared. Used to compute the
// `secrets_pattern` flag. Tuned for precision:
// specific credential shapes plus a conservative high-entropy heuristic that
// deliberately skips pure-hex/decimal runs (git SHAs, hashes, ids) to avoid
// false positives. Tested both ways (catches real, ignores innocent).
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/, // PEM private keys
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\bAIza[0-9A-Za-z_\-]{20,}\b/, // Google API key
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style secret keys
  /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/, // Stripe publishable-style
  // Credential-carrying key/value. The optional quote before the separator makes it
  // tolerant of JSON ("client_secret": "…") as well as shell/env (secret=… / token: …).
  /(?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-/+]{12,}/i,
  // Authorization headers carry a live credential regardless of the token's shape, so
  // key on the header context (Bearer/Token/Basic/Digest) — this flags low-entropy or
  // opaque tokens that the entropy heuristic would miss. Common in
  // `curl -H "Authorization: Bearer …"`.
  /\bauthorization\s*:\s*(?:bearer|token|basic|digest)\s+[A-Za-z0-9._~+/=-]{6,}/i,
];

// A reference to a dotenv file (e.g. `curl --data @.env`), bounded so it does not
// fire inside unrelated words.
const ENV_FILE_REF = /(?:^|[\s"'=@/])\.env(?:\.[A-Za-z0-9_]+)?\b/;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function hasHighEntropyToken(text: string): boolean {
  for (const token of text.match(/[A-Za-z0-9+/_-]{32,}={0,2}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(token)) continue; // hex (SHAs, hashes) — skip
    if (/^[0-9]+$/.test(token)) continue; // pure digits — skip
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(token)).length;
    if (classes >= 3 && shannonEntropy(token) >= 4.0) return true;
  }
  return false;
}

// True when a string looks like it carries a credential/secret.
export function looksLikeSecret(text: string): boolean {
  if (typeof text !== "string") return false;
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  if (ENV_FILE_REF.test(text)) return true;
  return hasHighEntropyToken(text);
}

// ---------------------------------------------------------------------------
// Audit chain (decisions.md 007) — hash = sha256(prev_hash + entry_json), one row
// per state change. The entry shape below is a versioned contract: it is what
// `brezia verify` re-hashes and what `brezia export` emits, so it is additive-only
// after v0. Every string is hashed exactly as stored; verify never re-serializes.
// ---------------------------------------------------------------------------

// prev_hash of the first real entry (seq 1). A fixed, well-known constant so the
// whole chain — including its root — is reproducible by anyone verifying it.
export const GENESIS_HASH = "0".repeat(64);

// The chained state changes. One variant per state change:
// event received, policy decision, human decision, timeout/crash deferral, policy
// reload. `ts` is inside the entry so an exported entry is self-describing.
export const AuditEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event_received"),
    ts: z.number(),
    eventId: z.string(),
    source: z.string(),
    session: z.string(),
    tool: z.string(),
    idempotencyKey: z.string().optional(),
  }),
  z.object({
    kind: z.literal("policy_decision"),
    ts: z.number(),
    eventId: z.string(),
    decision: DecisionSchema,
    tierName: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("human_decision"),
    ts: z.number(),
    requestId: z.string(),
    eventId: z.string(),
    status: z.enum(["approved", "denied"]),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("deferral"),
    ts: z.number(),
    requestId: z.string(),
    eventId: z.string(),
    // hold_timeout: the held call outlived the hook window; crash_recovery: a
    // request left pending by a daemon crash is resolved deferred on restart.
    cause: z.enum(["hold_timeout", "crash_recovery"]),
  }),
  z.object({
    kind: z.literal("policy_reload"),
    ts: z.number(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
]);
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// A persisted audit row, as read back for verify and export.
export interface AuditRow {
  seq: number;
  ts: number;
  entryJson: string;
  prevHash: string;
  hash: string;
}

// A persisted event row: the event plus its computed flags and recorded outcome.
export interface StoredEvent extends ApprovalEvent {
  id: string;
  ts: number;
  flags: Flags;
  policyTier?: string;
  decision: Decision;
}

// Aggregation dimension for the auto-allow counter (mirrors PolicyLimit.per). The
// value is the already-resolved key (e.g. the tool name, or owner-or-session for
// `agent`) — the daemon's counter parses it out of the policy layer's opaque key.
export type AggregationDim = "tool" | "session" | "agent";

// The one piece of v1 foresight allowed in v0 (decisions.md 003): storage behind
// an interface so Postgres later is an implementation, not a rewrite. SQLite is the
// only implementation at v0. Note there is deliberately no update/delete method for
// the audit chain — it is append-only.
export interface StorageAdapter {
  // Events.
  insertEvent(event: StoredEvent): void;
  getEventByIdempotencyKey(key: string): StoredEvent | undefined;

  // First-time history, derived from the events table (no shadow copy). "Seen"
  // means a prior persisted event — call before inserting the current event.
  hasSeenTool(tool: string): boolean;
  hasSeenCommand(command: string): boolean;

  // Aggregation counter, derived from the events table: how many auto-allowed
  // events match the dimension/value at or after sinceTs.
  countAutoAllows(dim: AggregationDim, value: string, sinceTs: number): number;

  // The rolling counter for /v1/stats: totals since a cutoff. Auto-resolved =
  // auto_allowed + auto_denied (policy decided without a human).
  statsSince(sinceTs: number): { total: number; autoResolved: number };

  // Requests.
  insertRequest(request: Request): void;
  getRequest(id: string): Request | undefined;
  getRequestByEventId(eventId: string): Request | undefined;
  listRequestsByStatus(status: RequestStatus): Request[];
  updateRequestStatus(
    id: string,
    status: RequestStatus,
    resolvedTs: number,
    reason?: string,
  ): void;

  // Audit chain. appendAuditEntry stores entryJson verbatim and links it to
  // prevHash; there is deliberately no update or delete for audit_log.
  appendAuditEntry(
    entryJson: string,
    prevHash: string,
  ): { seq: number; hash: string };
  getLastAuditEntry(): { seq: number; hash: string } | undefined;
  allAuditEntries(): AuditRow[];
  verifyAuditChain(): boolean;
}
