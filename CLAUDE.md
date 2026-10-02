# Brezia

Operating guide — precedence, the three invariants, hard rules — imported so it
loads every session:

@.private/CLAUDE.md

## Canonical docs (read on demand; precedence order)
- .private/brezia-spec.md — product & strategy (v3.1). Read-only.
- .private/brezia-build-plan.md — construction phases; read the current phase before working in it.
- .private/decisions.md — settled ADRs (append-only). Private: internal rationale/history, never reproduced in docs/. Public docs cite a decision by number only, with no link.

## Environment
- Subagents (.claude/agents/): invariant-guardian, policy-engine, hook-verifier, spec-guardian
- Commands: /new-decision, /check-invariants, /capture-fixture
