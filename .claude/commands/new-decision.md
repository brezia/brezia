---
description: Draft an append-only ADR entry for .private/decisions.md and get approval before appending.
argument-hint: <short topic of the decision>
---

Draft a new ADR-lite entry recording the settled decision about: **$ARGUMENTS**

Follow the append-only discipline exactly — the decisions log is never rewritten, only extended or superseded.

## Steps
1. Locate the decisions file: `.private/decisions.md`. Read it. (This log is private and stays out of the public `docs/` tree and out of git — decisions 001-014 are the settled record; do not reproduce their content anywhere in `docs/`.)
2. Find the highest existing entry number. The next entry is that number + 1, zero-padded to three digits. (Note: entry 008 — hook transport — is currently **Pending**; if this decision *is* the hook-transport outcome, resolve 008 in place per its own instructions rather than creating a new number.)
3. Draft the entry in the house format:
   ```
   ## NNN — <concise title>

   **Accepted · YYYY-MM-DD**   (or **Pending — resolve after <event>** if not yet settled)

   <One tight paragraph: the decision, the alternative rejected, and why. Future-you is the audience. State the disqualifying condition if there is one.>
   ```
   Use today's date. Keep it to one paragraph — the rationale, not a transcript.
4. **Present the drafted entry to me for approval. Do not append until I approve.**
5. On approval, append it to the end of the decisions file. Never edit or reorder existing entries; if this decision changes an earlier one, say "supersedes NNN" in the new entry and leave the old one intact.

If the topic is ambiguous or spans two decisions, ask before drafting.
