// A player at the keyboard: joins the way a person does (the real Play button and starter pick, or a
// dev admin guest placed straight onto a planet on local stacks), then looks, walks and fights with
// real mouse and key events. Game state comes from the test hook (window.__fl, src/debug/e2eHook.ts).

import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { OUT } from "./stack.ts";

export type Gfx = "webgl" | "webgpu";

export const STARTERS = ["Hexwick", "Brother Ash", "Kappa", "Unit 7"] as const;
export type StarterName = (typeof STARTERS)[number];
/** content.md §2.4: each starter's weapon (shared/content/weapons.ts STARTERS). */
export const STARTER_WEAPON: Record<StarterName, string> = { Hexwick: "hexquill", "Brother Ash": "sunbrand", Kappa: "riverstaff", "Unit 7": "carbine" };
export const COMBAT_PLANETS = ["arcadia", "hollowmere", "meridian"] as const;
export type Planet = (typeof COMBAT_PLANETS)[number];

export interface Target {
  dist: number;
  surface: number;
  bearing: number;
  onScreen: boolean;
  aimYaw: number | null;
  aimPitch: number | null;
}
export interface Npc extends Target {
  id: string;
  kind: string;
  name: string | null;
  temper: string | null;
  hostile: boolean;
  level: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  drawn: boolean;
}
/** The parts of `__fl.snapshot()` the journeys read (see src/debug/e2eHook.ts). */
export interface Snap {
  t: number;
  stage: "landing" | "loading" | "starting" | "playing" | "stopped";
  loading: string | null;
  body: string | null;
  gfx: { webgpu: boolean; tier: string | null } | null;
  input: { pointerLocked: boolean; anyPointerLock: boolean; gameLocked: boolean | null; sensitivity: number | null; invertY: boolean | null };
  ui: { visibleE2e: string[]; overlays: string[]; pauseMenuMode: string | null; photo: boolean | null; loggedOutCard: boolean };
  lastDenied: { action: string; reason: string; t: number } | null;
  net?: { roomId: string; sessionId: string } | null;
  player?: { pos: number[]; heading: number; pitch: number; anim: number; clip: string | null; onGround: boolean; swimming: boolean; name: string | null; starter: number | null; hp: number | null; level: number | null; flags: number; protected: boolean; inCombat: boolean; dead: boolean };
  zone?: { server: "safe" | "danger" | null; label: string | null; labelText: string | null; chip: boolean; local: "safe" | "danger" | null; padIndex: number; padDist: number; safeRadius: number };
  you?: { xp: number; xpToNext: number; coins: number; level: number; dead: boolean } | null;
  weapon?: { id: string; name: string; delivery: string; range: number; tier: number; slot: number } | null;
  hotbar?: ({ id: string; tier: number; qty: number } | null)[] | null;
  combat?: { training: boolean; deadUntilRespawn: boolean };
  onboarding?: { active: boolean; paid: boolean; ended: boolean; step: string | null; done: number; allDone: boolean } | null;
  dummies?: (Target & { down: boolean; hits: number | null })[];
  portals?: (Target & { to: string })[];
  npcs?: Npc[];
  npcCount?: number;
}
/** One row of the server's `npc list` (apps/server/src/world/npc/NpcSystem.ts). */
export interface ServerNpc {
  id: string;
  def: string;
  level: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  mode: string;
  boss: boolean;
  area: string | null;
}
export interface FlEvent {
  t: number;
  kind: string;
  type?: string;
  mine?: boolean;
  reason?: string;
  action?: string;
  text?: string;
  [k: string]: unknown;
}
export interface AttackResult {
  /** The server broadcast our shot / projectile / swing. */
  accepted: boolean;
  /** Server refusals (`denied` reasons). */
  denied: string[];
  /** A safe-zone notice (toast) appeared. */
  notice: boolean;
  /** Attack messages we sent (`fire`, `melee`, `train`…). */
  sent: string[];
  toasts: string[];
}

