# The inbox — frontend internals

> The React inbox: a Vite bundle driven by a single `useReducer`, an SSE feed that
> keeps it live, optimistic decisions, and the one rule that governs everything a human
> reads — agent-supplied strings render inert.

The inbox is `packages/ui`: a small Vite + React application that the daemon serves
same-origin. It shows the queue of [held requests](../architecture.md#the-held-requests-model),
groups them by session, and lets a human approve or deny with a keystroke. It is
deliberately the least clever package in the repo — the interesting logic lives in the
daemon and the [policy engine](policy-evaluation.md); the UI is a thin, pure-where-it-can-be
view over one wire contract.

## Contents

- [The one hard rule: untrusted input renders inert](#the-one-hard-rule-untrusted-input-renders-inert)
- [The UI does not import the contract](#the-ui-does-not-import-the-contract)
- [Stack: Vite + React + one reducer](#stack-vite--react--one-reducer)
- [State shape and reducer actions](#state-shape-and-reducer-actions)
- [SSE wiring and optimistic resolve](#sse-wiring-and-optimistic-resolve)
- [The Card](#the-card)
- [The keyboard model](#the-keyboard-model)
- [Multi-session grouping and filtering](#multi-session-grouping-and-filtering)
- [Same-origin serving and the dev proxy](#same-origin-serving-and-the-dev-proxy)

---

## The one hard rule: untrusted input renders inert

Every field on a card that originates from the agent — the tool name, every argument
value, the `cwd`/`worktree` paths — is untrusted input. A human reads it, so a crafted
string must never become a live element, a link, interpreted markdown, or an ANSI escape
that rewrites the terminal-like view. This is a project-level hard rule, and in the UI it
is enforced structurally: agent strings are rendered as **text nodes inside `<pre>`**, and
nothing in the render path ever interprets them.

The mechanism is `stringify` plus JSX text interpolation. React escapes any string
interpolated as a child into a text node; it never parses it as HTML. Non-string values
are JSON-serialized, so an object argument is shown as literal JSON, not spread into
attributes.

```tsx
// packages/ui/src/Card.tsx:7
function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
```

Argument values land in a `<pre>` under a `<dd>`:

```tsx
// packages/ui/src/Card.tsx:82
<dd className="arg__val">
  <pre>{stringify(value)}</pre>
</dd>
```

There is no `dangerouslySetInnerHTML` anywhere in the package, no markdown renderer, and
no anchor is ever synthesized from argument text. The inertness is locked by a permanent
test that feeds the card a hostile payload and asserts the output is escaped, not live:

```tsx
// packages/ui/src/Card.test.tsx:8
const HOSTILE: CardData = {
  ...
  arguments: {
    command: "<script>alert('xss')</script>",
    note: "click here: [click me](http://evil.example)",
    ansi: "[31mred[0m danger",
    img: "<img src=x onerror=alert(1)>",
  },
  ...
};
```

The assertions state the rule precisely: `<script>` appears only as `&lt;script&gt;`, no
`<a `anchor is emitted for the markdown link (it is shown literally), and the ANSI escape
survives as raw text with no styling (`packages/ui/src/Card.test.tsx:27-42`). Because the
test renders through the real `Card` component with `renderToStaticMarkup`, it fails the
moment any future change routes agent text through an interpreting renderer.

> **Security.** The `<pre>` + text-node rule is the UI half of Brezia's untrusted-input
> posture; the CLI has its own half (`inert()` strips control bytes from the `brezia up`
> decision stream, `packages/cli/src/up.ts:41`). Both are documented together in
> [../security.md](../security.md).

One deliberate exception proves the rule: the app's own footer link is chrome the UI
authors, not agent-supplied, so it is a normal `<a>` (`packages/ui/src/App.tsx:156`). The
distinction the code draws is authorship — *our* strings may be interactive; *agent*
strings never are.

---

## The UI does not import the contract

Every other package imports its types from `@brezia/shared`, "THE contract." **The UI does
not.** Its only runtime dependencies are `react` and `react-dom`
(`packages/ui/package.json:13`); it re-declares the small card shape locally in
`types.ts`:

```ts
// packages/ui/src/types.ts:4
export interface Card {
  id: string;
  session: string;
  tool: string;
  arguments: Record<string, unknown>;
  flags: Record<string, boolean>;
  createdTs: number;
  cwd?: string;
  worktree?: string;
  policyTier?: string;
}
```

This is intentional. Keeping `@brezia/shared` out of the bundle means the Vite output is a
self-contained browser artifact with no leakage of daemon-side types (schemas, storage
interfaces, zod) into client code. The consequence is that **the contract between the UI
and the daemon is the wire JSON, not a shared type import.** The authoritative shapes are
what the daemon actually sends:

- `GET /v1/requests` and the `request.created` SSE event both send `cardPayload(r)`, whose
  fields are exactly the `Card` interface above (`packages/daemon/src/index.ts:102`).
- `GET /v1/stats` and the `stats.updated` event send `{ windowDays, total, autoResolved,
  ratio }` (`packages/daemon/src/index.ts:119`), mirrored by `Stats`
  (`packages/ui/src/types.ts:16`).

The daemon comment makes the coupling explicit: `cardPayload` is "shared by GET
/v1/requests and the request.created broadcast, so the inbox sees identical fields either
way" (`packages/daemon/src/index.ts:99`). Because the two `Card` declarations are not
mechanically linked, keeping them in step is a review responsibility: a change to
`cardPayload` is a change to the UI's contract even though no TypeScript error will flag
it. See [../reference/http-api.md](../reference/http-api.md) for the full endpoint shapes.

---

## Stack: Vite + React + one reducer

The stack is fixed by project rule: React with `useReducer`, **no state library**. The
entire application state is one object, mutated by one pure reducer, held by one
`useReducer` call at the root:

```tsx
// packages/ui/src/App.tsx:8
const [state, dispatch] = useReducer(reducer, initialState);
const [denyReason, setDenyReason] = useState("");
```

The only piece of state outside the reducer is the in-progress deny reason (`denyReason`),
kept in `useState` because it is transient input-box text, not part of the queue model.
`main.tsx` mounts `<App/>` in React `StrictMode` (`packages/ui/src/main.tsx:11`); there is
no router, no context provider, no store. The whole component tree is `App → Card[]`.

Why so plain: the inbox is a single screen with a live list and two actions. A reducer
gives deterministic, unit-testable transitions (`state.test.ts` drives the reducer
directly, no DOM), which is worth far more here than a state framework's ergonomics.

---

## State shape and reducer actions

`State` is the whole inbox in one interface (`packages/ui/src/state.ts:4`):

| Field | Type | Meaning |
|---|---|---|
| `cards` | `Card[]` | Pending cards in arrival order. The queue. |
| `stats` | `Stats \| null` | The rolling auto-resolved counter, or null before first load. |
| `connection` | `"connecting" \| "open" \| "closed"` | SSE stream state, for the header dot. |
| `policyError` | `string \| null` | The current policy-reload error, or null when the policy is healthy. |
| `sessionFilter` | `string \| null` | The active session filter; `null` means all sessions. |
| `selectedId` | `string \| null` | The keyboard cursor — an id in the *visible* list. |
| `denyingId` | `string \| null` | The card currently capturing a deny reason. |

The reducer handles eleven actions (`packages/ui/src/state.ts:24`). Grouped by concern:

| Action | Effect |
|---|---|
| `SNAPSHOT` | Replace `cards` with the initial `GET /v1/requests` load; reconcile selection. |
| `CREATED` | Append a new card; **ignore a duplicate id** (a snapshot and an in-flight SSE event can overlap). |
| `RESOLVED` | Remove a card by id; cancel its deny box if open; reconcile selection. |
| `STATS` | Replace the stats slice. |
| `POLICY_ERROR` | Set or clear the policy banner. |
| `CONNECTION` | Set the stream indicator. |
| `SET_FILTER` | Change the session filter; reconcile selection into the newly visible set. |
| `SELECT` / `MOVE` | Move the keyboard cursor (absolute select, or relative j/k). |
| `START_DENY` / `CANCEL_DENY` | Open / close the deny-reason box for a card. |

Two design choices in the reducer are worth calling out because they keep the view honest.

**Derived, never stored.** The visible list and the session list are computed by pure
functions (`visibleCards`, `sessions`), not held in state, "so it can never drift from
`cards`" (`packages/ui/src/state.ts:38`):

```ts
// packages/ui/src/state.ts:39
export function visibleCards(state: State): Card[] {
  if (state.sessionFilter === null) return state.cards;
  return state.cards.filter((c) => c.session === state.sessionFilter);
}
```

**Selection is always reconciled.** Any action that can change what is visible runs
`reconcileSelection`, which keeps the cursor on a real, visible card or moves it to the
first one (or `null` when the queue empties):

```ts
// packages/ui/src/state.ts:53
function reconcileSelection(state: State): State {
  const visible = visibleCards(state);
  if (state.selectedId !== null && visible.some((c) => c.id === state.selectedId)) {
    return state;
  }
  return { ...state, selectedId: visible[0]?.id ?? null };
}
```

This is why resolving the selected card automatically advances the cursor to the next one,
and why filtering never leaves the cursor pointing at a hidden card — behavior asserted in
`state.test.ts:28` and `:62`.

---

## SSE wiring and optimistic resolve

The inbox loads a snapshot once, then stays live off Server-Sent Events. On mount, `App`
fetches the current queue and stats, then subscribes to the stream; the subscription's
cleanup closes the `EventSource` (`packages/ui/src/App.tsx:13`).

`api.ts` is the only I/O in the package — thin same-origin `fetch` helpers plus the SSE
subscription. Because the daemon serves the bundle, every URL is relative and hits the API
on `127.0.0.1` with no CORS:

```ts
// packages/ui/src/api.ts:39
export function subscribe(h: StreamHandlers): () => void {
  const es = new EventSource("/v1/stream");
  es.addEventListener("request.created", (e) => h.onCreated(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("request.resolved", (e) => h.onResolved(JSON.parse((e as MessageEvent).data).id));
  es.addEventListener("stats.updated", (e) => h.onStats(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("policy.error", (e) => h.onPolicyError(JSON.parse((e as MessageEvent).data).error));
  es.onopen = () => h.onOpen();
  es.onerror = () => h.onError();
  return () => es.close();
}
```

The four event names are the daemon↔inbox contract, defined in
`packages/daemon/src/sse.ts:10`. They are explicitly *not* the versioned Events API — they
are an internal wire between these two processes. `EventSource` auto-reconnects, so
`onError → "connecting"` is treated as transient, not fatal (`packages/ui/src/api.ts:38`).

**Optimistic resolve.** When a human approves or denies, the UI does not wait for the
server. It fires the POST and immediately drops the card locally; the `request.resolved`
event that follows is a harmless no-op (the card is already gone, and `RESOLVED` on an
absent id changes nothing):

```tsx
// packages/ui/src/App.tsx:29
function approve(id: string): void {
  void postDecision(id, "approve");
  dispatch({ type: "RESOLVED", id });
}
function deny(id: string, reason: string): void {
  void postDecision(id, "deny", reason || undefined);
  setDenyReason("");
  dispatch({ type: "RESOLVED", id });
}
```

The comment names the reason: this keeps approving "as fast as the terminal prompt" — the
latency budget for the inbox. The `RESOLVED` reducer case is idempotent against the
following SSE echo (`filter` on an already-removed id is a no-op), so optimism never
double-counts or leaves a ghost card. This is the frontend counterpart to the daemon's
race-safe held-request resolution, where whoever resolves first wins and the other path is
a no-op ([architecture.md](../architecture.md#the-held-requests-model)).

---

## The Card

`Card` is a pure presentational component (`packages/ui/src/Card.tsx:39`): given card data
and optional callbacks, it renders one queue entry. It computes three view-only helpers —
the active flag names, a short project label from the last path segment of
`worktree`/`cwd`, and the tier label — and draws four regions:

- **Header** — the tool name (inert text, "never a link"), a session badge, an optional
  project badge, and the matched tier (`tier: <name>` or `unmatched` when `policyTier` is
  absent).
- **Flags** — a banner of active [flag](../concepts.md#flags--anomaly--context-signals)
  names (e.g. `secrets_pattern`), shown only when at least one is set, with
  `role="status"`.
- **Args** — a `<dl>` of every argument, each value inert inside `<pre>` per the rule
  above.
- **Actions footer** — Approve/Deny buttons, or, while denying, a reason input with
  Deny/Cancel.

The flag banner and tier label are why flags are "computed before policy, displayed on
every card": the card is where a human sees *why* a call is being asked about. The
`secrets_pattern` flag in the hostile fixture, for instance, is asserted to appear in the
rendered banner (`packages/ui/src/Card.test.tsx:44`).

The Card holds no state. The deny reason lives in `App` and is passed down as
`denyReason`; the buttons call back up (`onApprove`, `onSubmitDeny`, …). This keeps the
component trivially testable by static rendering and keeps all mutation in the one
reducer.

---

## The keyboard model

Keyboard handling is split into a pure intent map (`keymap.ts`) and an effectful handler
(`App`'s global `keydown` listener). `keyToIntent` translates a key plus a mode flag into
an intent or `null`, with no reference to the DOM or to state:

```ts
// packages/ui/src/keymap.ts:13
export function keyToIntent(key: string, denying: boolean): Intent | null {
  if (denying) {
    if (key === "Enter") return { kind: "submit_deny" };
    if (key === "Escape") return { kind: "cancel_deny" };
    return null;
  }
  switch (key) {
    case "j": return { kind: "move", delta: 1 };
    case "k": return { kind: "move", delta: -1 };
    case "a": return { kind: "approve" };
    case "d": return { kind: "start_deny" };
    default: return null;
  }
}
```

The `denying` flag is the whole subtlety. While a deny-reason box is open, keystrokes are
for *typing*: only Enter (submit) and Escape (cancel) are intents, and `j`/`k`/`a`/`d` must
fall through to `null` so the letters land in the input rather than navigating the queue.
`keymap.test.ts:19` locks exactly this — every ordinary key returns `null` while denying.

`App` turns intents into dispatches and decision calls, guarding on selection state and
calling `e.preventDefault()` only when an intent actually fires (`packages/ui/src/App.tsx:41`).
Because the mapping is pure and unit-tested apart from React, the keyboard behavior is
verified without simulating events through the DOM.

---

## Multi-session grouping and filtering

Parallel Claude sessions share one inbox; grouping keeps that legible. `sessions(cards)`
lists the distinct session ids in arrival order (`packages/ui/src/state.ts:45`), and `App`
renders a filter-chip row **only when more than one session is present**
(`packages/ui/src/App.tsx:101`):

```tsx
// packages/ui/src/App.tsx:101
{sessionList.length > 1 && (
  <nav className="chips" aria-label="filter by session">
    <button ...>all ({state.cards.length})</button>
    {sessionList.map((s) => {
      const n = state.cards.filter((c) => c.session === s).length;
      return <button ...>{s} ({n})</button>;
    })}
  </nav>
)}
```

Each chip carries a live count; selecting one sets `sessionFilter`, which `visibleCards`
honors and `reconcileSelection` follows so the cursor lands inside the filtered set
(`state.test.ts:62`). The card also surfaces a per-card project badge from
`worktree`/`cwd`, so an operator watching several worktrees can tell them apart at a
glance. The `cwd`/`worktree` fields that drive this come straight from the event context
via `cardPayload` (`packages/daemon/src/index.ts:110`).

---

## Same-origin serving and the dev proxy

In production there is no separate UI server. Vite builds straight into the daemon's static
directory, and the daemon serves it same-origin:

```ts
// packages/ui/vite.config.ts:20
build: { outDir: "../daemon/static", emptyOutDir: true },
```

The daemon loads that directory into an **in-memory map at startup** and serves only known
keys (`registerUi`, `packages/daemon/src/ui-static.ts:61`). Request paths are looked up in
a fixed `Map<urlPath, Asset>`, never joined onto the filesystem at request time, so there
is no path-traversal surface and no `@fastify/static` dependency:

```ts
// packages/daemon/src/ui-static.ts:71
app.get("/*", async (req, reply) => {
  const path = req.url.split("?")[0] ?? "/";
  if (!built || index === undefined) { /* placeholder or 404 */ }
  if (path === "/" || path === "/index.html") return reply.code(200).type(index.type).send(index.body);
  const asset = assets.get(path);
  if (asset === undefined) return reply.code(404).send({ error: "not found" });
  return reply.code(200).type(asset.type).send(asset.body);
});
```

Two properties fall out of this shape. The catch-all `GET /*` is registered **last**, so
every `/v1/*` API route wins over it (find-my-way ranks specific routes above the
wildcard). And when the UI has not been built, a friendly placeholder page names the fix
(`npm run build -w @brezia/ui`) rather than 404-ing the root
(`packages/daemon/src/ui-static.ts:53`).

For development, the Vite dev server (`127.0.0.1:5173`) proxies the API and SSE stream to
the running daemon so the dev environment behaves like production:

```ts
// packages/ui/vite.config.ts:12
server: {
  host: "127.0.0.1",
  port: 5173,
  proxy: {
    "/v1": { target: "http://127.0.0.1:4747" },
  },
},
```

There is deliberately no `changeOrigin`: the daemon compares each request's `Origin` with
its `Host` ([security.md](../security.md#the-v0-security-model-localhost-binding)), so the
proxy must pass the dev server's `Host` through unchanged or the inbox's POSTs are refused.

The dev server binds `127.0.0.1` too, mirroring the daemon's loopback constraint. In dev
you run `npm run dev:daemon` and `npm run dev:ui` side by side; the proxy makes the
relative `fetch`/`EventSource` calls in `api.ts` reach the daemon without CORS. See
[../guides/development.md](../guides/development.md#running-the-ui-in-dev) for the workflow.

---

**Next:** [../reference/http-api.md](../reference/http-api.md) for the endpoints and SSE
frames the inbox consumes, or [../security.md](../security.md) for the untrusted-input rule
across the whole system.
