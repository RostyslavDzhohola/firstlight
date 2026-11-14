// Residents speak (#82, D-agents-talk-1): an AI agent sends `speak {line, to?, place?, dist?, dir?}`
// and the server says the authored line (content/residentLines.ts) as a speech bubble to everyone
// within 30 m. No free text: the line is looked up by id, `{you}` and `{me}` are names the server
// knows, and the other slots must come from the catalogue's fixed lists (renderLine). Agents only
// (people have the phrase wheel), alive, at most one line every 2 s and 12 a minute.

import { z } from "zod";
import { COMPASS_WORDS, LINE_BY_ID, renderLine } from "@firstlight/shared/content/residentLines";
import { actorPos } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import type { RoomSystem } from "./systems.ts";

export const SPEECH_RULES = { radius: 30, minGapMs: 2000, perMinute: 12, toWithin: 30 };

const speakSchema = z.strictObject({
  line: z.string().min(1).max(40),
  to: z.string().min(1).max(40).optional(),
  place: z.string().min(1).max(60).optional(),
  dist: z.number().int().min(1).max(5000).optional(),
  dir: z.enum(COMPASS_WORDS).optional(),
});

export function createResidentSpeech(room: BodyRoom): RoomSystem {
  const said = new Map<string, number[]>();
  room.onMessage("speak", speakSchema, (c, m) => {
    const a = room.actors.get(c.sessionId);
    if (!a || a.dead) return;
    const deny = (reason: string) => c.send("denied", { action: "speak", reason });
    if (!a.identity.agent) return deny("agents only");
    const now = Date.now();
    const recent = (said.get(c.sessionId) ?? []).filter((t) => now - t < 60_000);
    if ((recent.length && now - recent[recent.length - 1]! < SPEECH_RULES.minGapMs) || recent.length >= SPEECH_RULES.perMinute) return deny("too fast");
    const line = LINE_BY_ID.get(m.line);
    if (!line) return deny("unknown line");
    const to = m.to ? room.actors.get(m.to) : undefined;
    if (m.to) {
      const here = actorPos(a);
      const there = to ? actorPos(to) : null;
      if (!to || !there || Math.hypot(there[0] - here[0], there[1] - here[1], there[2] - here[2]) > SPEECH_RULES.toWithin) return deny("not near");
    }
    const text = renderLine(line, { you: to?.state.name, me: a.state.name, place: m.place, dist: m.dist, dir: m.dir });
    if (!text) return deny("bad slots");
    recent.push(now);
    said.set(c.sessionId, recent);
    room.broadcastNear("speech", { by: c.sessionId, text, line: line.id, ...(to ? { to: to.id } : {}) }, actorPos(a), SPEECH_RULES.radius);
  });
  return {
    tick() {},
    onPlayerLeave(sessionId) {
      said.delete(sessionId);
    },
  };
}
