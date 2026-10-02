# Flags — anomaly & context signals

> The booleans computed *before* policy runs. Matchers may require them, and the inbox card
> always displays them. The v0 set is three: `secrets_pattern`, `first_time_tool`,
> `first_time_command`. Small, curated, and additive-only after v0.

Flags are computed by `computeFlags()` in `packages/policy/src/flags.ts:21`; the
`secrets_pattern` heuristic lives in `looksLikeSecret()` at
`packages/shared/src/index.ts:223`. Read [concepts.md](../concepts.md#flags--anomaly--context-signals)
for the `Flags` type and `FLAG_NAMES`.

## Contents

- [Flags run before policy](#flags-run-before-policy)
- [The three flags](#the-three-flags)
- [secrets_pattern: the pattern set](#secrets_pattern-the-pattern-set)
- [The high-entropy heuristic and what it skips](#the-high-entropy-heuristic-and-what-it-skips)
- [first_time_tool / first_time_command](#first_time_tool--first_time_command)
- [Testing both ways + the captured fixture](#testing-both-ways--the-captured-fixture)

---

## Flags run before policy

`computeFlags` is called in the hook pipeline *before* `evaluate()` and *before* the event
is persisted (`packages/daemon/src/index.ts:230`), so first-time detection is always
measured against the *past* (see
[request-lifecycle.md](request-lifecycle.md#the-pipeline-stages)). Two consumers use the
result: matchers may require a flag via the `flags:` condition (AND-within-matcher — see
[policy-evaluation.md](policy-evaluation.md#the-matcher-algebra)), and the held card always
carries `flags` so a human sees them (`cardPayload`, `index.ts:108`).

The function is **pure**. Secrets detection needs nothing external; the first-time flags need
a `HistoryLookup`, which is *injected* so the policy layer never touches storage:

```ts
// packages/policy/src/flags.ts:21
export function computeFlags(event: ApprovalEvent, history?: HistoryLookup): Flags {
  const flags: Flags = {};
  const strings: string[] = [];
  collectStrings(event.arguments, strings);
  if (strings.some((s) => looksLikeSecret(s))) flags.secrets_pattern = true;
  if (history !== undefined) {
    if (!history.hasSeenTool(event.tool)) flags.first_time_tool = true;
    const command = event.arguments["command"];
    if (typeof command === "string" && !history.hasSeenCommand(command)) {
      flags.first_time_command = true;
    }
  }
  return flags;
}
```

A flag is only ever *set to `true`* — a false flag is simply absent (`Flags` is a
`Partial<Record<FlagName, boolean>>`). The matcher's `active[f] === true` check
(`evaluate.ts:44`) treats absent as not-active, so the two representations are equivalent.

`collectStrings` (`flags.ts:10`) walks the arguments recursively — strings, arrays, and
nested objects — so a credential buried in a nested/array value is still scanned. That
nested case is asserted at `packages/policy/src/__tests__/flags.test.ts:24`
(`headers: ["Authorization: Bearer ghp_…"]`).

---

## The three flags

| Flag | True when | Needs history? | Source |
|---|---|---|---|
| `secrets_pattern` | any string in `arguments` looks like a credential | no | `looksLikeSecret`, `shared/src/index.ts:223` |
| `first_time_tool` | this `tool` has no prior persisted event | yes | `history.hasSeenTool`, `flags.ts:29` |
| `first_time_command` | this `arguments.command` string has no prior persisted event | yes | `history.hasSeenCommand`, `flags.ts:31` |

When no `history` is supplied (e.g. a pure unit test), the first-time flags are simply not
computed — the block is skipped entirely (`flags.test.ts:47`). In the daemon, history is
always supplied via `SqliteHistory` (`packages/daemon/src/derived.ts:7`), which derives
"seen" from the persisted events table (decision 012 — no in-memory shadow); see
[persistence.md](persistence.md) and [aggregation-limits.md](aggregation-limits.md#the-derived-counter)
for the same Option-A derivation pattern.

---

## secrets_pattern: the pattern set

`looksLikeSecret` runs three checks in order — curated regexes, then a `.env` reference,
then the high-entropy heuristic — and is true if any fires:

```ts
// packages/shared/src/index.ts:223
export function looksLikeSecret(text: string): boolean {
  if (typeof text !== "string") return false;
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  if (ENV_FILE_REF.test(text)) return true;
  return hasHighEntropyToken(text);
}
```

The curated regex set (`SECRET_PATTERNS`, `shared/src/index.ts:179`) targets specific
credential shapes plus two context-based patterns:

| Pattern | Catches | Source |
|---|---|---|
| `-----BEGIN … PRIVATE KEY-----` | PEM private keys (RSA, OPENSSH, …) | `index.ts:180` |
| `A(KIA\|SIA)[0-9A-Z]{16}` | AWS access key ids | `index.ts:181` |
| `gh[pousr]_[A-Za-z0-9]{20,}` | GitHub tokens | `index.ts:182` |
| `xox[baprs]-…` | Slack tokens | `index.ts:183` |
| `AIza[0-9A-Za-z_\-]{20,}` | Google API keys | `index.ts:184` |
| `sk-[A-Za-z0-9]{20,}` | OpenAI-style secret keys | `index.ts:185` |
| `pk_(live\|test)_…` | Stripe publishable-style keys | `index.ts:186` |
| key/value credential | `api_key`/`secret`/`token`/`password`/`passwd`/`pwd` `= : ` value ≥12 chars | `index.ts:189` |
| Authorization header | `authorization: (bearer\|token\|basic\|digest) <token>` | `index.ts:194` |

Two of these carry extra design in their regex:

**JSON-quoted key/value.** The credential key/value pattern makes the quote before the
separator optional, so it catches both shell/env (`secret=…`, `token: …`) *and* JSON
(`"client_secret": "…"`) forms — the quote no longer hides the secret:

```ts
// packages/shared/src/index.ts:189
/(?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-/+]{12,}/i,
```

**Authorization headers.** A live credential in an `Authorization` header can be
low-entropy or opaque — a shape the entropy heuristic would miss. So this pattern keys on
the *header context* (`Bearer`/`Token`/`Basic`/`Digest`), flagging the credential regardless
of the token's own randomness. Common in `curl -H "Authorization: Bearer …"`:

```ts
// packages/shared/src/index.ts:194
/\bauthorization\s*:\s*(?:bearer|token|basic|digest)\s+[A-Za-z0-9._~+/=-]{6,}/i,
```

> **Why the header pattern exists.** It was added after a live dogfooding session where a
> bearer-carrying `curl` slipped the secrets flag — the token was too opaque for the entropy
> check and matched no key/value shape. Keying on the header context closes that gap
> (`secrets.test.ts:19` comment; captured as a permanent fixture — see below).

**`.env` references** (`ENV_FILE_REF`, `shared/src/index.ts:199`) catch `curl --data @.env`,
`cat .env.production`, etc. The regex is bounded by a leading separator class
(`(?:^|[\s"'=@/])`) so it does not fire inside unrelated words.

---

## The high-entropy heuristic and what it skips

If nothing curated matches, `hasHighEntropyToken` looks for a long random-looking token —
but is tuned hard for **precision**, to avoid flagging the many long non-secret strings a dev
session produces (git SHAs, hashes, ids):

```ts
// packages/shared/src/index.ts:212
function hasHighEntropyToken(text: string): boolean {
  for (const token of text.match(/[A-Za-z0-9+/_-]{32,}={0,2}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(token)) continue; // hex (SHAs, hashes) — skip
    if (/^[0-9]+$/.test(token)) continue;      // pure digits — skip
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(token)).length;
    if (classes >= 3 && shannonEntropy(token) >= 4.0) return true;
  }
  return false;
}
```

The heuristic **deliberately skips**:

- **Pure hex runs** — git SHAs and sha256 digests are hex; a 40-hex SHA or a 64-hex digest
  must not flag (`secrets.test.ts:44`).
- **Pure decimal runs** — long numeric ids.

And it only fires on a token that is ≥32 chars, mixes ≥3 character classes (lower, upper,
digit), *and* clears a Shannon entropy of 4.0 bits/char. Real base64-ish secret blobs clear
all four; prose and identifiers do not. Entropy is a plain Shannon calculation over character
frequencies (`shannonEntropy`, `shared/src/index.ts:201`).

---

## first_time_tool / first_time_command

These are context signals, not anomaly detectors: they surface *novelty*. `first_time_tool`
is set when the events table has no prior row for this `tool`; `first_time_command` is set
only when `arguments.command` is a string and has never been seen. A tool that carries no
command string (e.g. `Read` with a `file_path`) gets `first_time_tool` but never
`first_time_command` — asserted at `flags.test.ts:53`. Against an empty history, both fire;
against a fully-seen history, neither does (`flags.test.ts:35`, `:41`).

Because flags compute against *prior* events (before the current insert), the first event of
a session naturally trips these — which is the intended signal for a card ("this agent has
never run this before"). The daemon surfaces `first_time_command` on a held card in
`packages/daemon/src/hook-endpoint.test.ts:211`.

---

## Testing both ways + the captured fixture

The secrets detector is tested **both ways** — it must catch real secrets *and* ignore
innocent strings — because a false positive is as harmful to trust as a false negative. The
"ignores" list is as load-bearing as the "flags" list:

```ts
// packages/shared/src/secrets.test.ts:37 — must NOT flag
"git status",
"git show a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", // a git SHA (40 hex)
"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // sha256
"1234567890123456789012345678901234567890",           // pure digits
"we need authorization to proceed with the deploy",    // prose mentioning "authorization"
"token economics is the topic of the talk",            // prose mentioning "token"
```

Prose that merely *mentions* `authorization`/`bearer`/`token` carries no credential and must
not flag — the header pattern requires the `Bearer|Token|Basic|Digest` context and a
following token, so `"authorization: pending manager review"` stays clean.

The **fixtures ritual** (a real payload captured from a live session becomes a permanent
regression test) applies here: the bearer-`curl` that slipped the flag before the
Authorization pattern existed is frozen as `fixtures/pretooluse-secret-curl.json` and
asserted to flag now:

```ts
// packages/shared/src/secrets.test.ts:66
it("flags the bearer-credential curl from the live session", () => {
  const command = JSON.parse(readFileSync(path, "utf8")).tool_input.command as string;
  expect(looksLikeSecret(command)).toBe(true);
});
```

The daemon-level integration — a secrets-shaped command tripping a `secrets_pattern` deny
tier — is asserted at `hook-endpoint.test.ts:195`, closing the loop from raw arguments to an
emitted decision.

---

**Related:** [policy-evaluation.md](policy-evaluation.md#the-matcher-algebra) (the `flags:`
matcher, AND semantics) · [request-lifecycle.md](request-lifecycle.md#the-pipeline-stages)
(flags-before-policy) · [persistence.md](persistence.md) (derived history) ·
[frontend.md](frontend.md) (flag banners on the card) ·
[../reference/policy-format.md](../reference/policy-format.md).
