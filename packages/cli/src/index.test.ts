import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main, isEntryPoint } from "./index";

// main() calls process.exit() directly on every path (a real CLI entry point).
// Mock it to throw a catchable sentinel instead of killing the test worker, and
// capture stdout/stderr so assertions can read what the user would actually see.
class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`exit(${code})`);
  }
}

function run(argv: string[]): { code: number | undefined; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  let code: number | undefined;
  try {
    main(["node", "brezia", ...argv]);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  } finally {
    exitSpy.mockRestore();
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out: out.join(""), err: err.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("brezia --help / -h — never falls through to a real command", () => {
  it("--help prints general help and exits 0, listing every command", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    for (const cmd of ["init", "up", "remove", "export", "verify", "status"]) {
      expect(out).toContain(cmd);
    }
  });

  it("-h does the same as --help", () => {
    const { code, out } = run(["-h"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage: brezia");
  });

  it("bare invocation and an unknown command are unaffected (still exit 1)", () => {
    expect(run([]).code).toBe(1);
    expect(run(["bogus"]).code).toBe(1);
  });
});

describe("brezia <command> --help — never reaches the real command logic", () => {
  // A --db path that doesn't exist would make openDb() call fail() (process.exit(1))
  // if verify/export's real logic ran. Getting exit 0 + help text back proves help
  // was intercepted before openDb was ever called.
  it("verify --help does not open the database", () => {
    const { code, out } = run(["verify", "--help", "--db", "/does/not/exist.db"]);
    expect(code).toBe(0);
    expect(out).toContain("brezia verify");
    expect(out).toContain("audit chain");
  });

  it("export --help does not open the database or print any audit data", () => {
    const { code, out } = run(["export", "--help", "--db", "/does/not/exist.db"]);
    expect(code).toBe(0);
    expect(out).toContain("brezia export");
    expect(out).not.toContain("seq"); // would appear in real JSON/CSV output
  });

  it("init --help does not attempt the settings.json surgery", () => {
    // runInit() would throw for a nonsensical scope combo before ever touching a
    // file — --project and --user together always fails() if init's logic runs.
    const { code, out } = run(["init", "--help", "--project", "--user"]);
    expect(code).toBe(0);
    expect(out).toContain("brezia init");
  });

  it("up --help does not start the daemon", () => {
    const { code, out } = run(["up", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("brezia up");
    expect(out).toContain("127.0.0.1:4747");
  });

  it("status --help prints help instead of running the real diagnostic", () => {
    const { code, out } = run(["status", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("brezia status");
  });

  it("remove --help does not attempt the settings.json surgery", () => {
    const { code, out } = run(["remove", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("brezia remove");
  });

  it("an unknown command with --help still falls through to the usual error", () => {
    const { code, err } = run(["bogus", "--help"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown command 'bogus'");
  });
});

// A silently-ignored typo is a real footgun for init/remove specifically: a
// mistyped --user would otherwise fall back to --project (the default) with no
// indication the wrong settings file is about to be edited.
describe("brezia <command> --unknown-flag — rejected instead of silently ignored", () => {
  it("a typo'd --user on init is rejected, not silently treated as --project", () => {
    const { code, err } = run(["init", "--uesr"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown flag --uesr for 'init'");
  });

  it("up takes no flags at all — any flag is rejected", () => {
    const { code, err } = run(["up", "--tunnel"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown flag --tunnel for 'up'");
  });

  it("status takes no flags at all — any flag is rejected", () => {
    const { code, err } = run(["status", "--verbose"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown flag --verbose for 'status'");
  });

  it("export rejects a flag outside its known set (db/format/out)", () => {
    const { code, err } = run(["export", "--pretty"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown flag --pretty for 'export'");
  });

  it("reports multiple unknown flags together, pluralized", () => {
    const { code, err } = run(["verify", "--db", "/does/not/exist.db", "--foo", "--bar"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown flags --foo, --bar for 'verify'");
  });

  it("known flags on every command still pass through untouched", () => {
    // Only asserts the flag itself isn't rejected — real side effects (file I/O,
    // network) for init/remove/up are covered elsewhere; this just proves
    // checkKnownFlags doesn't false-positive on legitimate flags.
    expect(run(["verify", "--db", "/does/not/exist.db"]).err).not.toContain("unknown flag");
    expect(run(["export", "--db", "/does/not/exist.db", "--format", "csv"]).err).not.toContain(
      "unknown flag",
    );
  });
});

// npm satisfies `bin` entries via a symlink on POSIX (node_modules/.bin/brezia ->
// dist/index.js). Node's ESM loader resolves import.meta.url through that symlink
// to the real file, but process.argv[1] stays the literal (symlinked) invoked
// path — a strict-equality check on the raw, unresolved paths never matches under
// `npx brezia`/a global install on Mac/Linux, so main() silently never ran. This
// is the regression test for that bug: it drives isEntryPoint() through a real
// symlink rather than asserting on the mechanism in the abstract.
describe("isEntryPoint — resolves through a symlinked bin (the npx/npm install path)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("matches when invoked directly (no symlink)", () => {
    const dir = mkdtempSync(join(tmpdir(), "brezia-entry-"));
    dirs.push(dir);
    const real = join(dir, "real.mjs");
    writeFileSync(real, "// unused\n");
    expect(isEntryPoint(real, pathToFileURL(real).href)).toBe(true);
  });

  it("matches when invoked through a symlink, exactly as npx does", () => {
    const dir = mkdtempSync(join(tmpdir(), "brezia-entry-"));
    dirs.push(dir);
    const real = join(dir, "real.mjs");
    const link = join(dir, "bin-link.mjs"); // stands in for node_modules/.bin/brezia
    writeFileSync(real, "// unused\n");
    try {
      symlinkSync(real, link);
    } catch (e) {
      // Symlink creation needs a permission this environment may not grant (e.g.
      // Windows without Developer Mode/admin). Skip rather than fail the suite —
      // the mechanism this test exists to guard is a POSIX/npm behavior anyway.
      console.warn(`skipping symlink regression test: ${(e as Error).message}`);
      return;
    }
    // import.meta.url for code loaded through `link` resolves to `real`'s URL —
    // Node's ESM loader always resolves through symlinks. process.argv[1] would
    // be the symlink path (`link`) verbatim. isEntryPoint must still say true.
    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
  });

  it("does not match an unrelated file (sanity check the comparison isn't a no-op)", () => {
    const dir = mkdtempSync(join(tmpdir(), "brezia-entry-"));
    dirs.push(dir);
    const real = join(dir, "real.mjs");
    const other = join(dir, "other.mjs");
    writeFileSync(real, "// unused\n");
    writeFileSync(other, "// unused\n");
    expect(isEntryPoint(other, pathToFileURL(real).href)).toBe(false);
  });

  it("returns false (never throws) for a nonexistent path", () => {
    expect(isEntryPoint("/does/not/exist.mjs", "file:///does/not/exist.mjs")).toBe(false);
  });
});
