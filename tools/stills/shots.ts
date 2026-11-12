// The loading screen's stills (D-showcase-2), captured by capture.ts. Positions are east/north
// metres from `from` (a place in content/places.ts, or a pad index; default pad 0) in that spot's
// tangent frame (places.ts `tangentFrame`: Portus' pole frame is the town's, east = -X, north = +Z),
// plus a height above the ground or the water. `time` is the day fraction. The shots marked `ship`
// are the loader's (apps/client/src/ui/loadingStills.ts STILLS); the rest were candidates.

import type { BodyId } from "../../packages/shared/src/planet/bodies.ts";

export interface CastMember {
  /** STARTERS index (0 Hexwick, 1 Brother Ash, 2 Kappa, 3 Unit 7, 4 Hinoko) and look. */
  starter: number;
  look?: number;
  /** PALETTE_NAMES index (Ivory, Sand, Midnight, Moss, Ember, Dusk). */
  palette: number;
  at: [number, number];
  /** Where they look (east, north). */
  face: [number, number];
  /** ANIM id (0 idle, 1 walk, 2 run, 15 emote) and a clip offset in seconds. */
  anim?: number;
  t?: number;
}

export interface Shot {
  /** File name (apps/client/src/ui/stills/<id>.webp) and loadingStills.ts id. */
  id: string;
  /** In the loader (capture.ts --install copies only these). */
  ship?: boolean;
  body: BodyId;
  caption: string;
  /** CSS object-position for a narrow (phone) crop of the still (loadingStills.ts `focus`). */
  focus?: string;
  from?: string | number;
  time: number;
  cam: [number, number, number];
  look: [number, number, number];
  fov: number;
  dof?: { focus: number; aperture: number; bokeh: number };
  exposure?: number;
  /** PHOTO_FILTERS index (0: the planet's own grade). */
  filter?: number;
  /** The first member is the player's own avatar. */
  cast?: CastMember[];
  /** ms to wait after staging (streaming, grass, shaders, TRAA). */
  wait?: number;
}

/** The Arcadia portal in Portus (content/places.ts: 17 m east-north-east of the plaza). */
const PORTAL_A: [number, number] = [14.66, 8.46];

