// What the HUD zone label and the border banner say (D-zones-1). The label shows what the server
// enforces (its SAFE flag: the shared zone plus the 10 s combat tag); the shared zoneAt names where
// you are. Pure, so it is tested without a DOM.

import type { BodyId, Zone } from "@firstlight/shared";
import { padName } from "@firstlight/shared/content/places";

export interface ZoneInfo {
  zone: "safe" | "danger";
  /** Short chip text. */
  label: string;
  /** Where, for the chip's tooltip and the banner. */
  place: string;
  /** Border banner when the zone flips: title and small print. */
  title: string;
  sub: string;
}

export function zoneInfo(body: BodyId, here: Zone, serverSafe: boolean): ZoneInfo {
  if (serverSafe) {
    const place =
      body === "portus" ? "Portus town" : here.kind === "outpost" ? `${padName(body, 0)} outpost` : here.kind === "pad" ? `${padName(body, here.pad)} pad ring` : "Safe zone";
    return { zone: "safe", label: "Safe", place, title: "Safe zone", sub: `${place} · no damage in or out` };
  }
  if (here.safe) {
    // Inside the zone, but an attack in the last 10 s keeps you fair game (BodyRoom.tickBody).
    return { zone: "danger", label: "Danger", place: "In combat", title: "Still in combat", sub: "Safe 10 s after your last attack" };
  }
  const place = body === "portus" ? "Outside the walls" : "The wilds";
  // (Leaving a planet's outpost through its gates reads the same as leaving a pad ring: the wilds.)
  return { zone: "danger", label: "Danger", place, title: "Leaving the safe zone", sub: "Creeps and other players can hurt you" };
}
