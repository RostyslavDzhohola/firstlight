// "What next" after the tutorial (D-polish-ux-3): a few one-line hints, each shown once per device,
// that point a new player at what the tutorial never mentions: Lark's missions on arrival in Arcadia,
// then, back in Portus after a first mission, Sela Marchbank's trials and the plaza's scoreboard.
// Plus the way to each trial's planet, for Sela's panel and the journal. Pure; the client
// (NextStepsClient.ts) shows them as toasts.

import type { BodyId } from "@firstlight/shared";
import { MISSION_BY_ID, type MissionDef } from "@firstlight/shared/content/missions";

export type NextHintId = "lark" | "sela" | "board";

export interface NextHint {
  id: NextHintId;
  title: string;
  text: string;
}

export const NEXT_HINTS: Record<NextHintId, NextHint> = {
  lark: { id: "lark", title: "What next", text: "Lark, the shepherd by the pad, has your first missions: walk up and press E." },
  sela: { id: "sela", title: "What next", text: "Sela Marchbank in the plaza gives the trials of the Three Gleams: talk to her (E)." },
  board: { id: "board", title: "Scoreboard", text: "The hologram board in the plaza lists the top travellers: finish missions and trials to climb it." },
};

/** The hints due now, in order, leaving out those already `seen`. */
export function nextHints(s: { body: BodyId; missions: readonly { id: string; done: boolean }[]; seen: ReadonlySet<string> }): NextHint[] {
  const out: NextHintId[] = [];
  const def = (id: string) => MISSION_BY_ID.get(id);
  if (s.body === "arcadia" && !s.missions.some((m) => def(m.id)?.body === "arcadia" && !def(m.id)?.giver)) out.push("lark");
  if (s.body === "portus" && s.missions.some((m) => m.done)) {
    if (!s.missions.some((m) => def(m.id)?.trial)) out.push("sela");
    out.push("board");
  }
  return out.filter((id) => !s.seen.has(id)).map((id) => NEXT_HINTS[id]);
}

const PORTAL_WORD: Record<Exclude<BodyId, "portus">, string> = { arcadia: "cyan", hollowmere: "violet", meridian: "orange", lumen: "pearl" };
const TRIAL_PLACE: Record<1 | 2 | 3, string> = { 1: "then out to Highscore Hill", 2: "then south to Thornwood", 3: "then out to the Glasspan Salt Flats" };

/** How to reach a trial from Portus: "Hollowmere: through the plaza's violet portal, then south to Thornwood". "" for other missions. */
export function trialWay(def: MissionDef): string {
  if (!def.trial) return "";
  const planet = def.body[0]!.toUpperCase() + def.body.slice(1);
  return `${planet}: through the plaza's ${PORTAL_WORD[def.body]} portal, ${TRIAL_PLACE[def.trial]}`;
}

const KEY = "fl.nextSteps";

/** Hints shown on this device (localStorage; an empty set when storage is unavailable). */
export function seenHints(store: Pick<Storage, "getItem"> | null = globalThis.localStorage ?? null): Set<string> {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function markHintSeen(id: string, store: Pick<Storage, "getItem" | "setItem"> | null = globalThis.localStorage ?? null): void {
  try {
    const s = seenHints(store);
    s.add(id);
    store?.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // storage full or blocked: the hint may show again, nothing else breaks
  }
}
