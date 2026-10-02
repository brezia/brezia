# Performance notes

## Decision → release latency (Phase D / D4)

**Budget:** a human decision reaches the held hook response in **under 1 s** on
localhost. The moment approving feels slower than the terminal prompt, single-player
value dies.

**Measured (2026-07-16, Phase D end-to-end, in-process daemon, `:memory:` DB):**

| Segment | Time |
|---|---|
| `POST /v1/requests/:id/decision` → held hook response resolves | **~1.6 ms** |

The held response is completed synchronously the instant the decision arrives (the
held-request `Map` lookup + `resolve`), so the server-side release is sub-millisecond
to low-single-digit ms. The user-perceived path is one additional localhost fetch
round-trip: the inbox **optimistically** drops the card on a successful decision POST
(it does not wait for the `request.resolved` SSE echo), so the card disappears within
that round-trip and the `request.resolved`/`stats.updated` events that follow are
idempotent no-ops.

**Method:** start the daemon on an ephemeral loopback port, POST a `PreToolUse` hook
that holds (default `ask`), poll `/v1/requests` for the card, then time from the
decision POST to the held hook response completing. Re-run this measurement if the
hold/resolve path changes.

**Conclusion:** comfortably within budget with ~600× headroom on the server-side
segment; no optimization needed at v0.
