import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  root: "web",
  build: {
    target: "es2022",
    emptyOutDir: true,
    outDir: mode === "standalone" ? "dist-standalone" : "dist",
    // single-file build: inline the wasm as a data URL
    assetsInlineLimit: mode === "standalone" ? 100_000_000 : 4096,
  },
  server: {
    // `npm run dev:worker` serves the storage API on :8787
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
}));
