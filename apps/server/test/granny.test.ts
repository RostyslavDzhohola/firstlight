// Granny Gust (#2): a roaming mini-boss on Hollowmere who outruns a sprinting player, shows a tell
// before each dash, sits winded after three, and has a medal for surviving her and one for beating her.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { GRANNY, GRANNY_LINES, NPC_AREAS, NPC_INDEX, npcDef } from "@firstlight/shared/content/npcs";
import { BASE_MOVE } from "@firstlight/shared/content/starters";
import { MEDAL_BY_ID } from "@firstlight/shared/content/medals";
import { REGEN } from "@firstlight/shared/content/progression";
import { dealDamage } from "../src/world/combat.ts";
import { grannyPhase } from "../src/world/npc/granny.ts";
import { NPC_TUNING, onNpcEvent, resetTuning, type NpcEvent } from "../src/world/npc/index.ts";
import { fakeWorld } from "./npcWorld.ts";

beforeEach(() => {
  resetTuning();
  NPC_TUNING.ambient = false;
  NPC_TUNING.bosses = false;
});
afterEach(() => resetTuning());

/** A point `m` metres from Hollowmere's pad 3 along a fixed tangent, on the surface. */
function fenPoint(w: ReturnType<typeof fakeWorld>, m: number): [number, number, number] {
  const R = BODIES.hollowmere.radius;
  const d = padDirs(BODIES.hollowmere)[3]!;
  const t = [0.3, 0.9, 0.3];
  const v = [d[0] + (t[0]! * (60 + m)) / R, d[1] + (t[1]! * (60 + m)) / R, d[2] + (t[2]! * (60 + m)) / R];
  return w.world.snapToGround(v as [number, number, number]);
}

