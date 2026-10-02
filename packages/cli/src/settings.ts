// Pure settings surgery for `brezia init` / `brezia remove`. NO file I/O here — this
// operates on a parsed settings object so it can be hammered in tests against
// real-world files (other people's hooks, no hooks, malformed shapes) before any
// user's settings.json is ever touched. The file I/O + backup live in the command.
//
// HIGH-STAKES (CLAUDE.md): this edits users' Claude Code settings. The rules:
// never clobber existing hooks, idempotent re-runs, and `remove` leaves everything
// except our own entry byte-identical.
//
// Strategy: Brezia manages its OWN PreToolUse matcher group — a group whose single
// hook targets our daemon URL. We never merge into someone else's group, so adding
// can't disturb their hooks and removing is a clean drop of our group. Our entry is
// identified solely by the daemon URL below.

export const BREZIA_HOOK_URL = "http://127.0.0.1:4747/v1/hook";
export const BREZIA_HOOK_TIMEOUT = 300;

// The exact group we write. Shape verified live against the installed Claude Code
// (decisions.md 008): type "http", url, timeout under hooks.PreToolUse[].hooks.
function breziaGroup(): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [{ type: "http", url: BREZIA_HOOK_URL, timeout: BREZIA_HOOK_TIMEOUT }],
  };
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Does this single hook target our daemon URL?
function isBreziaHook(hook: unknown): boolean {
  return isObject(hook) && hook["url"] === BREZIA_HOOK_URL;
}

// Does any PreToolUse group already carry our hook?
export function isInstalled(settings: unknown): boolean {
  if (!isObject(settings)) return false;
  const hooks = settings["hooks"];
  if (!isObject(hooks)) return false;
  const pre = hooks["PreToolUse"];
  if (!Array.isArray(pre)) return false;
  return pre.some((group) => isObject(group) && Array.isArray(group["hooks"]) && group["hooks"].some(isBreziaHook));
}

// Deep clone so callers never mutate the parsed original (the backup must stay the
// true pre-edit state). structuredClone is in Node LTS.
function clone<T>(v: T): T {
  return structuredClone(v);
}

// Add our matcher group. Idempotent: if our hook is already present, returns the
// input unchanged with changed=false. Everything else in `settings` is preserved.
export function addBreziaHook(settings: unknown): { settings: Json; changed: boolean } {
  const base: Json = isObject(settings) ? clone(settings) : {};
  if (isInstalled(base)) return { settings: base, changed: false };

  const hooks: Json = isObject(base["hooks"]) ? (base["hooks"] as Json) : {};
  const pre: unknown[] = Array.isArray(hooks["PreToolUse"]) ? (hooks["PreToolUse"] as unknown[]) : [];
  pre.push(breziaGroup());
  hooks["PreToolUse"] = pre;
  base["hooks"] = hooks;
  return { settings: base, changed: true };
}

// Remove our hook everywhere it appears, dropping any group we thereby empty, then
// cleaning up the PreToolUse array / hooks object ONLY if we left them empty (so a
// file that had no hooks before init returns to having none). Foreign hooks and all
// other settings are untouched.
export function removeBreziaHook(settings: unknown): { settings: Json; changed: boolean } {
  const base: Json = isObject(settings) ? clone(settings) : {};
  const hooks = base["hooks"];
  if (!isObject(hooks) || !Array.isArray(hooks["PreToolUse"])) {
    return { settings: base, changed: false };
  }

  let changed = false;
  const kept: unknown[] = [];
  for (const group of hooks["PreToolUse"] as unknown[]) {
    if (!isObject(group) || !Array.isArray(group["hooks"])) {
      kept.push(group);
      continue;
    }
    const before = group["hooks"].length;
    const remaining = (group["hooks"] as unknown[]).filter((h) => !isBreziaHook(h));
    if (remaining.length !== before) changed = true;
    if (remaining.length === 0) continue; // group held only our hook → drop it
    kept.push({ ...group, hooks: remaining });
  }

  if (kept.length > 0) {
    (hooks as Json)["PreToolUse"] = kept;
  } else {
    delete (hooks as Json)["PreToolUse"];
  }
  // If we emptied the hooks object entirely, drop it so the file returns to its
  // pre-init shape (supports byte-identical restore for standard-formatted files).
  if (Object.keys(hooks).length === 0) {
    delete base["hooks"];
  }
  return { settings: base, changed };
}
