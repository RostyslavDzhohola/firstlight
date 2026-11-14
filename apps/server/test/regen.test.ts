// Out-of-combat regeneration (#77, content.md §1.1): the server heals REGEN.PER_SEC of max HP a second
// once the combat tag (REGEN.DELAY_S without taking or dealing damage) has run out, and a hit stops it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REGEN } from "@firstlight/shared/content/progression";
import { COMBAT_TAG_MS } from "../src/world/combat.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, harness, me, offPad, serverRoom, sleep, tpAndWait, until } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

describe("out-of-combat regeneration (#77)", () => {
  it("waits for the combat tag, then heals 1% of max HP a second; a new hit stops it", async () => {
    expect(COMBAT_TAG_MS).toBe(REGEN.DELAY_S * 1000);
    const b = await bot("mender", "arcadia");
    await tpAndWait(b, offPad("arcadia", 0, 40));
    b.send("admin", { cmd: "unprotect" });
    await sleep(120);
    b.send("admin", { cmd: "damage", args: { target: b.id, amount: 50 } });
    await until("hurt", () => me(b).hp < me(b).maxHp);
    const hurt = me(b).hp;
    const max = me(b).maxHp;
    // In the fight (the tag is up): nothing comes back.
    await sleep(1500);
    expect(me(b).hp).toBe(hurt);
    // As if the tag had run out: regeneration starts.
    const actor = serverRoom(b).actors.get(b.id)!;
    actor.combatUntil = Date.now();
    const t0 = Date.now();
    await until("regenerating", () => me(b).hp >= hurt + 3, 6000);
    const perSec = ((me(b).hp - hurt) / ((Date.now() - t0) / 1000)) / max;
    expect(perSec).toBeGreaterThan(REGEN.PER_SEC * 0.5);
    expect(perSec).toBeLessThan(REGEN.PER_SEC * 2);
    // A hit puts the tag back up: it stops.
    const before = me(b).hp;
    b.send("admin", { cmd: "damage", args: { target: b.id, amount: 5 } });
    await until("hit again", () => actor.combatUntil > Date.now() + 5000 && me(b).hp < before);
    await sleep(200);
    const held = me(b).hp;
    await sleep(1500);
    expect(me(b).hp).toBe(held);
  }, 20_000);
});
