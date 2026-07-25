import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8765",
    },
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    clearMocks: true,
  },
});
