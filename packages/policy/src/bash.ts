import { parse } from "shell-quote";

// The sentinel class for any command Brezia will not vouch for. It is never a
// member of an allow tier by construction (matchBash in evaluate.ts refuses it),
// so anything unclassifiable falls toward ask.
export const UNCLASSIFIABLE = "unclassifiable";

// Any of these characters implies a compound command, expansion, substitution,
// or redirect — unclassifiable by construction (fail toward ask). Checked against
// the RAW string so an escaped or quoted operator cannot sneak a safe class:
// `;` `&` `|` `<` `>` `$` backtick `(` `)` `{` `}` and newlines.
const COMPOUND = /[;&|<>$`(){}\n\r]/;

// Curated prefix table: a token prefix maps to a class. Small and conservative for
// v0; the default policy pack tunes it. A command classifies only when its LEADING
// tokens exactly equal an entry's prefix (token equality, not substring).
const PREFIX_TABLE: ReadonlyArray<{ prefix: readonly string[]; klass: string }> = [
  // read: inspect files/dirs, no mutation, no code execution IN THE PLAIN FORM. A
  // redirect (`>`) or substitution carries a COMPOUND char and never reaches here,
  // but that gate does NOT protect against a command's OWN dangerous flags — so
  // every entry must have no plain-argument exec-or-write vector. Deliberately
  // EXCLUDES: find/xargs (-exec), env/node/sh/awk (run code), and notably `rg`
  // (--pre / --hostname-bin execute a program), `tree` (-o writes a file), and
  // `file` (-C -m compiles/writes) — all of which look read-only but are not.
  { prefix: ["ls"], klass: "read" },
  { prefix: ["cat"], klass: "read" },
  { prefix: ["head"], klass: "read" },
  { prefix: ["tail"], klass: "read" },
  { prefix: ["pwd"], klass: "read" },
  { prefix: ["wc"], klass: "read" },
  { prefix: ["stat"], klass: "read" },
  { prefix: ["grep"], klass: "read" }, // GNU grep has no exec/write flag (unlike rg)
  { prefix: ["which"], klass: "read" },
  { prefix: ["echo"], klass: "read" },
  { prefix: ["du"], klass: "read" },
  // vcs-read: git subcommands that only read. EXCLUDES anything that mutates the
  // repo/index/config/refs (push, commit, add, branch -d, remote add, config set).
  //
  // Considered and ruled out: diff/log/show can invoke an external diff/textconv
  // tool (via .gitattributes `diff=<driver>` + a matching `diff.<driver>.command`
  // in git config) or a pager (`core.pager`) — a plain-form exec side channel in
  // the same family as the rg/tree/file findings below. Verified empirically
  // (packages/policy: bash hardening pass) that .gitattributes ALONE — the part a
  // hostile repo can actually ship via a normal clone — does nothing without a
  // matching driver already defined in *local* git config, which a clone cannot
  // supply. The attack requires the victim to have pre-configured the dangerous
  // driver themselves, outside Brezia's threat model (an agent operating on a
  // repo it was just handed). Left in the table; revisit if a git-native way to
  // ship driver config via repo content is ever found.
  //
  // Found and FIXED (not just considered) in the same pass: diff/log/show/blame
  // accept `--output=<file>` / `--output <file>` (git 2.35.1, live-verified —
  // exit 0, no stdout, file written; `blame --output=` creates/truncates the
  // target even though blame's own output still goes to stdout). Zero shell
  // metacharacters, so COMPOUND never sees it — a plain-argument write vector in
  // the same family as rg/tree/file, just missed in that pass. status/rev-parse/
  // ls-files/describe correctly reject `--output` (confirmed) and stay
  // unaffected. See hasGitOutputRedirect below — checked BEFORE this table
  // returns vcs-read for diff/log/show/blame specifically, not a table removal,
  // since blocking one flag preserves the auto-resolve value of routine
  // `git diff`/`git log` with ~zero legitimate cost (an agent has no reason to
  // redirect git's own output to a file instead of the stdout Claude Code
  // already captures).
  { prefix: ["git", "status"], klass: "vcs-read" },
  { prefix: ["git", "diff"], klass: "vcs-read" },
  { prefix: ["git", "log"], klass: "vcs-read" },
  { prefix: ["git", "show"], klass: "vcs-read" },
  { prefix: ["git", "rev-parse"], klass: "vcs-read" },
  { prefix: ["git", "ls-files"], klass: "vcs-read" },
  { prefix: ["git", "blame"], klass: "vcs-read" },
  { prefix: ["git", "describe"], klass: "vcs-read" },
  // test / build: routine dev loops.
  { prefix: ["npm", "test"], klass: "test" },
  { prefix: ["pytest"], klass: "test" },
  { prefix: ["vitest"], klass: "test" },
  { prefix: ["npm", "run", "build"], klass: "build" },
  { prefix: ["tsc"], klass: "build" },
];

// diff/log/show/blame's `--output`/`-o` redirect the command's own output (or,
// for blame, still create/truncate the target) to an arbitrary path with no
// shell metacharacter at all. Matched defensively — both `--output=X` (one
// token) and `--output X` (X as the next token) are live-confirmed on git
// 2.35.1; `-o`/`-oX` are NOT currently accepted by these subcommands on that
// version, but are blocked anyway since that's a git-version/build detail we
// don't want this classifier's safety resting on. A bare `-o`-prefixed token is
// never a legitimate argument to these subcommands, so this cannot reject a real
// use — worst case it fails toward ask, never toward allow.
const GIT_OUTPUT_LIKE_SUBCOMMANDS = new Set(["diff", "log", "show", "blame"]);
const GIT_OUTPUT_FLAG = /^(--output(=.*)?|-o.*)$/;

function hasGitOutputRedirect(strs: readonly string[]): boolean {
  return (
    strs[0] === "git" &&
    GIT_OUTPUT_LIKE_SUBCOMMANDS.has(strs[1] ?? "") &&
    strs.slice(2).some((t) => GIT_OUTPUT_FLAG.test(t))
  );
}

// Classify a Bash command string into a curated class, or UNCLASSIFIABLE. The
// parser is deliberately dumb and conservative: any compound/expansion/redirect
// construct, any parse failure, and any command not in the table are all
// UNCLASSIFIABLE. It must never classify an adversarial string into a real class.
export function classifyBash(command: unknown): string {
  if (typeof command !== "string") return UNCLASSIFIABLE;
  if (COMPOUND.test(command)) return UNCLASSIFIABLE;

  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    return UNCLASSIFIABLE;
  }

  // After the COMPOUND check every token should be a plain string; if shell-quote
  // still produced an operator/glob/comment object, bail conservatively.
  if (tokens.some((t) => typeof t !== "string")) return UNCLASSIFIABLE;
  const strs = tokens as string[];
  if (strs.length === 0) return UNCLASSIFIABLE;
  if (hasGitOutputRedirect(strs)) return UNCLASSIFIABLE;

  for (const entry of PREFIX_TABLE) {
    if (
      strs.length >= entry.prefix.length &&
      entry.prefix.every((p, i) => strs[i] === p)
    ) {
      return entry.klass;
    }
  }
  return UNCLASSIFIABLE;
}
