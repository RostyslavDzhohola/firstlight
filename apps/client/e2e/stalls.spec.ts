// Shop stalls and the camera (#22, D-view-5): the player walks round and under each safe zone's shop
// stall, looking every way, and no frame has the camera inside a counter or an awning, nor the stall's
// label or awning across the view. Coverage is measured in drawn pixels (__fl.stalls.coverage: each
// frame drawn with and without the label, then the stall, then the keeper). Then trading with E works
// from each side of the counter the keeper faces.
//
// Shots and numbers go to $STALL_SHOTS (default $E2E_OUT/stalls) and $STALL_OUT/<phase>-<body>.json;
// STALL_PHASE=before|after names them (the before run is the same spec against main's game code).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures.ts";
import { OUT } from "./stack.ts";
import type { Player } from "./player.ts";

const PHASE = process.env.STALL_PHASE ?? "after";
const SHOTS = path.join(process.env.STALL_SHOTS ?? path.join(OUT, "stalls"), PHASE);
const NUMBERS = process.env.STALL_OUT ?? path.join(OUT, "stalls");

type V = [number, number, number];
interface StallInfo {
  body: string;
  id: string;
  keeper: V;
  centre: V;
  right: V;
  up: V;
  front: V;
}
interface CameraState {
  inside: boolean;
  inAwning: boolean;
  inSolid: boolean;
  labelDepth: number | null;
  labelOpacity: number | null;
  keeperDistance: number;
}
interface Coverage {
  label: number;
  awning: number;
  /** The rest of the stall: counter, posts, goods, sign, an outpost stall's walls. */
  stall: number;
  keeper: number;
  total: number;
  noise: number;
  /** How many meshes were hidden for the awning and the rest (0: nothing of the stall measured). */
  parts: { awning: number; stall: number };
  camera: CameraState | null;
}
interface Stalls {
  info(): StallInfo | null;
  camera(): Promise<CameraState | null>;
  settle(): Promise<{ frames: number; settled: boolean }>;
  standable(x: number, y: number, z: number): Promise<boolean | null>;
  coverage(o?: object): Promise<Coverage | null>;
  watch: { start(): Promise<boolean>; stop(): { frames: number; inside: number; minLabelDepth: number | null; minVisibleLabelDepth: number | null; worst: unknown[] } | null };
}
const stalls = <T>(player: Player, fn: (s: Stalls) => T | Promise<T>): Promise<T> =>
  player.page.evaluate(`(${fn.toString()})(window.__fl.stalls)`) as Promise<T>;

/**
 * "A small share of the screen" for the awning, in any view sampled (round and under the stall,
 * looking every way): from 2.6 m, or under its overhang at the counter, an outpost's 3.9 × 2.6 m
 * awning legitimately covers up to a quarter of a view (24 % at Arcadia's counter, review round);
 * the camera inside Juno's stall had the stall over 40 %.
 */
const AWNING_MAX = 0.3;
/** The whole stall (awning and the rest) with the player turned from it: under the overhang, looking up, 22 % (review round). */
const TURNED_AWAY_MAX = 0.25;

const SHOPS: Record<string, string> = { portus: "Portus Exchange", arcadia: "Dawnpad Trading Post", hollowmere: "Lanternfall Stall", meridian: "Waystation Supply" };

/** Stall-frame (x right, z toward the customers) metres from the stall's middle → a world point. */
function at(s: StallInfo, x: number, z: number): V {
  return [0, 1, 2].map((i) => s.centre[i]! + s.right[i]! * x + s.front[i]! * z) as V;
}

/** Admin-teleport to `p` (the server puts the feet on the nearest clear ground) and let the camera settle. */
async function teleport(player: Player, p: V) {
  await player.admin("teleport", { x: p[0], y: p[1], z: p[2] });
  await player.until((x) => !!x.player && Math.hypot(x.player.pos[0]! - p[0], x.player.pos[1]! - p[1], x.player.pos[2]! - p[2]) < 1.6, "teleported beside the stall", 10_000);
  await stalls(player, (x) => x.settle());
}

/** Face world point `p` (heading), offset by `off` degrees, at camera pitch `pitch` (rad, + up). */
async function look(player: Player, p: V, off: number, pitch: number) {
  for (let i = 0; i < 3; i++) {
    const t = await player.targetOf(p);
    if (!t) break;
    const want = ((t.bearing + off + 540) % 360) - 180;
    if (Math.abs(want) < 3) break;
    await player.turn(want);
  }
  const s = await player.snap();
  await player.lookUp(pitch - (s.player?.pitch ?? 0));
  await stalls(player, (x) => x.settle()); // the camera eases back out from a wall at 0.25 m a frame
}

