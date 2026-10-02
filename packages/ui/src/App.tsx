import { useEffect, useReducer, useState } from "react";
import { reducer, initialState, visibleCards, sessions } from "./state";
import { keyToIntent } from "./keymap";
import { Card } from "./Card";
import { fetchRequests, fetchStats, postDecision, subscribe } from "./api";

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [denyReason, setDenyReason] = useState("");

  // Initial snapshot + the live feed. The snapshot fills the queue on load; SSE
  // keeps it live (and re-sends stats immediately on connect).
  useEffect(() => {
    fetchRequests().then((cards) => dispatch({ type: "SNAPSHOT", cards })).catch(() => {});
    fetchStats().then((stats) => dispatch({ type: "STATS", stats })).catch(() => {});
    return subscribe({
      onCreated: (card) => dispatch({ type: "CREATED", card }),
      onResolved: (id) => dispatch({ type: "RESOLVED", id }),
      onStats: (stats) => dispatch({ type: "STATS", stats }),
      onPolicyError: (error) => dispatch({ type: "POLICY_ERROR", error }),
      onOpen: () => dispatch({ type: "CONNECTION", status: "open" }),
      onError: () => dispatch({ type: "CONNECTION", status: "connecting" }),
    });
  }, []);

  // Optimistic resolve: POST, then drop the card immediately (the SSE
  // request.resolved that follows is a no-op). Keeps approving as fast as the
  // terminal prompt — the D4 latency budget.
  function approve(id: string): void {
    void postDecision(id, "approve");
    dispatch({ type: "RESOLVED", id });
  }
  function deny(id: string, reason: string): void {
    void postDecision(id, "deny", reason || undefined);
    setDenyReason("");
    dispatch({ type: "RESOLVED", id });
  }

  // Global keyboard: j/k navigate, a approve, d deny → reason (Enter submits, Esc
  // cancels). While a reason box is open, other keys fall through to typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const intent = keyToIntent(e.key, state.denyingId !== null);
      if (intent === null) return;
      e.preventDefault();
      switch (intent.kind) {
        case "move":
          dispatch({ type: "MOVE", delta: intent.delta });
          break;
        case "approve":
          if (state.selectedId !== null) approve(state.selectedId);
          break;
        case "start_deny":
          if (state.selectedId !== null) {
            setDenyReason("");
            dispatch({ type: "START_DENY", id: state.selectedId });
          }
          break;
        case "submit_deny":
          if (state.denyingId !== null) deny(state.denyingId, denyReason);
          break;
        case "cancel_deny":
          setDenyReason("");
          dispatch({ type: "CANCEL_DENY" });
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.selectedId, state.denyingId, denyReason]);

  const visible = visibleCards(state);
  const sessionList = sessions(state.cards);
  const pct = state.stats ? Math.round(state.stats.ratio * 100) : null;

  return (
    <div className="app">
      <header className="topbar">
        <img className="topbar__mark" src="/favicon.svg" alt="" width="22" height="22" />
        <h1 className="topbar__title">brezia</h1>
        <div className="topbar__stats" title="auto-resolved ÷ total, rolling 7 days">
          {state.stats && state.stats.total > 0 ? (
            <>
              <strong>{pct}%</strong> auto-resolved
              <span className="topbar__sub">
                {state.stats.autoResolved}/{state.stats.total} · 7d
              </span>
            </>
          ) : (
            <span className="topbar__sub">no activity yet</span>
          )}
        </div>
        <span className={`dot dot--${state.connection}`} title={`stream: ${state.connection}`} />
      </header>

      {state.policyError !== null && (
        <div className="banner banner--error" role="alert">
          <pre>policy error: {state.policyError}</pre>
        </div>
      )}

      {sessionList.length > 1 && (
        <nav className="chips" aria-label="filter by session">
          <button
            className={`chip${state.sessionFilter === null ? " chip--on" : ""}`}
            onClick={() => dispatch({ type: "SET_FILTER", session: null })}
          >
            all ({state.cards.length})
          </button>
          {sessionList.map((s) => {
            const n = state.cards.filter((c) => c.session === s).length;
            return (
              <button
                key={s}
                className={`chip${state.sessionFilter === s ? " chip--on" : ""}`}
                onClick={() => dispatch({ type: "SET_FILTER", session: s })}
              >
                {s} ({n})
              </button>
            );
          })}
        </nav>
      )}

      <main className="queue">
        {visible.length === 0 ? (
          <p className="empty">Nothing waiting. Approved and denied calls leave the queue.</p>
        ) : (
          visible.map((card) => (
            <Card
              key={card.id}
              card={card}
              selected={card.id === state.selectedId}
              denying={card.id === state.denyingId}
              denyReason={denyReason}
              onSelect={(id) => dispatch({ type: "SELECT", id })}
              onApprove={approve}
              onDeny={(id) => {
                setDenyReason("");
                dispatch({ type: "START_DENY", id });
              }}
              onDenyReasonChange={setDenyReason}
              onSubmitDeny={(id) => deny(id, denyReason)}
              onCancelDeny={() => {
                setDenyReason("");
                dispatch({ type: "CANCEL_DENY" });
              }}
            />
          ))
        )}
      </main>

      {/* Honest fake door: the Team tier isn't built yet. This is our own chrome
          (not agent-supplied), so a normal link is fine. */}
      <footer className="footer">
        <span>Brezia — local approval control plane.</span>
        <a className="footer__cta" href="https://tally.so/r/q484Ng" target="_blank" rel="noreferrer">
          Team tier (shared policy, multi-approver) → join the waitlist
        </a>
      </footer>
    </div>
  );
}
