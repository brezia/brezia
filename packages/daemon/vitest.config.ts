import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to source so tests run without a prebuild.
      "@brezia/shared": fileURLToPath(
        new URL("../shared/src/index.ts", import.meta.url),
      ),
      "@brezia/policy": fileURLToPath(
        new URL("../policy/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
