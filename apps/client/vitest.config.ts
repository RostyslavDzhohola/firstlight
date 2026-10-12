import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "client", include: ["src/**/*.test.ts"], environment: "node", testTimeout: 30000 }, // shader/vegetation builds are slow under load
});
