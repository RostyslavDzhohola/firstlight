// Portal positions, shared so the server can authorise travel (review: travel bypass) and the
// client draws them in the same place. Portus has three portals on its plaza; each planet has one
// portal home beside its main pad.

import type { BodyDef, BodyId } from "./bodies.ts";
import { padDirs } from "./pads.ts";
import type { Terrain } from "./terrain.ts";

type V3 = [number, number, number];

export interface PortalSpot {
  to: BodyId;
  /** Unit direction of the portal's base. */
  dir: V3;
  /** Base height above the radius. */
  h: number;
  /** World position of the ring centre (2.6 m above the base). */
  center: V3;
  /** Tangent the ring faces (players walk through along it). */
  facing: V3;
}

export const PORTAL_RING_HEIGHT = 2.6;
/** How close (metres) a player must be to a portal ring centre for the server to accept travel. */
export const PORTAL_REACH = 4.5;

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Tangent frame at `up`: fwd from +Z (or +X near the Z poles), right = fwd × up. */
export function tangentFrame(up: V3): { fwd: V3; right: V3 } {
  const ref: V3 = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0] * up[0] + ref[1] * up[1] + ref[2] * up[2];
  const fwd = norm([ref[0] - k * up[0], ref[1] - k * up[1], ref[2] - k * up[2]]);
  const right: V3 = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
  return { fwd, right: norm(right) };
}

export function portalSpots(body: BodyDef, terrain: Terrain): PortalSpot[] {
  const R = body.radius;
  const spots: PortalSpot[] = [];
  const make = (to: BodyId, dir: V3, h: number, facing: V3) => {
    const k = facing[0] * dir[0] + facing[1] * dir[1] + facing[2] * dir[2];
    const f = norm([facing[0] - k * dir[0], facing[1] - k * dir[1], facing[2] - k * dir[2]]);
    const r = R + h;
    spots.push({ to, dir, h, center: [dir[0] * r + dir[0] * PORTAL_RING_HEIGHT, dir[1] * r + dir[1] * PORTAL_RING_HEIGHT, dir[2] * r + dir[2] * PORTAL_RING_HEIGHT], facing: f });
  };
  if (body.terrain.kind === "hub") {
    const up: V3 = [0, 1, 0];
    const { right, fwd } = tangentFrame(up);
    (["arcadia", "hollowmere", "meridian"] as BodyId[]).forEach((to, i) => {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const t: V3 = [right[0] * Math.cos(a) + fwd[0] * Math.sin(a), right[1] * Math.cos(a) + fwd[1] * Math.sin(a), right[2] * Math.cos(a) + fwd[2] * Math.sin(a)];
      const dir = norm([up[0] + (t[0] * 17) / R, up[1] + (t[1] * 17) / R, up[2] + (t[2] * 17) / R]);
      make(to, dir, terrain.groundHeight(dir[0], dir[1], dir[2]), [-t[0], -t[1], -t[2]]);
    });
  } else {
    const d0 = padDirs(body)[0]!;
    const dir0: V3 = [d0[0], d0[1], d0[2]];
    const { fwd } = tangentFrame(dir0);
    const pdir = norm([dir0[0] + (fwd[0] * 8.5) / R, dir0[1] + (fwd[1] * 8.5) / R, dir0[2] + (fwd[2] * 8.5) / R]);
    make("portus", pdir, (terrain.padHeights[0] ?? 0) - 0.2, [-fwd[0], -fwd[1], -fwd[2]]);
  }
  return spots;
}

/** The portal (if any) whose ring centre is within `reach` of a position. */
export function portalNear(spots: readonly PortalSpot[], x: number, y: number, z: number, reach = PORTAL_REACH): PortalSpot | null {
  for (const s of spots) if (Math.hypot(s.center[0] - x, s.center[1] - y, s.center[2] - z) <= reach) return s;
  return null;
}
