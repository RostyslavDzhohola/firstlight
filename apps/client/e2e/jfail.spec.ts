// Jfail (#85, lane ship): a stranger's worst moments. Each way a first visit can go wrong must end on a
// screen that says what happened and what to do, never a blank page, a frozen world or a console error:
// the server down at Play, graphics unavailable, a full world, the connection lost mid-game, a deploy
// mid-session, a blocked pointer lock, a phone-sized window. And the funnel: the page reports its
// first-time steps to our own server. The failures are made with Playwright routes and init scripts on
// the journeys' local stack, so the real client code handles each one.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { API_ORIGIN, OUT, TARGET } from "./stack.ts";

test.skip(TARGET === "prod", "local stack only: these break the connection on purpose");

/** Console noise that isn't a defect (fullscreen needs a user gesture under ?autoplay; the failed requests we made). */
const BENIGN = [/requestFullscreen/i, /user gesture/i, /Failed to load resource/i, /ERR_CONNECTION_REFUSED|ERR_FAILED|net::/i, /WebSocket/i];
const realErrors = (errors: string[]) => errors.filter((e) => !BENIGN.some((re) => re.test(e)));

/** Keep every WebSocket the page opens, so a test can drop the game's connection like a network would. */
async function captureSockets(page: Page) {
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    const list: WebSocket[] = [];
    (window as unknown as { __sockets: WebSocket[] }).__sockets = list;
    window.WebSocket = class extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        list.push(this);
      }
    } as typeof WebSocket;
  });
}

/** Drop the game's connection (a close the server didn't ask for: the client's rejoin path runs). */
const dropConnection = (page: Page) =>
  page.evaluate(() => {
    for (const s of (window as unknown as { __sockets: WebSocket[] }).__sockets) if (s.readyState === WebSocket.OPEN) s.close(4999, "e2e drop");
  });

const PLAY = `${API_ORIGIN}/api/play`;

/**
 * JFAIL_FILM=1: film each test into $E2E_OUT/films/jfail-<n>-<project>.mp4 (needs ffmpeg) from the
 * page's screencast (CDP, frames as the compositor makes them), played back at the real timing with the
 * last frame held, so a loaded machine gives a choppier clip but never a shorter or faster one.
 */
