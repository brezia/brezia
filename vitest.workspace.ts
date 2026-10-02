import { defineWorkspace } from "vitest/config";

// Each package carries its own vitest.config.ts; this runs them all from the root.
export default defineWorkspace(["packages/*"]);
