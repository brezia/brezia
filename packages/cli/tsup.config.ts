import { defineConfig } from "tsup";
import { cpSync, rmSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  banner: { js: "#!/usr/bin/env node" },
  dts: false,
  sourcemap: true,
  clean: true,
  platform: "node",
  target: "node20",
  // The published package is just `brezia`: the private workspace packages are bundled
  // in, and their npm dependencies are listed in this package's own dependencies.
  noExternal: [/^@brezia\//],
  // Ship what the bundled code reads from disk beside dist/: the inbox (the daemon's
  // ../static, built first by the root build script) and the default policy pack.
  // cpSync throws if the inbox has not been built, so a package without it can't be made.
  async onSuccess() {
    rmSync("static", { recursive: true, force: true }); // drop stale hashed assets
    cpSync("../daemon/static", "static", { recursive: true });
    cpSync("../../policy-packs", "policy-packs", { recursive: true });
    cpSync("../../README.md", "README.md");
    cpSync("../../LICENSE", "LICENSE");
  },
});
