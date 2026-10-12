// Staged scenes and admin tools leave nothing permanent behind (F12 review, Opus): stage spawns are
// capped and dissolve, the staged loot pile expires, and boss kills or egg claims in a staged copy,
// or with admin help, write no medals and no Hall of Firsts entries. Seam 1: SDK bots.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bossArena } from "@firstlight/shared/content/arenas";
import { createTerrain } from "@firstlight/shared";
import { NPC_TUNING, npcSystemOf } from "../src/world/npc/index.ts";
import { emitNpcEvent } from "../src/world/npc/tuning.ts";
import { pileStore } from "../src/world/piles.ts";
import { QUEST_RULES } from "../src/world/quests/QuestSystem.ts";
import { STAGE_LIMITS } from "../src/world/quests/stage.ts";
import { progressStore } from "../src/world/quests/store.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, ground, harness, invIds, objAt, serverRoom, tpAndWait, until, type Bot } from "./quest-helpers.ts";

const savedStage = { ...STAGE_LIMITS };
const savedQuest = { ...QUEST_RULES };
beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  Object.assign(STAGE_LIMITS, savedStage);
  Object.assign(QUEST_RULES, savedQuest);
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const staged = (b: Bot) => [...npcSystemOf(serverRoom(b))!.npcs.values()].filter((n) => n.spawned?.reason === "stage" && !n.dead);
const hall = () => progressStore.current.hall().map((h) => h.secretId);

describe("staged scenes", () => {
  it("stage spawns are capped per room and dissolve; the staged pile expires", async () => {
    STAGE_LIMITS.perBody = 10;
    STAGE_LIMITS.ttlMs = 2500;
    STAGE_LIMITS.pileTtlMs = 1500;
    QUEST_RULES.PILE_SWEEP_MS = 100;
    const d = await bot("director", "hollowmere");
    d.send("admin", { cmd: "stage", args: { n: 3 } }); // 4 Bonewalkers + 2 Bone Archers
    await until("first wave", () => staged(d).length === 6);
    d.send("admin", { cmd: "stage", args: { n: 3 } });
    await until("capped", () => staged(d).length === 10);
    const npcs = npcSystemOf(serverRoom(d))!;
    await until("dissolved", () => [...npcs.npcs.values()].every((n) => !n.spawned), 8000);

    const a = await bot("director2", "arcadia");
    a.send("admin", { cmd: "stage", args: { n: 5 } });
    await until("staged pile", () => pileStore.current.list("arcadia").some((p) => p.kind === "staged"));
    const pile = pileStore.current.list("arcadia").find((p) => p.kind === "staged")!;
    expect(pile.expiresAt).toBeGreaterThan(Date.now());
    await until("pile in room state", () => (a.room.state as any).piles.has(pile.id));
    await until("pile swept", () => !pileStore.current.get(pile.id) && !(a.room.state as any).piles.has(pile.id), 6000);
  }, 30_000);

  it("a boss kill in a staged copy writes no medals and no Hall of Firsts entry", async () => {
    const d = await bot("filmcrew", "arcadia");
    d.send("admin", { cmd: "stage", args: { n: 2 } });
    await until("staged", () => d.toasts.some((t) => t.startsWith("Stage 2")));
    emitNpcEvent({ kind: "bossKill", body: "arcadia", boss: "tidewrath", sessionIds: [d.id], userIds: ["filmcrew"], names: ["filmcrew"] });
    await until("told", () => d.toasts.some((t) => t.includes("no medals")));
    expect(d.you.medals).not.toContain("tide_turner");
    expect(hall()).not.toContain("boss:tidewrath");
    // Once the staging window is over, kills count again.
    STAGE_LIMITS.stagedMs = 0;
    d.send("admin", { cmd: "stage", args: { n: 2 } });
    await until("restaged", () => d.toasts.filter((t) => t.startsWith("Stage 2")).length === 2);
    emitNpcEvent({ kind: "bossKill", body: "arcadia", boss: "tidewrath", sessionIds: [d.id], userIds: ["filmcrew"], names: ["filmcrew"] });
    await until("tide turner", () => d.you.medals.includes("tide_turner"));
    expect(hall()).toContain("boss:tidewrath");
  });
});

describe("admin assistance", () => {
  it("an admin heal during a boss fight makes the kill assisted: loot only", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = [];
    const b = await bot("helped", "arcadia");
    const arena = bossArena(createTerrain("arcadia"))!;
    await tpAndWait(b, ground("arcadia", arena.centre.map((v) => v / Math.hypot(...arena.centre))));
    const boss = npcSystemOf(serverRoom(b))!.boss!;
    await until("fight on", () => boss.engaged, 8000);
    b.send("admin", { cmd: "heal" });
    await until("heal seen", () => serverRoom(b).systems.some((s: any) => s.bossAssistedAt > 0));
    emitNpcEvent({ kind: "bossKill", body: "arcadia", boss: "tidewrath", sessionIds: [b.id], userIds: ["helped"], names: ["helped"] });
    await until("told", () => b.toasts.some((t) => t.includes("no medals")));
    expect(b.you.medals).not.toContain("tide_turner");
    expect(hall()).not.toContain("boss:tidewrath");
  }, 20_000);

  it("an admin boss spawn marks the fight assisted; read-only admin tools don't", async () => {
    const b = await bot("spawner", "arcadia");
    b.send("npc", { cmd: "boss", action: "info" });
    await until("info", () => b.count("bossInfo") === 1);
    emitNpcEvent({ kind: "bossKill", body: "arcadia", boss: "tidewrath", sessionIds: [b.id], userIds: ["spawner"], names: ["spawner"] });
    await until("medal", () => b.you.medals.includes("tide_turner"));
    const c = await bot("spawner2", "meridian");
    c.send("npc", { cmd: "boss", action: "spawn" });
    await until("spawned", () => c.count("bossInfo") === 1);
    emitNpcEvent({ kind: "bossKill", body: "meridian", boss: "the_receiver", sessionIds: [c.id], userIds: ["spawner2"], names: ["spawner2"] });
    await until("told", () => c.toasts.some((t) => t.includes("no medals")));
    expect(c.you.medals).not.toContain("decommissioned");
    expect(hall()).not.toContain("boss:receiver");
  });

  it("admin egg claims (and steps an admin opened) give the item but no medal or plaque", async () => {
    const b = await bot("tester", "hollowmere");
    b.send("admin", { cmd: "egg", args: { id: "E5" } });
    await until("crown", () => invIds(b).includes("candle_crown"));
    expect(b.you.medals).not.toContain("bellringer");
    expect(hall()).not.toContain("E5");
    // An admin-opened passage: the claim that follows is assisted too.
    b.send("admin", { cmd: "egg", args: { id: "E6", step: "open" } });
    await tpAndWait(b, objAt("e6_altar"));
    b.send("interact", { target: "e6_altar" });
    await until("bone bell", () => invIds(b).includes("bone_bell"));
    expect(b.you.medals).not.toContain("down_the_well");
    expect(hall()).not.toContain("E6");
  });
});

describe("quest bookkeeping", () => {
  it("the per-player action limiter forgets players once their last second of actions is over", async () => {
    QUEST_RULES.PILE_SWEEP_MS = 100;
    const b = await bot("clicker", "arcadia");
    const quests = serverRoom(b).systems.find((s) => "eggs" in s) as unknown as { ops: Map<string, number[]> };
    b.send("questSync");
    b.send("mission", { action: "accept", id: "A1" }); // far from the guide: refused, but counted
    await until("counted", () => quests.ops.size === 1);
    await until("pruned", () => quests.ops.size === 0, 4000);
  });
});
