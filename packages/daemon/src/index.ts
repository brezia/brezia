import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import Fastify from "fastify";
import { ulid } from "ulid";
import {
  HookPayloadSchema,
  type ApprovalEvent,
  type Decision,
  type PolicyResult,
  type StorageAdapter,
  type StoredEvent,
} from "@brezia/shared";
import { evaluate, computeFlags, type Policy, type EvaluationContext } from "@brezia/policy";
import {
  hookPayloadToEvent,
  hookDecision,
  reasonForPolicy,
  NO_DECISION,
} from "./hook-adapter";
import { HeldRequests } from "./held-requests";
import { PolicyStore } from "./policy-loader";
import { SqliteStorage } from "./sqlite-storage";
// Re-exported so the CLI (verify/export) shares one storage implementation and the
// single source of the chain-verification logic.
export { SqliteStorage } from "./sqlite-storage";
import { AuditChain } from "./audit-chain";
import { SqliteHistory, SqliteAllowCounter } from "./derived";
import { replayResponse } from "./replay";
import { SseHub } from "./sse";
import { registerUi } from "./ui-static";
import { makeLogger } from "./logger";
export { makeLogger } from "./logger";
export type { Logger } from "./logger";
import type { HeldRequest } from "./held-requests";

// Localhost binding IS the v0 security model. This address is a constant, never
// configurable — never widen it.
export const HOST = "127.0.0.1";
export const PORT = 4747;

// Default persistent DB location (decisions.md 003). Used by start() for a real
// daemon; tests use ":memory:".
export function defaultDbPath(): string {
  return join(homedir(), ".brezia", "brezia.db");
}

// The rolling window for the auto-resolved counter.
const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Until a brezia.yaml is loaded, the daemon runs the no-allow-by-omission floor:
// every event is unmatched → ask → held for a human. It never auto-allows.
const DEFAULT_POLICY: Policy = {
  version: 1,
  defaults: { unmatched: "ask" },
  tiers: [],
};

// The hold window: how long a held request waits for a human before it auto-defers.
// Just under the 300s hook timeout `brezia init` installs, so Brezia defers first.
const DEFAULT_HOLD_TIMEOUT_MS = 290_000;

export interface ServerOptions {
  policy?: Policy;
  holdTimeoutMs?: number;
  /** Bind port. Defaults to PORT (4747). The address (HOST) is never configurable. */
  port?: number;
  /** Injectable policy evaluator (tests / Phase B wiring). Defaults to the pure evaluate(). */
  evaluate?: (event: ApprovalEvent, policy: Policy, context?: EvaluationContext) => PolicyResult;
  /** Resolve the live policy per request (enables hot reload). Overrides `policy`. */
  getPolicy?: () => Policy;
  /** Load + watch this brezia.yaml on start(); invalid file → safe default + log + chain. */
  policyPath?: string;
  /** Injected storage (tests). If omitted, createServer opens SqliteStorage(dbPath). */
  storage?: StorageAdapter;
  /** SQLite path when storage is not injected. Defaults to ":memory:" (ephemeral). */
  dbPath?: string;
  /** Built inbox directory. Defaults to the daemon package's ../static (vite outDir). */
  uiDir?: string;
  /** Append a human-readable diagnostics log here (e.g. ~/.brezia/brezia.log). */
  logPath?: string;
}

