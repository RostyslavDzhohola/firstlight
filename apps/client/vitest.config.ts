import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __FL_DEV_CODES__: "false" }, // as in a build: no dev sign-in codes (vite.config.ts)
  test: { name: "client", include: ["src/**/*.test.ts"], environment: "node", testTimeout: 30000 }, // shader/vegetation builds are slow under load
});
