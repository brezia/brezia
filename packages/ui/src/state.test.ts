import { describe, it, expect } from "vitest";
import { reducer, initialState, visibleCards, sessions, type State } from "./state";
import type { Card } from "./types";

function card(id: string, session = "s1"): Card {
  return { id, session, tool: "Bash", arguments: { command: "ls" }, flags: {}, createdTs: 1 };
}

function withCards(cards: Card[], over: Partial<State> = {}): State {
  return { ...initialState, cards, selectedId: cards[0]?.id ?? null, ...over };
}

describe("reducer — queue lifecycle", () => {
  it("SNAPSHOT fills the queue and selects the first card", () => {
    const s = reducer(initialState, { type: "SNAPSHOT", cards: [card("a"), card("b")] });
    expect(s.cards.map((c) => c.id)).toEqual(["a", "b"]);
    expect(s.selectedId).toBe("a");
  });

  it("CREATED appends and ignores a duplicate id", () => {
    let s = withCards([card("a")]);
    s = reducer(s, { type: "CREATED", card: card("b") });
    expect(s.cards.map((c) => c.id)).toEqual(["a", "b"]);
    s = reducer(s, { type: "CREATED", card: card("b") }); // dup
    expect(s.cards.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("RESOLVED removes the card and moves selection to the next visible", () => {
    let s = withCards([card("a"), card("b")], { selectedId: "a" });
    s = reducer(s, { type: "RESOLVED", id: "a" });
    expect(s.cards.map((c) => c.id)).toEqual(["b"]);
    expect(s.selectedId).toBe("b");
  });

  it("RESOLVED of the last card clears the selection", () => {
    let s = withCards([card("a")], { selectedId: "a" });
    s = reducer(s, { type: "RESOLVED", id: "a" });
    expect(s.selectedId).toBeNull();
  });

  it("RESOLVED cancels an open deny box for that card", () => {
    let s = withCards([card("a")], { denyingId: "a" });
    s = reducer(s, { type: "RESOLVED", id: "a" });
    expect(s.denyingId).toBeNull();
  });
});

describe("reducer — navigation", () => {
  it("MOVE clamps at both ends and starts from the edges when nothing is selected", () => {
    const base = withCards([card("a"), card("b"), card("c")], { selectedId: null });
    expect(reducer(base, { type: "MOVE", delta: 1 }).selectedId).toBe("a");
    expect(reducer(base, { type: "MOVE", delta: -1 }).selectedId).toBe("c");

    const atA = { ...base, selectedId: "a" };
    expect(reducer(atA, { type: "MOVE", delta: -1 }).selectedId).toBe("a"); // clamp top
    const atC = { ...base, selectedId: "c" };
    expect(reducer(atC, { type: "MOVE", delta: 1 }).selectedId).toBe("c"); // clamp bottom
  });
});

describe("reducer — sessions and filtering", () => {
  it("SET_FILTER narrows the visible set and reconciles selection into it", () => {
    let s = withCards([card("a", "s1"), card("b", "s2")], { selectedId: "a" });
    s = reducer(s, { type: "SET_FILTER", session: "s2" });
    expect(visibleCards(s).map((c) => c.id)).toEqual(["b"]);
    expect(s.selectedId).toBe("b"); // 'a' filtered out → jump to first visible
  });

  it("sessions() lists distinct sessions in arrival order", () => {
    expect(sessions([card("a", "s2"), card("b", "s1"), card("c", "s2")])).toEqual(["s2", "s1"]);
  });
});

describe("reducer — misc", () => {
  it("STATS, CONNECTION, and POLICY_ERROR update their slices", () => {
    let s = reducer(initialState, { type: "STATS", stats: { windowDays: 7, total: 4, autoResolved: 3, ratio: 0.75 } });
    expect(s.stats?.ratio).toBe(0.75);
    s = reducer(s, { type: "CONNECTION", status: "open" });
    expect(s.connection).toBe("open");
    s = reducer(s, { type: "POLICY_ERROR", error: "bad yaml" });
    expect(s.policyError).toBe("bad yaml");
    s = reducer(s, { type: "POLICY_ERROR", error: null });
    expect(s.policyError).toBeNull();
  });
});