for (const body of ["portus", "arcadia", "hollowmere", "meridian"] as const) {
  test(`stalls · #22 · ${body}: round and under the shop stall, no awning or label across the view; E trades from every side`, { tag: ["@stalls", `@stalls-${body}`] }, async ({ player, page }) => {
    test.setTimeout(900_000);
    mkdirSync(SHOTS, { recursive: true });
    mkdirSync(NUMBERS, { recursive: true });
    await player.joinAsDevAdmin({ starter: "Hexwick", body });
    await player.waitInWorld(180_000, body);
    // The stall's faded material (an outpost's own, D-view-5) compiled behind the loading screen.
    const shaders = await player.shaderWatchClosed();
    expect.soft(shaders.afterWarmup, `no shader built after the warm-up (${JSON.stringify(shaders.recent)})`).toBe(0);
    await player.lock();
    const s = (await stalls(player, (x) => x.info()))!;
    expect(s, "the shop's keeper is in the world").toBeTruthy();
    expect(s.body).toBe(body);
    await stalls(player, (x) => x.watch.start());

    // Round the stall at 2.6 m from its middle, and under the front of the awning at the counter.
    const spots: { name: string; x: number; z: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      spots.push({ name: `ring${i * 45}`, x: Math.sin(a) * 2.6, z: Math.cos(a) * 2.6 });
    }
    spots.push({ name: "counter", x: 0, z: body === "portus" ? 1.25 : 1.3 }, { name: "counter-left", x: -1.2, z: body === "portus" ? 1.25 : 1.3 });
    const looks: { name: string; off: number; pitch: number }[] = [];
    for (const [hn, off] of [["at", 0], ["away", 180], ["left", -90], ["right", 90]] as const) for (const [pn, pitch] of [["level", -0.1], ["down", -0.7], ["up", 0.3]] as const) looks.push({ name: `${hn}-${pn}`, off, pitch });
    const rows: (Coverage & { spot: string; look: string })[] = [];
    for (const spot of spots) {
      await teleport(player, at(s, spot.x, spot.z));
      for (const l of looks) {
        await look(player, s.centre, l.off, l.pitch);
        let c = await stalls(player, (x) => x.coverage());
        if (!c) continue;
        // A lightning flash or a gust between the frames of one measure shows up as cover: anything
        // large is measured again and the smaller of the two kept, part by part.
        if (c.label > 0.02 || c.awning > 0.1 || c.stall + c.keeper > 0.15) {
          const again = await stalls(player, (x) => x.coverage());
          if (again) c = { ...c, label: Math.min(c.label, again.label), awning: Math.min(c.awning, again.awning), stall: Math.min(c.stall, again.stall), keeper: Math.min(c.keeper, again.keeper), total: Math.min(c.total, again.total) };
        }
        rows.push({ ...c, spot: spot.name, look: l.name });
        // The view the owner recorded: at the counter, turned away from it, looking down; and every
        // pose where something covers a lot.
        if ((spot.name === "counter" && l.name.startsWith("away")) || c.label > 0.03 || c.awning > 0.1 || (c.awning + c.stall > 0.15 && l.name.startsWith("away")) || c.camera?.inside) {
          await page.screenshot({ path: path.join(SHOTS, `${body}-${spot.name}-${l.name}.png`) }).catch(() => {});
        }
      }
    }
    // A real walk: strafe round the stall facing it, then push into the counter from the front.
    await teleport(player, at(s, 0, 2.6));
    for (let i = 0; i < 10; i++) {
      await look(player, s.centre, 0, -0.35);
      await player.hold(["KeyA"], 450);
    }
    await teleport(player, at(s, 0, 2.6));
    await look(player, s.centre, 0, -0.2);
    await player.hold(["KeyW"], 1400);
    await look(player, s.centre, 180, -0.6);
    await page.screenshot({ path: path.join(SHOTS, `${body}-walked-into-counter-turned-away.png`) }).catch(() => {});
    const watched = await stalls(player, (x) => x.watch.stop());

    // E at the counter from the front, both front corners and both sides (the sides the keeper
    // faces, and beside the stall: within reach of the keeper everywhere a player can stand there).
    const trades: { side: string; prompt: string; opened: boolean; blocked?: boolean }[] = [];
    for (const [side, x, z] of [["front", 0, 1.8], ["front-left", -1.6, 1.6], ["front-right", 1.6, 1.6], ["left", -2.3, 0.3], ["right", 2.3, 0.3]] as const) {
      const p = at(s, x, z);
      // A side a wall closes off isn't a way to the keeper: say so instead of trading there.
      const standable = await page.evaluate(([x, y, z]) => (window as unknown as { __fl: { stalls: Stalls } }).__fl.stalls.standable(x, y, z), p);
      if (!standable) {
        trades.push({ side, prompt: "", opened: false, blocked: true });
        continue;
      }
      await teleport(player, p);
      await look(player, s.keeper, 0, -0.15);
      const prompt = await page
        .locator(".fl-prompt")
        .textContent()
        .catch(() => "");
      await player.tap("KeyE");
      const shop = page.locator('[data-e2e="shop"]');
      const opened = await shop.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
      if (opened && side === "front") {
        expect.soft(await shop.getAttribute("aria-label"), "the shop's own panel").toBe(SHOPS[body]);
        await page.screenshot({ path: path.join(SHOTS, `${body}-trade-${side}.png`) }).catch(() => {});
      }
      trades.push({ side, prompt: (prompt ?? "").trim(), opened });
      if (opened) {
        await page.keyboard.press("Escape");
        await expect(shop).toBeHidden({ timeout: 4000 });
      }
      await player.lock();
    }

    const worst = (k: (r: (typeof rows)[number]) => number, filter: (r: (typeof rows)[number]) => boolean = () => true) =>
      rows.filter(filter).reduce((m, r) => (k(r) > m.v ? { v: k(r), at: `${r.spot} ${r.look}` } : m), { v: 0, at: "" });
    const summary = {
      phase: PHASE,
      body,
      poses: rows.length,
      insidePoses: rows.filter((r) => r.camera?.inside).map((r) => `${r.spot} ${r.look}`),
      stallParts: rows[0]?.parts ?? null,
      maxLabel: worst((r) => r.label),
      maxAwning: worst((r) => r.awning),
      // Turned away from the stall (the camera behind the player, toward the stall): it was 40 % of the
      // view at Portus with the camera inside or beyond it. Beside it (left, right) a stall at your
      // shoulder fills that side of the view like a wall does, and facing it, it's what you look at.
      maxStallTurnedAway: worst((r) => r.awning + r.stall, (r) => r.look.startsWith("away")),
      maxStallBeside: worst((r) => r.awning + r.stall, (r) => r.look.startsWith("left") || r.look.startsWith("right")),
      maxStallFacing: worst((r) => r.awning + r.stall, (r) => r.look.startsWith("at")),
      maxKeeper: worst((r) => r.keeper),
      maxTotal: worst((r) => r.total),
      maxNoise: rows.reduce((m, r) => Math.max(m, r.noise), 0),
      watched,
      trades,
    };
    writeFileSync(path.join(NUMBERS, `${PHASE}-${body}.json`), JSON.stringify({ summary, rows }, null, 1));
    await player.note("stalls", summary);

    expect(summary.stallParts?.awning ?? 0, "the stall's awning is measured (Juno's mesh, the outpost's own)").toBeGreaterThan(0);
    for (const t of trades) {
      if (t.blocked) continue; // reported: a wall there (standable() false)
      expect.soft(t.prompt, `${t.side}: the trade prompt`).toMatch(/Trade with/);
      expect.soft(t.opened, `${t.side}: E opens the shop`).toBe(true);
    }
    expect.soft(trades.filter((t) => !t.blocked).length, "the front and its corners at least").toBeGreaterThanOrEqual(3);
    expect.soft(summary.insidePoses, "the camera never inside a counter or an awning (measured poses)").toEqual([]);
    expect.soft(watched?.inside ?? 1, "…nor in any frame of the walk and the poses").toBe(0);
    expect.soft(watched?.minVisibleLabelDepth ?? 99, "no label drawn closer than 1.5 m to the camera").toBeGreaterThanOrEqual(1.5);
    // In every view sampled: the label and the awning cover a small share of the screen.
    expect.soft(summary.maxLabel.v, `the label's share of the screen, any view (worst: ${summary.maxLabel.at})`).toBeLessThan(0.06);
    expect.soft(summary.maxAwning.v, `the awning's share of the screen, any view (worst: ${summary.maxAwning.at})`).toBeLessThan(AWNING_MAX);
    expect.soft(summary.maxStallTurnedAway.v, `the whole stall's share with the player turned from it (worst: ${summary.maxStallTurnedAway.at})`).toBeLessThan(TURNED_AWAY_MAX);
  });
}
