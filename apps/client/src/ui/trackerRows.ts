// What the HUD missions panel lists (polish-ux, D-polish-ux-1, #69): the running trial first (shown in
// full, flagged `trial`), then the mission the player tracks (game/missionTrack.ts); then the open missions given out on this
// body; then open ones elsewhere, which say where ("on Hollowmere"); done ones fill any room left. At
// most `max` rows: the rest is one "+N more (J)" line that opens the journal. Each row carries the
// mission's colour (#86). Pure, so it is tested without a DOM.

import type { BodyId } from "@firstlight/shared";
import { MISSION_BY_ID, missionGoal, trackedMission } from "@firstlight/shared/content/missions";
import type { MissionLine } from "./hud.ts";
import { missionColour } from "./missionColour.ts";

export interface TrackerMission {
  id: string;
  done: boolean;
  progress: number;
  goal?: number;
}

export interface TrackerRows {
  lines: MissionLine[];
  /** Open missions not listed (the "+N more (J)" line); 0 hides it. */
  more: number;
  header: string;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function trackerRows(missions: readonly TrackerMission[], body: BodyId, opts: { trial?: string | null; tracked?: string | null; max?: number } = {}): TrackerRows {
  const max = opts.max ?? 3;
  const open = missions.filter((m) => !m.done && MISSION_BY_ID.has(m.id));
  const pick = (id: string | null | undefined) => (id ? open.find((m) => m.id === id) : undefined);
  // The one tracked mission is the compass's and the server's (trackedMission with the player's
  // choice); a running trial leads the list without taking that name (review 2026-11-13 #2).
  const trial = pick(opts.trial);
  const tracked = trackedMission(open, body, opts.tracked ?? null);
  const lead = [...new Set([trial, tracked].filter((m): m is TrackerMission => !!m))];
  const here = open.filter((m) => !lead.includes(m) && MISSION_BY_ID.get(m.id)!.body === body);
  const away = open.filter((m) => !lead.includes(m) && !here.includes(m));
  const ordered = [...lead, ...here, ...away];
  const shown = ordered.slice(0, max);
  const more = ordered.length - shown.length;
  if (more === 0) shown.push(...missions.filter((m) => m.done && MISSION_BY_ID.has(m.id)).slice(0, max - shown.length));
  const lines: MissionLine[] = shown.map((m) => {
    const def = MISSION_BY_ID.get(m.id)!;
    const elsewhere = !m.done && def.body !== body;
    return {
      id: m.id,
      title: def.name,
      detail: elsewhere ? `On ${cap(def.body)} · ${def.objective}` : def.objective,
      progress: m.done ? "Done" : `${m.progress}/${m.goal ?? missionGoal(def)}`,
      state: m.done ? "done" : m === tracked ? "tracked" : "open",
      ...(m === trial ? { trial: true } : {}),
      colour: missionColour(m.id),
    };
  });
  const top = shown[0] ? MISSION_BY_ID.get(shown[0].id) : undefined;
  const header = top ? (top.body === body ? [top.guide, cap(top.body)].join(" · ") : `${open.length} open`) : "";
  return { lines, more, header };
}
