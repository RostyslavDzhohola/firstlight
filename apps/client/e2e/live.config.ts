// `pnpm e2e:live`: one live play session (live/session.ts) on the journeys' stack and fixtures, driven a
// command at a time by `e2e/live/fl.mjs` (live/README.md). One renderer per session: E2E_GFX=webgl
// (default) or webgpu. E2E_TARGET=prod plays production with a flagged test guest, like `pnpm e2e:prod`.

import { defineConfig } from "@playwright/test";
import path from "node:path";
import base from "./playwright.config.ts";
import { OUT } from "./stack.ts";

const gfx = process.env.E2E_GFX === "webgpu" ? "webgpu" : "webgl";

export default defineConfig({
  ...base,
  testDir: "./live",
  testMatch: /session\.ts$/,
  grep: undefined,
  globalSetup: undefined,
  // The session ends on `fl quit` or when no command came for FL_LIVE_IDLE_MIN minutes.
  timeout: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: path.join(OUT, "live-results"),
  projects: base.projects?.filter((p) => p.name === gfx),
});
