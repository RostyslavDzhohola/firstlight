// Evidence clip for #74 (trees change shape as you walk towards them): a dev admin on Arcadia at
// Medium walks out of the pad's ring, faces the densest tree line 20–70 m ahead, walks towards it and
// back in short steps with a screenshot after each (stop-motion). The frames are numbered JPEGs in
// $TREEFADE_OUT/<label>/ (ffmpeg turns them into a clip afterwards), so a loaded machine slows the
// clip down instead of breaking it the way a real-time recording does. Skipped unless TREEFADE_OUT is set:
//   TREEFADE_OUT=/tmp/treefade TREEFADE_LABEL=after pnpm exec playwright test -c e2e/playwright.config.ts --project webgpu --grep @treefade

import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "./fixtures.ts";

const OUT = process.env.TREEFADE_OUT ?? "";
const LABEL = process.env.TREEFADE_LABEL ?? "after";

/** Degrees to turn right to face the most trees between 20 and 70 m (15° bins). */
const TREE_BEARING = `(() => { const g = window.__game; const c = g.ctx.camera; const pr = g.planet.props;
  const up = c.position.clone().normalize(); const f = c.getWorldDirection(c.position.clone()); f.addScaledVector(up, -f.dot(up)).normalize();
  const bins = new Map();
  for (const ch of pr.chunks.values()) for (const [k, e] of ch.byKind) { const km = pr.kinds.get(k); if (!km || !["oak","pine","blossom","deadtree"].includes(km.kind)) continue;
    for (let i = 0; i < e.count; i++) { const vx = e.positions[i*3] - c.position.x, vy = e.positions[i*3+1] - c.position.y, vz = e.positions[i*3+2] - c.position.z;
      const d = Math.hypot(vx, vy, vz); if (d < 20 || d > 70) continue; const vd = vx*up.x + vy*up.y + vz*up.z; const tx = vx - up.x*vd, ty = vy - up.y*vd, tz = vz - up.z*vd;
      const s = (f.y*tz - f.z*ty)*up.x + (f.z*tx - f.x*tz)*up.y + (f.x*ty - f.y*tx)*up.z; const dot = f.x*tx + f.y*ty + f.z*tz;
      const a = Math.round(-Math.atan2(s, dot) * 180 / Math.PI / 15) * 15; bins.set(a, (bins.get(a) ?? 0) + 1); } }
  return [...bins].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0; })()`;

test("treefade · walk at a tree line", { tag: ["@treefade"] }, async ({ player, page }) => {
  test.skip(!OUT, "set TREEFADE_OUT to film the tree cross-fade (#74)");
  test.setTimeout(20 * 60_000);
  const dir = path.join(OUT, LABEL);
  mkdirSync(dir, { recursive: true });
  await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia", extra: { tier: "medium" } });
  await player.waitInWorld(240_000, "arcadia");
  await player.lock();
  await player.walkOutOfRing(60_000);
  await page.waitForTimeout(1500);
  await player.turn(Number(await page.evaluate(TREE_BEARING)));
  await player.lookUp((-4 * Math.PI) / 180);
  await page.waitForTimeout(1500);
  // Stop-motion: a short step, then a frame, so every frame is a still view however slow the machine is.
  let n = 0;
  const shot = () => page.screenshot({ path: path.join(dir, `${String(n++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 80 });
  for (let i = 0; i < 4; i++) await shot();
  for (let i = 0; i < 36; i++) {
    await player.hold(["KeyW"], 350);
    await page.waitForTimeout(120);
    await shot();
  }
  for (let i = 0; i < 4; i++) await shot();
  for (let i = 0; i < 30; i++) {
    await player.hold(["KeyS"], 350);
    await page.waitForTimeout(120);
    await shot();
  }
  console.log(`[treefade] ${n} frames in ${dir}`);
});