describe("Granny Gust (#2)", () => {
  it("is appended to the roster, lives on Hollowmere's Whisper Fen, outruns a sprint and holds regen while she chases", () => {
    const def = npcDef("granny_gust");
    expect(NPC_INDEX.get("granny_gust")).toBeGreaterThan(NPC_INDEX.get("cratermaw")!);
    expect(def.runSpeed).toBeGreaterThan(BASE_MOVE.sprint);
    expect(def.attacks[0]!.speed!).toBeGreaterThan(BASE_MOVE.sprint);
    expect(def.attacks[0]!.telegraph).toBeGreaterThanOrEqual(0.8); // a tell you can read
    expect(NPC_AREAS.find((a) => a.id === "whisper_fen")!.singles!.some((s) => s.kind === "granny_gust")).toBe(true);
    expect(REGEN.PAUSED_IN).toContain("miniboss");
    expect(MEDAL_BY_ID.get("outran_granny")).toBeTruthy();
    expect(MEDAL_BY_ID.get("grounded_granny")).toBeTruthy();
    for (const lines of Object.values(GRANNY_LINES)) for (const l of lines) expect(l.length).toBeLessThan(60);
    const w = fakeWorld("hollowmere");
    expect(w.sys.points.some((p) => p.members.some((m) => m.def === NPC_INDEX.get("granny_gust")))).toBe(true);
    w.sys.dispose();
  });

  it("spots you, tells before every dash, sits winded after three (taking more damage), and gives up if you last the chase", () => {
    const w = fakeWorld("hollowmere", { immortal: true });
    const events: NpcEvent[] = [];
    const off = onNpcEvent((e) => events.push(e));
    try {
      const p = w.addPlayer("p", fenPoint(w, 0), 12);
      const g = w.sys.createNpc(NPC_INDEX.get("granny_gust")!, 9, fenPoint(w, 30), w.clock.t, { instant: true, roam: 20 });
      for (let i = 0; i < 20 && grannyPhase(g) !== "chase"; i++) w.step(50);
      expect(grannyPhase(g)).toBe("chase");
      const says = () => w.sent.filter((s) => s.type === "npcSay").map((s) => (s.msg as { line: string }).line);
      expect(says().some((l) => (GRANNY_LINES.spot as readonly string[]).includes(l))).toBe(true);
      // Run the chase: count dash telegraphs (attack 0) and wait for the winded sit.
      let winded = false;
      let tells = 0;
      let seen = 0;
      for (let i = 0; i < 20 * 30 && !winded; i++) {
        w.step(50);
        const atk = w.sent.filter((s) => s.type === "npcAtk" && (s.msg as { id: string; a: number }).id === g.id && (s.msg as { a: number }).a === 0);
        tells += atk.length - seen;
        seen = atk.length;
        winded = grannyPhase(g) === "winded";
      }
      expect(winded).toBe(true);
      expect(tells).toBe(GRANNY.dashesBeforeRest);
      expect(says().some((l) => (GRANNY_LINES.winded as readonly string[]).includes(l))).toBe(true);
      // Winded: hits land harder than on her shawl.
      const hp0 = g.state.hp;
      dealDamage(w.world.host, p, g, 50, false);
      const windedHit = hp0 - g.state.hp;
      expect(windedHit).toBeCloseTo(50 * GRANNY.windedDamage, 0);
      for (let i = 0; i < 20 * (GRANNY.windedSeconds + 0.5); i++) w.step(50);
      expect(grannyPhase(g)).toBe("chase");
      const hp1 = g.state.hp;
      dealDamage(w.world.host, p, g, 50, false);
      expect(hp1 - g.state.hp).toBeCloseTo(50 * GRANNY.armour, 0);
      expect(p.noRegenUntil).toBeGreaterThan(w.clock.t);
      // Last the chase (the fake world keeps you alive): she gives up, the medal event fires, she leaves you be.
      for (let i = 0; i < 20 * GRANNY.surviveSeconds && !events.some((e) => e.kind === "granny"); i++) w.step(50);
      const e = events.find((x) => x.kind === "granny");
      expect(e).toMatchObject({ kind: "granny", outcome: "outran", sessionIds: ["p"] });
      expect(grannyPhase(g)).toBe("roam");
      for (let i = 0; i < 40; i++) w.step(50);
      expect(grannyPhase(g)).toBe("roam");
    } finally {
      off();
      w.sys.dispose();
    }
  });

  it("only time in her sights counts toward surviving her: leaving and coming back doesn't pay the medal early", () => {
    const w = fakeWorld("hollowmere", { immortal: true });
    const events: NpcEvent[] = [];
    const off = onNpcEvent((e) => events.push(e));
    try {
      const p = w.addPlayer("p", fenPoint(w, 0), 12);
      const g = w.sys.createNpc(NPC_INDEX.get("granny_gust")!, 9, fenPoint(w, 30), w.clock.t, { instant: true, roam: 20 });
      for (let i = 0; i < 20 && grannyPhase(g) !== "chase"; i++) w.step(50);
      for (let i = 0; i < 20 * 10; i++) w.step(50); // 10 s of chase
      // Gone (another body, far off) for a long while: she loses you.
      w.movePlayer(p, fenPoint(w, 400));
      for (let i = 0; i < 20 * 60; i++) w.step(50);
      expect(grannyPhase(g)).toBe("roam");
      w.movePlayer(p, fenPoint(w, 0));
      for (let i = 0; i < 20 * 10 && grannyPhase(g) !== "chase"; i++) w.step(50);
      // A fresh chase: ten seconds in, no medal yet (the old time doesn't count).
      for (let i = 0; i < 20 * 10; i++) w.step(50);
      expect(events.some((e) => e.kind === "granny")).toBe(false);
    } finally {
      off();
      w.sys.dispose();
    }
  });

  it("beating her pays like a beast and names her in the kill event (the Grounded medal)", () => {
    const w = fakeWorld("hollowmere", { immortal: true });
    const events: NpcEvent[] = [];
    const off = onNpcEvent((e) => events.push(e));
    try {
      const p = w.addPlayer("p", fenPoint(w, 0), 12);
      const g = w.sys.createNpc(NPC_INDEX.get("granny_gust")!, 9, fenPoint(w, 10), w.clock.t, { instant: true });
      w.step(50);
      for (let i = 0; i < 60 && !g.dead; i++) dealDamage(w.world.host, p, g, 200, false);
      expect(g.dead).toBe(true);
      w.step(50);
      expect(events.some((e) => e.kind === "kill" && e.def === "granny_gust" && e.players.includes("p"))).toBe(true);
      expect(w.sent.some((s) => s.type === "npcSay" && (GRANNY_LINES.beaten as readonly string[]).includes((s.msg as { line: string }).line))).toBe(true);
    } finally {
      off();
      w.sys.dispose();
    }
  });
});