const FILM = !!process.env.JFAIL_FILM;
test.beforeEach(async ({ page }, info) => {
  if (!FILM) return;
  const id = info.title.match(/Jfail\.\d+/)?.[0]?.replace(".", "-") ?? "jfail";
  const dir = path.join(OUT, "films", `${id}-${info.project.name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames: { file: string; t: number }[] = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
  (info as unknown as { filmStop: () => Promise<void> }).filmStop = async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
    if (frames.length < 2) return;
    // The concat list: each frame for as long as it was on screen (at most 4 s), the last held 2.5 s.
    const lines = frames.flatMap((f, i) => [`file '${f.file}'`, `duration ${i + 1 < frames.length ? Math.min(4, Math.max(0.02, frames[i + 1]!.t - f.t)).toFixed(3) : "2.5"}`]);
    lines.push(`file '${frames[frames.length - 1]!.file}'`);
    const list = path.join(dir, "list.txt");
    writeFileSync(list, lines.join("\n") + "\n");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", "scale=1280:-2,format=yuv420p", "-r", "24", path.join(OUT, "films", `${path.basename(dir)}.mp4`)]);
  };
});
test.afterEach(async ({}, info) => {
  await (info as unknown as { filmStop?: () => Promise<void> }).filmStop?.();
});

test.describe("Jfail a stranger's worst moments", () => {
  test("Jfail.1 · the server is down at Play: the loader says so with Retry, and Retry gets in", { tag: ["@Jfail", "@Jfail.1"] }, async ({ player, page, consoleErrors }) => {
    await page.route(PLAY, (r) => r.abort("connectionrefused"));
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    await expect(page.getByText("Couldn't reach the world"), "the failure is named").toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to the home page" })).toBeVisible();
    await player.shot("server-down");
    await page.unroute(PLAY);
    await page.getByRole("button", { name: "Retry" }).click();
    await player.waitInWorld(120_000, "portus");
    await player.shot("server-down-retried");
    expect(realErrors(consoleErrors), "no console errors").toEqual([]);
  });

  test("Jfail.2 · no WebGL2 and no WebGPU: \"Graphics didn't start\" with what to try", { tag: ["@Jfail", "@Jfail.2"] }, async ({ player, page, consoleErrors }) => {
    await page.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl|webgpu/i.test(type)) return null;
        return (get as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
      Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    });
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    await expect(page.getByText("Graphics didn't start"), "the failure is named").toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/hardware acceleration/i), "and what to do").toBeVisible();
    await player.shot("no-webgl");
    expect(realErrors(consoleErrors).filter((e) => !/webgl|renderer|context/i.test(e)), "no console errors beyond the renderer's own").toEqual([]);
  });

  test("Jfail.3 · a full world: the queue card says so and lets the player in by itself", { tag: ["@Jfail", "@Jfail.3"] }, async ({ player, page, consoleErrors }) => {
    let queued = 0;
    await page.route(PLAY, async (r) => {
      if (queued++ < 2) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, queue: { position: 3, etaSeconds: 40 } }) });
      return r.fallback();
    });
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    await expect(page.getByText("THE WORLD IS FULL"), "the queue card").toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".fl-queue")).toContainText(/3/);
    await player.shot("full-world");
    await player.waitInWorld(120_000, "portus");
    await expect(page.locator(".fl-queue"), "the card goes once in").toHaveCount(0);
    expect(realErrors(consoleErrors), "no console errors").toEqual([]);
  });

  test("Jfail.4 · the connection drops mid-game: Reconnecting…, then back in the world", { tag: ["@Jfail", "@Jfail.4"] }, async ({ player, page, consoleErrors }) => {
    await captureSockets(page);
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(120_000, "arcadia");
    // The first rejoins fail too (the server is "still down"), then it comes back.
    let refused = 0;
    await page.route(PLAY, (r) => (refused++ < 1 ? r.abort("connectionrefused") : r.fallback()));
    await dropConnection(page);
    await expect(page.locator("#loading"), "the loader says what is happening").toContainText(/Reconnecting/, { timeout: 20_000 });
    await player.shot("reconnecting");
    await player.waitInWorld(120_000, "arcadia");
    expect(refused, "a rejoin was refused before it got back").toBeGreaterThan(0);
    await player.shot("reconnected");
    expect(realErrors(consoleErrors), "no console errors").toEqual([]);
  });

  test("Jfail.5 · a deploy mid-session that the one reload can't fix: \"A new version is out\" with Reload", { tag: ["@Jfail", "@Jfail.5"] }, async ({ player, page, consoleErrors }) => {
    await captureSockets(page);
    // The automatic reload for this server version already happened (a cached old page came back).
    await page.addInitScript(() => sessionStorage.setItem("fl.reloadedForVersion", "999"));
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    await player.waitInWorld(120_000, "portus");
    await page.route(PLAY, (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "version", version: 999 }) }));
    await dropConnection(page);
    await expect(page.getByText("A NEW VERSION IS OUT"), "the notice names it").toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(page.locator("#loading"), "no loader left spinning").toBeHidden();
    await player.shot("new-version");
    expect(realErrors(consoleErrors), "no console errors").toEqual([]);
  });

  test("Jfail.6 · the browser refuses pointer lock: the game says to click, nothing throws", { tag: ["@Jfail", "@Jfail.6"] }, async ({ player, page, consoleErrors }) => {
    await page.addInitScript(() => {
      Element.prototype.requestPointerLock = function () {
        return Promise.reject(new DOMException("The user has exited the lock before this request was completed.", "SecurityError"));
      } as typeof Element.prototype.requestPointerLock;
    });
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    await player.waitInWorld(120_000, "portus");
    await page.mouse.click(640, 360);
    await expect(page.getByText("Click to look around"), "the hint tells the player what to do").toBeVisible({ timeout: 15_000 });
    await player.shot("pointer-lock-refused");
    expect(realErrors(consoleErrors), "no console errors").toEqual([]);
  });

  test("Jfail.7 · a phone-sized window: the home page fits and says how to play", { tag: ["@Jfail", "@Jfail.7"] }, async ({ player, page, consoleErrors }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await player.open();
    await expect(page.getByText(/desktop game for keyboard and mouse/i), "the phone card").toBeVisible();
    await expect(page.locator('[data-e2e="home-try-touch"]'), "and the experimental touch try").toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no sideways scrolling").toBeLessThanOrEqual(1);
    await player.shot("phone-home");
    expect(realErrors(consoleErrors), "no console errors").toEqual([]);
  });

  test("Jfail.9 · the tab is frozen in the background, then comes back: the world runs on, the connection holds", { tag: ["@Jfail", "@Jfail.9"] }, async ({ player, page, consoleErrors }) => {
    // JFAIL_BACKGROUND_S (default 60; the brief's case is 600): how long the page stays frozen, as
    // Chrome freezes a background tab (no frames, no timers, no scripts).
    const seconds = Number(process.env.JFAIL_BACKGROUND_S ?? 60);
    test.setTimeout(420_000 + seconds * 1000);
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    const before = await player.waitInWorld(120_000, "portus");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await page.waitForTimeout(seconds * 1000);
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await cdp.detach();
    const t = await player.now();
    await expect.poll(async () => ((await page.evaluate((since) => (window as any).__fl.frames.stats(since).frames, t)) as number) > 30, { timeout: 30_000, message: "frames again after the freeze" }).toBe(true);
    const after = await player.waitInWorld(60_000, "portus");
    expect(after.player?.hp, "still in the world, alive").toBeGreaterThan(0);
    expect(after.net, "still connected").toBeTruthy();
    await player.note("background", { seconds, before: before.net, after: after.net });
    await player.shot("after-background");
    expect(realErrors(consoleErrors), "no console errors").toEqual([]);
  });

  test("Jfail.8 · the funnel: the page reports its first-time steps to our own server, once each", { tag: ["@Jfail", "@Jfail.8"] }, async ({ player, page }) => {
    const posted: { visit: string; steps: { step: string; value?: number; detail?: string }[] }[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith(`${API_ORIGIN}/api/funnel`) && r.method() === "POST") posted.push(JSON.parse(r.postData() ?? "{}"));
    });
    await player.playAsNewGuest({ starter: "Hexwick" });
    await player.waitInWorld(120_000, "portus");
    await expect.poll(() => posted.flatMap((p) => p.steps.map((s) => s.step)), { timeout: 15_000, message: "page, play, pick and world reported" }).toEqual(expect.arrayContaining(["page", "play", "pick", "world"]));
    const steps = posted.flatMap((p) => p.steps);
    const world = steps.find((s) => s.step === "world")!;
    expect(world.value, "seconds from Play to the world").toBeGreaterThan(0);
    expect(world.detail, "the renderer and tier picked").toMatch(player.gfx === "webgpu" ? /^webgpu\// : /^webgl2\//);
    expect(new Set(posted.map((p) => p.visit)).size, "one visit id").toBe(1);
    expect(steps.filter((s) => s.step === "page"), "each step once").toHaveLength(1);
    // A reload is the same browser: nothing it already reported goes again.
    const before = posted.length;
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { __fl?: unknown }).__fl);
    await page.waitForTimeout(2500);
    expect(posted.slice(before).flatMap((p) => p.steps.map((s) => s.step)), "nothing resent after a reload").not.toContain("page");
  });
});
