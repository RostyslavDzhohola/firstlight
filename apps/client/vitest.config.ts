import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __FL_DEV_SIGNIN_KEY__: JSON.stringify("") }, // as in a build: no dev sign-in key (vite.config.ts)
  test: { name: "client", include: ["src/**/*.test.ts"], environment: "node", testTimeout: 30000 }, // shader/vegetation builds are slow under load
});