const LOAD_MS = Number(process.env.E2E_LOAD_MS ?? 180_000);
const ATTACK_ECHOES = new Set(["shot", "projectile", "swing"]);
const SAFE_NOTICE = /safe zone|holstered/i;

export class Player {
  /** Where Playwright's mouse is. Under pointer lock only the movement matters, so it may leave the viewport. */
  private mouse = { x: 640, y: 360 };
  private shots = 0;

  constructor(
    readonly page: Page,
    readonly info: TestInfo,
    readonly gfx: Gfx,
  ) {}

  // ------------------------------------------------------------------------------------------ joining

  /** `/?e2e[&webgl]&…`: the hook, the renderer under test, and any extra flags. */
  url(extra: Record<string, string | number | true> = {}): string {
    const parts = ["e2e", ...(this.gfx === "webgl" ? ["webgl"] : [])];
    for (const [k, v] of Object.entries(extra)) parts.push(v === true ? k : `${k}=${encodeURIComponent(String(v))}`);
    return `/?${parts.join("&")}`;
  }

  async open(extra: Record<string, string | number | true> = {}) {
    await this.page.goto(this.url(extra));
    await this.page.waitForFunction(() => !!(window as unknown as { __fl?: unknown }).__fl, null, { timeout: 15_000 });
  }

  /** The Play button: the home page's (item 6a contract) or, until that lands, the landing page's #play. */
  playButton() {
    return this.page.locator('[data-e2e="home-play"], #play').first();
  }

  /**
   * A brand-new guest, the real way: Play → choose the starter → name → "Play as …". Returns when the
   * world starts loading (or the pick never came: a saved character).
   */
  async playAsNewGuest(opts: { starter: StarterName; name?: string; extra?: Record<string, string | number | true> }) {
    await this.open(opts.extra);
    const play = this.playButton();
    await expect(play).toBeVisible();
    const clickedAt = Date.now();
    await play.click();
    const pick = this.page.locator(".fl-charpick");
    await expect(pick, "the starter pick opens after Play").toBeVisible({ timeout: 45_000 });
    const pickShownAt = Date.now();
    await pick.locator(".fl-starter", { hasText: opts.starter }).click();
    const name = pick.locator("#fl-name");
    if (await name.isVisible()) await name.fill(opts.name ?? newName());
    await this.shot("starter-pick");
    await pick.getByRole("button", { name: new RegExp(`^Play as ${opts.starter}`) }).click();
    return { clickedAt, pickShownAt, playAsAt: Date.now() };
  }

  /**
   * A dev admin guest placed straight onto `body` (local stacks: the server runs with
   * ALLOW_DEV_GUESTS=1; admins skip travel tickets, D26). The client's dev token is
   * `dev:<id>:Wanderer-…` (net/auth.ts); storing `<id>:<name>:admin` as the id yields the server's
   * documented `dev:<userId>:<name>:admin` form (auth/identity.ts). Fresh id per test: a new character.
   */
  async joinAsDevAdmin(opts: { starter: StarterName; body: string; extra?: Record<string, string | number | true> }) {
    const id = `e2e${Math.random().toString(16).slice(2, 12)}`;
    const name = `E2E_${id.slice(3, 9)}`;
    await this.page.addInitScript(
      ([id, name, starter]) => {
        if (localStorage.getItem("firstlight.devGuest")) return;
        localStorage.setItem("firstlight.devGuest", `${id}:${name}:admin`);
        localStorage.setItem("fl.starter", String(starter));
        localStorage.setItem("fl.palette", "0");
      },
      [id, name, STARTERS.indexOf(opts.starter)] as const,
    );
    await this.open({ devguest: true, autoplay: true, tier: "medium", body: opts.body, ...opts.extra });
    return { id, name };
  }

