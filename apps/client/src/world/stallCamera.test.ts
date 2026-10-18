// Shop stalls block the third-person camera like buildings (#22, D-view-5): the camera-only volumes
// cover what each stall draws outside its shared solids, and the camera placed round and under every
// safe zone's stall never ends up inside a counter or an awning, nor on the far side of one.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain, type BodyId } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { SHOP_SPOTS } from "@firstlight/shared/content/shops";
import { plazaFacingPlacement, sitePlacements } from "@firstlight/shared/planet/sites";
import type { TownPlacement } from "@firstlight/shared/planet/townFrame";
import { stubCanvasDocument } from "../render/disposeWatch.testutil.ts";
import { emptyStored, resolveSettings } from "../render/quality.ts";
import { testSiteAssets } from "../render/townAssets.testutil.ts";
import type { Input } from "../game/input.ts";
import { PlayerController } from "../game/PlayerController.ts";
import { cameraBoxRay, CAMERA_PAD, inCameraBox, KEEPER_STALL_CAMERA, placeStallBoxes, stallCameraBoxes, stallCameraLocal, unpadded, type CameraBox, type StallBox } from "./stallCamera.ts";

// config.ts reads the URL at import time; ?nochars keeps AvatarView on capsules (no asset fetches).
vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

let restore: () => void;
beforeAll(() => {
  restore = stubCanvasDocument(); // QuestWorld's labels draw on canvases
});
afterAll(() => restore());

const BODIES_: readonly BodyId[] = ["portus", "arcadia", "hollowmere", "meridian"];
const terrains = new Map(BODIES_.map((b) => [b, createTerrain(b)] as const));
const IDENTITY: TownPlacement = { item: 0, prefab: 0, scale: 1, px: 0, py: 0, pz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: 1 };

/** The stall's frame on `body`: Juno's (Portus) or the outpost stall's placement. */
function stallFrame(body: BodyId): TownPlacement {
  const t = terrains.get(body)!;
  if (body === "portus") return plazaFacingPlacement("juno_vale", t)!;
  return sitePlacements(t)[OUTPOSTS[body as OutpostBody].shop.item]!;
}

