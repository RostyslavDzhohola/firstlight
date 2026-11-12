import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "agent-tools", include: ["*.test.ts"], testTimeout: 20_000 },
});
