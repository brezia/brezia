---
description: Run the test suite and audit-chain verify, then report the status of Brezia's three invariants.
---

Verify Brezia's three permanent invariants and report a clear status for each.

## Steps
1. If no `package.json` / test suite exists yet (pre-scaffold), say so plainly and stop — report that the invariant tests are not yet present rather than inventing a result.
2. Run the full test suite from the repo root: `npm test`. Capture the output.
3. If the daemon/CLI audit-chain verifier exists (`brezia verify`, or the audit-chain test), run it to walk the chain end to end.
4. Report PASS/FAIL for each invariant, citing the specific test(s) that cover it:
   - **Invariant 1** — no event resolves `allow` without a named matching policy tier (`unmatched: ask`).
   - **Invariant 2** — ingestion never breaks the user: garbage stdin, malformed POSTs, dead sockets, pipeline exceptions all resolve to "no decision"; nothing throws out of the boundary.
   - **Invariant 3** — the audit chain verifies end-to-end.
5. If any invariant test fails, quote the failing output. The invariant is never the thing that's wrong — a failure means the code under test is wrong. Do not weaken, skip, or delete an invariant test to make this pass.

Lead with a one-line overall verdict (all green / which invariant failed), then the per-invariant detail.
