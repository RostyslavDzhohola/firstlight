// The browser half of `pnpm metrics` (tools/metrics, docs/metrics.md): load and frame numbers, written
// as raw JSON to $METRICS_OUT for the collector to turn into metrics. Skipped unless METRICS_MODE is set,
// so `pnpm e2e` never runs it. The collector starts it; by hand:
//   METRICS_MODE=load  METRICS_OUT=/tmp/m.json pnpm exec playwright test -c e2e/playwright.config.ts --project webgpu --grep @metrics
//   METRICS_MODE=frame METRICS_BODIES=portus,arcadia METRICS_TIER=medium METRICS_SECONDS=20 …
//
// load   a first visit in a fresh browser (cold HTTP cache): navigation → first paint → home menu → Play →
//        starter pick → in the world; the arrival's warm-up; requests and bytes to the menu and to the
//        world; shader builds after the warm-up. Then a second visit in the same browser (warm cache).
// frame  `?bench` offline on each body at a fixed tier: the scripted camera path, frame-time
//        percentiles, hitches, draw calls, triangles, heap and three's GPU memory estimate.

import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import type { Player } from "./player.ts";

const MODE = process.env.METRICS_MODE ?? "";
const OUT_FILE = process.env.METRICS_OUT ?? "";
const TIER = process.env.METRICS_TIER ?? "medium";

interface HeapNode {
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  selfSize: number;
  children: HeapNode[];
}

interface Resources {
  requests: number;
  transferKB: number;
  decodedKB: number;
  /** The 15 largest over the wire: path (no query) and KB. */
  top: [string, number][];
}

/** Every resource the page fetched so far (the navigation included), from Resource Timing. */
function resources(page: Page): Promise<Resources> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const all = [...nav, ...res];
    const kb = (v: number) => Math.round(v / 102.4) / 10;
    return {
      requests: all.length,
      transferKB: kb(all.reduce((a, e) => a + (e.transferSize || 0), 0)),
      decodedKB: kb(all.reduce((a, e) => a + (e.decodedBodySize || 0), 0)),
      top: [...all]
        .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
        .slice(0, 15)
        .map((e) => [new URL(e.name).pathname, kb(e.transferSize || 0)] as [string, number]),
    };
  });
}

const firstPaint = (page: Page) =>
  page.evaluate(() => {
    const p = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
    return p ? Math.round(p.startTime) : null;
  });

/** Play from the home menu: the starter pick for a new guest, straight in for a returning one. */
async function pressPlay(player: Player): Promise<number> {
  const page = player.page;
  await expect(player.playButton()).toBeVisible({ timeout: 60_000 });
  const t = await player.now();
  await player.playButton().click();
  const pick = page.locator(".fl-charpick");
  // A new guest gets the starter pick; a returning one goes straight to loading. Whichever comes first.
  let picked = false;
  for (const until = Date.now() + 45_000; Date.now() < until; await page.waitForTimeout(100)) {
    if (await pick.isVisible()) {
      picked = true;
      break;
    }
    if ((await player.snap()).stage !== "landing") break;
  }
  if (picked) {
    await pick.locator(".fl-starter", { hasText: "Hexwick" }).click();
    const name = pick.locator("#fl-name");
    if (await name.isVisible()) await name.fill(`M${Math.random().toString(36).slice(2, 8)}`);
    await pick.getByRole("button", { name: /^Play as Hexwick/ }).click();
  }
  return t;
}

/** One visit: home menu, Play, the world. Times are page milliseconds from navigation start. */
async function visit(player: Player) {
  const page = player.page;
  await player.open({ tier: TIER });
  await expect(player.playButton()).toBeVisible({ timeout: 60_000 });
  const menuMs = Math.round(await player.now());
  const fcpMs = await firstPaint(page);
  const atMenu = await resources(page);
  const playAt = await pressPlay(player);
  await player.waitInWorld(240_000);
  const worldMs = Math.round(await player.now());
  const atWorld = await resources(page);
  const warm = await player.warmup("arrival");
  const shaders = await player.shaderWatchClosed(60_000);
  const heap = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
  });
  const backend = await page.evaluate(() => (window as unknown as { __game?: { ctx: { webgpu: boolean } } }).__game?.ctx.webgpu ?? null);
  return { fcpMs, menuMs, playToWorldMs: Math.round(worldMs - playAt), navToWorldMs: worldMs, atMenu, atWorld, warm, afterWarmup: shaders.afterWarmup, heapMB: heap, webgpu: backend };
}

