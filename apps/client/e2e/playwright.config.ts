// Playwright journeys J1–J7 (HANDOFF item 6i, SPEC §9.3, D-e2e-1): the game played the way a new
// player plays it, headless and muted, on WebGL2 and WebGPU.
//
//   pnpm e2e                      local stack (server :2601 + production client build on :5201)
//   pnpm e2e -- --project webgl   one renderer;   pnpm e2e -- --grep @J2   one journey
//   pnpm e2e:prod                 read-only smoke subset (@smoke) against https://firstlight.one4all.dev
//   pnpm e2e:gate                 only the journeys in e2e/gates.json; non-zero exit on any failure
//
// Env: E2E_OUT (artifacts, default e2e/.out), E2E_PORT / E2E_CLIENT_PORT, E2E_WORKERS (default 2),
// E2E_REUSE=1 (reuse a stack you started yourself; its server log must be $E2E_OUT/server.log).

import { defineConfig } from "@playwright/test";
import path from "node:path";
import { BASE_URL, CLIENT_DIR, CLIENT_ENV, CLIENT_PORT, DB_DIR, DIST, LOCAL_API, OUT, SERVER_DIR, SERVER_ENV, SERVER_LOG, TARGET } from "./stack.ts";

/**
 * Every browser is headless AND muted (owner rule; the fixtures re-check both flags through CDP before
 * the first page loads). Background throttling is off so rAF keeps 60 Hz in a headless page.
 */
const CHROME_ARGS = [
  "--mute-audio",
  "--enable-automation", // lets CDP Browser.getBrowserCommandLine return the flags for the check
  "--ignore-gpu-blocklist",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
];

const shell = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export default defineConfig({
  testDir: ".",
  testMatch: TARGET === "prod" ? /smoke\.spec\.ts$/ : /\.spec\.ts$/,
  outputDir: path.join(OUT, "results"),
  timeout: 240_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  retries: 0,
  reporter: [["list"], ["json", { outputFile: path.join(OUT, "report.json") }], ["html", { outputFolder: path.join(OUT, "html"), open: "never" }]],
  grep: TARGET === "prod" ? /@smoke/ : undefined,
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "webgl",
      metadata: { gfx: "webgl" },
      // Playwright's own Chromium in new headless mode; the game is forced onto WebGL2 with ?webgl.
      use: { browserName: "chromium", channel: "chromium", launchOptions: { args: CHROME_ARGS } },
    },
    {
      name: "webgpu",
      metadata: { gfx: "webgpu" },
      // Installed Google Chrome: WebGPU works headless on macOS (Metal) with this flag.
      use: { browserName: "chromium", channel: "chrome", launchOptions: { args: [...CHROME_ARGS, "--enable-unsafe-webgpu"] } },
    },
  ],
  webServer:
    TARGET === "prod"
      ? undefined
      : [
          {
            name: "server",
            command: `rm -rf ${shell(DB_DIR)} && mkdir -p ${shell(DB_DIR)} && : > ${shell(SERVER_LOG)} && cd ${shell(SERVER_DIR)} && exec node src/main.ts >> ${shell(SERVER_LOG)} 2>&1`,
            url: `${LOCAL_API}/healthz`,
            env: SERVER_ENV,
            reuseExistingServer: process.env.E2E_REUSE === "1",
            timeout: 60_000,
          },
          {
            name: "client",
            command: `cd ${shell(CLIENT_DIR)} && npx vite build --outDir ${shell(DIST)} --emptyOutDir --logLevel warn && exec npx vite preview --outDir ${shell(DIST)} --port ${CLIENT_PORT} --strictPort --host 127.0.0.1`,
            url: `http://127.0.0.1:${CLIENT_PORT}/`,
            env: CLIENT_ENV,
            reuseExistingServer: process.env.E2E_REUSE === "1",
            timeout: 120_000,
          },
        ],
});
