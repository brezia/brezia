import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index";

const dirs: string[] = [];
function builtUiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "brezia-ui-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Brezia</title><div id=root></div>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('inbox')");
  writeFileSync(join(dir, "assets", "index-abc123.css"), "body{margin:0}");
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("daemon serves the built inbox same-origin", () => {
  it("serves index.html at / and /index.html with html content-type", async () => {
    const app = await createServer({ uiDir: builtUiDir() });
    for (const url of ["/", "/index.html"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("id=root");
    }
    await app.close();
  });

  it("serves hashed JS/CSS assets with correct content-types", async () => {
    const app = await createServer({ uiDir: builtUiDir() });
    const js = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    const css = await app.inject({ method: "GET", url: "/assets/index-abc123.css" });
    expect(css.headers["content-type"]).toContain("text/css");
    await app.close();
  });

  it("404s an unknown asset path (no filesystem traversal surface)", async () => {
    const app = await createServer({ uiDir: builtUiDir() });
    for (const url of ["/assets/missing.js", "/../secret", "/etc/passwd"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });

  it("still routes /v1/* to the API, not the static catch-all", async () => {
    const app = await createServer({ uiDir: builtUiDir() });
    const res = await app.inject({ method: "GET", url: "/v1/requests" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]); // empty pending queue, not an HTML page
    await app.close();
  });

  it("serves a build-me placeholder at / when the UI is not built", async () => {
    const app = await createServer({ uiDir: join(tmpdir(), "brezia-nonexistent-ui") });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("npm run build -w @brezia/ui");
    const missing = await app.inject({ method: "GET", url: "/assets/anything.js" });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
