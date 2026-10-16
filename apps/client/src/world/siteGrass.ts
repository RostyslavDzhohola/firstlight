// Where the structure sites keep grass off the ground (D38, D42): Portus' paving, streets and
// footprints (planet/townGround.ts), and a planet outpost's apron, paths and footprints round pad 0
// (planet/outpostGround.ts). Shared by the terrain worker (per-vertex grass weights) and the grass
// system (per blade), so both agree.

import { padDirs, type BodyDef } from "@firstlight/shared";
import { OUTPOST_GROUND_HALF, outpostGrass } from "@firstlight/shared/planet/outpostGround";
import { siteAnchor, siteCoords, townCoords } from "@firstlight/shared/planet/townFrame";
import { townGrass } from "@firstlight/shared/planet/townGround";

/** Grass factor 0..1 at a planet point (any length) for `body`'s site, or null if it has none. */
export function siteGrassMask(body: BodyDef): ((x: number, y: number, z: number) => number) | null {
  const R = body.radius;
  const at: [number, number] = [0, 0];
  if (body.terrain.kind === "hub") return (x, y, z) => townGrass(...townCoords(x, y, z, R, at));
  if (body.id !== "arcadia" && body.id !== "hollowmere" && body.id !== "meridian") return null;
  const pad = padDirs(body)[0]!;
  const anchor = siteAnchor(pad);
  // Outside the outpost's raster (a cheap chord test against pad 0) grass grows as before.
  const reach = Math.sin(Math.min(Math.PI / 2, (OUTPOST_GROUND_HALF * 1.45) / R));
  const reach2 = reach * reach;
  return (x, y, z) => {
    const l = Math.hypot(x, y, z);
    const dx = x / l - pad[0], dy = y / l - pad[1], dz = z / l - pad[2];
    if (dx * dx + dy * dy + dz * dz > reach2) return 1;
    return outpostGrass(body.id, ...siteCoords(anchor, x, y, z, R, at));
  };
}
