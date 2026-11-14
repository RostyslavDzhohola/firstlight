import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "metrics", include: ["*.test.ts"], environment: "node" },
});
