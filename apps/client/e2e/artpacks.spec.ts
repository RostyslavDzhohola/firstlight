// HD art packs (#48, D-artpacks): the evidence runs. Skipped unless ARTPACKS is set, so `pnpm e2e`
// never runs them. Offline sessions (no server needed), headless and muted like every journey.
//
//   ARTPACKS=shots   same-frame screenshots at the game's camera distances, shipped textures then the HD
//                    pack swapped in during play (Portus, Arcadia, Meridian), with the node builds counted
//                    over the 120 frames after the swap; PNGs + shots.json in $ARTPACKS_OUT/<project>/
//   ARTPACKS=bench   the renderer bench (?bench, Portus, a 16-avatar crowd) with the packs (ARTPACKS_PACKS=on,
//                    the default: they swap in during the warm-up) or without (off): frame times over 60 s,
//                    the swap window's frames, node builds, and the GPU process's memory footprint
//   ARTPACKS_TIER=medium (default)   ARTPACKS_RUN=1   ARTPACKS_WARM=40   ARTPACKS_TIME=60
//
//   ARTPACKS=bench ARTPACKS_PACKS=off E2E_WORKERS=1 pnpm exec playwright test -c e2e/playwright.config.ts --project webgl --grep @artpacks

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { OUT } from "./stack.ts";

const MODE = process.env.ARTPACKS ?? "";
const TIER = process.env.ARTPACKS_TIER ?? "medium";
const RUN = process.env.ARTPACKS_RUN ?? "1";
const PACKS = process.env.ARTPACKS_PACKS ?? "on";
const WARM = Number(process.env.ARTPACKS_WARM ?? 40);
const TIME = Number(process.env.ARTPACKS_TIME ?? 60);
const DIR = process.env.ARTPACKS_OUT ?? path.join(OUT, "artpacks");

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = any;

async function inWorld(page: Page, timeoutMs = 360_000) {
  await expect
    .poll(async () => page.evaluate(() => {
      const s = (window as W).__fl?.snapshot();
      return !!s && s.stage === "playing" && !s.loading;
    }), { timeout: timeoutMs, intervals: [500], message: "in the world" })
    .toBe(true);
}

const packsState = (page: Page) => page.evaluate(() => (window as W).__game.packs.state());

/** The browser's GPU process (CDP SystemInfo.getProcessInfo) and its physical footprint (MB) from macOS `footprint`, or null. */
async function gpuFootprintMB(page: Page): Promise<{ pid: number; mb: number } | null> {
  try {
    const cdp = await page.context().browser()!.newBrowserCDPSession();
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
    await cdp.detach();
    const gpu = processInfo.find((p) => p.type.toLowerCase() === "gpu");
    if (!gpu) return null;
    const out = execFileSync("footprint", ["-p", String(gpu.id)], { encoding: "utf8" });
    const m = /Footprint:\s*([\d.]+)\s*([KMG])B/.exec(out);
    if (!m) return null;
    const v = Number(m[1]);
    return { pid: gpu.id, mb: Math.round(m[2] === "G" ? v * 1024 : m[2] === "K" ? v / 1024 : v) };
  } catch {
    return null;
  }
}