test("metrics · browser", { tag: ["@metrics"] }, async ({ player: fixturePlayer, page: fixturePage, context, browser }, info) => {
  test.skip(MODE !== "load" && MODE !== "frame", "set METRICS_MODE=load|frame (pnpm metrics --load / --frame)");
  test.setTimeout(30 * 60_000);
  // METRICS_VIEWPORT=1920x1080 and METRICS_DPR=2 (frame mode): a window the size of a real one (#87),
  // in a context of its own (same headless, muted browser) since a page can't change its pixel ratio.
  const vp = /^(\d+)x(\d+)$/.exec(process.env.METRICS_VIEWPORT ?? "");
  const dpr = Number(process.env.METRICS_DPR ?? 1);
  let player = fixturePlayer;
  let page = fixturePage;
  if (MODE === "frame" && (vp || dpr !== 1)) {
    const ctx = await browser.newContext({ viewport: vp ? { width: Number(vp[1]), height: Number(vp[2]) } : (page.viewportSize() ?? undefined), deviceScaleFactor: dpr });
    page = await ctx.newPage();
    const { Player: P } = await import("./player.ts");
    player = new P(page, info, fixturePlayer.gfx);
  }
  const out: Record<string, unknown> = { mode: MODE, project: info.project.name, tier: TIER, viewport: page.viewportSize(), dpr };
  if (MODE === "load") {
    out.cold = await visit(player);
    // The same browser again: HTTP cache, Chrome's GPU program cache and the saved guest all warm.
    const page2 = await context.newPage();
    await page.close();
    const { Player: P } = await import("./player.ts");
    out.warm = await visit(new P(page2, info, fixturePlayer.gfx));
    await page2.close();
  } else {
    const bodies = (process.env.METRICS_BODIES ?? "portus,arcadia,hollowmere,meridian").split(",").filter(Boolean);
    const seconds = Number(process.env.METRICS_SECONDS ?? 20);
    const warm = Number(process.env.METRICS_WARM ?? 8);
    const extra = (process.env.METRICS_FLAGS ?? "").split(",").filter(Boolean);
    const runs: Record<string, unknown> = {};
    for (const body of bodies) {
      const flags: Record<string, true | string> = { offline: true, autoplay: true, bench: true, body, tier: TIER, benchwarm: String(warm), benchtime: String(seconds) };
      for (const f of extra) {
        const [k, v] = f.split("=");
        flags[k!] = v ?? true;
      }
      await page.goto(player.url(flags));
      // METRICS_HEAPPROF=1: Chrome's sampling heap profiler over the recorded run, summed by allocating function.
      const cdp = process.env.METRICS_HEAPPROF === "1" ? await page.context().newCDPSession(page) : null;
      if (cdp) {
        // Only the recorded run (not loading or the shader warm-up): the bench overlay reads "BENCH <preset> <s> / <s> s" then.
        await page.waitForFunction(() => [...document.querySelectorAll("div")].some((d) => /^BENCH \w+ \d+\.\d \/ /.test(d.textContent ?? "")), null, { timeout: 10 * 60_000, polling: 100 });
        await cdp.send("HeapProfiler.enable");
        await cdp.send("HeapProfiler.startSampling", { samplingInterval: 16384 });
      }
      await page.waitForFunction(() => (window as unknown as { __benchDone?: boolean }).__benchDone === true, null, { timeout: 10 * 60_000, polling: 1000 });
      runs[body] = await page.evaluate(() => (window as unknown as { __bench: unknown }).__bench);
      if (cdp) {
        const { profile } = (await cdp.send("HeapProfiler.stopSampling")) as unknown as { profile: { head: HeapNode } };
        const sites = new Map<string, number>();
        const walk = (n: HeapNode) => {
          const f = n.callFrame;
          const key = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\/assets\//, "")}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
          if (n.selfSize) sites.set(key, (sites.get(key) ?? 0) + n.selfSize);
          for (const c of n.children) walk(c);
        };
        walk(profile.head);
        (runs[body] as Record<string, unknown>).heapSites = [...sites].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(v / 1024)]);
        await cdp.detach();
      }
    }
    out.bodies = runs;
  }
  writeFileSync(OUT_FILE || `${info.outputDir}/metrics.json`, JSON.stringify(out, null, 1));
});
