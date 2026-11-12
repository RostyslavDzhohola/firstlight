import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "balance", include: ["*.test.ts"], environment: "node" },
});
