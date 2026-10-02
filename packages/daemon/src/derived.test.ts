import { describe, it, expect, afterEach } from "vitest";
import { SqliteStorage } from "./sqlite-storage";
import { SqliteHistory, SqliteAllowCounter } from "./derived";
import type { StoredEvent } from "@brezia/shared";

const stores: SqliteStorage[] = [];
function storage(): SqliteStorage {
  const s = new SqliteStorage(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

function allowed(id: string, over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id,
    ts: over.ts ?? 1000,
    source: "claude-code-http",
    session: over.session ?? "sess-a",
    tool: over.tool ?? "Bash",
    arguments: over.arguments ?? { command: "ls" },
    context: over.context,
    flags: {},
    policyTier: "reads",
    decision: "auto_allowed",
  };
}

describe("SqliteHistory", () => {
  it("delegates first-time lookups to prior persisted events", () => {
    const s = storage();
    const h = new SqliteHistory(s);
    expect(h.hasSeenTool("Bash")).toBe(false);
    s.insertEvent(allowed("e1", { tool: "Bash", arguments: { command: "ls" } }));
    expect(h.hasSeenTool("Bash")).toBe(true);
    expect(h.hasSeenCommand("ls")).toBe(true);
    expect(h.hasSeenCommand("rm")).toBe(false);
  });
});

describe("SqliteAllowCounter — counts real dimensions, fails closed on the rest", () => {
  it("counts auto-allows for a known dimension within the window", () => {
    const s = storage();
    s.insertEvent(allowed("e1", { tool: "Bash", ts: 100 }));
    s.insertEvent(allowed("e2", { tool: "Bash", ts: 200 }));
    const c = new SqliteAllowCounter(s);
    // cutoff = now - windowMs. Wide window (cutoff < 100) keeps both.
    expect(c.countInWindow("tool:Bash", 2_000, 500)).toBe(2);
    // cutoff = 250 - 100 = 150 → keeps e2 (ts 200), drops e1 (ts 100).
    expect(c.countInWindow("tool:Bash", 100, 250)).toBe(1);
    expect(c.countInWindow("session:sess-a", 2_000, 500)).toBe(2);
  });

  it("an unrecognized dimension forces a breach (fail toward ask, never allow)", () => {
    const c = new SqliteAllowCounter(storage());
    // Any positive max_asks_auto_allowed is `<=` this, so breachedLimit escalates
    // the would-be allow to ask rather than silently skipping the cap.
    expect(c.countInWindow("owner:someone", 1_000, 500)).toBe(Number.MAX_SAFE_INTEGER);
    expect(c.countInWindow("no-colon-key", 1_000, 500)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
