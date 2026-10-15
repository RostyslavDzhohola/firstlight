// J2 (HANDOFF 6i, item 2 "weapons work in the safe zone but not outside — reversed"): for every starter
// and its starter weapon, an attack inside Portus or a pad's safe ring is refused with the safe-zone
// notice, and an attack outside is accepted by the server. The HUD zone label matches the server.
// The owner plays Hexwick with Hexquill I: that pair runs the real join flow and every combat planet.

import { expect, test } from "./fixtures.ts";
import { COMBAT_PLANETS, STARTER_WEAPON, STARTERS, type AttackResult, type Player, type StarterName } from "./player.ts";

/** Attack once facing away from anything we could be training on; report what happened. */
async function attackOnce(player: Player): Promise<AttackResult> {
  const since = await player.attack();
  return player.attackResult(since);
}

/** Inside a safe zone: refused with the notice, nothing accepted by the server. */
async function expectRefusedInside(player: Player, where: string) {
  const s = await player.snap();
  expect(s.zone?.server, `the server has us in a safe zone (${where})`).toBe("safe");
  const r = await attackOnce(player);
  await player.note(`inside ${where}`, r);
  expect.soft(r.accepted, `${where}: the server must not accept an attack inside a safe zone`).toBe(false);
  expect.soft(r.notice, `${where}: the safe-zone notice shows (toasts: ${JSON.stringify(r.toasts)}; sent: ${JSON.stringify(r.sent)})`).toBe(true);
  return r;
}

/** Outside: the server accepts the attack (it echoes our shot, projectile or swing; no `denied`). */
async function expectAcceptedOutside(player: Player, where: string) {
  await player.readyToFight();
  // Attack twice (a first click can be eaten by a weapon switch or the semi-auto edge).
  let r = await attackOnce(player);
  if (!r.accepted) r = await attackOnce(player);
  await player.note(`outside ${where}`, r);
  expect.soft(r.denied, `${where}: no server refusal outside`).toEqual([]);
  expect.soft(r.notice, `${where}: no safe-zone notice outside`).toBe(false);
  expect(r.accepted, `${where}: the server accepted the attack outside (sent: ${JSON.stringify(r.sent)})`).toBe(true);
  return r;
}

async function expectStarterWeapon(player: Player, starter: StarterName) {
  const s = await player.until((x) => !!x.weapon, "our weapon is known", 10_000);
  expect(s.weapon?.id, `${starter} holds the starter weapon`).toBe(STARTER_WEAPON[starter]);
}

test.describe("J2 safe zones and weapons", () => {
  test("J2.1 · item 2 · Hexwick + Hexquill I, the real way: refused in Portus, accepted outside on Arcadia", { tag: ["@J2", "@J2.1", "@item-2"] }, async ({ player }) => {
    await player.playAsNewGuest({ starter: "Hexwick", extra: { tier: "medium" } });
    await player.waitInWorld(90_000, "portus");
    await expectStarterWeapon(player, "Hexwick");
    await player.lock();
    // Face away from the training dummies: a new player shooting at the sky over the plaza.
    const s = await player.snap();
    const dummy = s.dummies?.[0];
    if (dummy) await player.turn(dummy.bearing + 180);
    await player.lookUp(0.25);
    await player.shot("portus-before-attack");
    const inside = await expectRefusedInside(player, "Portus plaza");
    if (inside.sent.includes("train")) await player.note("finding", "Portus attacks go to the tutorial's training dummies (sent `train`), so weapons look like they work in the safe zone.");
    await player.lookUp(-0.25);

    await player.walkThroughPortal("arcadia");
    await player.lock();
    await player.shot("arcadia-arrival");
    await expectRefusedInside(player, "Arcadia arrival pad");
    await player.walkOutOfRing();
    await expectAcceptedOutside(player, "Arcadia, outside the pad ring");
    await player.shot("arcadia-outside");
  });

  for (const starter of STARTERS) {
    test(`J2.${2 + STARTERS.indexOf(starter)} · item 2 · ${starter} + ${STARTER_WEAPON[starter]} I on Arcadia: refused on the pad, accepted outside`, { tag: ["@J2", `@J2.${2 + STARTERS.indexOf(starter)}`, "@item-2"] }, async ({ player }) => {
      await player.joinAsDevAdmin({ starter, body: "arcadia" });
      await player.waitInWorld(90_000, "arcadia");
      await expectStarterWeapon(player, starter);
      await player.lock();
      await expectRefusedInside(player, "Arcadia arrival pad");
      await player.walkOutOfRing();
      await expectAcceptedOutside(player, "Arcadia, outside the pad ring");
      await player.shot("outside");
    });
  }

  for (const planet of COMBAT_PLANETS.filter((p) => p !== "arcadia")) {
    const n = planet === "hollowmere" ? 6 : 7;
    test(`J2.${n} · item 2 · Hexwick + Hexquill I on ${planet}: refused on the pad, accepted outside`, { tag: ["@J2", `@J2.${n}`, "@item-2"] }, async ({ player }) => {
      await player.joinAsDevAdmin({ starter: "Hexwick", body: planet });
      await player.waitInWorld(90_000, planet);
      await expectStarterWeapon(player, "Hexwick");
      await player.lock();
      await expectRefusedInside(player, `${planet} arrival pad`);
      await player.walkOutOfRing();
      await expectAcceptedOutside(player, `${planet}, outside the pad ring`);
      await player.shot("outside");
    });
  }

  test("J2.8 · item 2 · the HUD zone label matches the server, inside and outside the ring", { tag: ["@J2", "@J2.8", "@item-2"] }, async ({ player, page }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(90_000, "arcadia");
    await player.lock();
    const label = page.locator('[data-e2e="zone-label"]');
    await expect(label, "a zone label on the HUD").toBeVisible();
    let s = await player.snap();
    expect(s.zone?.label, "label on the pad").toBe(s.zone?.server);
    expect(s.zone?.server).toBe("safe");
    await player.shot("label-safe");
    await player.walkOutOfRing();
    s = await player.until((x) => x.zone?.server === "danger", "server: outside");
    await expect.poll(async () => (await player.snap()).zone?.label, { message: "label follows the server outside", timeout: 3000 }).toBe("danger");
    await player.shot("label-danger");
  });
});
