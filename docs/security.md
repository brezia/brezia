# Security — the v0 threat model and posture

> How Brezia stays safe while sitting in the tool-call path of other people's agents:
> localhost binding *is* the model, agent strings are untrusted everywhere a human reads
> them, the audit chain is tamper-evident, and nothing ever phones home.

Brezia's failure semantics outrank its features (see
[internals/failure-semantics.md](internals/failure-semantics.md)). This page is the security
counterpart: the boundaries, the untrusted-input handling, the tamper-evidence, and what is
deliberately *not* in scope at v0. Read [concepts.md](concepts.md) for the vocabulary.

## Contents

- [The v0 security model: localhost binding](#the-v0-security-model-localhost-binding)
- [Untrusted input: agent strings render inert](#untrusted-input-agent-strings-render-inert)
- [The audit chain as tamper-evidence](#the-audit-chain-as-tamper-evidence)
- [No telemetry, ever](#no-telemetry-ever)
- [High-stakes: editing the user's settings file](#high-stakes-editing-the-users-settings-file)
- [Bash-classification exclusions as a security decision](#bash-classification-exclusions-as-a-security-decision)
- [Out of scope at v0](#out-of-scope-at-v0)

---

## The v0 security model: localhost binding

> **Security.** Localhost binding **is** the v0 security model. The daemon binds
> `127.0.0.1` only, the address is a hard-coded constant that is never configurable, there
> is no authentication, and there is no CORS. The inbox is served same-origin by the same
> process, so there is no legitimate cross-origin client to authorize — and a request that
> is not addressed to loopback, or that announces another origin, is refused.

There is no network service to attack. Everything — the daemon, the SQLite database, the
policy file, and the browser inbox — lives on one machine on loopback. The bind address is a
constant, not an option:

```ts
// packages/daemon/src/index.ts:39
export const HOST = "127.0.0.1";
export const PORT = 4747;
```

`ServerOptions` lets a caller override the *port* (used by tests to bind an ephemeral port),
but there is deliberately no field for the address — the comment on `port` says so directly:
"The address (HOST) is never configurable." (`packages/daemon/src/index.ts:66`).

The binding is not merely a default; it is asserted at startup, and the daemon refuses to run
if it finds itself bound to anything but loopback:

```ts
// packages/daemon/src/index.ts:460 — startup invariant, covered by a test
for (const addr of app.addresses()) {
  if (addr.address !== HOST) {
    await app.close();
    throw new Error(`FATAL: daemon bound to ${addr.address}, expected ${HOST} only.`);
  }
}
```

Why refuse rather than warn: a daemon that binds a routable interface would expose an
unauthenticated approve/deny surface to the network, which is precisely the thing this model
rules out. The assertion is exercised by a test that starts a real server and checks every
bound address is `127.0.0.1` (`packages/daemon/src/hook-endpoint.test.ts:253`), plus a test
that `HOST` is the constant (`:248`).

**Same-origin UI, no static-file surface.** The inbox is served by the daemon itself, so the
only origin the browser ever talks to is `http://127.0.0.1:4747`. The built assets are loaded
into an in-memory map at startup and served only for known keys — request paths are never
joined onto the filesystem at request time, so there is no path-traversal surface and no
`@fastify/static` dependency:

```ts
// packages/daemon/src/ui-static.ts:8
// Because request paths are looked up in a fixed map (never joined onto the
// filesystem at request time), there is no path-traversal surface.
```

The lookup is a map `get` against pre-loaded keys, returning `404` for anything absent
(`packages/daemon/src/ui-static.ts:82`). UI routes are registered last so `/v1/*` API routes
always win (`ui-static.ts:71`, and the ordering note at `index.ts:420`).

**Local, same-origin requests only.** Binding loopback limits who can *connect*, but a
browser connects on behalf of any page it has open. After a DNS rebind a hostile page is
same-origin as far as the browser is concerned, and only the `Host` header still names its
domain; a plain cross-site page keeps a loopback `Host` but announces its own `Origin`. So
every route requires a loopback `Host`, a browser-sent `Origin` must be the daemon's own,
and no response may be framed:

```ts
// packages/daemon/src/index.ts:432
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
```

A refused request gets `403` — except on `/v1/hook`, which keeps its never-brick contract and
answers `200 {}` without evaluating anything. The hook path also skips the `Origin` rule:
Claude Code is not a browser, and a browser-oriented check must never be able to switch
Brezia off. There, a cross-site page is kept out by the browser's own preflight for JSON
and by payload validation, rather than by this guard.

Three kinds of page are covered. A **rebound** page fails the `Host` rule. A **cross-site**
page fails the `Origin` rule whenever its request announces an `Origin` — every POST, and
every `fetch` or `EventSource` made in CORS mode — and so does a page on another local
port. A page that tries to **frame** the real inbox, to steal a click or the `a` keystroke
that approves, is stopped by the frame headers. What the guard does not refuse is a
cross-site request that carries no `Origin` (a plain navigation, an `<img>`, a `no-cors`
`GET`): the daemon answers it, the browser withholds the response from the page, and no
`GET` route changes state. The tests forge a rebound page, a cross-site page, and a page on
another local port, and assert that each is refused on every route and cannot approve a
held request; a further test asserts the frame headers
(`packages/daemon/src/hook-endpoint.test.ts:272`).

This is the whole of the v0 boundary. It must never be widened: no permissive CORS, no
configurable bind address, no auth bolted on to compensate — the correct posture is *stay on
loopback*.

---

## Untrusted input: agent strings render inert

Every command, path, and reason in a request comes from an AI agent, and a human reads it in
the inbox and in the terminal. These strings are **untrusted input everywhere a human reads
them**. They are validated with zod at every boundary (stdin, HTTP bodies, YAML) and rendered
inertly at every display — never as markdown, links, HTML, or interpreted ANSI.

### In the inbox: text nodes in `<pre>`

The React inbox renders argument values as text nodes inside `<pre>`. React escapes text
nodes, so `<script>`, `[md](links)`, and ANSI escapes all render as literal characters:

```tsx
// packages/ui/src/Card.tsx:7
// Strings pass through unchanged (React renders them as text nodes — never HTML);
// non-strings are JSON-stringified. NOTHING here interprets the value as markdown,
// a link, HTML, or ANSI.
function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
```

```tsx
// packages/ui/src/Card.tsx:82 — pre + text node: <script>, [md](links), ANSI all literal
<dd className="arg__val">
  <pre>{stringify(value)}</pre>
</dd>
```

The tool name, session, and tier are rendered the same way — inert text nodes, never links
(`Card.tsx:52`, `:61`). There is no `dangerouslySetInnerHTML` anywhere in the UI, and no
markdown renderer. This is locked by a permanent **inertness fixture**: a hostile card
carrying `<script>`, a markdown link, an ANSI sequence, and an `onerror` image tag is
rendered to static markup, and the test asserts the HTML is escaped, no anchor is synthesized,
and the ANSI is raw text (`packages/ui/src/Card.test.tsx:8`, `:24`). See
[internals/frontend.md](internals/frontend.md).

### In the terminal: the `inert()` control-char sanitizer

`brezia up` streams a line per decision to the terminal, and those lines include
agent-supplied strings. A crafted command containing ANSI escape sequences could otherwise
spoof, hide, or rewrite lines in that terminal view. The CLI strips C0/C1 control characters —
including the ESC byte that begins ANSI sequences — before printing:

```ts
// packages/cli/src/up.ts:41
export function inert(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue; // C0, DEL, C1
    out += ch;
  }
  return out;
}
```

Every agent-supplied field printed by the decision stream is wrapped in `inert()` — the
command/path, the tool name, and the resolved status (`packages/cli/src/up.ts:73`–`:80`). This
is the same untrusted-input rule as the inbox `<pre>`, applied to the CLI surface.

> **Failure direction.** Neither of these paths can affect a *decision* — they are display
> concerns. The daemon's stats and SSE broadcasts are wrapped so a UI/logging failure can
> never perturb the hook path (`packages/daemon/src/index.ts:128` `broadcastStats`,
> `:403` the SSE setup catch). A rendering bug degrades the view, never the control.

---

## The audit chain as tamper-evidence

The audit log is Brezia's evidence story: an append-only, hash-linked record of every state
change. It does not *prevent* tampering — a determined operator with disk access can edit the
SQLite file — but it makes tampering **detectable**.

Every entry hashes the previous hash concatenated with the exact stored entry JSON:

```ts
// packages/daemon/src/sqlite-storage.ts:16
export function chainHash(prevHash: string, entryJson: string): string {
  return createHash("sha256").update(prevHash + entryJson).digest("hex");
}
```

`verifyAuditChain` walks the whole chain: seq 1's `prev_hash` must be `GENESIS_HASH`, each
row's `prev_hash` must equal the previous row's `hash`, and each stored `hash` must equal
`sha256(prev_hash + entry_json)` recomputed from the **stored string** — never a
re-serialization, so canonical-JSON ordering never enters the trust boundary
(`packages/daemon/src/sqlite-storage.ts:254`). A modified entry breaks its own hash and every
hash after it.

**Append-only is enforced two ways.** First, as discipline plus a source-scan test: there is
no `UPDATE` or `DELETE` statement for `audit_log` anywhere in the storage file, and a test
fails the build if one appears:

```ts
// packages/daemon/src/sqlite-storage.test.ts:179
expect(src).not.toMatch(/\bupdate\s+audit_log\b/i);
expect(src).not.toMatch(/\bdelete\s+from\s+audit_log\b/i);
```

(Note the storage layer *does* `UPDATE requests` — the requests table is a mutable lifecycle
table; the append-only rule applies only to `audit_log`, `sqlite-storage.ts:210`.) Second, as
**invariant 3**: the chain verifies end-to-end after a real held→decide loop, and a test that
corrupts a row out-of-band asserts `verifyAuditChain()` then returns `false`
(`packages/daemon/src/invariants.test.ts:67`, `:81`).

The chain records every state change — event received, policy decision, human decision,
timeout/crash deferral, policy reload — so the log stays truthful even about the decisions
Brezia *declined* to make: a hold that times out or a request left pending by a crash is
chained as a `deferral` (`packages/daemon/src/index.ts:141`, `:322`). `brezia verify` exposes
the walk to an operator, and `brezia export` emits the entries for external audit. Full detail
in [internals/audit-chain.md](internals/audit-chain.md).

---

## No telemetry, ever

Brezia has **no telemetry, no phone-home, and no update checks**. There is no network egress
of any kind — the daemon only *receives* on loopback. The only outbound HTTP in the codebase
is the CLI reading the daemon's own local stats/stream endpoints
(`packages/cli/src/up.ts:54`, `:130`, both to `http://127.0.0.1:4747`). No analytics
endpoint, no crash reporter, no version ping exists anywhere, and none may be added.

---

## High-stakes: editing the user's settings file

`brezia init` and `brezia remove` edit a real Claude Code `settings.json`. This is the most
dangerous thing the product does to a user's machine, and it is built to be safe against the
messy reality of files that already contain other people's hooks.

**Parse defensively — never clobber a file we can't understand.** A settings file that is not
valid JSON, or is valid JSON but not an object, is refused with an actionable error; the file
is left untouched (`packages/cli/src/init.ts:64`–`:84`). A test writes `{ this is not json`,
asserts `init` throws, and asserts the file is byte-for-byte unchanged
(`packages/cli/src/init.test.ts:79`).

**Back up before every write.** A timestamped copy is made before the file is modified, and
the backup is byte-identical to the original (`packages/cli/src/init.ts:86` `backup`;
asserted at `init.test.ts:54`).

**Deep-merge, never overwrite.** The surgery is pure and exhaustively tested against
real-world files. Brezia manages its *own* PreToolUse matcher group, identified solely by the
daemon URL, and never merges into anyone else's group — so adding cannot disturb existing
hooks and removing is a clean drop of one group (`packages/cli/src/settings.ts:1`–`:25`,
`addBreziaHook` at `:56`). Foreign hooks and all other settings are preserved
(`init.test.ts:45`).

**Atomic write.** The new content is written to a sibling temp file and renamed over the
target, so a crash mid-write cannot corrupt `settings.json`:

```ts
// packages/cli/src/init.ts:95
function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.brezia-tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}
```

**Idempotent re-runs, byte-identical restore.** A second `init` makes no change and no second
backup (`init.test.ts:60`). `remove` restores the file byte-for-byte to its pre-init state —
including preserved indent, line endings, and trailing newline for non-canonical files
(4-space + CRLF, tabs + LF + no trailing newline). The original formatting is detected and
reproduced (`packages/cli/src/init.ts:48` `detectFormat`, `:57` `serialize`), and the
byte-identical round trip is a permanent test (`init.test.ts:101`, `:123`–`:141`).

These are the paths to review line-by-line on any change; see the review discipline in
[testing.md](testing.md#the-review-discipline) and the command reference in
[reference/cli.md](reference/cli.md).

---

## Bash-classification exclusions as a security decision

Which Bash commands are eligible for an allow tier is a security boundary, not a convenience.
The classifier fails toward `ask` by construction (decision 005): any compound, expansion, or
redirect construct is unclassifiable, and only a simple command whose leading tokens exactly
match a curated prefix table earns a real class.

The subtle part is that the compound gate does **not** protect against a command's own
dangerous flags. So the curated table deliberately *excludes* commands that look read-only but
carry a plain-argument execute-or-write vector that no shell-metacharacter gate would catch —
`rg` (`--pre` / `--hostname-bin` run an arbitrary program), `tree` (`-o` writes a file),
`file` (`-C -m` compiles and writes a `.mgc`), and `find`/`env`/`node`/`sh`/`awk` (run code):

```ts
// packages/policy/src/bash.ts:20 — read: no plain-argument exec-or-write vector, so
// rg / tree / file / find are excluded even though they look read-only.
```

These exclusions are regression-tested (`packages/policy/src/__tests__/bash.test.ts:55`), and
the load-bearing property — no adversarial string ever classifies into a real class — is a
fuzzing property test (`bash.test.ts:76`). Full reasoning in
[internals/bash-classification.md](internals/bash-classification.md).

---

## Out of scope at v0

The v0 security model is intentionally minimal because the deployment is intentionally
minimal — a single user, on one machine, on loopback. The following are **not built** at v0,
and their absence is a scope decision, not an oversight:

- **Authentication / OAuth.** There is no login; localhost binding is the access control.
- **Multi-approver, delegation, routing.** A single human decides; there is no approver graph.
- **A network/hosted control plane, Postgres, webhooks.** No remote surface exists to secure.
- **Risk scoring, flood detection, an MCP proxy.** Not present; policy is ordered tiers only.
- **`needs_info` as a state.** Deny-with-reason covers it.

The one piece of forward-looking design allowed at v0 is the `StorageAdapter` interface
(decision 003) — an interface, with SQLite as the only implementation. Anything reaching for
these out-of-scope capabilities is scope creep; the `spec-guardian` review agent exists to
flag it (see [testing.md](testing.md#the-review-discipline)).

---

**Next:** [internals/failure-semantics.md](internals/failure-semantics.md) for how every
component fails, [internals/audit-chain.md](internals/audit-chain.md) for the evidence
mechanics, or [testing.md](testing.md) for how these guarantees are held permanent.
