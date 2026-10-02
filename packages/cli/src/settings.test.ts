import { describe, it, expect } from "vitest";
import { addBreziaHook, removeBreziaHook, isInstalled, BREZIA_HOOK_URL } from "./settings";

// A realistic settings.json that already contains OTHER people's hooks + unrelated
// settings. init must never disturb any of this, and remove must leave it identical.
function foreignSettings() {
  return {
    permissions: { allow: ["Bash(git status:*)"], deny: ["Read(./.env)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/audit.sh" }] },
      ],
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "echo done" }] },
      ],
    },
    env: { FOO: "bar" },
  };
}

// addBreziaHook/removeBreziaHook correctly return Json (Record<string, unknown>) —
// real settings.json is untrusted input, so settings.ts never claims a specific shape.
// These assertions inspect the structure the functions just built, so narrow locally
// rather than loosen the production return type.
type Hooked = Record<string, unknown> & {
  hooks: {
    PreToolUse: Array<{ hooks: Array<{ type?: string; url?: string; command?: string }> }>;
    PostToolUse?: unknown;
  };
};
function hooked<T extends { settings: Record<string, unknown> }>(r: T): T & { settings: Hooked } {
  return r as T & { settings: Hooked };
}

describe("addBreziaHook — never clobbers, idempotent", () => {
  it("adds our own PreToolUse group without touching foreign hooks or other settings", () => {
    const original = foreignSettings();
    const { settings, changed } = hooked(addBreziaHook(original));
    expect(changed).toBe(true);
    // foreign PreToolUse group still first and untouched
    expect(settings.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    // our group appended
    const ours = settings.hooks.PreToolUse.at(-1)!;
    expect(ours.hooks[0]!.url).toBe(BREZIA_HOOK_URL);
    // everything else preserved
    expect(settings.permissions).toEqual(original.permissions);
    expect(settings.hooks.PostToolUse).toEqual(original.hooks.PostToolUse);
    expect(settings.env).toEqual(original.env);
  });

  it("creates hooks.PreToolUse when the file has none", () => {
    const { settings, changed } = hooked(addBreziaHook({ permissions: { allow: [] } }));
    expect(changed).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.url).toBe(BREZIA_HOOK_URL);
    expect(settings.permissions).toEqual({ allow: [] });
  });

  it("is idempotent — a second add makes no change and no duplicate", () => {
    const once = addBreziaHook(foreignSettings()).settings;
    const twice = hooked(addBreziaHook(once));
    expect(twice.changed).toBe(false);
    const breziaGroups = twice.settings.hooks.PreToolUse.filter(
      (g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.url === BREZIA_HOOK_URL),
    );
    expect(breziaGroups).toHaveLength(1);
  });

  it("does not mutate the input object (the backup must stay pristine)", () => {
    const original = foreignSettings();
    const snapshot = JSON.stringify(original);
    addBreziaHook(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("tolerates a non-object input (null/array/garbage) → fresh settings", () => {
    for (const bad of [null, undefined, [], 42, "x"]) {
      const { settings, changed } = hooked(addBreziaHook(bad as unknown));
      expect(changed).toBe(true);
      expect(settings.hooks.PreToolUse[0]!.hooks[0]!.url).toBe(BREZIA_HOOK_URL);
    }
  });
});

describe("removeBreziaHook — surgical, foreign hooks survive", () => {
  it("removes only our group, leaving foreign hooks and settings intact", () => {
    const added = addBreziaHook(foreignSettings()).settings;
    const { settings, changed } = hooked(removeBreziaHook(added));
    expect(changed).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1); // foreign group remains
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("/usr/local/bin/audit.sh");
    expect(isInstalled(settings)).toBe(false);
  });

  it("no-op when our hook is not present", () => {
    const { changed } = removeBreziaHook(foreignSettings());
    expect(changed).toBe(false);
  });

  it("strips only our hook from a group we happen to share, keeping the group", () => {
    // A user who manually put our url alongside their own hook in one group.
    const shared = {
      hooks: { PreToolUse: [{ matcher: "*", hooks: [
        { type: "command", command: "mine.sh" },
        { type: "http", url: BREZIA_HOOK_URL, timeout: 300 },
      ] }] },
    };
    const { settings, changed } = hooked(removeBreziaHook(shared));
    expect(changed).toBe(true);
    expect(settings.hooks.PreToolUse[0]!.hooks).toEqual([{ type: "command", command: "mine.sh" }]);
  });
});

describe("byte-identical round-trip (init → remove restores the original)", () => {
  for (const [name, original] of [
    ["file with foreign hooks + settings", foreignSettings()],
    ["file with no hooks", { permissions: { allow: ["Bash(ls:*)"] }, env: { A: "1" } }],
    ["empty file", {}],
  ] as const) {
    it(`${name}: add then remove deep-equals AND serializes identically`, () => {
      const added = addBreziaHook(original).settings;
      const restored = removeBreziaHook(added).settings;
      expect(restored).toEqual(original);
      // 2-space serialization (Claude Code's format) is byte-for-byte identical.
      expect(JSON.stringify(restored, null, 2)).toBe(JSON.stringify(original, null, 2));
    });
  }

  // Documented edge: at remove-time we cannot tell "hooks key was absent" from
  // "hooks key was an empty object" — both are indistinguishable and inert. We
  // optimize byte-identical for the realistic cases above and normalize a rare
  // pre-existing empty `hooks: {}` to absent. Semantically identical to Claude Code;
  // the timestamped backup is the guarantee if a literal restore is ever needed.
  it("normalizes a pre-existing empty hooks:{} to absent (inert, semantically equal)", () => {
    const original = { hooks: {}, model: "sonnet" };
    const restored = removeBreziaHook(addBreziaHook(original).settings).settings;
    expect(restored).toEqual({ model: "sonnet" }); // empty hooks dropped, nothing else
  });
});

describe("isInstalled", () => {
  it("detects our hook, ignores foreign-only and malformed", () => {
    expect(isInstalled(addBreziaHook({}).settings)).toBe(true);
    expect(isInstalled(foreignSettings())).toBe(false);
    expect(isInstalled(null)).toBe(false);
    expect(isInstalled({ hooks: { PreToolUse: "nope" } })).toBe(false);
  });
});
