import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "./Card";
import type { Card as CardData } from "./types";

// The untrusted-input rule as a permanent test: agent-supplied strings must
// render inert — never HTML, never a link, never interpreted markdown or ANSI.
const HOSTILE: CardData = {
  id: "h1",
  session: "sess-x",
  tool: "Bash",
  arguments: {
    command: "<script>alert('xss')</script>",
    note: "click here: [click me](http://evil.example)",
    ansi: "[31mred[0m danger",
    img: "<img src=x onerror=alert(1)>",
  },
  flags: { secrets_pattern: true },
  createdTs: 1,
  cwd: "/home/dev/project",
  policyTier: "needs-review",
};

describe("Card renders agent-supplied strings inert (untrusted-input rule)", () => {
  const markup = renderToStaticMarkup(<Card card={HOSTILE} />);

  it("escapes HTML rather than emitting live elements", () => {
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    // The img payload is escaped to text — the whole tag is inert, no live element.
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img src=x");
  });

  it("does not turn markdown into a link", () => {
    expect(markup).not.toContain("<a "); // no anchor synthesized
    expect(markup).toContain("[click me](http://evil.example)"); // shown literally
  });

  it("does not interpret ANSI escape sequences", () => {
    expect(markup).toContain("[31mred[0m danger"); // raw text, no styling
  });

  it("shows the flags banner, the matched tier, and the session", () => {
    expect(markup).toContain("secrets_pattern");
    expect(markup).toContain("needs-review");
    expect(markup).toContain("sess-x");
  });
});

describe("Card renders non-string arguments as JSON text", () => {
  it("stringifies objects/arrays without executing anything", () => {
    const card: CardData = {
      id: "j1", session: "s", tool: "Write",
      arguments: { file_path: "/a.txt", meta: { lines: 3, tags: ["x", "y"] } },
      flags: {}, createdTs: 1,
    };
    const markup = renderToStaticMarkup(<Card card={card} />);
    expect(markup).toContain("/a.txt");
    expect(markup).toContain("&quot;lines&quot;"); // JSON-quoted key, escaped for HTML
  });
});
