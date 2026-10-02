import type { Card, Connection, Stats } from "./types";

// The whole inbox state. No state library — a single reducer (CLAUDE.md stack).
export interface State {
  cards: Card[]; // pending, in arrival order
  stats: Stats | null;
  connection: Connection;
  policyError: string | null;
  sessionFilter: string | null; // null = all sessions
  selectedId: string | null; // keyboard cursor, an id in the VISIBLE list
  denyingId: string | null; // the card currently capturing a deny reason
}

export const initialState: State = {
  cards: [],
  stats: null,
  connection: "connecting",
  policyError: null,
  sessionFilter: null,
  selectedId: null,
  denyingId: null,
};

export type Action =
  | { type: "SNAPSHOT"; cards: Card[] }
  | { type: "STATS"; stats: Stats }
  | { type: "CREATED"; card: Card }
  | { type: "RESOLVED"; id: string }
  | { type: "POLICY_ERROR"; error: string | null }
  | { type: "CONNECTION"; status: Connection }
  | { type: "SET_FILTER"; session: string | null }
  | { type: "SELECT"; id: string }
  | { type: "MOVE"; delta: 1 | -1 }
  | { type: "START_DENY"; id: string }
  | { type: "CANCEL_DENY" };

// The cards actually shown, honoring the session filter. Derived (never stored) so
// it can never drift from `cards`.
export function visibleCards(state: State): Card[] {
  if (state.sessionFilter === null) return state.cards;
  return state.cards.filter((c) => c.session === state.sessionFilter);
}

// The distinct sessions present, for the filter chips — arrival order preserved.
export function sessions(cards: Card[]): string[] {
  const seen: string[] = [];
  for (const c of cards) if (!seen.includes(c.session)) seen.push(c.session);
  return seen;
}

// Keep the cursor valid: if the selected card is gone or filtered out, move to the
// first visible card (or null when the queue is empty).
function reconcileSelection(state: State): State {
  const visible = visibleCards(state);
  if (state.selectedId !== null && visible.some((c) => c.id === state.selectedId)) {
    return state;
  }
  return { ...state, selectedId: visible[0]?.id ?? null };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SNAPSHOT":
      return reconcileSelection({ ...state, cards: action.cards });

    case "STATS":
      return { ...state, stats: action.stats };

    case "CREATED": {
      // Ignore a duplicate id (a snapshot + an in-flight SSE event can overlap).
      if (state.cards.some((c) => c.id === action.card.id)) return state;
      return reconcileSelection({ ...state, cards: [...state.cards, action.card] });
    }

    case "RESOLVED": {
      const cards = state.cards.filter((c) => c.id !== action.id);
      const denyingId = state.denyingId === action.id ? null : state.denyingId;
      return reconcileSelection({ ...state, cards, denyingId });
    }

    case "POLICY_ERROR":
      return { ...state, policyError: action.error };

    case "CONNECTION":
      return { ...state, connection: action.status };

    case "SET_FILTER":
      return reconcileSelection({ ...state, sessionFilter: action.session });

    case "SELECT":
      return { ...state, selectedId: action.id };

    case "MOVE": {
      const visible = visibleCards(state);
      if (visible.length === 0) return state;
      const idx = visible.findIndex((c) => c.id === state.selectedId);
      // From no selection, j selects the first, k the last.
      const next =
        idx < 0
          ? action.delta === 1
            ? 0
            : visible.length - 1
          : Math.min(Math.max(idx + action.delta, 0), visible.length - 1);
      return { ...state, selectedId: visible[next]!.id };
    }

    case "START_DENY":
      return { ...state, denyingId: action.id, selectedId: action.id };

    case "CANCEL_DENY":
      return { ...state, denyingId: null };

    default:
      return state;
  }
}
