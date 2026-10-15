// J4 (HANDOFF 6i; item 6b "the map is inverted, I cannot put a dot where to go, there's no minimap"):
// the minimap shows without covering the HUD; a point due east on the world map is east on the compass
// (right of the player when north is up); a waypoint drops on the map, shows on the compass, and clears.

import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import type { Player } from "./player.ts";

/** HUD parts the minimap must never cover (item 6b). */
const KEEP_CLEAR = ["playerCard", "hotbar", "tutorial", "saveCard", "compass", "missions", "party", "e2e:save-toast", "e2e:save-card"];

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Turn the camera to face north (so north-up and player-up maps agree). */
async function faceNorth(player: Player) {
  await player.face((s) => {
    const h = s.player?.heading ?? 0;
    return h > 180 ? 360 - h : -h;
  }, 3);
}

async function openWorldMap(player: Player): Promise<Locator> {
  await player.tap("KeyM");
  const map = player.page.locator('[data-e2e="world-map"]');
  await expect(map, "M opens the world map").toBeVisible();
  return map;
}

/** The player's marker on the world map: `[data-e2e="map-player"]` when the map lane provides it, else the map's centre. */
async function playerOnMap(player: Player, map: Locator) {
  const marker = player.page.locator('[data-e2e="map-player"]').first();
  const box = (await marker.isVisible().catch(() => false)) ? await marker.boundingBox() : await map.boundingBox();
  expect(box, "a place for the player on the map").not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Bearing (degrees from the strip centre) of an element on the compass strip (±95°, social/compass.ts). */
async function stripBearing(player: Player, el: Locator): Promise<number | null> {
  const strip = await player.page.locator(".fl-compass").first().boundingBox();
  const box = await el.boundingBox();
  if (!strip || !box) return null;
  return ((box.x + box.width / 2 - strip.x) / strip.width - 0.5) * 190;
}

test.describe("J4 map, waypoint and minimap", () => {
  test("J4.1 · item 6b · the minimap shows and covers no HUD part (tutorial, player card, hotbar, save card)", { tag: ["@J4", "@J4.1", "@item-6b"] }, async ({ player, page }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    await player.waitInWorld(90_000, "portus");
    await player.lock();
    await player.until((s) => !!s.onboarding?.active, "tutorial up (the busiest HUD)", 10_000).catch(() => null);
    await player.shot("hud");
    const minimap = page.locator('[data-e2e="minimap"]');
    await expect(minimap, "a minimap on the HUD").toBeVisible();
    const rects = (await page.evaluate(() => (window as any).__fl.hudRects())) as Record<string, Rect>;
    await player.note("hud rects", rects);
    const mm = rects["e2e:minimap"]!;
    expect(mm.x >= 0 && mm.y >= 0 && mm.x + mm.w <= 1280 && mm.y + mm.h <= 720, "minimap fully on screen").toBe(true);
    for (const k of KEEP_CLEAR) if (rects[k]) expect.soft(overlap(mm, rects[k]!), `minimap overlaps ${k}`).toBe(0);
  });

  test("J4.2 · item 6b · a point due east on the world map is east on the compass (map not mirrored)", { tag: ["@J4", "@J4.2", "@item-6b"] }, async ({ player, page }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(90_000, "arcadia");
    await player.lock();
    await faceNorth(player);
    const map = await openWorldMap(player);
    await player.shot("map");
    const me = await playerOnMap(player, map);
    // East of the player on a north-up map is to the right.
    await page.mouse.click(me.x + 60, me.y);
    await expect(page.locator('[data-e2e="map-waypoint"]'), "clicking the map drops a waypoint").toBeVisible();
    const wp = await page.locator('[data-e2e="map-waypoint"]').boundingBox();
    expect(wp!.x + wp!.width / 2, "the waypoint marker sits right of the player marker").toBeGreaterThan(me.x + 20);
    await player.shot("map-waypoint-east");
    await player.tap("KeyM");
    await expect(map).toBeHidden();
    await player.lock();
    const tick = page.locator('[data-e2e="compass-waypoint"]');
    await expect(tick, "the waypoint shows on the compass").toBeVisible();
    const east = page.locator(".fl-compass .cd", { hasText: /^E$/ }).first();
    const tickB = await stripBearing(player, tick);
    const eastB = await stripBearing(player, east);
    await player.note("compass", { tickB, eastB });
    expect(tickB, "compass tick for the waypoint").not.toBeNull();
    expect(Math.abs((tickB ?? 999) - (eastB ?? 90)), "the waypoint is due east on the compass (within 15°)").toBeLessThan(15);
    await player.shot("compass-east");
  });

  test("J4.3 · item 6b · a waypoint drops, clears with right-click, and clears when reached", { tag: ["@J4", "@J4.3", "@item-6b"] }, async ({ player, page }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(90_000, "arcadia");
    await player.lock();
    await faceNorth(player);
    let map = await openWorldMap(player);
    let me = await playerOnMap(player, map);
    await page.mouse.click(me.x + 50, me.y - 30);
    const mapWp = page.locator('[data-e2e="map-waypoint"]');
    await expect(mapWp, "waypoint dropped").toBeVisible();
    await mapWp.click({ button: "right" });
    await expect(mapWp, "right-click clears the waypoint").toBeHidden();
    await player.tap("KeyM");
    await player.lock();
    await expect(page.locator('[data-e2e="compass-waypoint"]'), "no compass tick after clearing").toBeHidden();

    // A near waypoint, then walk to it following the compass tick: it clears on arrival.
    map = await openWorldMap(player);
    me = await playerOnMap(player, map);
    await page.mouse.click(me.x + 12, me.y);
    await expect(mapWp).toBeVisible();
    await player.tap("KeyM");
    await player.lock();
    const tick = page.locator('[data-e2e="compass-waypoint"]');
    await expect(tick).toBeVisible();
    const until = Date.now() + 45_000;
    while (Date.now() < until && (await tick.isVisible())) {
      const b = await stripBearing(player, tick);
      if (b !== null && Math.abs(b) > 8) await player.turn(b);
      await player.hold(["KeyW"], 600);
    }
    await player.shot("waypoint-reached");
    await expect(tick, "the waypoint clears when reached").toBeHidden();
  });
});
