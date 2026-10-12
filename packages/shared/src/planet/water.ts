// Swimming vs wading, shared by the client controller and the server's movement validator so they
// agree at lake edges (F12 final Opus SF2: the server swam 0.2 m shallower than the client and
// corrected honest waders to swim speed).

/** Ground more than this far (m) under the water surface is deep water: bodies swim there. */
export const SWIM_DEPTH = 1.2;

/** A swimmer's feet float this far (m) under the water surface. */
export const SWIM_FLOAT = 1.05;

/** Is ground at height `ground` (above the radius) deep water on a body with this water level? */
export function deepWater(ground: number, waterLevel: number): boolean {
  return ground < waterLevel - SWIM_DEPTH;
}
