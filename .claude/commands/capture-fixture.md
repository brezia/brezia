---
description: Capture a real Claude Code hook payload into fixtures/, scrubbed, and turn it into a test.
argument-hint: <tool being captured, e.g. bash | write | read | mcp | subagent>
---

Capture a real PreToolUse hook payload for **$ARGUMENTS** into `fixtures/`, following the fixtures ritual.

## The rule this enforces
Never code the Claude Code hook protocol from memory or training data — field names drift between versions. Fixtures come from payloads captured off the **installed** version. Reality outranks documentation.

## Steps
1. Obtain the raw JSON the PreToolUse hook actually received for this tool call. If it isn't already captured, tell me exactly how to produce it (e.g. the hook/log configuration to capture stdin) rather than guessing the shape.
2. **Scrub before saving:** replace secrets, tokens, API keys, and personal paths with fake values — but keep the exact structure, field names, and types. The shape is the test; the values are disposable.
3. Save to `fixtures/` with a descriptive name, e.g. `fixtures/pretooluse-<tool>-01.json`. If a numbered fixture already exists for this tool, increment.
4. Note that this fixture becomes a test input (the policy suite is table-driven: `event + policy → expected decision`). If the target test file exists, add or point out the case to add.
5. Confirm back to me: the file path written, that it was scrubbed, and any field that differs from the documented contract (capture the mismatch — it outranks the doc).

Keep the payload verbatim in structure. Do not normalize, reorder, or "clean up" field names.
