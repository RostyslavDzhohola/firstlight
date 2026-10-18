// Shader warm-up bench (D-load-2, #30): one arrival on Portus at a fixed tier, its warm-up per phase
// and the frame times during it, written to $BENCH_OUT/<project>-<mode>-<tier>-<run>.json. Skipped
// unless BENCH_MODE is set, so `pnpm e2e` never runs it.
//
//   BENCH_MODE=serial    ?serialcompile: three's own one-program-at-a-time compiles (before D-load-2)
//   BENCH_MODE=parallel  the default: the warm-up's programs compile side by side
//   BENCH_TIER=high      (default; the owner's M1 tier)   BENCH_RUN=1   BENCH_OUT=/tmp/…
//
// Chrome shares its GPU program cache between the contexts of one browser, so a second arrival in the
// same browser compiles from a warm cache. Run each measurement as its own Playwright invocation (a
// fresh browser and profile), against one stack started once (E2E_REUSE=1), alternating the modes:
//   for run in 1 2; do for mode in serial parallel; do
//     BENCH_MODE=$mode BENCH_RUN=$run E2E_REUSE=1 npx playwright test -c e2e/playwright.config.ts --project webgl --grep @bench
//   done; done

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures.ts";
import { OUT } from "./stack.ts";

const MODE = process.env.BENCH_MODE ?? "";
const TIER = process.env.BENCH_TIER ?? "high";
const RUN = process.env.BENCH_RUN ?? "1";
const BENCH_OUT = process.env.BENCH_OUT ?? path.join(OUT, "bench");

test(`bench · shader warm-up · ${MODE || "off"} · ${TIER}`, { tag: ["@bench"] }, async ({ player }, info) => {
  test.skip(!MODE, "set BENCH_MODE=serial|parallel to run the warm-up bench");
  const extra: Record<string, true | string> = { tier: TIER };
  if (MODE === "serial") extra.serialcompile = true;
  await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus", extra });
  await player.waitInWorld(240_000, "portus");
  const warm = await player.warmup("arrival");
  const shaders = await player.shaderWatchClosed();
  const result = { project: info.project.name, mode: MODE, tier: TIER, run: RUN, warm, afterWarmup: shaders.afterWarmup, recent: shaders.recent };
  mkdirSync(BENCH_OUT, { recursive: true });
  writeFileSync(path.join(BENCH_OUT, `${info.project.name}-${MODE}-${TIER}-${RUN}.json`), JSON.stringify(result, null, 1));
  await player.note("bench", result);
  expect(warm, "the arrival's warm-up is reported").not.toBeNull();
});
