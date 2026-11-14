// One colour per mission (#86): its status mark in the missions panel, its compass marker and its
// objects in the world (kite panels, rings, beacons) share it, so a glowing thing out there can be
// matched to a row. Picked by the mission's place in the catalogue (stable: ids are append-only).
// Colour is never the only signal (ui/README.md): rows, markers and labels also say the mission's name.

import { MISSIONS } from "@firstlight/shared/content/missions";

/** Distinct on the dark HUD and in daylight, none of them the hostile red or the safe cyan. */
export const MISSION_COLOURS = [0xffc94a, 0x9be15d, 0xff9ad5, 0x8ab4ff, 0xffa55a, 0xc7a6ff] as const;

const INDEX = new Map<string, number>(MISSIONS.map((m, i) => [m.id, i]));

/** The mission's colour as a number (for three.js materials). */
export function missionColourHex(id: string): number {
  const i = INDEX.get(id) ?? 0;
  return MISSION_COLOURS[i % MISSION_COLOURS.length]!;
}

/** The mission's colour as CSS (`#rrggbb`). */
export function missionColour(id: string): string {
  return `#${missionColourHex(id).toString(16).padStart(6, "0")}`;
}