  /**
   * In the world: loading screen gone, the loop running, our player replicated. Never waits less than
   * E2E_LOAD_MS (default 180 s): arrival speed is J1's assertion, not every journey's.
   */
  async waitInWorld(timeoutMs = 90_000, body?: string): Promise<Snap> {
    timeoutMs = Math.max(timeoutMs, LOAD_MS);
    let last: Snap | null = null;
    await expect
      .poll(
        async () => {
          last = await this.snap();
          return last.stage === "playing" && !last.loading && !!last.player && !!last.net && (!body || last.body === body);
        },
        { timeout: timeoutMs, intervals: [250], message: `in the world${body ? ` on ${body}` : ""}` },
      )
      .toBe(true);
    return last!;
  }

  // ------------------------------------------------------------------------------------------ state

  snap(): Promise<Snap> {
    return this.page.evaluate(() => (window as unknown as { __fl: { snapshot(): Snap } }).__fl.snapshot());
  }

  events(since = -Infinity): Promise<FlEvent[]> {
    return this.page.evaluate((s) => (window as unknown as { __fl: { events(s: number): FlEvent[] } }).__fl.events(s), since);
  }

  now(): Promise<number> {
    return this.page.evaluate(() => performance.now());
  }

  /** Poll the snapshot until `pred` holds; returns that snapshot (or throws with `what`). */
  async until(pred: (s: Snap) => boolean, what: string, timeoutMs = 15_000): Promise<Snap> {
    let hit: Snap | null = null;
    await expect
      .poll(
        async () => {
          const s = await this.snap();
          if (pred(s)) hit = s;
          return !!hit;
        },
        { timeout: timeoutMs, intervals: [200], message: what },
      )
      .toBe(true);
    return hit!;
  }

  // ------------------------------------------------------------------------------------------ input

  /** Click into the world until the pointer is locked (the game only takes mouse and keys then). */
  async lock() {
    for (let i = 0; i < 4; i++) {
      const s = await this.snap();
      if (s.input.pointerLocked) return;
      this.mouse = { x: 640, y: 360 };
      await this.page.mouse.click(this.mouse.x, this.mouse.y);
      await this.page.waitForTimeout(400);
    }
    expect((await this.snap()).input.pointerLocked, "pointer lock after clicking the world").toBe(true);
  }

  private async sens(): Promise<{ s: number; inv: boolean }> {
    const s = await this.snap();
    return { s: s.input.sensitivity ?? 0.0022, inv: !!s.input.invertY };
  }

  /** Turn the camera right by `deg` (negative: left), with a real mouse move. */
  async turn(deg: number) {
    const { s } = await this.sens();
    const dx = (deg * Math.PI) / 180 / s;
    this.mouse.x += dx;
    await this.page.mouse.move(this.mouse.x, this.mouse.y);
    await this.page.waitForTimeout(80);
  }

  /** Look up (+) or down (−) by `rad`. */
  async lookUp(rad: number) {
    const { s, inv } = await this.sens();
    this.mouse.y += ((inv ? 1 : -1) * rad) / s;
    await this.page.mouse.move(this.mouse.x, this.mouse.y);
    await this.page.waitForTimeout(80);
  }

  /** Turn until `bearing(s)` (degrees, right = +) is within `tol`. */
  async face(bearing: (s: Snap) => number | null, tol = 5) {
    for (let i = 0; i < 4; i++) {
      const b = bearing(await this.snap());
      if (b === null || Math.abs(b) <= tol) return;
      await this.turn(b);
    }
  }

  /** Put a target under the crosshair (yaw and pitch from the camera, the way the server aims). */
  async aim(target: (s: Snap) => Target | null) {
    for (let i = 0; i < 5; i++) {
      const t = target(await this.snap());
      if (!t || t.aimYaw === null || t.aimPitch === null) return false;
      if (Math.abs(t.aimYaw) < 0.015 && Math.abs(t.aimPitch) < 0.02) return true;
      const { s, inv } = await this.sens();
      this.mouse.x += t.aimYaw / s;
      this.mouse.y += ((inv ? 1 : -1) * t.aimPitch) / s;
      await this.page.mouse.move(this.mouse.x, this.mouse.y);
      await this.page.waitForTimeout(120);
    }
    return true;
  }

