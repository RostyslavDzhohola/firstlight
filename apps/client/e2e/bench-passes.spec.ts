// Per-pass GPU cost bench (#52): `?bench=passes` offline on Portus at a fixed tier, written to
// $BENCH_OUT/<project>-passes-<tier>-<run>.json. Skipped unless BENCH_MODE=passes, so `pnpm e2e`
// never runs it. WebGPU only (the webgl project gets `passes: null` and skips the checks):
//   BENCH_MODE=passes BENCH_TIER=high pnpm exec playwright test -c e2e/playwright.config.ts --project webgpu --grep @bench
// Optional: BENCH_RUN=1, BENCH_OUT=/tmp/…, BENCH_FLAGS=benchwarm=30,benchrounds=4 (extra URL flags).
// Run it with the machine otherwise idle and plugged in: the numbers are wall-clock GPU time.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures.ts";
import { OUT } from "./stack.ts";

const MODE = process.env.BENCH_MODE ?? "";
const TIER = process.env.BENCH_TIER ?? "high";
const RUN = process.env.BENCH_RUN ?? "1";
const BENCH_OUT = process.env.BENCH_OUT ?? path.join(OUT, "bench");

test(`bench · passes · ${TIER}`, { tag: ["@bench"] }, async ({ player, page }, info) => {
  test.skip(MODE !== "passes", "set BENCH_MODE=passes to run the per-pass bench");
  test.setTimeout(30 * 60_000);
  const extra: Record<string, true | string> = { offline: true, autoplay: true, bench: "passes", tier: TIER };
  for (const f of (process.env.BENCH_FLAGS ?? "").split(",").filter(Boolean)) {
    const [k, v] = f.split("=");
    extra[k!] = v ?? true;
  }
  mkdirSync(BENCH_OUT, { recursive: true });
  await page.goto(player.url(extra));
  await page.waitForFunction(() => (window as unknown as { __benchDone?: boolean }).__benchDone === true, null, { timeout: 25 * 60_000, polling: 2000 });
  const result = await page.evaluate(() => (window as unknown as { __bench: unknown }).__bench);
  writeFileSync(path.join(BENCH_OUT, `${info.project.name}-passes-${TIER}-${RUN}.json`), JSON.stringify(result, null, 1));
  await player.note("bench-passes", result);

  const r = result as { backend: string; preset: string; passes: null | { v: number; valid: boolean; invalidReason: string | null; passes: { feature: string; deltaMs: { p50: number } }[]; baseline: { p50: number } } };
  expect(r.preset).toBe("passes");
  if (r.backend !== "webgpu") {
    expect(r.passes, "WebGL2 reports no per-pass costs").toBeNull();
    return;
  }
  expect(r.passes, "a per-pass report").not.toBeNull();
  expect(r.passes!.v).toBe(1);
  expect(r.passes!.baseline.p50).toBeGreaterThan(0);
  expect(r.passes!.passes.length, "at least one pass measured").toBeGreaterThan(0);
  expect.soft(r.passes!.valid, `valid run (${r.passes!.invalidReason})`).toBe(true);
});
