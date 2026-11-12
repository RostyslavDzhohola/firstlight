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
  // A real browser refuses pointer lock without a mouse gesture (autoplay, a pad button); headless
  // Chrome grants it. Refuse it here so the pad has to work with the pointer free.
  HTMLElement.prototype.requestPointerLock = function () {
    return Promise.reject(new DOMException("no user gesture", "NotAllowedError"));
  } as typeof HTMLElement.prototype.requestPointerLock;
  (window as unknown as { __pad: unknown }).__pad = {
    set(b: number, on: boolean) {
      buttons[b] = { pressed: on, touched: on, value: on ? 1 : 0 };
      pad.timestamp++;
    },
    axes(a: number[]) {
      pad.axes.splice(0, 4, ...a);
      pad.timestamp++;
    },
    /** Give pointer lock back (the harness's walking helpers turn with the mouse). */
    allowLock() {
      delete (HTMLElement.prototype as { requestPointerLock?: unknown }).requestPointerLock;
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

    // Walk: the left stick pushed directly away from the arrival portal (bearings are relative to where
    // we face), so the walk can't end in a travel.
    const p0 = s0.player!.pos;
    const away = (((s0.portals?.[0]?.bearing ?? 180) + 180) * Math.PI) / 180;
    await stick(player, [Math.sin(away), -Math.cos(away), 0, 0], 1200);
    const s1 = await player.snap();
    await player.note("pad walk", `${dist(p0, s1.player!.pos).toFixed(1)} m`);
    expect(dist(p0, s1.player!.pos), "the left stick walks").toBeGreaterThan(3);
    expect(s1.body, "still on Arcadia").toBe("arcadia");

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

    // Start opens the pause menu; the D-pad moves a visible focus ring; B goes back.
    await press(player, BTN.START);
    await expect(page.locator('[data-e2e="pause-menu"]')).toBeVisible();
    await press(player, BTN.DOWN);
    await expect(page.locator(".fl-padfocus"), "a focus ring on a menu item").toHaveCount(1);
    await player.shot("pad-pause-focus");
    // A on Settings (the row under Resume) opens it: the Gamepad section with the layout.
    const focused = await page.locator(".fl-padfocus").textContent();
    if (/Settings/.test(focused ?? "")) {
      await press(player, BTN.A);
      await expect(page.locator('[data-e2e="settings-gamepad"]'), "Settings shows the Gamepad section").toBeVisible();
      await page.locator('[data-e2e="settings-gamepad"]').scrollIntoViewIfNeeded();
      await player.shot("pad-settings");
      await press(player, BTN.B); // Esc in Settings goes straight back to the game
    } else await press(player, BTN.B);
    await expect(page.locator('[data-e2e="pause-menu"]'), "B goes back to the game").toBeHidden();
    await player.until((s) => s.input.captured === true, "captured again", 5000);

    // On the pad's safe ring RT and the D-pad reach the game, which holsters them with its notices.
    const t0 = await player.now();
    await press(player, BTN.RT, 150);
    await press(player, BTN.LEFT);
    const safe = await player.attackResult(t0, 1200);
    await player.note("pad on the safe ring", JSON.stringify(safe.toasts));
    expect(safe.notice, "RT on the ring: the holstered notice").toBe(true);
    expect(safe.toasts.some((t) => /spells/i.test(t)), "D-pad left on the ring: the no-spells notice").toBe(true);

    // Out in the wild (the harness walks out with keys and the mouse), the pad's RT attacks and D-pad left casts.
    await page.evaluate(() => (window as any).__pad.allowLock());
    await player.lock();
    await player.walkOutOfRing();
    await player.readyToFight();
    const t = await player.now();
    await press(player, BTN.RT, 150);
    const r = await player.attackResult(t, 1500);
    await player.note("pad attack", JSON.stringify(r));
    expect(r.sent.length > 0 || r.accepted, "RT attacks").toBe(true);
    expect(r.notice, "not holstered out here").toBe(false);
    await press(player, BTN.LEFT);
    const cast = await player.until((s) => (s.spells?.slots[0]?.cooldown ?? 0) > 0, "Skipstep cast from the D-pad (its slot cools down)", 5000);
    await player.note("pad cast", JSON.stringify(cast.spells?.slots[0]));
  });

  test.describe("touch", () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

    test("touch · a phone reaches the world and moves with the stick", { tag: ["@touch"] }, async ({ player, page, gfx }) => {
      test.skip(gfx !== "webgl", "input only: one renderer is enough");
      await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia", extra: { touch: true, tier: "low" } });
      await player.waitInWorld(90_000, "arcadia");
      const overlay = page.locator('[data-e2e="touch-overlay"]');
      await expect(overlay, "the touch overlay shows in play").toBeVisible({ timeout: 20_000 });
      await player.until((s) => s.input.device === "touch" && s.input.captured === true, "touch is the device and the input is captured", 10_000);
      await page.waitForTimeout(2000); // the dev placement and the first frames settle

      const cdp: CDPSession = await page.context().newCDPSession(page);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
      const active = () => overlay.getAttribute("data-active");
      const turn = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);

      // 1. Look: one finger dragged on the right half.
      const s0 = await player.snap();
      await touch("touchStart", [{ x: 620, y: 200, id: 2 }]);
      expect(await active(), "the look finger is tracked").toBe("1");
      for (let i = 1; i <= 8; i++) {
        await touch("touchMove", [{ x: 620 + i * 20, y: 200, id: 2 }]);
        await page.waitForTimeout(50);
      }
      await touch("touchEnd", []);
      await page.waitForTimeout(300);
      const s1 = await player.snap();
      const looked = turn(s0.player!.heading, s1.player!.heading);

      // 2. Move: the left thumb pushes up (forward) and holds.
      await touch("touchStart", [{ x: 160, y: 300, id: 1 }]);
      await touch("touchMove", [{ x: 160, y: 240, id: 1 }]);
      await page.waitForTimeout(1500);
      const s2 = await player.snap();
      const moved = dist(s1.player!.pos, s2.player!.pos);

      // 3. Both at once: the stick still held while a second finger looks.
      await touch("touchStart", [{ x: 160, y: 240, id: 1 }, { x: 620, y: 200, id: 2 }]);
      expect(await active(), "two fingers tracked").toBe("2");
      for (let i = 1; i <= 6; i++) {
        await touch("touchMove", [{ x: 160, y: 240, id: 1 }, { x: 620 - i * 20, y: 200, id: 2 }]);
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(600);
      const s3 = await player.snap();
      await player.shot("touch-landscape-play");
      await touch("touchEnd", []);
      const moved2 = dist(s2.player!.pos, s3.player!.pos);
      const looked2 = turn(s2.player!.heading, s3.player!.heading);
      await player.note("touch move", `look ${looked.toFixed(0)}°, walk ${moved.toFixed(1)} m, together ${moved2.toFixed(1)} m and ${looked2.toFixed(0)}°`);
      expect(looked, "a drag on the right half looks").toBeGreaterThan(5);
      expect(moved, "the touch stick walks").toBeGreaterThan(2);
      expect(moved2, "walking continues while another finger looks").toBeGreaterThan(1);
      expect(looked2, "looking works while the stick is held").toBeGreaterThan(5);

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
