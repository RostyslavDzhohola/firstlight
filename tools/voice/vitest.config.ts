import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "voice-tools", include: ["*.test.ts"], environment: "node" },
});
