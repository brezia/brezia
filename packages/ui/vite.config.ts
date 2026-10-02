import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Mirror the daemon's loopback constraint for the dev server. In production the
  // inbox is served same-origin by the daemon; Phase D points build.outDir at the
  // daemon's static dir.
  // Dev only: proxy the API + SSE stream to the daemon so the dev server behaves
  // like production (the daemon serves this bundle same-origin). No `changeOrigin`:
  // the daemon compares Origin with Host, so Host must pass through unchanged.
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": { target: "http://127.0.0.1:4747" },
    },
  },
  // Build straight into the daemon's static dir; the daemon serves it same-origin.
  build: { outDir: "../daemon/static", emptyOutDir: true },
});
