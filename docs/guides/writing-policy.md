# Writing policy

> How to author a `brezia.yaml` that clears your routine and holds the rest — the file
> structure, the shipped default read line by line, hot-reload behavior, common tiers, and
> how to test a change safely.

Your policy is the whole point of Brezia: it is the thing that decides which tool calls
clear themselves and which wait for you. This guide is task-oriented — how to write and
tune the file. For the exhaustive field-by-field spec see
[../reference/policy-format.md](../reference/policy-format.md); for how a decision is
actually computed see [../internals/policy-evaluation.md](../internals/policy-evaluation.md).

## Contents

- [The mental model](#the-mental-model)
- [File structure](#file-structure)
- [Reading the shipped default](#reading-the-shipped-default)
- [Common tiers and patterns](#common-tiers-and-patterns)
- [Hot reload — edit and it takes effect](#hot-reload--edit-and-it-takes-effect)
- [Testing a policy change](#testing-a-policy-change)

---

## The mental model

Think of `brezia.yaml` as a **firewall rule set**: an ordered list of tiers, evaluated top
to bottom, **first match wins** (decision 004). There is no scoring, no weighting, no
"most specific rule" — outcomes are derivable by reading the file straight down. Two rules
follow from that and never change:

- **`unmatched: ask` is the floor.** Anything that matches no tier waits for a human.
  Nothing is ever allowed by omission. This is invariant 1
  ([../concepts.md](../concepts.md#policyresult--the-output-of-evaluation)).
- **Order encodes priority.** Put the tiers that must win — like the secrets escalation —
  *above* the allow tiers, because the first match stops evaluation.

A tier's `match` is a list of **matchers**. A tier fires if **any** matcher matches (OR
across the list). A single matcher matches only if **all** its conditions hold (AND within
the matcher): the `tool`, every `args` pattern, every `bash` class, and every `flag`. This
"AND within, OR across" gives you full boolean expressiveness — disjunctive normal form
([../concepts.md](../concepts.md#the-policy-format-breziayaml)).

---

## File structure

Every `brezia.yaml` has four top-level keys (`packages/shared/src/index.ts:161`):

```yaml
version: 1          # literal 1 — the schema version
defaults: { ... }   # the floor: unmatched, and (reserved) on_expiry
tiers: [ ... ]      # ordered rules, first match wins
limits: [ ... ]     # optional aggregation ceilings (anti-splitting)
```

**`defaults`** is the floor (`packages/shared/src/index.ts:152`):

```yaml
defaults:
  unmatched: ask     # or `deny`. Never `allow` — there is no allow-by-omission.
  on_expiry: defer   # reserved for enforced mode; `defer` on the single-player daemon
```

`unmatched` is `ask` or `deny` and nothing else — the schema rejects `allow`. `on_expiry`
(`deny`/`defer`) is accepted but reserved for a future enforced mode (decision 006); at v0
a held call that outlives the hook window simply defers to the native flow.

**A tier** is a named rung (`packages/shared/src/index.ts:125`):

```yaml
- name: allow-reads      # required, non-empty — shown on the inbox card
  match: [ ... ]         # a list of matchers (OR)
  action: allow          # allow | ask | deny
```

`route` and `batch` are **v1-reserved** keys: accepted and ignored so a forward-compatible
policy still loads on the v0 daemon, but every *other* unknown key is rejected loudly
(decision 014, `.strict()` schemas). A typo like `matches:` instead of `match:` will fail
validation rather than silently disable your rule — which is exactly what you want.

**A matcher** is the atom (`packages/shared/src/index.ts:112`):

```yaml
- tool: Bash             # exact name, or a picomatch glob like "mcp__*"
  args: { command: "npm run test*" }   # per-arg glob; prefix `re:` for a regex
  bash: [read, vcs-read]               # required bash classes (Bash only)
  flags: [secrets_pattern]             # required flags
```

Argument values are picomatch globs by default; prefix a value with `re:` to match it as a
regular expression instead. All present conditions must hold together.

**`limits`** are aggregation ceilings (`packages/shared/src/index.ts:143`) — see
[Common tiers and patterns](#common-tiers-and-patterns).

---

## Reading the shipped default

The bundled pack, `policy-packs/claude-code-default.yaml`, is written to double as the
format reference — its comments *are* documentation. `brezia init` copies it as your
starter policy. Here it is with the reasoning behind each tier.

**Defaults — the floor:**

```yaml
# policy-packs/claude-code-default.yaml:13
defaults:
  unmatched: ask     # No allow by omission: any event matching no tier asks a human.
  on_expiry: defer   # A held call that outlives the hook window defers to the native flow.
```

**Tier 1 — secrets first.** Placed at the top so it wins over the allow tiers below. Any
argument that looks like a credential sets the `secrets_pattern`
[flag](../internals/flags.md), and this tier escalates it to `ask` *whatever the tool* —
so `cat .env` is a read, but it still stops here:

```yaml
# policy-packs/claude-code-default.yaml:26
- name: escalate-secrets
  match:
    - flags: [secrets_pattern]
  action: ask
```

**Tier 2 — read-only.** Read-only tools and classified-safe shell reads auto-resolve. The
`bash` classes come from a curated table (`read`: `ls`, `cat`, `head`, `grep`, `which`,
`echo`, `wc`, `stat`, `pwd`; `vcs-read`: `git status`/`diff`/`log`/`show`/…). A compound or
expansion command is unclassifiable and never matches here — it falls through to `ask`
([../internals/bash-classification.md](../internals/bash-classification.md)):

```yaml
# policy-packs/claude-code-default.yaml:36
- name: allow-reads
  match:
    - tool: Read
    - tool: Grep
    - tool: Glob
    - tool: Bash
      bash: [read, vcs-read]
  action: allow
```

**Tier 3 — routine dev.** Running tests and builds auto-resolves. This deliberately does
*not* cover `npm install`, an arbitrary `npm run <script>`, or `make`, which mutate or run
arbitrary scripts and so remain `ask`:

```yaml
# policy-packs/claude-code-default.yaml:49
- name: allow-dev
  match:
    - tool: Bash
      bash: [test, build]
  action: allow
```

Everything else — `Write`, `Edit`, mutating shell, network tools, any unclassifiable
command — has no matching tier and falls to `unmatched: ask`.

**Limits — the anti-splitting ceiling.** After 200 auto-allows in a day for one session,
further would-be allows escalate to `ask`, so an agent cannot launder one large change into
many individually-cheap approved calls (decision 013; ships in v0, not deferred):

```yaml
# policy-packs/claude-code-default.yaml:62
limits:
  - per: session
    window: 24h
    max_asks_auto_allowed: 200
```

---

## Common tiers and patterns

Building blocks you can adapt. Remember: order matters, and escalations go above allows.

**Escalate anything touching a specific path** (regex arg):

```yaml
- name: protect-prod-config
  match:
    - args: { file_path: "re:.*/(prod|production)/.*" }
  action: ask
```

**Auto-allow a specific safe command via arg glob** (rather than a whole bash class):

```yaml
- name: allow-npm-test
  match:
    - tool: Bash
      args: { command: "npm run test*" }
  action: allow
```

Note the compound-command floor still protects you: `npm run test && rm -rf /` is
unclassifiable and would be held regardless, because Brezia's bash handling treats any
`&&`/`|`/`$(`/backtick construct as unclassifiable and fails toward `ask`
([../internals/bash-classification.md](../internals/bash-classification.md)).

**Deny outright** (rare — usually `ask` is friendlier, since deny-with-reason covers it):

```yaml
- name: never-force-push
  match:
    - tool: Bash
      args: { command: "git push*--force*" }
  action: deny
```

**Flag a first-time tool for review:**

```yaml
- name: review-new-tools
  match:
    - flags: [first_time_tool]
  action: ask
```

**Tune the aggregation ceiling** per dimension. `per` is `agent`, `tool`, or `session`;
`window` is a duration like `24h`, `30m`, `90s`; `max_asks_auto_allowed` is the cap:

```yaml
limits:
  - { per: tool, window: 1h, max_asks_auto_allowed: 50 }
  - { per: session, window: 24h, max_asks_auto_allowed: 200 }
```

The counter counts only *final* auto-allows and **fails toward the breach** on an
unevaluable key — details in
[../internals/aggregation-limits.md](../internals/aggregation-limits.md).

---

## Hot reload — edit and it takes effect

You do not restart the daemon to change policy. The daemon watches your `brezia.yaml` with
chokidar and reloads on change; the load path is **parse → validate → atomic swap**
(`packages/daemon/src/policy-loader.ts`).

The critical property: **an invalid file never fails open.** On a bad edit, the daemon
keeps the *previous* good policy and records the error — it never crashes, never falls back
to allow-everything, never drops to an empty policy silently:

```ts
// packages/daemon/src/policy-loader.ts:65
load(path: string): boolean {
  const r = loadPolicyFile(path);
  if (r.ok && r.policy !== undefined) {
    this.current = r.policy; // atomic swap
    this.lastError = null;
    return true;
  }
  this.lastError = r.error ?? "unknown policy load error";
  return false;   // keep the current policy
}
```

`loadPolicyFile` returns a structured error (never throws) for each failure mode — file
unreadable, invalid YAML, or a schema violation with the offending path
(`policy-loader.ts:21`). The "atomic swap" is simply the single reference assignment
`this.current = r.policy`: evaluation always reads a complete, valid policy object; it is
never observed half-updated.

When you save the file, the daemon:

1. tries to load it;
2. on success, swaps in the new policy, logs `policy reloaded`, and clears the inbox banner;
3. on failure, keeps the old policy, logs `policy reload rejected: <error>`, and pushes the
   error to the inbox as a red banner (`packages/daemon/src/index.ts:158`).

Every reload — good or bad — is chained into the audit log as a `policy_reload` entry
(`packages/daemon/src/index.ts:164`), so the record shows exactly when policy changed and
whether it took. The banner uses the same `policy.error` SSE event with `error: null` to
clear on a good reload ([../internals/frontend.md](../internals/frontend.md#sse-wiring-and-optimistic-resolve)).

> **Why never-fail-open matters.** This code sits in the tool-call path. A malformed edit
> mid-session must not silently disable governance or brick the agent. Keeping the last
> good policy means a typo costs you nothing but a banner until you fix it. This is the
> policy-layer expression of "fail toward `ask`, never toward `allow`"
> ([../internals/failure-semantics.md](../internals/failure-semantics.md)).

If no policy can be loaded at startup at all, the daemon uses a safe default —
`unmatched: ask` with zero tiers, i.e. *hold everything* — never an allow
(`packages/daemon/src/policy-loader.ts:7`).

---

## Testing a policy change

You have three ways to gain confidence, cheapest first.

**1. Validate by watching the reload.** With `brezia up` running, edit `brezia.yaml` and
save. The `up` terminal prints `policy reloaded` on success or `POLICY ERROR: <detail>` on
a rejected file (`packages/cli/src/up.ts:79`), and the inbox shows the same. If you see an
error, the *old* policy is still in force — fix and save again. This is the fastest loop
for catching typos and schema mistakes.

**2. Exercise it live.** Run the tool calls you care about in a Claude Code session and
watch where they land — cleared silently, or held with a tier label on the card. The card
shows the matched tier name (or `unmatched`), which tells you *which* rule fired, and any
flags that were set. Because evaluation is first-match-wins and order-sensitive, seeing the
tier name is the quickest way to catch a rule that a higher tier shadowed.

**3. Trust the engine's own test suite.** The evaluator is the most-tested code in the
repo: exhaustive table-driven fixtures of `(event + policy) → expected decision`, plus a
property test asserting no adversarial string ever classifies into an allow class
(`packages/policy/src/*.test.ts`, described in [../testing.md](../testing.md)). You do not
write those tests to author a policy — but they are why you can rely on the semantics: AND
within a matcher, OR across a tier, first match wins, and unmatched holds.

A good workflow: start from the shipped default, add one tier at a time above or below the
allow tiers, save, and confirm in the `up` stream and the inbox that calls land where you
expect before moving on.

---

**Next:** [../reference/policy-format.md](../reference/policy-format.md) for every field and
the matcher algebra in full, or [operations.md](operations.md) for running the daemon and
the audit log.
