import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { ServerResponse } from "node:http";
import { createServer } from "./index";
import { SseHub } from "./sse";
import type { Policy } from "@brezia/policy";

describe("SseHub — framing and client lifecycle", () => {
  function fakeRes(sink: string[]): ServerResponse {
    return { write: (s: string) => sink.push(s), end() {} } as unknown as ServerResponse;
  }

  it("formats an event frame as `event:` + `data:` + blank line", () => {
    const hub = new SseHub();
    const writes: string[] = [];
    hub.add(fakeRes(writes));
    hub.broadcast("stats.updated", { total: 3, ratio: 0.5 });
    expect(writes[0]).toBe('event: stats.updated\ndata: {"total":3,"ratio":0.5}\n\n');
    expect(hub.count()).toBe(1);
  });

  it("drops a client whose write throws (dead socket)", () => {
    const hub = new SseHub();
    hub.add({ write: () => { throw new Error("EPIPE"); }, end() {} } as unknown as ServerResponse);
    hub.broadcast("policy.error", { error: "x" });
    expect(hub.count()).toBe(0);
  });

  it("never throws into the caller on a non-serializable payload (decision-path safety)", () => {
    const hub = new SseHub();
    const writes: string[] = [];
    hub.add(fakeRes(writes));
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify would throw
    expect(() => hub.broadcast("stats.updated", circular)).not.toThrow();
    expect(writes).toHaveLength(0); // skipped, not written
  });
});

// ---- Live SSE integration: a real listening server + a raw http client --------

const askPolicy: Policy = { version: 1, defaults: { unmatched: "ask" }, tiers: [] };

function bash(command: string, id: string): unknown {
  return {
    session_id: "sess-a", transcript_path: "t", cwd: "/repo", permission_mode: "auto",
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id,
  };
}

// Collect SSE events off a raw stream, resolving each time a named event lands.
class SseClient {
  private buffer = "";
  readonly events: Array<{ event: string; data: unknown }> = [];
  private waiters: Array<{ name: string; resolve: () => void }> = [];
  constructor(private readonly req: http.ClientRequest, res: http.IncomingMessage) {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => this.feed(chunk));
  }
  private feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const m = /^event: (.+)$/m.exec(frame);
      const d = /^data: (.+)$/m.exec(frame);
      if (m && d) {
        this.events.push({ event: m[1]!, data: JSON.parse(d[1]!) });
        for (const w of this.waiters.filter((w) => w.name === m[1])) w.resolve();
        this.waiters = this.waiters.filter((w) => w.name !== m[1]);
      }
    }
  }
  waitFor(name: string, ms = 2000): Promise<void> {
    if (this.events.some((e) => e.event === name)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`SSE '${name}' did not arrive`)), ms);
      this.waiters.push({ name, resolve: () => { clearTimeout(t); resolve(); } });
    });
  }
  close(): void { this.req.destroy(); }
}

function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": data.length },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : undefined }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

function openStream(base: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/v1/stream`, (res) => resolve(new SseClient(req, res)));
    req.on("error", reject);
  });
}

describe("live SSE — the inbox feed reflects the pipeline", () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  let stream: SseClient | undefined;
  afterEach(async () => {
    stream?.close();
    await app?.close();
    app = stream = undefined;
  });

  it("streams stats on connect, then request.created and request.resolved", async () => {
    app = await createServer({ policy: askPolicy, holdTimeoutMs: 5000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    stream = await openStream(base);
    await stream.waitFor("stats.updated"); // sent immediately on connect

    // A hook call is held (default ask) → request.created broadcast.
    const hookP = post(base, "/v1/hook", bash("rm -rf x", "toolu_1"));
    await stream.waitFor("request.created");
    const created = stream.events.find((e) => e.event === "request.created")!.data as { id: string; tool: string; cwd: string };
    expect(created.tool).toBe("Bash");
    expect(created.cwd).toBe("/repo");

    // Approve it → held hook response completes AND request.resolved broadcasts.
    await post(base, `/v1/requests/${created.id}/decision`, { action: "approve" });
    await stream.waitFor("request.resolved");
    const resolved = stream.events.find((e) => e.event === "request.resolved")!.data as { id: string; status: string };
    expect(resolved).toEqual({ id: created.id, status: "approved" });

    const hook = await hookP;
    expect(hook.json.hookSpecificOutput.permissionDecision).toBe("allow");
  });
});
