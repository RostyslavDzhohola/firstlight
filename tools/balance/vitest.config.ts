import { defineConfig } from "vitest/config";

// 20 s, like the server project: several tests run the whole model (bands.ts checks(), ~0.15 s on an
// idle M1, ~0.3 s at load 180), and under the full suite's load one such test took 11 s of starvation.
export default defineConfig({
  test: { name: "balance", include: ["*.test.ts"], environment: "node", testTimeout: 20_000 },
});