describe("stall camera volumes", () => {
  it("cover Juno's awning, counter top and crate as QuestWorld draws them", async () => {
    const { QuestWorld } = await import("./QuestWorld.ts");
    const world = new QuestWorld(new THREE.Scene(), "portus", terrains.get("portus")!);
    world.group.updateMatrixWorld(true);
    const boxes = stallCameraBoxes(terrains.get("portus")!);
    expect(boxes).toHaveLength(KEEPER_STALL_CAMERA.length);
    const stall = world.props.find((p) => p.def.id === "juno_vale")!;
    for (const name of ["stall:awning", "stall:top", "stall:crate"]) {
      const mesh = stall.root.getObjectByName(name) as THREE.Mesh;
      expect(mesh, name).toBeTruthy();
      const pos = mesh.geometry.getAttribute("position");
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        // Drawn within its padded volume, at least half the padding inside (QuestWorld's frame is
        // the shared plaza-facing one to within the 2 cm it stands above the ground).
        expect(inCameraBox(boxes, v.x, v.y, v.z), `${name} vertex ${i}`).toBe(true);
        expect(inCameraBox(placeStallBoxes(stallFrame("portus"), KEEPER_STALL_CAMERA, CAMERA_PAD / 2), v.x, v.y, v.z), `${name} vertex ${i}`).toBe(true);
      }
    }
    world.dispose();
  });

  for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
    it(`cover the ${body} outpost stall's awning, valance and sign: everything it draws outside its solid`, async () => {
      const site = OUTPOSTS[body];
      const name = site.prefabs[sitePlacements(terrains.get(body)!)[site.shop.item]!.prefab]!.name;
      const solid = site.prefabs.find((p) => p.name === name)!.solids[0]!; // [shape, cx, cz, hx, hz, y0, y1, yaw]
      const [, cx, cz, hx, hz, , y1] = solid;
      // The volumes in the prefab's own frame (what the GLB's vertices are in).
      const local = placeStallBoxes(IDENTITY, stallCameraLocal(body));
      const mesh = (await testSiteAssets(body)).meshes.get(name)!;
      let outside = 0;
      for (const part of [mesh.opaque, mesh.cutout]) {
        if (!part) continue;
        const p = part.position;
        for (let i = 0; i < p.length; i += 3) {
          const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
          // Within 0.15 m of the solid (posts, the back panel): the camera stops 0.3 m short of it anyway.
          const beyond = Math.max(Math.abs(x - cx) - hx, Math.abs(z - cz) - hz, y - y1);
          if (beyond <= 0.15) continue;
          outside++;
          expect(inCameraBox(local, x, y, z), `${name} vertex (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`).toBe(true);
        }
      }
      expect(outside, "the stall draws an overhang beyond its solid").toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------------------------------

const settings = resolveSettings("medium", false, true, emptyStored(), new Set());
/** Each stall's body in its frame: Juno's from the back of her spot to the counter's front and up to the awning; an outpost stall's solid. */
const STALL_BODY: Record<string, StallBox> = {
  portus: { x: 0, y: 1.45, z: 0.575, w: 3.2, h: 2.9, d: 1.85 },
  arcadia: { x: 0, y: 1.45, z: 0, w: 3.6, h: 2.9, d: 2 },
  hollowmere: { x: 0, y: 1.45, z: 0, w: 3.6, h: 2.9, d: 2 },
  meridian: { x: 0, y: 1.45, z: 0, w: 3.6, h: 2.9, d: 2 },
};
const still = { locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), down: () => false } as unknown as Input;

/** Feet on the ground at stall-frame (x, z) of `body`. */
function feetAt(body: BodyId, x: number, z: number): THREE.Vector3 {
  const t = terrains.get(body)!;
  const f = stallFrame(body);
  const p = new THREE.Vector3(f.px + f.rx * x + f.fx * z, f.py + f.ry * x + f.fy * z, f.pz + f.rz * x + f.fz * z).normalize();
  return p.multiplyScalar(t.body.radius + t.groundHeight(p.x, p.y, p.z));
}

/** Unit tangent at `pos` along stall-frame direction (x, z). */
function along(body: BodyId, pos: THREE.Vector3, x: number, z: number): THREE.Vector3 {
  const f = stallFrame(body);
  const up = pos.clone().normalize();
  const v = new THREE.Vector3(f.rx * x + f.fx * z, f.ry * x + f.fy * z, f.rz * x + f.fz * z);
  return v.addScaledVector(up, -v.dot(up)).normalize();
}

describe("the third-person camera and the shop stalls (#22)", () => {
  for (const body of BODIES_) {
    it(`never ends up inside or beyond ${body}'s stall counter or awning, all the way round and under it`, async () => {
      const { SiteTown } = await import("./SiteTown.ts");
      const t = terrains.get(body)!;
      const town = new SiteTown(t, settings, Promise.resolve(null));
      const solids = town.collider;
      // The pieces themselves (no padding).
      const awnings: readonly CameraBox[] = stallCameraBoxes(t).map(unpadded);
      // The stall's whole body: the counter to the awning, side to side (its frame, unpadded).
      const whole = placeStallBoxes(stallFrame(body), [STALL_BODY[body]!], 0);
      const spot = SHOP_SPOTS.find((s) => s.body === body)!;
      const pc = new PlayerController(t, t.body.waterLevel);
      pc.setStructures(town.moveColliders);
      const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
      const failures: string[] = [];
      let poses = 0;
      // Spots round the stall (frame metres: x right, z front) at the counter, its corners, its sides
      // and its back, and right under the front of the awning.
      const ring: [number, number][] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        for (const r of [2.3, 3.2]) ring.push([Math.sin(a) * r, Math.cos(a) * r]);
      }
      ring.push([0, 1.85], [-1.0, 1.85], [1.0, 1.85], [0, 1.35], [-1.4, 1.35], [1.4, 1.35]);
      for (const [x, z] of ring) {
        for (let h = 0; h < 8; h++) {
          const a = (h / 8) * Math.PI * 2;
          for (const pitch of [-1.2, -0.7, -0.35, -0.15, 0.2, 0.6]) {
            const feet = feetAt(body, x, z);
            pc.teleport(feet.x, feet.y, feet.z);
            pc.update(1 / 60, still, false); // onto the ground, out of any solid the spot touches
            pc.camForward.copy(along(body, pc.pos, Math.sin(a), Math.cos(a)));
            pc.camPitch = pitch;
            for (let k = 0; k < 30; k++) pc.placeCamera(cam); // let it ease out to where it settles
            poses++;
            const c = cam.position;
            const up = pc.pos.clone().normalize();
            const head = pc.pos.clone().addScaledVector(up, 1.65);
            const v = c.clone().sub(head);
            const l = v.length();
            v.divideScalar(l);
            const where = `feet (${x.toFixed(1)}, ${z.toFixed(1)}) heading ${h * 45}° pitch ${pitch}`;
            if (inCameraBox(awnings, c.x, c.y, c.z)) failures.push(`${where}: lens inside an awning or counter`);
            else if (solids.footing(c.x, c.y, c.z, 0, { radius: 0.01, height: 0.01, step: 0 }).inside) failures.push(`${where}: lens inside a structure`);
            else if (cameraBoxRay(awnings, head.x, head.y, head.z, v.x, v.y, v.z, l) < l) failures.push(`${where}: an awning between the head and the lens`);
            // Nor looking back through the stall: the lens on its far side, the stall between it and the
            // player (the e2e caught Portus' open middle, under the awning and over the counter, round 1).
            else if (!inCameraBox(whole, head.x, head.y, head.z) && cameraBoxRay(whole, head.x, head.y, head.z, v.x, v.y, v.z, l) < l) failures.push(`${where}: the lens beyond the stall`);
          }
        }
      }
      town.dispose();
      expect(poses).toBeGreaterThan(1000);
      expect(failures.slice(0, 12), `${failures.length} of ${poses} poses near ${spot.name}`).toEqual([]);
    }, 60_000);
  }
});