  async hold(keys: string[], ms: number) {
    for (const k of keys) await this.page.keyboard.down(k);
    await this.page.waitForTimeout(ms);
    for (const k of [...keys].reverse()) await this.page.keyboard.up(k);
  }

  async tap(key: string) {
    await this.page.keyboard.press(key, { delay: 60 });
  }

  /**
   * Esc as a player presses it. Desktop Chrome, while the pointer is locked, takes Esc itself (it
   * releases the lock; the page sees no key). Headless Chrome delivers the key and keeps the lock, so we
   * do what Chrome does (`__fl.act.browserEscape`). Without the lock the key goes to the page.
   */
  async escape() {
    const s = await this.snap();
    if (s.input.anyPointerLock) await this.page.evaluate(() => (window as unknown as { __fl: { act: { browserEscape(): boolean } } }).__fl.act.browserEscape());
    else await this.page.keyboard.press("Escape");
    await this.page.waitForTimeout(250);
  }

  /** An admin console command (dev admin guests only). */
  async admin(cmd: string, args: Record<string, unknown> = {}) {
    return this.page.evaluate(([c, a]) => (window as unknown as { __fl: { act: { admin(c: string, a: object): boolean } } }).__fl.act.admin(c, a), [cmd, args] as const);
  }

  /** The server's full NPC list for this copy (dev admin guests only; not view-filtered). */
  async npcList(): Promise<ServerNpc[]> {
    const r = await this.page.evaluate(() => (window as unknown as { __fl: { act: { npc(c: string): Promise<{ npcs: ServerNpc[] } | null> } } }).__fl.act.npc("list"));
    return r?.npcs ?? [];
  }

  /** Distance, bearing and aim from us to a world point. */
  targetOf(p: readonly number[]): Promise<Target | null> {
    return this.page.evaluate(([x, y, z]) => (window as unknown as { __fl: { targetOf(x: number, y: number, z: number): Target | null } }).__fl.targetOf(x!, y!, z!), [p[0], p[1], p[2]]);
  }

  // ------------------------------------------------------------------------------------------ moving

  /**
   * Walk toward a target until `arrived`, steering with the mouse and getting round obstacles by
   * strafing. False on timeout.
   */
  async walkTo(target: (s: Snap) => Target | null, arrived: (s: Snap) => boolean, opts: { timeoutMs?: number; sprint?: boolean } = {}) {
    const until = Date.now() + (opts.timeoutMs ?? 30_000);
    const trail: number[][] = [];
    let side = "KeyD";
    while (Date.now() < until) {
      const s = await this.snap();
      if (arrived(s)) return true;
      const t = target(s);
      if (!t) return false;
      if (Math.abs(t.bearing) > 8) await this.turn(t.bearing);
      const ms = Math.max(150, Math.min(900, (t.surface / 6) * 1000));
      await this.hold(opts.sprint === false ? ["KeyW"] : ["ShiftLeft", "KeyW"], ms);
      trail.push(s.player!.pos);
      if (trail.length >= 4) {
        const a = trail[trail.length - 4]!;
        const b = s.player!.pos;
        if (Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1) {
          await this.hold([side, "KeyW"], 700);
          await this.tap("Space");
          side = side === "KeyD" ? "KeyA" : "KeyD";
          trail.length = 0;
        }
      }
    }
    return arrived(await this.snap());
  }

