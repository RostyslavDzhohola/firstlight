// Gamepad and touch (D-controls-5, D-controls-6): an emulated standard gamepad walks, looks, attacks,
// casts and drives the pause menu without pointer lock; a phone-sized touch page reaches the world and
// moves with the floating stick. Screenshots of the pad glyphs in the HUD and of the touch overlay
// (landscape play, the portrait hint). WebGL project only: the input path doesn't depend on the renderer.

import type { CDPSession } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import type { Player } from "./player.ts";

/** A fake standard-mapping pad the page reads through navigator.getGamepads (window.__pad drives it). */
function installPad() {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = {
    id: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)",
    index: 0,
    connected: true,
    mapping: "standard",
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons,
    vibrationActuator: { type: "dual-rumble", playEffect: () => Promise.resolve("complete"), reset: () => Promise.resolve("complete") },
  };
  Object.defineProperty(navigator, "getGamepads", { value: () => [pad, null, null, null], configurable: true });
  (window as unknown as { __pad: unknown }).__pad = {
    set(b: number, on: boolean) {
      buttons[b] = { pressed: on, touched: on, value: on ? 1 : 0 };
      pad.timestamp++;
    },
    axes(a: number[]) {
      pad.axes.splice(0, 4, ...a);
      pad.timestamp++;
    },
  };
}

const BTN = { A: 0, B: 1, RT: 7, START: 9, LEFT: 14, DOWN: 13 };

async function press(p: Player, b: number, ms = 120) {
  await p.page.evaluate((b) => (window as any).__pad.set(b, true), b);
  await p.page.waitForTimeout(ms);
  await p.page.evaluate((b) => (window as any).__pad.set(b, false), b);
  await p.page.waitForTimeout(80);
}

