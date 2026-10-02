import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

// Serve the built inbox same-origin from the daemon (the v0 security model: the UI
// has no legitimate cross-origin client). No @fastify/static dependency — the built
// output is a handful of files, so we load them into memory at startup and serve
// only known keys. Because request paths are looked up in a fixed map (never joined
// onto the filesystem at request time), there is no path-traversal surface.

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

interface Asset {
  body: Buffer;
  type: string;
}

// Recursively load every file under dir into a map keyed by its URL path
// ("/index.html", "/assets/index-abc.js", …).
function loadDir(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const urlPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, urlPath);
      } else {
        assets.set(urlPath, { body: readFileSync(full), type: contentType(entry.name) });
      }
    }
  };
  walk(dir, "");
  return assets;
}

// A friendly placeholder when the UI has not been built yet — names the fix, per
// the working-style rule (assume a stranger).
const PLACEHOLDER = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Brezia</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Brezia daemon is running</h1>
<p>The inbox UI has not been built yet. From the repo root:</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:6px">npm run build -w @brezia/ui</pre>
<p>Then reload this page. The daemon serves the built inbox from this same origin.</p>
</body></html>`;

export function registerUi(app: FastifyInstance, uiDir?: string): void {
  // ../static resolves to packages/daemon/static from both dist/index.js (prod)
  // and src/ui-static.ts (tests) — both live one level under the package root.
  const dir = uiDir ?? fileURLToPath(new URL("../static/", import.meta.url));
  const built = existsSync(join(dir, "index.html"));
  const assets = built ? loadDir(dir) : new Map<string, Asset>();
  const index = assets.get("/index.html");

  // Catch-all GET, registered after all /v1/* routes so specific API routes win
  // (find-my-way ranks static routes above the wildcard).
  app.get("/*", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";

    if (!built || index === undefined) {
      if (path === "/") return reply.code(200).type("text/html; charset=utf-8").send(PLACEHOLDER);
      return reply.code(404).send({ error: "not found" });
    }

    if (path === "/" || path === "/index.html") {
      return reply.code(200).type(index.type).send(index.body);
    }
    const asset = assets.get(path);
    if (asset === undefined) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.code(200).type(asset.type).send(asset.body);
  });
}