  /** Walk out of the pad's safe ring, away from the portal home (on planets) or the given bearing. */
  async walkOutOfRing(timeoutMs = 25_000) {
    const s0 = await this.snap();
    const home = s0.portals?.[0];
    await this.turn(home ? home.bearing + 180 : 180);
    const until = Date.now() + timeoutMs;
    let lastPos = s0.player!.pos;
    while (Date.now() < until) {
      await this.hold(["ShiftLeft", "KeyW"], 700);
      const s = await this.snap();
      if (s.zone?.local === "danger" && s.zone.padDist > s.zone.safeRadius + 4 && !s.player?.swimming) return s;
      const p = s.player!.pos;
      if (Math.hypot(p[0]! - lastPos[0]!, p[1]! - lastPos[1]!, p[2]! - lastPos[2]!) < 1.5 || s.player?.swimming) await this.turn(50);
      lastPos = p;
    }
    throw new Error("couldn't walk out of the safe ring");
  }

  /** Travel through a Portus plaza portal on foot. */
  async walkThroughPortal(to: string, timeoutMs = 60_000) {
    const ok = await this.walkTo(
      (s) => s.portals?.find((p) => p.to === to) ?? null,
      (s) => s.body === to || s.stage !== "playing",
      { timeoutMs },
    );
    expect(ok, `walked into the ${to} portal`).toBe(true);
    return this.waitInWorld(90_000, to);
  }

  // ------------------------------------------------------------------------------------------ fighting

  /** One left click (an attack with the held weapon). Returns the page time just before it. */
  async attack(holdMs = 60): Promise<number> {
    const t = await this.now();
    await this.page.mouse.down();
    await this.page.waitForTimeout(holdMs);
    await this.page.mouse.up();
    return t;
  }

  /** What happened to an attack made at page time `since` (waits up to `ms` for the server). */
  async attackResult(since: number, ms = 2000): Promise<AttackResult> {
    await this.page.waitForTimeout(ms);
    const ev = await this.events(since);
    return {
      accepted: ev.some((e) => e.kind === "in" && ATTACK_ECHOES.has(e.type ?? "") && e.mine === true),
      denied: ev.filter((e) => e.kind === "in" && e.type === "denied").map((e) => `${e.action}:${e.reason}`),
      notice: ev.some((e) => e.kind === "toast" && SAFE_NOTICE.test(String(e.text ?? ""))),
      sent: ev.filter((e) => e.kind === "out").map((e) => e.type ?? ""),
      toasts: ev.filter((e) => e.kind === "toast").map((e) => String(e.text ?? "")),
    };
  }

  /** Wait until spawn protection is off and the server agrees we're outside (attacks count). */
  async readyToFight(timeoutMs = 15_000) {
    return this.until((s) => !s.player?.protected && s.zone?.server === "danger" && !s.player?.dead, "outside a safe zone, spawn protection over", timeoutMs);
  }

  // ------------------------------------------------------------------------------------------ evidence

  /**
   * Screenshot into $E2E_OUT/shots (and the report). Evidence, not an assertion: on a loaded machine a
   * GPU page can take long to hand over a frame, so a timeout is noted and the journey goes on.
   */
  async shot(name: string): Promise<string | null> {
    const dir = path.join(OUT, "shots");
    mkdirSync(dir, { recursive: true });
    const id = this.info.titlePath.slice(1).join(" ").match(/J\d+\.\d+|smoke/)?.[0] ?? "test";
    const file = path.join(dir, `${id}-${this.info.project.name}-${String(++this.shots).padStart(2, "0")}-${name.replace(/[^a-z0-9-]+/gi, "-")}.png`);
    try {
      await this.page.screenshot({ path: file, timeout: 30_000 });
    } catch (e) {
      await this.note("screenshot-skipped", `${name}: ${String(e).split("\n")[0]}`);
      return null;
    }
    await this.info.attach(name, { path: file, contentType: "image/png" });
    return file;
  }

  async note(type: string, description: unknown) {
    this.info.annotations.push({ type, description: typeof description === "string" ? description : JSON.stringify(description) });
  }
}

export function newName(): string {
  return `E2E_${Math.random().toString(36).slice(2, 10)}`.slice(0, 16);
}
