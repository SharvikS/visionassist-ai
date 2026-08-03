import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";


const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirror the `@/*` path alias from tsconfig.json so tests import modules the
    // same way the app does.
    alias: { "@": path.resolve(projectRoot, "src") },
  },
  test: {
    // jsdom supplies localStorage, Blob, and the DOM timers these libs use.
    // Web Crypto and atob/btoa come from Node itself.
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
