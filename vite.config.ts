import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    // `npm run dev:worker` serves the storage API on :8787
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
