// Evidence clips for the wild sites (lane world; review 2026-11-13 fixes): a dev admin with Unit 7's
// carbine fights Bellwether Watch's camp at the tower's foot, then climbs the stair to the lookout by
// walking and looks round. Stop-motion, like treefade.spec.ts: a short step or a shot, then a
// frame, so a loaded machine slows the clip down instead of breaking it. Frames are numbered JPEGs in
// $SITEFILM_OUT/fight/ and $SITEFILM_OUT/climb/ (ffmpeg turns them into clips). Skipped unless set:
//   SITEFILM_OUT=/tmp/sitefilm pnpm exec playwright test -c e2e/playwright.config.ts --project webgl --grep @sitefilm

import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "./fixtures.ts";
import { createTerrain } from "@firstlight/shared";
import { prefabPoint, wildSitePlacements } from "@firstlight/shared/planet/wildSites";

const OUT = process.env.SITEFILM_OUT ?? "";
type V = [number, number, number];

test("sitefilm · fight and climb at Bellwether Watch", { tag: ["@sitefilm"] }, async ({ player, page }) => {
  test.skip(!OUT, "set SITEFILM_OUT to film the wild site");
  test.setTimeout(30 * 60_000);
  const ws = wildSitePlacements(createTerrain("arcadia")).find((p) => p.site.id === "bellwether_watch")!;
  const at = (x: number, z: number): V => prefabPoint(ws.frame, x, z, 0) as V;
  let dir = "";
  let n = 0;
  const shot = () => page.screenshot({ path: path.join(dir, `${String(n++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 82 });
  const film = (name: string) => {
    dir = path.join(OUT, name);
    mkdirSync(dir, { recursive: true });
    n = 0;
  };

  await player.joinAsDevAdmin({ starter: "Unit 7", body: "arcadia", extra: { tier: "medium", time: "0.40" } });
  await player.waitInWorld(240_000, "arcadia");
  await player.lock();
  // Level 8 and a heal every fight frame: stop-motion runs the fight far slower than it plays, and a
  // level-3 Unit 7 fell to the camp in 20 frames (the guardian is level 3).
  await player.admin("level", { level: 8 });
  const face = async (p: V) => {
    const t = await player.targetOf(p);
    if (t && Math.abs(t.bearing) > 4) await player.turn(t.bearing);
  };

  // Point the camera (so W) at planet point `p` in the tangent plane, as the controller tests steer
  // (player.turn's mouse turns drift over a long walk); the camera looks down `pitch` rad. Returns the
  // distance along the ground.
  const steer = (p: V, pitch = -0.2) =>
    page.evaluate(([x, y, z, pitch]) => {
      const pc = (window as unknown as { __game: { player: { pos: { x: number; y: number; z: number; length(): number }; camForward: { set(x: number, y: number, z: number): void }; camPitch: number } } }).__game.player;
      const l = pc.pos.length(), ux = pc.pos.x / l, uy = pc.pos.y / l, uz = pc.pos.z / l;
      let dx = x! - pc.pos.x, dy = y! - pc.pos.y, dz = z! - pc.pos.z;
      const k = dx * ux + dy * uy + dz * uz;
      dx -= k * ux; dy -= k * uy; dz -= k * uz;
      const d = Math.hypot(dx, dy, dz);
      if (d > 1e-6) pc.camForward.set(dx / d, dy / d, dz / d);
      pc.camPitch = pitch!;
      return d;
    }, [p[0], p[1], p[2], pitch] as const);
  const only = process.env.SITEFILM_PART ?? "";

  // ---- The fight: 18 m out in front of the stair, at the camp.
  if (only !== "climb") {
  const start = at(-3, 18); // close enough that the tower stays in the shot
  await player.admin("teleport", { x: start[0], y: start[1], z: start[2] });
  await page.waitForTimeout(4000);
  await face(at(0, 0));
  await player.lookUp((6 * Math.PI) / 180);
  film("fight");
  for (let i = 0; i < 4; i++) await shot();
  let kills = 0;
  for (let i = 0; i < 170; i++) {
    await player.admin("heal");
    const s = await player.snap();
    if (s.player?.dead) throw new Error("died in the fight");
    const foes = (s.npcs ?? []).filter((x) => x.hostile && !x.dead && x.dist < 45).sort((a, b) => a.dist - b.dist);
    const foe = foes[0];
    if (!foe) {
      if (i > 30 && kills > 0 && foes.length === 0) break;
      await face(at(0, 4));
      await player.hold(["KeyW"], 300);
    } else if (foe.dist > 22) {
      if (Math.abs(foe.bearing) > 6) await player.turn(foe.bearing);
      await player.hold(["KeyW"], 300);
    } else if (foe.dist < 5) {
      // Point blank the bolt (it leaves from the hand) flies past a Hopbit at our feet: back off (j3-creeps).
      await player.turn(foe.bearing);
      await player.hold(["KeyS"], 400);
    } else {
      await player.aim((x) => x.npcs?.find((m) => m.id === foe.id && !m.dead) ?? null, 2);
      await player.attack();
      await page.waitForTimeout(120);
      await player.lookUp(0.25 - ((await player.snap()).player?.pitch ?? 0)); // the site in the shot, not the grass
      const after = await player.snap();
      if (after.npcs?.find((m) => m.id === foe.id)?.dead) kills++;
    }
    await shot();
  }
  for (let i = 0; i < 6; i++) await shot();
  console.log(`[sitefilm] fight: ${n} frames, ${kills} kills`);
  }

  // ---- The climb: the camp stands at the tower's foot and would kill a stop-motion climber, so what
  // is left of it after the fight goes first (admin hurt). Then the stair's foot, round the tower,
  // along the walkway, in through the rail's gap.
  const base = at(0, 0);
  for (const m of await player.npcList()) {
    if (!m.boss && m.hp > 0 && Math.hypot(m.x - base[0], m.y - base[1], m.z - base[2]) < 45) await player.npc("hurt", { id: m.id, amount: 100_000 });
  }
  await page.waitForTimeout(1500);
  await player.admin("heal");
  const foot = at(-4.5, 2.35);
  await player.admin("teleport", { x: foot[0], y: foot[1], z: foot[2] });
  await page.waitForTimeout(3000);
  const route: [number, number][] = [[-1.8, 2.35], [2.35, 2.35], [2.35, -2.35], [0.45, -2.35], [0.45, -0.6], [0, 0]];
  await steer(at(...route[0]!));
  await page.waitForTimeout(500);
  film("climb");
  for (let i = 0; i < 4; i++) await shot();
  for (const [w, [x, z]] of route.entries()) {
    const goal = at(x, z);
    let d = Infinity;
    for (let k = 0; k < 80; k++) {
      d = await steer(goal);
      if (d < 0.3) break;
      if (k % 3 === 0) await player.admin("heal");
      await player.hold(["KeyW"], d > 1.5 ? 200 : 100);
      await page.waitForTimeout(60);
      await shot();
    }
    if (d >= 0.3) throw new Error(`climb: stuck ${d.toFixed(2)} m short of waypoint ${w}`);
  }
  const s = await player.snap();
  const top = Math.hypot(...(s.player!.pos as V)) - Math.hypot(...(at(0, 0)));
  console.log(`[sitefilm] climb: on the lookout ${top.toFixed(2)} m above the base`);
  // Look round from the lookout: the camera turns 12° a frame, level with the horizon.
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => {
      const pc = (window as unknown as { __game: { player: { pos: { x: number; y: number; z: number; length(): number }; camForward: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }; camPitch: number } } }).__game.player;
      const l = pc.pos.length(), u = [pc.pos.x / l, pc.pos.y / l, pc.pos.z / l], f = pc.camForward;
      const r = [f.y * u[2]! - f.z * u[1]!, f.z * u[0]! - f.x * u[2]!, f.x * u[1]! - f.y * u[0]!];
      const c = Math.cos(0.21), sn = Math.sin(0.21);
      pc.camForward.set(f.x * c + r[0]! * sn, f.y * c + r[1]! * sn, f.z * c + r[2]! * sn);
      pc.camPitch = 0.05;
    });
    await page.waitForTimeout(80);
    await shot();
  }
  console.log(`[sitefilm] climb: ${n} frames`);

});
