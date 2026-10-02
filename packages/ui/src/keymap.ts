// Pure key → intent mapping, unit-tested apart from the DOM. The App turns these
// intents into dispatches and decision POSTs.
export type Intent =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "approve" }
  | { kind: "start_deny" }
  | { kind: "submit_deny" }
  | { kind: "cancel_deny" };

// `denying` = a deny reason input is open. While it is, keystrokes are for typing;
// only Enter (submit) and Escape (cancel) are intents. Otherwise j/k navigate and
// a/d act on the selected card.
export function keyToIntent(key: string, denying: boolean): Intent | null {
  if (denying) {
    if (key === "Enter") return { kind: "submit_deny" };
    if (key === "Escape") return { kind: "cancel_deny" };
    return null;
  }
  switch (key) {
    case "j":
      return { kind: "move", delta: 1 };
    case "k":
      return { kind: "move", delta: -1 };
    case "a":
      return { kind: "approve" };
    case "d":
      return { kind: "start_deny" };
    default:
      return null;
  }
}