function uptime(): string {
  try {
    return execFileSync("uptime", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Poses for a body, found from the spawn: structure walls by the town's colliders, trees by the natural solids. */
async function findPoses(page: Page, body: string) {
  return page.evaluate((body) => {
    const g = (window as W).__game;
    const p = g.player;
    const up = p.pos.clone().normalize();
    const ref = Math.abs(up.y) < 0.95 ? up.clone().set(0, 1, 0) : up.clone().set(1, 0, 0);
    const east = ref.clone().cross(up).normalize();
    const north = up.clone().cross(east).normalize();
    // Above stalls, barrels and the portal dais: the rays find house walls, towers and the curtain wall.
    const head = p.pos.clone().addScaledVector(up, 3.2);
    const dirAt = (deg: number) => east.clone().multiplyScalar(Math.sin((deg * Math.PI) / 180)).addScaledVector(north, Math.cos((deg * Math.PI) / 180));
    const hits: { deg: number; town: number; nature: number }[] = [];
    for (let deg = 0; deg < 360; deg += 5) {
      const d = dirAt(deg);
      const town = g.planet.town?.moveColliders?.raycast?.(head, d, 60) ?? Infinity;
      const nature = g.nature?.raycast?.(head.x, head.y, head.z, d.x, d.y, d.z, 60) ?? Infinity;
      hits.push({ deg, town, nature });
    }
    const near = (k: "town" | "nature", lo: number, hi: number) => hits.filter((h) => h[k] >= lo && h[k] <= hi).sort((a, b) => a[k] - b[k])[0] ?? null;
    const open = [...hits].sort((a, b) => Math.min(b.town, b.nature) - Math.min(a.town, a.nature))[0]!;
    const poses: { name: string; deg: number; forward: number; dist: number; camDistance: number; pitch: number; faceCamera?: boolean; side?: number; sideDeg?: number }[] = [];
    const wall = near("town", 6, 40);
    if (wall) {
      // the street view from the spawn; the wall with the player 2 m from it (the camera behind, ~6.6 m);
      // the closest zoom (the camera ~3.3 m from it); a photo-mode-like close-up (1 m behind the head);
      // the wall along the side of the view
      poses.push({ name: "town-street", deg: wall.deg, forward: 0, dist: 0, camDistance: 4.6, pitch: -0.05 });
      poses.push({ name: "town-wall", deg: wall.deg, forward: Math.max(0, wall.town - 2), dist: 0, camDistance: 4.6, pitch: 0.05 });
      poses.push({ name: "town-wall-zoom", deg: wall.deg, forward: Math.max(0, wall.town - 0.8), dist: 0, camDistance: 2.5, pitch: 0.12 });
      poses.push({ name: "town-wall-photo", deg: wall.deg, forward: Math.max(0, wall.town - 2.2), dist: 0, camDistance: 1.0, pitch: 0.1 });
      poses.push({ name: "town-grazing", deg: wall.deg + 70, forward: 0, dist: 0, camDistance: 4.6, pitch: -0.05, side: Math.max(0, wall.town - 1.5), sideDeg: wall.deg });
    }
    const tree = near("nature", 3, 60);
    if (tree) {
      poses.push({ name: "tree", deg: tree.deg, forward: Math.max(0, tree.nature - 2.5), dist: 0, camDistance: 4.6, pitch: 0.05 });
      poses.push({ name: "tree-zoom", deg: tree.deg, forward: Math.max(0, tree.nature - 1.6), dist: 0, camDistance: 2.5, pitch: 0.1 });
    }
    if (body === "portus") {
      // the player's own character, from the front: the default distance and the closest zoom
      poses.push({ name: "char", deg: open.deg, forward: 0, dist: 0, camDistance: 4.6, pitch: -0.1, faceCamera: true });
      poses.push({ name: "char-zoom", deg: open.deg, forward: 0, dist: 0, camDistance: 2.5, pitch: -0.05, faceCamera: true });
    }
    return { poses, hits: hits.filter((h) => h.town < 60 || h.nature < 60).length };
  }, body);
}

type Pose = Awaited<ReturnType<typeof findPoses>>["poses"][number];

/** Put the player at the pose (from the spawn `origin`), hide the HUD, let LODs, fades and the camera settle. */
async function pose(page: Page, origin: [number, number, number], p: Pose) {
  await page.evaluate(([o, p]) => {
    const g = (window as W).__game;
    const pl = g.player;
    pl.pos.set(o[0], o[1], o[2]);
    const up = pl.pos.clone().normalize();
    const ref = Math.abs(up.y) < 0.95 ? up.clone().set(0, 1, 0) : up.clone().set(1, 0, 0);
    const east = ref.clone().cross(up).normalize();
    const north = up.clone().cross(east).normalize();
    const d = east.clone().multiplyScalar(Math.sin((p.deg * Math.PI) / 180)).addScaledVector(north, Math.cos((p.deg * Math.PI) / 180));
    pl.pos.addScaledVector(d, p.forward);
    if (p.side) {
      // first walk `side` metres along sideDeg (toward a wall), then look along `deg`
      const s = east.clone().multiplyScalar(Math.sin((p.sideDeg! * Math.PI) / 180)).addScaledVector(north, Math.cos((p.sideDeg! * Math.PI) / 180));
      pl.pos.addScaledVector(s, p.side);
    }
    const n = pl.pos.clone().normalize();
    const terrain = g.planet.terrain;
    pl.pos.copy(n.multiplyScalar(terrain.body.radius + terrain.groundHeight(n.x, n.y, n.z) + 0.05));
    pl.vel.set(0, 0, 0);
    pl.camForward.copy(d);
    pl.facing.copy(p.faceCamera ? d.clone().negate() : d);
    pl.camPitch = p.pitch;
    pl.camDistance = p.camDistance;
    for (const el of document.querySelectorAll<HTMLElement>("body > *:not(#game)")) el.style.visibility = "hidden";
  }, [origin, p] as const);
  await page.waitForTimeout(2500);
}

// The owner's MacBook Air M1 in fullscreen: 1440×900 CSS px at device pixel ratio 2 (Medium renders
// 1440 × 1.25 × 0.85 ≈ 1530 px wide). ARTPACKS_VIEW=e2e keeps the journeys' 1280×720 at 1×.
if ((process.env.ARTPACKS_VIEW ?? "owner") === "owner") test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

test("artpacks · shots", { tag: ["@artpacks"] }, async ({ player, page }, info) => {
  test.skip(MODE !== "shots", "set ARTPACKS=shots");
  test.setTimeout(30 * 60_000);
  const dir = path.join(DIR, info.project.name);
  mkdirSync(dir, { recursive: true });
  const report: Record<string, unknown> = { project: info.project.name, tier: TIER, uptimeStart: uptime() };
  for (const body of (process.env.ARTPACKS_BODIES ?? "portus,arcadia,meridian").split(",")) {
    await player.open({ offline: true, autoplay: true, tier: TIER, body, nodaynight: true, noweather: true, packs: true, packsdelay: 3_600_000 });
    await inWorld(page);
    await page.waitForTimeout(3000);
    const origin = await page.evaluate(() => (window as W).__game.player.pos.toArray());
    const found = await findPoses(page, body);
    const shots: Record<string, unknown>[] = [];
    for (const p of found.poses) {
      await pose(page, origin, p);
      await page.screenshot({ path: path.join(dir, `${body}-${p.name}-shipped.png`) });
    }
    // The HD pack, swapped in during play (no loading screen), at the same poses.
    const footprintBefore = await gpuFootprintMB(page);
    const before = await page.evaluate(() => (window as W).__shaders.total);
    const t0 = await page.evaluate(() => performance.now());
    await page.evaluate(() => {
      const packs = (window as W).__game.packs;
      packs.pause();
      packs.resume({ delayMs: 0 });
    });
    await expect.poll(async () => (await packsState(page)).busy, { timeout: 300_000, intervals: [500], message: "the packs settle" }).toBe(false);
    const state = await packsState(page);
    // 120 rendered frames after the last swap: no new node builds
    await page.waitForTimeout(3000);
    const after = await page.evaluate(() => (window as W).__shaders.total);
    const frames = await page.evaluate(([t]) => (window as W).__fl.frames.stats(t), [t0] as const);
    const footprintAfter = await gpuFootprintMB(page);
    for (const p of found.poses) {
      await pose(page, origin, p);
      await page.screenshot({ path: path.join(dir, `${body}-${p.name}-hd.png`) });
      shots.push({ ...p });
    }
    report[body] = { origin, poses: shots, rays: found.hits, packs: state, nodeBuildsAfterSwap: after - before, framesDuringSwap: frames, gpuProcess: { before: footprintBefore, after: footprintAfter } };
  }
  report.uptimeEnd = uptime();
  writeFileSync(path.join(dir, "shots.json"), JSON.stringify(report, null, 1));
});

test("artpacks · bench", { tag: ["@artpacks"] }, async ({ player, page }, info) => {
  test.skip(MODE !== "bench", "set ARTPACKS=bench");
  test.setTimeout(30 * 60_000);
  mkdirSync(DIR, { recursive: true });
  const extra: Record<string, string | number | true> = { bench: true, body: "portus", tier: TIER, benchwarm: WARM, benchtime: TIME, benchcrowd: 16, autoplay: true };
  if (PACKS === "off") extra.packs = "off";
  else extra.packs = true;
  const uptimeStart = uptime();
  await player.open(extra);
  await expect.poll(async () => page.evaluate(() => !!(window as W).__benchDone), { timeout: 25 * 60_000, intervals: [2000], message: "the bench finishes" }).toBe(true);
  const bench = await page.evaluate(() => (window as W).__bench);
  const swaps = (bench.packs?.end?.swaps ?? []) as { group: string; uploadAt: number; at: number }[];
  const windows = await page.evaluate((swaps) => swaps.map((s) => ({
    group: s.group,
    before: (window as W).__fl.frames.stats(s.uploadAt - 5000, s.uploadAt - 500),
    during: (window as W).__fl.frames.stats(s.uploadAt - 50, s.at + 500),
  })), swaps);
  const footprint = await gpuFootprintMB(page);
  const result = { project: info.project.name, packs: PACKS, tier: TIER, run: RUN, uptimeStart, uptimeEnd: uptime(), gpuProcess: footprint, swapWindows: windows, bench };
  writeFileSync(path.join(DIR, `bench-${info.project.name}-${TIER}-${PACKS}-${RUN}.json`), JSON.stringify(result, null, 1));
  expect(bench.frames).toBeGreaterThan(0);
  if (PACKS !== "off") expect(bench.packs?.start?.live?.length ?? 0, "the packs were in before the run").toBeGreaterThan(0);
});