async function stick(p: Player, axes: number[], ms: number) {
  await p.page.evaluate((a) => (window as any).__pad.axes(a), axes);
  await p.page.waitForTimeout(ms);
  await p.page.evaluate(() => (window as any).__pad.axes([0, 0, 0, 0]));
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

test.describe("Gamepad and touch", () => {
  test("pad · walks, looks, attacks, casts and pauses without pointer lock", { tag: ["@pad"] }, async ({ player, page, gfx }) => {
    test.skip(gfx !== "webgl", "input only: one renderer is enough");
    await page.addInitScript(installPad);
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(90_000, "arcadia");

    // A press makes the pad the device: the game is captured with the pointer free.
    await press(player, BTN.A);
    const s0 = await player.until((s) => s.input.device === "pad" && s.input.captured === true, "the pad is the device and the input is captured", 10_000);
    expect(s0.input.pointerLocked, "no pointer lock needed").toBe(false);

    // Walk: left stick forward.
    const p0 = s0.player!.pos;
    await stick(player, [0, -1, 0, 0], 1500);
    const s1 = await player.snap();
    await player.note("pad walk", `${dist(p0, s1.player!.pos).toFixed(1)} m`);
    expect(dist(p0, s1.player!.pos), "the left stick walks").toBeGreaterThan(3);

    // Look: right stick right.
    const h0 = s1.player!.heading;
    await stick(player, [0, 0, 1, 0], 500);
    const s2 = await player.snap();
    const turned = Math.abs(((s2.player!.heading - h0 + 540) % 360) - 180);
    await player.note("pad look", `${turned.toFixed(0)}°`);
    expect(turned, "the right stick turns the camera").toBeGreaterThan(20);

    // Glyphs: the HUD keycaps show pad buttons.
    const glyphs = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".fl-hud [data-glyph]")].map((e) => `${e.textContent}→${e.dataset.glyph}`));
    await player.note("pad glyphs", glyphs.join(" "));
    expect(glyphs.length, "HUD keycaps carry pad glyphs").toBeGreaterThan(0);
    await player.shot("pad-hud-glyphs");

    // Attack: RT. Arcadia's pad ring is a safe zone: either a swing goes out, or the holstered notice shows.
    const t = await player.now();
    await press(player, BTN.RT, 150);
    const r = await player.attackResult(t, 1500);
    await player.note("pad attack", JSON.stringify(r));
    expect(r.sent.length > 0 || r.notice || r.accepted, "RT attacks (or is holstered in the safe zone with the notice)").toBe(true);

    // Cast: D-pad left is the spellbar's first slot (Skipstep, Q).
    const before = (await player.snap()).spells?.slots[0];
    await press(player, BTN.LEFT);
    const cast = await player.until((s) => (s.spells?.slots[0]?.cooldown ?? 0) > 0 || !!s.lastDenied, "the first spell cast (or a refusal)", 5000).catch(() => null);
    await player.note("pad cast", JSON.stringify({ before, after: cast?.spells?.slots[0], denied: cast?.lastDenied }));
    expect((cast?.spells?.slots[0]?.cooldown ?? 0) > 0 || cast?.lastDenied?.action === "cast", "D-pad left casts").toBe(true);

    // Start opens the pause menu; the D-pad moves a visible focus ring; B goes back.
    await press(player, BTN.START);
    await expect(page.locator('[data-e2e="pause-menu"]')).toBeVisible();
    await press(player, BTN.DOWN);
    await expect(page.locator(".fl-padfocus"), "a focus ring on a menu item").toHaveCount(1);
    await player.shot("pad-pause-focus");
    await press(player, BTN.B);
    await expect(page.locator('[data-e2e="pause-menu"]'), "B goes back to the game").toBeHidden();
    await player.until((s) => s.input.captured === true, "captured again", 5000);
  });

  test.describe("touch", () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

    test("touch · a phone reaches the world and moves with the stick", { tag: ["@touch"] }, async ({ player, page, gfx }) => {
      test.skip(gfx !== "webgl", "input only: one renderer is enough");
      await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia", extra: { touch: true, tier: "low" } });
      await player.waitInWorld(90_000, "arcadia");
      const overlay = page.locator('[data-e2e="touch-overlay"]');
      await expect(overlay, "the touch overlay shows in play").toBeVisible({ timeout: 20_000 });
      const s0 = await player.until((s) => s.input.device === "touch" && s.input.captured === true, "touch is the device and the input is captured", 10_000);

      const cdp: CDPSession = await page.context().newCDPSession(page);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
      // Left thumb pushes up (forward) while the right thumb drags to look.
      await touch("touchStart", [{ x: 160, y: 260, id: 1 }]);
      await touch("touchMove", [{ x: 160, y: 200, id: 1 }]);
      await touch("touchStart", [{ x: 160, y: 200, id: 1 }, { x: 600, y: 200, id: 2 }]);
      for (let i = 1; i <= 6; i++) {
        await touch("touchMove", [{ x: 160, y: 200, id: 1 }, { x: 600 + i * 20, y: 200, id: 2 }]);
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(1200);
      const mid = await player.snap();
      await player.shot("touch-landscape-play");
      await touch("touchEnd", []);
      const moved = dist(s0.player!.pos, mid.player!.pos);
      const turned = Math.abs(((mid.player!.heading - s0.player!.heading + 540) % 360) - 180);
      await player.note("touch move", `${moved.toFixed(1)} m, turned ${turned.toFixed(0)}°`);
      expect(moved, "the touch stick walks").toBeGreaterThan(2);
      expect(turned, "a drag on the right half looks").toBeGreaterThan(5);

      // Fire held through the overlay's button reaches the game as attack.
      const t = await player.now();
      const fire = page.locator('[data-touch="fire"]');
      const box = (await fire.boundingBox())!;
      await touch("touchStart", [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 3 }]);
      await page.waitForTimeout(200);
      await touch("touchEnd", []);
      const r = await player.attackResult(t, 1200);
      await player.note("touch fire", JSON.stringify(r));
      expect(r.sent.length > 0 || r.notice || r.accepted, "Fire attacks (or is holstered in the safe zone)").toBe(true);

      // Portrait: the turn-sideways cover.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await expect(page.locator(".fl-touch__portrait"), "portrait shows the landscape hint").toBeVisible();
      await player.shot("touch-portrait-hint");
      await page.setViewportSize({ width: 844, height: 390 });
    });
  });
});
