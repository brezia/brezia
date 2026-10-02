import { describe, it, expect } from "vitest";
import { keyToIntent } from "./keymap";

describe("keyToIntent — navigation and actions when no reason box is open", () => {
  it("maps j/k to movement and a/d to approve/start-deny", () => {
    expect(keyToIntent("j", false)).toEqual({ kind: "move", delta: 1 });
    expect(keyToIntent("k", false)).toEqual({ kind: "move", delta: -1 });
    expect(keyToIntent("a", false)).toEqual({ kind: "approve" });
    expect(keyToIntent("d", false)).toEqual({ kind: "start_deny" });
  });

  it("ignores unrelated keys", () => {
    expect(keyToIntent("x", false)).toBeNull();
    expect(keyToIntent("Enter", false)).toBeNull();
    expect(keyToIntent("Escape", false)).toBeNull();
  });
});

describe("keyToIntent — while a deny reason box is open", () => {
  it("only Enter (submit) and Escape (cancel) are intents; everything else types", () => {
    expect(keyToIntent("Enter", true)).toEqual({ kind: "submit_deny" });
    expect(keyToIntent("Escape", true)).toEqual({ kind: "cancel_deny" });
    // j/k/a/d must fall through so they can be typed into the reason.
    for (const key of ["j", "k", "a", "d", "z", " "]) {
      expect(keyToIntent(key, true)).toBeNull();
    }
  });
});