export async function createServer(opts: ServerOptions = {}) {
  const holdTimeoutMs = opts.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
  const evaluatePolicy = opts.evaluate ?? evaluate;
  const held = new HeldRequests();

  // Storage: injected (caller-owned) or opened here (we own its lifecycle).
  const ownsStorage = opts.storage === undefined;
  const storage: StorageAdapter =
    opts.storage ?? new SqliteStorage(opts.dbPath ?? ":memory:");
  const chain = new AuditChain(storage);
  const history = new SqliteHistory(storage);
  const allowCounter = new SqliteAllowCounter(storage);
  const sse = new SseHub();
  const log = makeLogger(opts.logPath);

  // One shape for a held request's card, shared by GET /v1/requests and the
  // request.created broadcast, so the inbox sees identical fields either way.
  // cwd/worktree drive the multi-session grouping in the UI.
  function cardPayload(r: HeldRequest) {
    return {
      id: r.id,
      session: r.event.session,
      tool: r.event.tool,
      arguments: r.event.arguments,
      flags: r.flags,
      createdTs: r.createdTs,
      cwd: r.event.context?.cwd,
      worktree: r.event.context?.worktree,
      policyTier: r.policyTier,
    };
  }

  // The rolling auto-resolved counter: 7-day auto-resolved ÷ total.
  function currentStats() {
    const { total, autoResolved } = storage.statsSince(Date.now() - STATS_WINDOW_MS);
    return {
      windowDays: 7,
      total,
      autoResolved,
      ratio: total > 0 ? autoResolved / total : 0,
    };
  }
  // Guarded so a stats read (a UI concern) can never divert a computed decision:
  // broadcastStats() is called on the hook path just before returning allow/deny.
  function broadcastStats(): void {
    try {
      sse.broadcast("stats.updated", currentStats());
    } catch {
      // a UI counter must never perturb a decision — swallow
    }
  }

  // Crash recovery: any request left `pending` in the DB belongs to
  // a previous process whose held HTTP connection died with it — resolve deferred
  // and chain, so the audit log stays truthful about what Brezia did NOT decide.
  for (const req of storage.listRequestsByStatus("pending")) {
    storage.updateRequestStatus(req.id, "deferred", Date.now(), "daemon restart");
    chain.deferral({ requestId: req.id, eventId: req.eventId, cause: "crash_recovery" });
    log(`defer crash_recovery ${req.id}`);
  }

  // Policy resolution. Explicit getPolicy/policy win; otherwise a watched file.
  let policyStore: PolicyStore | undefined;
  let getPolicy: () => Policy;
  if (opts.getPolicy !== undefined) {
    getPolicy = opts.getPolicy;
  } else if (opts.policyPath !== undefined) {
    policyStore = new PolicyStore();
    if (!policyStore.load(opts.policyPath)) {
      // Never fail open, never crash: keep the safe default and log the fix.
      console.error(
        `brezia: ${policyStore.getError()} — using safe default (unmatched: ask)`,
      );
    }
    policyStore.watch(opts.policyPath, (ok, error) => {
      console.error(
        ok
          ? "brezia: policy reloaded"
          : `brezia: policy reload rejected — ${error} — keeping the previous policy`,
      );
      chain.policyReload(ok, ok ? undefined : (error ?? undefined));
      log(ok ? "policy reloaded" : `policy reload rejected: ${error}`);
      // Drive the inbox banner: an error on a bad reload, null to clear it on a
      // good one (reusing the one event type — there is no policy.ok).
      sse.broadcast("policy.error", { error: ok ? null : (error ?? "policy reload failed") });
    });
    const store = policyStore;
    getPolicy = () => store.getPolicy();
  } else {
    getPolicy = () => opts.policy ?? DEFAULT_POLICY;
  }

  const app = Fastify({ logger: false });

  app.addHook("onClose", async () => {
    sse.closeAll();
    await policyStore?.close();
    if (ownsStorage && "close" in storage) {
      (storage as { close: () => void }).close();
    }
  });

  // Never 400 on malformed JSON — hand the handler `undefined` so it resolves to a
  // controlled no-decision instead of crashing the boundary (invariant 2).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, body === "" ? undefined : JSON.parse(body as string));
      } catch {
        done(null, undefined);
      }
    },
  );

  // Backstop: any unexpected error on the hook path resolves to no-decision — never
  // a 5xx surfaced as a decision (never-brick).
  app.setErrorHandler((_err, req, reply) => {
    if (req.url.startsWith("/v1/hook")) {
      return reply.code(200).send(NO_DECISION);
    }
    return reply.code(500).send({ error: "internal error" });
  });

  // Hook ingestion: validate → (idempotency replay) → map → evaluate → persist +
  // chain → decide or hold.
  app.post("/v1/hook", async (req, reply) => {
    try {
      const parsed = HookPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(200).send(NO_DECISION); // malformed → native flow
      }

      // Idempotency: a replayed tool_use_id returns the original outcome.
      const key = parsed.data.tool_use_id;
      const prior = storage.getEventByIdempotencyKey(key);
      if (prior !== undefined) {
        return reply.code(200).send(replayResponse(storage, prior));
      }

      const event = hookPayloadToEvent(parsed.data);
      const policy = getPolicy();
      // Flags computed before policy; matchers may reference them, cards display
      // them. Both flags and limits read PRIOR events — compute/evaluate before
      // persisting this one, so first-time and counts are always vs. the past.
      const flags = computeFlags(event, history);
      const now = Date.now();
      const result = evaluatePolicy(event, policy, { flags, now, allowCounter });

      // Invariant 1: emit allow only for a policy allow that names its matching
      // tier. An auto_allowed with no tier is a policy bug — treat it as ask
      // (held), never allow by omission. The persisted decision is the EFFECTIVE
      // one, so the counter and stats never credit a non-emitted allow.
      const allowWithTier =
        result.decision === "auto_allowed" &&
        typeof result.tierName === "string" &&
        result.tierName.length > 0;
      const effective: Decision = allowWithTier
        ? "auto_allowed"
        : result.decision === "auto_allowed"
          ? "ask"
          : result.decision;
      if (result.decision === "auto_allowed" && !allowWithTier) {
        // The pure evaluator always names a tier on allow; reaching here means a
        // policy-engine bug. We downgraded to ask (above) — log so it's diagnosable.
        console.error(
          "brezia: policy returned auto_allowed without a tier — downgraded to ask (policy bug)",
        );
        log("WARN policy returned auto_allowed without a tier — downgraded to ask");
      }

      const eventId = ulid();
      const stored: StoredEvent = {
        ...event,
        id: eventId,
        ts: now,
        flags,
        policyTier: result.tierName,
        decision: effective,
      };
      // Insert first; a UNIQUE(idempotency_key) collision means a concurrent
      // duplicate won the race — replay its now-persisted outcome instead.
      try {
        storage.insertEvent(stored);
      } catch {
        const raced = storage.getEventByIdempotencyKey(key);
        return reply
          .code(200)
          .send(raced ? replayResponse(storage, raced) : NO_DECISION);
      }
      chain.eventReceived({
        eventId,
        source: event.source,
        session: event.session,
        tool: event.tool,
        idempotencyKey: event.idempotencyKey,
      });
      chain.policyDecision({
        eventId,
        decision: effective,
        tierName: result.tierName,
        reason: result.reason,
      });
      log(`hook ${event.session} ${event.tool} -> ${effective}${result.tierName ? ` [${result.tierName}]` : ""}`);

      if (effective === "auto_allowed") {
        broadcastStats();
        return reply.code(200).send(hookDecision("allow", reasonForPolicy(result)));
      }
      if (effective === "auto_denied") {
        broadcastStats();
        return reply.code(200).send(hookDecision("deny", reasonForPolicy(result)));
      }

      // ask → record a pending request, announce the card, then hold the HTTP
      // response until a human decides or the hold times out.
      const requestId = ulid();
      storage.insertRequest({
        id: requestId,
        eventId,
        status: "pending",
        createdTs: now,
      });
      const heldReq: HeldRequest = {
        id: requestId,
        event,
        flags,
        createdTs: now,
        eventId,
        policyTier: result.tierName,
      };
      const body = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          // Timeout-deferral: the held call outlived the hook
          // window and native flow takes over — mark deferred and chain it.
          if (held.has(requestId)) {
            storage.updateRequestStatus(requestId, "deferred", Date.now(), "hold timeout");
            chain.deferral({ requestId, eventId, cause: "hold_timeout" });
            sse.broadcast("request.resolved", { id: requestId, status: "deferred" });
            log(`defer hold_timeout ${requestId}`);
          }
          held.resolve(requestId, NO_DECISION); // native flow (never-brick)
        }, holdTimeoutMs);
        held.add(heldReq, (finalBody) => {
          clearTimeout(timer);
          resolve(finalBody);
        });
        sse.broadcast("request.created", cardPayload(heldReq));
      });
      return reply.code(200).send(body);
    } catch {
      return reply.code(200).send(NO_DECISION); // any error → native flow
    }
  });

  // Pending queue (in-memory held requests). The inbox reads this on load, then
  // stays live via /v1/stream.
  app.get("/v1/requests", async (_req, reply) => {
    return reply.code(200).send(held.list().map(cardPayload));
  });

  // Human decision releases a held request, updates its row, and chains the
  // decision. Race-safe: the held registry is the single source of truth for
  // "still awaiting"; if resolve() fails, another path already finished it.
  app.post("/v1/requests/:id/decision", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { action?: unknown; reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason : undefined;

    if (body.action !== "approve" && body.action !== "deny") {
      return reply.code(400).send({ error: "action must be 'approve' or 'deny'" });
    }

    const entry = held.get(id);
    if (entry === undefined) {
      return reply.code(404).send({ error: "unknown or already-resolved request" });
    }

    const approve = body.action === "approve";
    const response = approve
      ? hookDecision("allow", reason ? `brezia: ${reason}` : "brezia: approved")
      : hookDecision("deny", reason ? `brezia: ${reason}` : "brezia: denied");

    if (!held.resolve(id, response)) {
      return reply.code(404).send({ error: "unknown or already-resolved request" });
    }
    storage.updateRequestStatus(id, approve ? "approved" : "denied", Date.now(), reason);
    chain.humanDecision({
      requestId: id,
      eventId: entry.eventId,
      status: approve ? "approved" : "denied",
      reason,
    });
    sse.broadcast("request.resolved", { id, status: approve ? "approved" : "denied" });
    broadcastStats();
    log(`human ${approve ? "approved" : "denied"} ${id}`);
    return reply.code(200).send({ ok: true });
  });

  // The rolling auto-resolved counter: 7-day auto-resolved ÷ total.
  app.get("/v1/stats", async (_req, reply) => reply.code(200).send(currentStats()));

  // SSE: the inbox's live feed. We own the socket after hijack(); Fastify sends no
  // response of its own. Deltas are pushed by the pipeline via the hub.
  app.get("/v1/stream", (req, reply) => {
    reply.hijack();
    try {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // defeat proxy buffering if any sits in front
      });
      reply.raw.write(": connected\n\n");
      sse.add(reply.raw);
      // Send the current counter immediately so the home screen is correct on connect.
      reply.raw.write(`event: stats.updated\ndata: ${JSON.stringify(currentStats())}\n\n`);
      req.raw.on("close", () => sse.remove(reply.raw));
    } catch {
      // A stream setup failure affects only this client's socket, never the hook
      // path — drop the client and close its connection.
      sse.remove(reply.raw);
      try {
        reply.raw.end();
      } catch {
        // already gone
      }
    }
  });

  // Still stubbed until their phase.
  app.post("/v1/approval-events", async (_req, reply) =>
    reply.code(501).send({ error: "not implemented — later phase" }),
  );

  // The inbox (static). Registered last so /v1/* always wins. Serves the built UI
  // from an in-memory map; a friendly placeholder when the UI has not been built.
  registerUi(app, opts.uiDir);

  // Binding loopback limits who can CONNECT, but a browser connects on behalf of any
  // page it has open. After a DNS rebind such a page is same-origin to the browser
  // and only the Host header still names the foreign domain. So every route above
  // (hooks bind at ready, not in registration order) requires a loopback Host, and
  // a browser-sent Origin must be this same origin. The hook path skips the Origin
  // rule — Claude Code is not a browser — and fails to no-decision, never an error.
  // Nothing may be framed either: a hostile page could otherwise embed the real
  // inbox and steal a click or an `a` keypress.
  app.addHook("onRequest", async (req, reply) => {
    reply.headers({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
    const host = (req.headers.host ?? "").toLowerCase();
    const origin = req.headers.origin?.toLowerCase();
    const onHookPath = req.routeOptions.url === "/v1/hook";
    const sameOrigin = onHookPath || origin === undefined || origin === `http://${host}`;
    if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) && sameOrigin) return;
    return onHookPath
      ? reply.code(200).send(NO_DECISION)
      : reply.code(403).send({ error: "non-local Host or cross-origin request" });
  });

  return app;
}

export async function start(opts: ServerOptions = {}) {
  // A real daemon persists to the home DB unless a path/storage is injected.
  let serverOpts = opts;
  if (opts.storage === undefined && opts.dbPath === undefined) {
    const dbPath = defaultDbPath();
    mkdirSync(join(homedir(), ".brezia"), { recursive: true });
    serverOpts = { ...opts, dbPath };
  }

  const app = await createServer(serverOpts);
  await app.listen({ host: HOST, port: opts.port ?? PORT });

  // Startup invariant: the daemon must bind loopback only. Covered by a test.
  for (const addr of app.addresses()) {
    if (addr.address !== HOST) {
      await app.close();
      throw new Error(
        `FATAL: daemon bound to ${addr.address}, expected ${HOST} only.`,
      );
    }
  }
  return app;
}
