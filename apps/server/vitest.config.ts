import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "server", include: ["src/**/*.test.ts", "test/**/*.test.ts"], testTimeout: 20000, pool: "forks" },
});
