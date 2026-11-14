import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/server", "apps/client", "tools/sfx", "tools/voice", "tools/agent", "tools/balance", "tools/metrics"],
  },
});
