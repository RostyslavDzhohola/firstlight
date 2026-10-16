// Shops in every safe zone (round 2): the real server path at each spot in content/shops.ts. Buy and
// sell at Portus and at every arrival outpost, refused away from a till, and locked items (below
// their level, not enough coins, not sold anywhere) refused with the reason the panel shows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHOP_SPOTS } from "@firstlight/shared/content/shops";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, harness, invIds, objAt, padAt, sleep, tpAndWait } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const qty = (b: Awaited<ReturnType<typeof bot>>, id: string) => [...b.you.hotbar, ...b.you.backpack].filter((i: any) => i?.id === id).reduce((n: number, i: any) => n + i.qty, 0);

describe("shops in every safe zone", () => {
  for (const spot of SHOP_SPOTS) {
    it(`trades at the ${spot.name} on ${spot.body}, and only there`, async () => {
      const b = await bot(`trader_${spot.body}`, spot.body);
      b.send("admin", { cmd: "coins", args: { amount: 200 } });
      await waitFor(() => b.you.coins === 200);

      // Away from the till (the main pad's far side, or the plaza on Portus): nothing trades.
      await tpAndWait(b, spot.body === "portus" ? offsetFrom(objAt(spot.id), 9) : padAt(spot.body, 1));
      b.send("buy", { itemId: "tonic_small" });
      await waitFor(() => b.last("shop")?.reason === "too far");
      expect(b.toasts.at(-1)).toContain(`${spot.keeper} at the ${spot.name}`);
      expect(b.you.coins).toBe(200);
      await sleep(1000); // quest actions: 5 per second

      // At the keeper: buy, sell back at 25%.
      await tpAndWait(b, objAt(spot.id));
      b.send("buy", { itemId: "tonic_small", qty: 3 });
      await waitFor(() => b.you.coins === 170);
      expect(qty(b, "tonic_small")).toBe(3);
      b.send("buy", { itemId: "sunbrand", tier: 1 });
      await waitFor(() => b.you.coins === 110);
      const slot = [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === "sunbrand");
      b.send("sell", { slot });
      await waitFor(() => b.you.coins === 125);

      // Locked: tier II needs level 6; a drop-only cosmetic is never sold; too dear for the purse.
      b.send("buy", { itemId: "riverstaff", tier: 2 });
      await waitFor(() => b.last("shop")?.reason === "level");
      expect(b.toasts.at(-1)).toContain("unlocks at level 6");
      await sleep(1000); // quest actions: 5 per second
      b.send("buy", { itemId: "coral_crown" });
      await waitFor(() => b.last("shop")?.reason === "not sold");
      b.send("buy", { itemId: "stillshot", tier: 1 }); // 90 ◎, level 1: fine… after the next one
      b.send("buy", { itemId: "bubble", tier: 1 }); // 120 ◎ > what's left after the rifle
      await waitFor(() => b.last("shop")?.reason === "coins");
      await waitFor(() => b.you.coins === 35); // `you` follows the shop reply on the next tick
      expect(invIds(b)).toContain("stillshot");
      expect([...b.you.hotbar, ...b.you.backpack].some((i: any) => i?.id === "riverstaff" && i.tier === 2)).toBe(false);
      expect(invIds(b)).not.toContain("coral_crown");
      expect(invIds(b)).not.toContain("bubble");
    });
  }
});

/** A point `metres` from `p` along the ground (roughly: a tangent step, then back to the same height). */
function offsetFrom(p: readonly number[], metres: number): [number, number, number] {
  const r = Math.hypot(p[0]!, p[1]!, p[2]!);
  const up = [p[0]! / r, p[1]! / r, p[2]! / r];
  const ref = Math.abs(up[0]!) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const k = ref[0]! * up[0]! + ref[1]! * up[1]! + ref[2]! * up[2]!;
  const t = [ref[0]! - k * up[0]!, ref[1]! - k * up[1]!, ref[2]! - k * up[2]!];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const v = up.map((u, i) => u + (t[i]! / tl) * (metres / r));
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * r, (v[1]! / l) * r, (v[2]! / l) * r];
}
