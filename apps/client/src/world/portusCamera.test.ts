// The third-person camera and the player all over the Portus town (#34): round every placed item
// (walls, towers, houses, crates, stalls), the lens's whole near plane stays out of the structures,
// the camera settles instead of flapping between shoulders, and nowhere does the player stay stuck.
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain } from "@firstlight/shared";
import { sitePlacements } from "@firstlight/shared/planet/sites";
import { TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { emptyStored, resolveSettings } from "../render/quality.ts";
import type { Input } from "../game/input.ts";
import { PlayerController } from "../game/PlayerController.ts";
import { STEP_OUT_MAX } from "../game/stepOut.ts";

// config.ts reads the URL at import time; ?nochars keeps AvatarView on capsules (no asset fetches).
vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

const terrain = createTerrain("portus");
const R = terrain.body.radius;
const settings = resolveSettings("medium", false, true, emptyStored(), new Set());
const POINT = { radius: 0.01, height: 0.01, step: 0 };

function keys(down: string[]): Input {
  const held = new Set(down);
  return { locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), down: (k: string) => held.has(k) } as unknown as Input;
}

/** Feet on the ground on three rings round every town item (inside its bound, just outside, a step further), every `every`th. */
function spots(every: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  let n = 0;
  for (const p of sitePlacements(terrain)) {
    const prefab = TOWN_PREFABS[p.prefab];
    if (!prefab) continue;
    const rad = prefab.radius * p.scale;
    for (const r of [rad * 0.6, rad + 0.5, rad + 1.2]) {
      for (let i = 0; i < 12; i++) {
        if (n++ % every) continue;
        const a = (i / 12) * Math.PI * 2;
        const c = Math.cos(a) * r, s = Math.sin(a) * r;
        const v = new THREE.Vector3(p.px + p.rx * c + p.fx * s, p.py + p.ry * c + p.fy * s, p.pz + p.rz * c + p.fz * s).normalize();
        out.push(v.multiplyScalar(R + terrain.groundHeight(v.x, v.y, v.z)));
      }
    }
  }
  return out;
}

/** Unit tangent at `pos`, heading `k` of `n` round from a fixed reference. */
function heading(pos: THREE.Vector3, k: number, n: number): THREE.Vector3 {
  const up = pos.clone().normalize();
  const e = new THREE.Vector3(1, 0, 0);
  return e.addScaledVector(up, -e.dot(up)).normalize().applyAxisAngle(up, (k / n) * Math.PI * 2);
}

async function town() {
  const { SiteTown } = await import("./SiteTown.ts");
  const t = new SiteTown(terrain, settings, Promise.resolve(null));
  const pc = new PlayerController(terrain, terrain.body.waterLevel);
  pc.setStructures(t.moveColliders);
  return { t, pc, solids: t.collider };
}

describe("the camera round the Portus town (#34)", () => {
  it("keeps the whole near plane out of every wall, tower, house and crate, and settles where it stops", async () => {
    const { t, pc, solids } = await town();
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
    const half = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.near;
    const corner = new THREE.Vector3();
    const still = keys([]);
    let poses = 0, lensIn = 0, clipped = 0, unsettled = 0;
    const at = new THREE.Vector3();
    for (const s of spots(3)) {
      pc.teleport(s.x, s.y, s.z);
      for (let k = 0; k < 3; k++) pc.update(1 / 60, still, false); // onto the ground, out of what the spot touches
      if (solids.footing(pc.pos.x, pc.pos.y, pc.pos.z, 0.4).inside) continue;
      for (let h = 0; h < 8; h++) {
        for (const pitch of [-0.7, -0.15, 0.4]) {
          pc.camForward.copy(heading(pc.pos, h, 8));
          pc.camPitch = pitch;
          for (let k = 0; k < 80; k++) pc.placeCamera(cam); // eased in, out, over the other shoulder
          at.copy(cam.position);
          for (let k = 0; k < 10; k++) pc.placeCamera(cam);
          if (cam.position.distanceTo(at) > 1e-3) unsettled++;
          cam.updateMatrixWorld(true);
          poses++;
          const c = cam.position;
          if (solids.footing(c.x, c.y, c.z, 0, POINT).inside) lensIn++;
          for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
            corner.set(sx * half * cam.aspect, sy * half, -cam.near).applyMatrix4(cam.matrixWorld);
            if (solids.footing(corner.x, corner.y, corner.z, 0, POINT).inside) {
              clipped++;
              break;
            }
          }
        }
      }
    }
    t.dispose();
    expect(poses).toBeGreaterThan(50_000);
    expect(lensIn).toBe(0);
    expect(unsettled, `${unsettled} of ${poses} poses still moving`).toBe(0);
    // One ray from the head left 6.6 % of these poses with a near-plane corner in a solid; what is
    // left is the head itself within 0.3 m of a wall (backed into a castle wall, under a lean-to).
    expect(clipped / poses, `${clipped} of ${poses} poses with a near-plane corner in a structure`).toBeLessThan(0.005);
  }, 240_000);
});

describe("stuck pockets in the Portus town (#34)", () => {
  it("from every spot round every town item, walking gets the player a metre away within 2 s, in some direction", async () => {
    const { t, pc, solids } = await town();
    const moves = t.moveColliders;
    let steppedOut = 0;
    const stepOut = moves.stepOut!;
    moves.stepOut = (pos) => {
      const from = pos.clone();
      const moved = stepOut(pos);
      if (moved) {
        steppedOut++;
        // A step the server takes: short, clear where it ends, through nothing.
        expect(from.distanceTo(pos)).toBeLessThanOrEqual(STEP_OUT_MAX + 1e-9);
        expect(solids.isClear(pos)).toBe(true);
        expect(solids.crosses(from.x, from.y, from.z, pos.x, pos.y, pos.z)).toBe(false);
      }
      return moved;
    };
    const still = keys([]), walk = keys(["KeyW"]);
    const stuck: string[] = [];
    let tested = 0;
    for (const s of spots(1)) {
      pc.teleport(s.x, s.y, s.z);
      for (let k = 0; k < 3; k++) pc.update(1 / 60, still, false);
      if (solids.footing(pc.pos.x, pc.pos.y, pc.pos.z, 0.4).inside) continue;
      const start = pc.pos.clone();
      tested++;
      let best = 0;
      for (let h = 0; h < 8 && best < 1; h++) {
        pc.teleport(start.x, start.y, start.z);
        pc.camForward.copy(heading(start, h, 8));
        for (let k = 0; k < 120 && best < 1; k++) {
          pc.update(1 / 60, walk, false);
          best = Math.max(best, pc.pos.distanceTo(start));
        }
      }
      if (best < 1) stuck.push(`(${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)}): ${best.toFixed(2)} m`);
    }
    t.dispose();
    expect(tested).toBeGreaterThan(5000);
    expect(stuck).toEqual([]);
    // The Hall of Firsts' column on its low plinth pins the feet between the two (found by this sweep).
    expect(steppedOut).toBeGreaterThan(0);
  }, 240_000);
});
