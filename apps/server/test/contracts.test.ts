// Contract: every medal and mission can actually be earned in production (F12 review, Sonnet 9).
// The medal and mission tests drive the quest system; this checks the other side of each seam: the
// events and messages those medals and missions listen for are emitted by production code, not
// only by tests. A static read of apps/server/src (the server is the only authority).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDALS } from "@firstlight/shared/content/medals";
import { MISSIONS } from "@firstlight/shared/content/missions";
import { EGGS } from "@firstlight/shared/content/secrets";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(readFileSync(p, "utf8"));
  }
  return out;
}

const SRC = sources(join(import.meta.dirname, "../src")).join("\n");
const QUESTS = readFileSync(join(import.meta.dirname, "../src/world/quests/QuestSystem.ts"), "utf8");

/** A production emitter for each signal the quest system listens to. */
const SIGNALS: Record<string, RegExp> = {
  "game:kill": /emitGameEvent\([^;]*type: "kill"/,
  "game:damage": /emitGameEvent\([^;]*\btype: "damage"/s,
  "game:death": /emitGameEvent\([^;]*type: "death"/,
  "game:pickup": /emitGameEvent\([^;]*type: "pickup"/,
  "game:levelUp": /emitGameEvent\([^;]*type: "levelUp"/,
  "game:travel": /emitGameEvent\([^;]*type: "travel"/,
  "game:propBroken": /emitGameEvent\([^;]*type: "propBroken"/,
  "game:onboardingDone": /emitGameEvent\([^;]*type: "onboardingDone"/,
  "npc:kill": /emitNpcEvent\(\{\s*kind: "kill"/,
  "npc:bossKill": /emitNpcEvent\(\{\s*kind: "bossKill"/,
  "npc:egg:E3": /emitNpcEvent\(\{\s*kind: "egg"[^}]*egg: "E3"/,
  "npc:egg:E9": /emitNpcEvent\(\{\s*kind: "egg"[^}]*egg: "E9"/,
  "broadcast:shot": /broadcastNear\("shot"/,
  "message:interact": /onMessage\("interact"/,
};

/** What each medal needs from production code (the quest system awards it when these arrive). */
const MEDAL_NEEDS: Record<string, string[]> = {
  spark: ["game:onboardingDone"],
  ten_down: ["game:levelUp"],
  firstlight: ["game:levelUp"],
  grand_tour: ["game:travel"],
  cartographer: [], // pad touches are checked on the quest tick
  errand_runner: ["npc:kill", "message:interact"], // all nine missions (reach is checked on the tick)
  tide_turner: ["npc:bossKill"],
  regicide: ["npc:bossKill"],
  decommissioned: ["npc:bossKill"],
  triple_crown: ["npc:bossKill"],
  demolition_crew: ["game:propBroken"],
  arc_welder: ["broadcast:shot"],
  long_shot: ["game:damage", "game:death"],
  back_for_my_stuff: ["game:pickup"],
  untouchable: ["npc:bossKill", "game:damage"],
  old_timer: [], // play time accrues on the quest tick
  by_a_thread: ["game:damage"],
  killed_by_a_woolback: ["game:damage", "game:death"],
  with_friends_like_these: ["game:death"],
  own_goal: ["game:death"],
};

/** Known gaps, owned by another lane (none now: onboarding pays Spark since lane/f12-ui). */
const PENDING = new Set<string>();

describe("production emitters (contract)", () => {
  it("every signal name used here has a pattern", () => {
    for (const needs of Object.values(MEDAL_NEEDS)) for (const n of needs) expect(SIGNALS[n], n).toBeTruthy();
  });

  it("every visible medal is awarded by the quest system and everything it listens for is emitted in production", () => {
    for (const m of MEDALS.filter((x) => !x.hidden)) {
      expect(MEDAL_NEEDS[m.id], `${m.id} has a contract entry`).toBeTruthy();
      expect(QUESTS.includes(`"${m.id}"`), `${m.id} is awarded somewhere`).toBe(true);
      if (PENDING.has(m.id)) continue;
      for (const need of MEDAL_NEEDS[m.id]!) expect(SIGNALS[need]!.test(SRC), `${m.id} needs a production ${need}`).toBe(true);
    }
  });

  it("every hidden egg medal comes from its egg's claim, and every egg has a production path", () => {
    expect(QUESTS).toMatch(/this\.award\(a, egg\.medal\)/);
    for (const e of EGGS) expect(MEDALS.find((m) => m.id === e.medal)?.hidden, e.id).toBe(true);
    // E3 and E9 finish through the NPC lane, each from its own emitter (the Golden Hopbit's run,
    // Ticket #000's walk); quests-content.test.ts drives both through the real brain.
    expect(SIGNALS["npc:egg:E3"]!.test(SRC)).toBe(true);
    expect(SIGNALS["npc:egg:E9"]!.test(SRC)).toBe(true);
    expect(SIGNALS["message:interact"]!.test(SRC)).toBe(true);
  });

  it("every mission objective has a production path", () => {
    for (const m of MISSIONS) {
      if (m.hunt) expect(SIGNALS["npc:kill"]!.test(SRC), `${m.id} hunt`).toBe(true);
      if (m.find) expect(SIGNALS["message:interact"]!.test(SRC), `${m.id} find`).toBe(true);
    }
  });

  it("Spark: the onboarding flow awards it on completion (in the payout transaction) and emits onboardingDone", () => {
    expect(SIGNALS["game:onboardingDone"]!.test(SRC)).toBe(true);
    const onboarding = readFileSync(join(import.meta.dirname, "../src/world/onboarding.ts"), "utf8");
    expect(onboarding).toMatch(/const SPARK = "spark"/);
    expect(onboarding).toMatch(/quests\.award\(a, SPARK, notify\)/);
    expect(QUESTS).toMatch(/case "onboardingDone"[\s\S]*?this\.award\(a, "spark"\)/);
  });
});