export const SHOTS: Shot[] = [
  // ------------------------------------------------------------------- Portus, the castle town
  {
    id: "portus-portal", ship: true, body: "portus", caption: "The portals of Portus", time: 0.42, focus: "70% 50%",
    cam: [6.0, 2.8, 1.6], look: [PORTAL_A[0], PORTAL_A[1], 2.6], fov: 52, dof: { focus: 5.0, aperture: 4, bokeh: 2 }, exposure: 1.1,
    cast: [
      { starter: 0, palette: 2, at: [10.6, 6.1], face: PORTAL_A, anim: 1 },
      { starter: 4, palette: 4, at: [9.2, 7.6], face: PORTAL_A, t: 0.6 },
      { starter: 1, palette: 1, at: [12.0, 4.4], face: PORTAL_A, t: 1.1 },
    ],
  },
  {
    id: "portus-plaza-dusk", ship: true, body: "portus", caption: "Portus, the castle town", time: 0.42,
    cam: [-2, -12, 1.7], look: [0, 25, 14], fov: 65,
    cast: [
      { starter: 2, look: 1, palette: 3, at: [-1.2, -6.5], face: [0, 30] },
      { starter: 3, palette: 0, at: [1.0, -6.0], face: [0, 30], t: 0.7 },
    ],
  },
  {
    id: "portus-plaza-night", body: "portus", caption: "Portus at night", time: 0.0,
    cam: [-2, -12, 1.7], look: [0, 25, 14], fov: 65,
    cast: [
      { starter: 2, look: 1, palette: 3, at: [-1.2, -6.5], face: [0, 30] },
      { starter: 3, palette: 0, at: [1.0, -6.0], face: [0, 30], t: 0.7 },
    ],
  },
  { id: "portus-above", ship: true, body: "portus", caption: "Portus from above", time: 0.42, cam: [-40, -54, 38], look: [0, 8, 4], fov: 52, wait: 11000 },
  {
    id: "portus-gate", body: "portus", caption: "The Meridian portal, Portus", time: 0.42,
    cam: [0, -5, 1.6], look: [0, -35, 16], fov: 60,
    cast: [{ starter: 3, palette: 0, at: [-0.4, -9.5], face: [0, -17] }],
  },
  // ------------------------------------------------------------------- Arcadia, lake and fields
  {
    id: "arcadia-pond", ship: true, body: "arcadia", from: "clover_fields", caption: "Clover Fields, Arcadia", time: 0.42,
    cam: [2, 2, 1.5], look: [-30, -30, 5], fov: 55,
    cast: [
      { starter: 0, palette: 2, at: [-4, -6], face: [-30, -30] },
      { starter: 2, palette: 3, at: [-6.2, -4.4], face: [-30, -30], t: 0.5 },
    ],
  },
  {
    id: "arcadia-pond-gold", body: "arcadia", from: "clover_fields", caption: "Clover Fields, Arcadia", time: 0.78,
    cam: [2, 2, 1.5], look: [-30, -30, 5], fov: 55,
    cast: [
      { starter: 0, palette: 2, at: [-4, -6], face: [-30, -30] },
      { starter: 2, palette: 3, at: [-6.2, -4.4], face: [-30, -30], t: 0.5 },
    ],
  },
  {
    // The east shore, looking west across the lake to the woods.
    id: "arcadia-lake", ship: true, body: "arcadia", from: "glasswater_lake", caption: "Glasswater Lake, Arcadia", time: 0.42,
    cam: [81, 14, 1.7], look: [-60, 4, 0], fov: 55,
    cast: [
      { starter: 0, palette: 2, at: [75, 11.5], face: [-60, 4] },
      { starter: 2, look: 1, palette: 0, at: [73, 16], face: [-60, 4], t: 0.5 },
    ],
  },
  {
    id: "arcadia-lake-gold", body: "arcadia", from: "glasswater_lake", caption: "Glasswater Lake, Arcadia", time: 0.78,
    cam: [81, 14, 1.7], look: [-60, 4, 0], fov: 55,
    cast: [
      { starter: 0, palette: 2, at: [75, 11.5], face: [-60, 4] },
      { starter: 2, look: 1, palette: 0, at: [73, 16], face: [-60, 4], t: 0.5 },
    ],
  },
  { id: "arcadia-above", body: "arcadia", from: "clover_fields", caption: "Arcadia from above", time: 0.42, cam: [-30, -30, 40], look: [0, 0, 0], fov: 70, wait: 11000 },
  // ------------------------------------------------------------------- Hollowmere, violet dusk
  {
    id: "hollowmere-fen", ship: true, body: "hollowmere", from: "fen_jetty", caption: "Whisper Fen, Hollowmere", time: 0.42,
    cam: [0, 0, 1.6], look: [17, 47, 8], fov: 60,
    cast: [{ starter: 1, palette: 1, at: [3, 7], face: [17, 47] }],
  },
  {
    id: "hollowmere-planet", ship: true, body: "hollowmere", from: "fen_jetty", caption: "Hollowmere at dusk", time: 0.42,
    cam: [0, 0, 1.6], look: [17, -47, 16], fov: 60,
    cast: [{ starter: 2, palette: 5, at: [3, -7], face: [17, -47] }],
  },
  // ------------------------------------------------------------------- Meridian, canyons and chrome
  {
    id: "meridian-waystation", ship: true, body: "meridian", caption: "Waystation Nine, Meridian", time: 0.85,
    cam: [29, 11, 3.2], look: [0, 0, 4], fov: 55,
    cast: [{ starter: 3, palette: 0, at: [24, 7], face: [0, 0] }],
  },
  { id: "meridian-canyons", body: "meridian", from: "cinder_canyons", caption: "Cinder Canyons, Meridian", time: 0.42, cam: [-40, -40, 30], look: [20, 20, 0], fov: 60, wait: 11000 },
  { id: "meridian-canyons-dusk", body: "meridian", from: "cinder_canyons", caption: "Cinder Canyons, Meridian", time: 0.8, cam: [-30, -30, 40], look: [0, 0, 0], fov: 65, wait: 11000 },
  {
    // 330 m north of the pad: chrome spires on the flats, the Cinder Canyons mesa (73 m) behind them.
    id: "meridian-mesa", ship: true, body: "meridian", caption: "Cinder Canyons, Meridian", time: 0.42,
    cam: [40, 330, 1.6], look: [-150, 330, 12], fov: 60, wait: 11000,
    cast: [
      { starter: 3, palette: 0, at: [24, 331.5], face: [-150, 330] },
      { starter: 4, palette: 4, at: [25.5, 328], face: [-150, 330], t: 0.4 },
    ],
  },
  {
    id: "meridian-mesa-dusk", body: "meridian", caption: "Cinder Canyons, Meridian", time: 0.8, wait: 11000,
    cam: [40, 330, 3], look: [-150, 330, 25], fov: 60,
    cast: [{ starter: 3, palette: 0, at: [26, 333], face: [-150, 330] }],
  },
  { id: "meridian-spires", body: "meridian", from: "chrome_spires", caption: "Chrome Spires, Meridian", time: 0.42, cam: [-80, -80, 25], look: [0, 0, 40], fov: 55, wait: 11000 },
];
