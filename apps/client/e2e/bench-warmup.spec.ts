// Shader warm-up bench (D-load-2, #30): one arrival on Portus at a fixed tier, its warm-up per phase
// and the frame times during it, written to $BENCH_OUT/<project>-<mode>-<tier>-<run>.json. Skipped
// unless BENCH_MODE is set, so `pnpm e2e` never runs it.
//
//   BENCH_MODE=serial    ?serialcompile: three's own one-program-at-a-time compiles (before D-load-2)
//   BENCH_MODE=parallel  the default: the warm-up's programs compile side by side
//   BENCH_TIER=high      (default; the owner's M1 tier)   BENCH_RUN=1   BENCH_OUT=/tmp/…
//   BENCH_TRACE=1        (Chromium) a browser-wide performance trace of the join and warm-up, next to the JSON
//   BENCH_HOME_MS=8000   a realistic first visit: the home page shown this long before Play (Chrome compiles
//                        its own raster pipelines for the page then, as in a real visit; #39)
//   BENCH_PROFILE_DIR=…  a returning visit: one browser profile kept across runs, so Chrome's own GPU
//                        program cache (in the profile) is warm as well as the system's Metal cache (#39)
//   BENCH_FLAGS=warmdiag (extra URL flags: warmdiag logs every WebGL2 first-draw batch in send order with
//   stage hashes and a census; warmsolo sends one pipeline per batch; oldpacer, fullshadow: the kill flags)
//
// Chrome shares its GPU program cache between the contexts of one browser, so a second arrival in the
// same browser compiles from a warm cache. Run each measurement as its own Playwright invocation (a
// fresh browser and profile), against one stack started once (E2E_REUSE=1), alternating the modes:
//   for run in 1 2; do for mode in serial parallel; do
//     BENCH_MODE=$mode BENCH_RUN=$run E2E_REUSE=1 pnpm exec playwright test -c e2e/playwright.config.ts --project webgl --grep @bench
//   done; done
// macOS also keeps each app's compiled Metal shaders outside the profile (a warm cache across
// browsers). For cold-cache numbers on the webgl project, delete Playwright Chromium's own caches
// before each run: $(getconf DARWIN_USER_CACHE_DIR)com.google.chrome.for.testing{,.helper}/
// {com.apple.metal,com.apple.metalfe,com.apple.gpuarchiver}. Never the installed Chrome's (the
// webgpu project and the owner's own browser share it), so WebGPU numbers are warm-cache only.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { Player } from "./player.ts";
import { markToolRequests, OUT } from "./stack.ts";

const MODE = process.env.BENCH_MODE ?? "";
const TIER = process.env.BENCH_TIER ?? "high";
const RUN = process.env.BENCH_RUN ?? "1";
const BENCH_OUT = process.env.BENCH_OUT ?? path.join(OUT, "bench");
const TRACE = process.env.BENCH_TRACE === "1";
const HOME_MS = Number(process.env.BENCH_HOME_MS ?? 0);
const PROFILE_DIR = process.env.BENCH_PROFILE_DIR ?? "";

/** A returning visitor's browser: a persistent profile, headless and muted like every test browser. */
async function returningVisit(info: Parameters<Parameters<typeof test>[2]>[1], gfx: Player["gfx"]): Promise<{ context: BrowserContext; player: Player }> {
  const use = info.project.use as { channel?: string; launchOptions?: { args?: string[] }; baseURL?: string; viewport?: { width: number; height: number } };
  const args = use.launchOptions?.args ?? [];
  if (!args.includes("--mute-audio")) throw new Error("refusing to run: the bench's browser must be muted");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, channel: use.channel, args, baseURL: use.baseURL, viewport: use.viewport });
  await markToolRequests(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("datafast_ignore", "true");
    } catch {}
  });
  const page = context.pages()[0] ?? (await context.newPage());
  // a new dev guest each run (the profile keeps localStorage)
  await page.goto("/THIRD-PARTY-NOTICES.md");
  await page.evaluate(() => localStorage.removeItem("firstlight.devGuest"));
  return { context, player: new Player(page, info, gfx) };
}
/** Main-thread tasks, V8 and the GPU process's command buffer: enough to see what a long task waited on. */
const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel", "v8.execute", "gpu", "disabled-by-default-v8.cpu_profiler"];

test(`bench · shader warm-up · ${MODE || "off"} · ${TIER}`, { tag: ["@bench"] }, async ({ player: fixturePlayer, page: fixturePage }, info) => {
  test.skip(!MODE, "set BENCH_MODE=serial|parallel to run the warm-up bench");
  const extra: Record<string, true | string> = { tier: TIER };
  if (MODE === "serial") extra.serialcompile = true;
  for (const f of (process.env.BENCH_FLAGS ?? "").split(",").filter(Boolean)) extra[f] = true; // e.g. warmdiag
  mkdirSync(BENCH_OUT, { recursive: true });
  const returning = PROFILE_DIR ? await returningVisit(info, fixturePlayer.gfx) : null;
  const player = returning?.player ?? fixturePlayer;
  const page = returning?.player.page ?? fixturePage;
  const browser = TRACE && !returning ? page.context().browser() : null;
  if (browser) await browser.startTracing(page, { path: path.join(BENCH_OUT, `${info.project.name}-${MODE}-${TIER}-${RUN}.trace.json`), categories: TRACE_CATEGORIES });
  if (HOME_MS > 0) {
    await player.open();
    await page.waitForTimeout(HOME_MS);
  }
  await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus", extra });
  await player.waitInWorld(240_000, "portus");
  const warm = await player.warmup("arrival");
  if (browser) await browser.stopTracing();
  const shaders = await player.shaderWatchClosed();
  const result = { project: info.project.name, mode: MODE, tier: TIER, run: RUN, warm, afterWarmup: shaders.afterWarmup, recent: shaders.recent };
  writeFileSync(path.join(BENCH_OUT, `${info.project.name}-${MODE}-${TIER}-${RUN}.json`), JSON.stringify(result, null, 1));
  await player.note("bench", result);
  await returning?.context.close();
  expect(warm, "the arrival's warm-up is reported").not.toBeNull();
});
