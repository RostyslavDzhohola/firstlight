// Test-only hook for the Playwright journeys (apps/client/e2e, SPEC §9.3, D-e2e-1). main.ts installs it
// through debug/e2eGate.ts only when the URL has `?e2e`; otherwise this chunk is never fetched and
// `window.__fl` doesn't exist. It reads game state for the journeys; it changes nothing in the game.
//
// window.__fl
//   snapshot()            plain JSON: stage, body, player (position, heading, animation), zone (server flag,
//                         HUD label, local ring test), nearby NPCs (kind, hostile, distance, on screen, aim),
//                         weapon and hotbar, the last server `denied`, pointer lock, onboarding step, open
//                         menus/panels/overlays, portals, training dummies, visible [data-e2e] elements
//   events(since?)        recent observations, oldest first: server combat messages ("in"), attack
//                         messages we sent ("out"), key and mouse presses, player animation and avatar clip
//                         changes, toasts, body/lock/loading/graphics changes
//   frames.stats(since?)  requestAnimationFrame deltas (always recorded: a 4096-entry ring, cheap)
//   probe.start(opts)     blink probe, only while a journey runs it: canvas luma from a 32×18 copy every
//                         `every` frames (createImageBitmap at the end of the frame's task, after all of the
//                         frame's work, so no readback of the full frame and no stall; every frame whose
//                         task changed the drawing-buffer size is read too) plus `hidden` flips in the DOM.
//                         probe.stop() → { luma, flashes, flaps, resizes, blanks }
//   hudRects()            visible HUD boxes (player card, hotbar, tutorial, minimap, save card…) for overlap checks
//   auth()                async: guest / saved / dev guest, from the auth session (never signs in)
//   act                   helpers for what Playwright can't drive through real input:
//     browserEscape()     what desktop Chrome does on Esc while the pointer is locked (releases the lock;
//                         the page gets no key event). Headless Chrome delivers the key and keeps the lock.
//     admin(cmd, args)    an admin console command (dev admin guests on local stacks; the server refuses others)
//     ladderStep(dir)     one resolution-ladder step (+1 down, −1 up), taken in the next frame's afterFrame
//                         like a natural step (D-view-3 blank-frame gate)
//
// Game internals are read through narrow structural types with optional chaining, so a refactor
// elsewhere shows up as a null field, not a crashed hook.

import { bearingTo, headingOf, surfaceDistance, type V3 } from "../social/compassMath.ts";
import { detectFlaps, detectFlashes, frameStats, isBlankWorld, lumaWorkerSource, meanAlpha, meanLuma, Ring, screenAim, type Flash } from "./e2eProbe.ts";

// ---------------------------------------------------------------------------------------------- structural views

interface Vec {
  x: number;
  y: number;
  z: number;
}
interface MapLike<T> {
  get(k: string): T | undefined;
  forEach(cb: (v: T, k: string) => void): void;
  readonly size: number;
}
interface PlayerSchema {
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  flags: number;
  level: number;
  name: string;
  starter: number;
  weapon: number;
}
interface NpcSchema {
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  kind: number;
  level: number;
  flags: number;
  target: string;
}
interface RoomLike {
  roomId: string;
  sessionId: string;
  state: { players?: MapLike<PlayerSchema>; npcs?: MapLike<NpcSchema> };
  onMessage(type: string, cb: (m: any) => void): unknown;
  send(type: string, msg?: unknown, ...rest: unknown[]): unknown;
}
interface Item {
  id: string;
  tier: number;
  qty: number;
}
interface GameLike {
  bodyId?: string;
  running?: boolean;
  travelling?: boolean;
  stopped?: boolean;
  ctx?: {
    webgpu?: boolean;
    tier?: string;
    pixelRatio?(): number;
    render?: () => void;
    ladder?: { index: number; scale: number; forceStep?(dir: 1 | -1): void };
    camera?: { matrixWorldInverse: { elements: ArrayLike<number> }; projectionMatrix: { elements: ArrayLike<number> }; position: Vec };
    renderer?: { domElement?: HTMLCanvasElement };
  };
  player?: {
    pos: Vec;
    camForward: Vec;
    camPitch: number;
    anim: number;
    onGround: boolean;
    swimming: boolean;
    frozen: boolean;
    mounted: boolean;
    getStructures?(): RayCollider | null;
    getColliders?(): RayCollider | null;
    getNature?(): RayCollider | null;
  };
  planet?: { terrain?: unknown; body?: { radius: number } };
  input?: { locked: boolean; enabled: boolean; sensitivity: number; invertY: boolean };
  net?: { room: RoomLike | null; rtt?: number };
  hud?: { you: { xp: number; xpToNext: number; coins: number; level: number; selected: number; hotbar: (Item | null)[]; dead: boolean; onboarding?: { hits: number[] } } | null };
  combat?: { training: unknown; deadUntilRespawn: boolean };
  menu?: { mode?: string };
  photo?: { active: boolean };
  self?: { currentName?: string };
  systems?: unknown[];
}
/** A collider the player's movement uses (structures: town, outposts, waystones; props: trees, rocks…). */
interface RayCollider {
  raycast?(o: Vec, d: Vec, maxT: number): number;
}
interface OnboardingLike {
  active: boolean;
  paid: boolean;
  ended: boolean;
  progress: { steps: { current: { id: string } | null; doneCount: number; allDone: boolean } };
  dummies: { dummies: { pos: Vec; down: boolean }[] };
}

// Shared catalogues, loaded once the game is up (the game chunk has them by then: no early fetch on the landing page).
interface SharedMods {
  BODIES: Record<string, { radius: number }>;
  padDirs(body: unknown): readonly (readonly [number, number, number])[];
  isSafe(body: unknown, x: number, y: number, z: number): boolean;
  PAD_SAFE_RADIUS: number;
  zoneAt(body: unknown, x: number, y: number, z: number): { safe: boolean; kind: string; pad: number };
  nearestSafeEntry(body: unknown, x: number, y: number, z: number): { dir: readonly [number, number, number]; edge: number };
  TOWN_GATES: readonly (readonly [number, number, number])[];
  safeGates(body: unknown): readonly (readonly [number, number, number])[];
  portalSpots(body: unknown, terrain: any): { to: string; center: [number, number, number] }[];
  NPC_DEFS: readonly { id: string; name: string; temper: string; tier: string; height: number }[];
  NF: { DEAD: number };
  PF: Record<string, number>;
  WEAPONS: readonly { id: string; name: string; delivery: string; range: number }[];
  WEAPON_BY_ID: ReadonlyMap<string, { id: string; name: string; delivery: string; range: number }>;
}

export type FlEvent = { t: number; kind: string; [k: string]: unknown };

const IN_TYPES = ["immune", "npcKill", "denied", "shot", "projectile", "swing", "hit", "toast", "death", "reborn", "explode", "loggedOut", "train", "onboarding", "correct"] as const;
const OUT_TYPES = new Set(["fire", "melee", "train", "equip", "charge", "block", "scope", "use", "respawn", "logout", "travel", "onboarding", "admin", "interact", "pickup"]);
const HUD_PARTS: [string, string][] = [
  ["playerCard", ".fl-me"],
  ["hotbar", ".fl-hotbar-wrap"],
  ["tutorial", ".fl-onb"],
  ["compass", ".fl-compass"],
  ["missions", ".fl-missions"],
  ["party", ".fl-party"],
  ["toasts", ".fl-toasts"],
  ["boss", ".fl-boss"],
  ["voiceSlot", ".fl-hud__br"],
  ["saveCard", ".fl-savecard"],
  ["prompt", ".fl-prompt"],
];

const r1 = (v: number) => Math.round(v * 10) / 10;
const v3 = (v: Vec): V3 => [v.x, v.y, v.z];

function visible(e: Element | null): boolean {
  if (!(e instanceof HTMLElement) || !e.isConnected || e.closest("[hidden]")) return false;
  const r = e.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(e);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01;
}

function rectOf(e: Element) {
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

// ---------------------------------------------------------------------------------------------- install

export function installE2eHook(win: Window & typeof globalThis): void {
  if ((win as unknown as { __fl?: unknown }).__fl) return;
  const game = () => (win as unknown as { __game?: GameLike }).__game ?? null;
  let shared: SharedMods | null = null;
  let sharedLoading = false;
  const loadShared = () => {
    if (shared || sharedLoading) return;
    sharedLoading = true;
    void Promise.all([import("@firstlight/shared"), import("@firstlight/shared/content/npcs"), import("@firstlight/shared/net/schema"), import("@firstlight/shared/content/weapons")])
      .then(([s, n, sc, w]) => {
        shared = { BODIES: s.BODIES, padDirs: s.padDirs, isSafe: s.isSafe, PAD_SAFE_RADIUS: s.PAD_SAFE_RADIUS, zoneAt: s.zoneAt, nearestSafeEntry: s.nearestSafeEntry, TOWN_GATES: s.TOWN_GATES, safeGates: s.safeGates, portalSpots: s.portalSpots, NPC_DEFS: n.NPC_DEFS, NF: n.NF, PF: sc.PF, WEAPONS: w.WEAPONS, WEAPON_BY_ID: w.WEAPON_BY_ID } as unknown as SharedMods;
      })
      .catch((e: unknown) => console.warn("[e2e] shared modules", e))
      .finally(() => (sharedLoading = false));
  };

  // ---- event log
  const log: FlEvent[] = [];
  const push = (e: FlEvent) => {
    log.push(e);
    if (log.length > 600) log.splice(0, log.length - 600);
  };
  let lastDenied: { action: string; reason: string; t: number } | null = null;
  let authState: unknown = null;

  win.addEventListener("keydown", (e) => push({ t: e.timeStamp, kind: "key", code: e.code, repeat: e.repeat }), { capture: true, passive: true });
  win.addEventListener("keyup", (e) => push({ t: e.timeStamp, kind: "keyup", code: e.code }), { capture: true, passive: true });
  win.addEventListener("mousedown", (e) => push({ t: e.timeStamp, kind: "mouse", button: e.button }), { capture: true, passive: true });
  win.addEventListener("mouseup", (e) => push({ t: e.timeStamp, kind: "mouseup", button: e.button }), { capture: true, passive: true });
  document.addEventListener("pointerlockchange", () => push({ t: performance.now(), kind: "lock", locked: !!document.pointerLockElement }));

  // Toasts (server and client ones) as they appear: the toast stack is watched, not the whole page.
  let toastBox: Element | null = null;
  const seenToasts = new WeakSet<Node>(); // the HUD appends a toast, then moves it to the top: one toast, two records
  const toastObserver = new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes)
        if (n instanceof HTMLElement && n.classList.contains("fl-toast") && !seenToasts.has(n)) {
          seenToasts.add(n);
          push({ t: performance.now(), kind: "toast", text: n.textContent ?? "", cls: n.className });
        }
  });

  // ---- room messages (re-attached after every travel)
  let hookedRoom: RoomLike | null = null;
  let npcReq = 0;
  const npcWaiters = new Map<string, (v: unknown) => void>();
  const hookRoom = (room: RoomLike) => {
    hookedRoom = room;
    const me = room.sessionId;
    push({ t: performance.now(), kind: "room", roomId: room.roomId, sessionId: me });
    // Replies to act.npc("list") (NpcRenderer ignores them).
    room.onMessage("npcList", (m: { req?: string }) => {
      const w = m?.req ? npcWaiters.get(m.req) : undefined;
      if (w) {
        npcWaiters.delete(m.req!);
        w(m);
      }
    });
    for (const type of IN_TYPES) {
      room.onMessage(type, (m: Record<string, unknown> | undefined) => {
        const t = performance.now();
        const e: FlEvent = { t, kind: "in", type };
        if (m && typeof m === "object") {
          if ("by" in m) e.mine = m.by === me;
          if ("attacker" in m) {
            e.mine = m.attacker === me;
            e.onMe = m.target === me;
            e.amount = m.amount;
            // Who took it: a player (PvP) or a creature.
            e.targetPlayer = !!room.state.players?.get(String(m.target));
            e.target = m.target;
            e.targetKind = m.kind;
          }
          if (type === "denied") {
            e.action = m.action;
            e.reason = m.reason;
            lastDenied = { action: String(m.action), reason: String(m.reason), t };
          }
          if (type === "toast") {
            e.text = m.text;
            e.toastKind = m.kind;
          }
          if (type === "death") {
            e.mine = m.victim === me;
            e.killer = m.killerName;
          }
          if ("weapon" in m) e.weapon = m.weapon;
          if (type === "swing") e.hits = m.hits;
        }
        push(e);
      });
    }
    const send = room.send.bind(room);
    room.send = (type: string, msg?: unknown, ...rest: unknown[]) => {
      if (OUT_TYPES.has(type)) {
        const m = (msg ?? {}) as Record<string, unknown>;
        push({ t: performance.now(), kind: "out", type, ...(type === "admin" ? { cmd: m.cmd } : {}), ...("slot" in m ? { slot: m.slot } : {}), ...("on" in m ? { on: m.on } : {}), ...("heavy" in m ? { heavy: m.heavy } : {}) });
      }
      return send(type, msg, ...rest);
    };
  };

  // ---- per-frame watch: frame times, room, animation, body, loading, graphics changes
  const frames = new Ring(4096);
  let last = performance.now();
  const seen = { anim: -1, clip: "", body: "", loading: "", gfx: "" };
  const watch = (now: number) => {
    frames.push(now, now - last);
    last = now;
    const g = game();
    if (g) {
      loadShared();
      const room = g.net?.room ?? null;
      if (room && room !== hookedRoom) hookRoom(room);
      const p = g.player;
      if (p && p.anim !== seen.anim) {
        push({ t: now, kind: "anim", from: seen.anim, to: p.anim });
        seen.anim = p.anim;
      }
      const clip = g.self?.currentName ?? "";
      if (clip !== seen.clip) {
        push({ t: now, kind: "clip", name: clip });
        seen.clip = clip;
      }
      if ((g.bodyId ?? "") !== seen.body) {
        seen.body = g.bodyId ?? "";
        push({ t: now, kind: "body", body: seen.body });
      }
      const gfx = `${g.ctx?.webgpu ? "webgpu" : "webgl"}/${g.ctx?.tier ?? "?"}/${r1(g.ctx?.pixelRatio?.() ?? 0)}`;
      if (gfx !== seen.gfx) {
        seen.gfx = gfx;
        push({ t: now, kind: "gfx", gfx });
      }
      if (!toastBox || !toastBox.isConnected) {
        toastBox = document.querySelector(".fl-toasts");
        if (toastBox) toastObserver.observe(toastBox, { childList: true });
      }
    }
    const ld = document.getElementById("loading");
    const loading = ld && !ld.hidden ? (ld.textContent ?? "").trim().slice(0, 80) || "…" : "";
    if (loading !== seen.loading) {
      seen.loading = loading;
      push({ t: now, kind: "loading", text: loading });
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);

  // ---- blink probe (only while a journey runs it)
  const luma = new Ring(4096);
  /** Degrees the camera rotated since the previous luma sample, keyed like `luma` (by sample time). */
  const turns = new Ring(4096);
  const flips: { t: number; key: string }[] = [];
  /** Samples that showed a blank world (isBlankWorld), with the drawing-buffer size they were read at. */
  const blanks: { t: number; size: string; luma: number; alpha: number }[] = [];
  let probe: { stop(): void; startedAt: number; every: number; skipped: number; errors: number; resizes: number } | null = null;
  const elementKeys = new WeakMap<Element, string>();
  let nextKey = 0;
  const keyOf = (e: Element) => {
    let k = elementKeys.get(e);
    if (!k) {
      k = `${e.tagName.toLowerCase()}.${String(e.className).split(" ").filter(Boolean).slice(0, 2).join(".")}#${nextKey++}`;
      elementKeys.set(e, k);
    }
    return k;
  };

  const startProbe = (opts: { every?: number; width?: number; height?: number } = {}) => {
    if (probe) return { ok: true, already: true };
    const g = game();
    const ctx = g?.ctx;
    const canvas = ctx?.renderer?.domElement;
    if (!ctx?.render || !canvas) return { ok: false, reason: "no game canvas yet" };
    const every = Math.max(1, Math.floor(opts.every ?? 2));
    const w = opts.width ?? 32;
    const h = opts.height ?? 18;
    // The pixel readback runs in a worker (lumaWorkerSource): on the main thread it waited for the
    // GPU inside the game's frames. Main-thread fallback where workers can't draw bitmaps.
    let worker: Worker | null = null;
    let workerUrl = "";
    if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
      workerUrl = URL.createObjectURL(new Blob([lumaWorkerSource()], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
    }
    const small = document.createElement("canvas");
    small.width = w;
    small.height = h;
    const c2d = small.getContext("2d", { willReadFrequently: true })!;
    luma.clear();
    turns.clear();
    blanks.length = 0;
    /** Drawing-buffer size of each sample in flight, by sample time. */
    const sizeAt = new Map<number, string>();
    const record = (t: number, v: number, a: number) => {
      luma.push(t, v);
      if (isBlankWorld(v, a) && blanks.length < 200) blanks.push({ t: Math.round(t), size: sizeAt.get(t) ?? "?", luma: Math.round(v * 10) / 10, alpha: Math.round(a) });
      sizeAt.delete(t);
    };
    const camera = ctx.camera as { quaternion?: { x: number; y: number; z: number; w: number } } | undefined;
    let lastQ: [number, number, number, number] | null = null;
    flips.length = 0;
    const own = Object.prototype.hasOwnProperty.call(ctx, "render");
    const original = ctx.render;
    let n = 0;
    let pending = false;
    /** Drawing-buffer size at the end of the last frame's task ("" before the first). */
    let lastSize = "";
    const state = { startedAt: performance.now(), every, skipped: 0, errors: 0, resizes: 0, stop: () => {} };
    const take = (t: number) => {
      // The end of the frame's task (D-view-3): the drawing buffer holds what this task leaves for
      // the compositor, after all of the frame's work (the ladder's afterFrame step included).
      sizeAt.set(t, lastSize);
      const shot = createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: "low" });
      if (worker) {
        shot.then((bmp) => worker!.postMessage({ bmp, t, w, h }, [bmp])).catch(() => {
          state.errors++;
          pending = false;
        });
        return;
      }
      shot
        .then((bmp) => {
          c2d.clearRect(0, 0, w, h);
          c2d.drawImage(bmp, 0, 0);
          bmp.close();
          const px = c2d.getImageData(0, 0, w, h).data;
          record(t, meanLuma(px), meanAlpha(px));
        })
        .catch(() => state.errors++)
        .finally(() => (pending = false));
    };
    ctx.render = function (this: unknown, ...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(ctx, args);
      const periodic = ++n % every === 0;
      const t = performance.now();
      // The rendered frame's camera: how far it turned since the last sample (a look-step changes
      // the picture without anything blinking).
      const q = camera?.quaternion;
      const turn = (): void => {
        if (!q) return;
        const d = lastQ ? Math.min(1, Math.abs(q.x * lastQ[0] + q.y * lastQ[1] + q.z * lastQ[2] + q.w * lastQ[3])) : 1;
        turns.push(t, (2 * Math.acos(d) * 180) / Math.PI);
        lastQ = [q.x, q.y, q.z, q.w];
      };
      queueMicrotask(() => {
        if (probe !== state) return;
        // A frame whose task changed the drawing-buffer size is always read: that is where a resize
        // after the draw would leave a blank world.
        const size = `${canvas.width}x${canvas.height}`;
        const resized = lastSize !== "" && size !== lastSize;
        lastSize = size;
        if (resized) state.resizes++;
        if (!resized && (!periodic || pending)) {
          if (periodic) state.skipped++;
          return;
        }
        pending = true;
        turn();
        take(t);
      });
      return result;
    };
    // Only real show/hide changes count: code that re-sets `hidden = true` every frame queues a record
    // each time without changing anything on screen.
    const shown = new WeakMap<Element, boolean>();
    const mo = new MutationObserver((records) => {
      const t = performance.now();
      for (const r of records) {
        if (!(r.target instanceof Element)) continue;
        const was = shown.has(r.target) ? shown.get(r.target)! : r.oldValue === null;
        const now = !r.target.hasAttribute("hidden");
        shown.set(r.target, now);
        if (now !== was) flips.push({ t, key: keyOf(r.target) });
      }
      if (flips.length > 5000) flips.splice(0, flips.length - 5000);
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["hidden"] });
    if (worker) {
      worker.onmessage = (e: MessageEvent<{ t: number; v?: number; a?: number; error?: string }>) => {
        pending = false;
        if (typeof e.data.v === "number") record(e.data.t, e.data.v, e.data.a ?? 255);
        else state.errors++;
      };
      worker.onerror = () => {
        pending = false;
        state.errors++;
      };
    }
    state.stop = () => {
      worker?.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      mo.disconnect();
      if (own) ctx.render = original;
      else delete (ctx as { render?: unknown }).render;
    };
    probe = state;
    return { ok: true };
  };

  const stopProbe = (opts: { threshold?: number } = {}) => {
    const p = probe;
    if (!p) return null;
    p.stop();
    probe = null;
    const turnAt = new Map(turns.since(p.startedAt).map((x) => [x.t, x.v] as const));
    const series = luma.since(p.startedAt).map((s) => ({ t: s.t, v: Math.round(s.v * 10) / 10, turn: Math.round((turnAt.get(s.t) ?? 0) * 10) / 10 }));
    const flashes: Flash[] = detectFlashes(series, opts.threshold ?? 40);
    // Candidates skipped because the camera turned into and out of them (reported, not hidden).
    const viewChanges = detectFlashes(series.map((x) => ({ t: x.t, v: x.v })), opts.threshold ?? 40).length - flashes.length;
    return {
      every: p.every,
      samples: series.length,
      skipped: p.skipped,
      errors: p.errors,
      /** Frames whose task changed the drawing-buffer size (each one is sampled). */
      resizes: p.resizes,
      /** Sampled frames that showed a blank world: a resize cleared the drawing buffer after the draw. */
      blanks: [...blanks],
      lumaMin: series.length ? Math.min(...series.map((s) => s.v)) : null,
      lumaMax: series.length ? Math.max(...series.map((s) => s.v)) : null,
      flashes,
      viewChanges,
      flaps: detectFlaps(flips),
      series,
    };
  };

  // ---- snapshot

  /** Distance, bearing (degrees, right = +) and camera aim to a world point, from the player now. */
  const targetFrom = (g: GameLike | null, radius?: number) => {
    const p = g?.player;
    if (!p) return null;
    const pos = v3(p.pos);
    const fwd = v3(p.camForward);
    const R = radius ?? (shared?.BODIES[g!.bodyId ?? ""]?.radius ?? Math.hypot(...pos));
    const cam = g!.ctx?.camera;
    return (x: number, y: number, z: number) => {
      const a = cam ? screenAim(cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, x, y, z) : null;
      return {
        dist: r1(Math.hypot(x - pos[0], y - pos[1], z - pos[2])),
        surface: r1(surfaceDistance(pos, [x, y, z], R)),
        bearing: r1(bearingTo(pos, fwd, [x, y, z])),
        onScreen: a?.onScreen ?? false,
        aimYaw: a ? Math.round(a.yaw * 1000) / 1000 : null,
        aimPitch: a ? Math.round(a.pitch * 1000) / 1000 : null,
      };
    };
  };

  const onboarding = (g: GameLike): OnboardingLike | null =>
    ((g.systems ?? []).find((s) => !!s && typeof s === "object" && "progress" in s && "dummies" in s) as OnboardingLike | undefined) ?? null;

  /** The tracked hunt mission's world callout (game/MissionPointer.ts), planets only. */
  const missionPointer = (g: GameLike): { callout: HTMLElement; title: HTMLElement; target: { at: [number, number, number]; title: string; creep: boolean } | null } | null =>
    ((g.systems ?? []).find((s) => !!s && typeof s === "object" && "callout" in s && "pickedAt" in s && "mission" in s) as never) ?? null;

  const npcRenderer = (g: GameLike): { views: Map<string, { dist: number; gone: boolean }> } | null =>
    ((g.systems ?? []).find((s) => !!s && typeof s === "object" && (s as { views?: unknown }).views instanceof Map && "telegraphs" in s) as { views: Map<string, { dist: number; gone: boolean }> } | undefined) ?? null;

  const snapshot = () => {
    const g = game();
    const now = performance.now();
    const canvas = g?.ctx?.renderer?.domElement ?? null;
    const ld = document.getElementById("loading");
    const loading = !!ld && !ld.hidden;
    const visibleE2e = [...document.querySelectorAll<HTMLElement>("[data-e2e]")].filter(visible).map((e) => e.dataset.e2e!);
    const overlays = [...document.querySelectorAll<HTMLElement>(".fl-overlay")].filter((e) => !e.hidden && e.isConnected && visible(e)).map((e) => e.className);
    const base = {
      t: now,
      hook: 1,
      stage: !g ? (loading ? "loading" : "landing") : loading ? "loading" : g.stopped ? "stopped" : g.running ? "playing" : "starting",
      loading: loading ? (ld!.textContent ?? "").trim().slice(0, 120) : null,
      input: {
        pointerLocked: !!document.pointerLockElement && document.pointerLockElement === canvas,
        anyPointerLock: !!document.pointerLockElement,
        gameLocked: g?.input?.locked ?? null,
        enabled: g?.input?.enabled ?? null,
        sensitivity: g?.input?.sensitivity ?? null,
        invertY: g?.input?.invertY ?? null,
      },
      ui: {
        visibleE2e,
        overlays,
        pauseMenuMode: g?.menu?.mode ?? null,
        photo: g?.photo?.active ?? null,
        loggedOutCard: !!document.querySelector(".fl-menu--notice:not([hidden])"),
      },
      lastDenied,
      auth: authState,
    };
    if (!g || !g.player || !shared) return { ...base, body: g?.bodyId ?? null, gfx: g?.ctx ? { webgpu: !!g.ctx.webgpu, tier: g.ctx.tier ?? null } : null };
    const S = shared;
    const p = g.player;
    const pos = v3(p.pos);
    const fwd = v3(p.camForward);
    const body = g.bodyId ?? "";
    const bodyDef = S.BODIES[body];
    const R = bodyDef?.radius ?? Math.hypot(...pos);
    const room = g.net?.room ?? null;
    const me = room?.state.players?.get(room.sessionId);
    const flags = me?.flags ?? 0;
    const PF = S.PF;
    const pads = bodyDef ? S.padDirs(bodyDef) : [];
    let padIndex = -1;
    let padDist = Infinity;
    pads.forEach((d, i) => {
      const m = surfaceDistance(pos, [d[0], d[1], d[2]], R);
      if (m < padDist) {
        padDist = m;
        padIndex = i;
      }
    });
    const label = document.querySelector<HTMLElement>('[data-e2e="zone-label"]');
    const target = targetFrom(g, R)!;

    const rendered = npcRenderer(g);
    const npcs: Record<string, unknown>[] = [];
    room?.state.npcs?.forEach((n, id) => {
      const def = S.NPC_DEFS[n.kind];
      const l = Math.hypot(n.x, n.y, n.z) || 1;
      const lift = (def?.height ?? 1) * 0.6;
      const view = rendered?.views.get(id);
      npcs.push({
        id,
        kind: def?.id ?? String(n.kind),
        name: def?.name ?? null,
        temper: def?.temper ?? null,
        hostile: def?.temper === "hostile",
        tier: def?.tier ?? null,
        height: def?.height ?? null,
        level: n.level,
        hp: n.hp,
        maxHp: n.maxHp,
        dead: (n.flags & S.NF.DEAD) !== 0 || n.hp <= 0,
        drawn: !!view && !view.gone && view.dist <= 150,
        ...target(n.x + (n.x / l) * lift, n.y + (n.y / l) * lift, n.z + (n.z / l) * lift),
      });
    });
    npcs.sort((a, b) => (a.dist as number) - (b.dist as number));

    const terrain = (g as { planet?: { terrain?: unknown } }).planet?.terrain;
    let portals: Record<string, unknown>[] = [];
    try {
      if (bodyDef && terrain) portals = S.portalSpots(bodyDef, terrain).map((s) => ({ to: s.to, ...target(...s.center) }));
    } catch {
      portals = [];
    }
    /** A unit direction (pushed `out` metres away from the +Y pole along the ground) as a world point on the terrain. */
    const onGround = (d: readonly [number, number, number], out: number, from: readonly [number, number, number] = [0, 1, 0]): [number, number, number] => {
      let u: [number, number, number] = [d[0], d[1], d[2]];
      if (out) {
        // Away from `from` (Portus: the pole; a planet: pad 0), in the tangent plane.
        const k = u[0] * from[0] + u[1] * from[1] + u[2] * from[2];
        const t: [number, number, number] = [k * u[0] - from[0], k * u[1] - from[1], k * u[2] - from[2]];
        const tl = Math.hypot(...t) || 1;
        u = [u[0] + (t[0] / tl) * (out / R), u[1] + (t[1] / tl) * (out / R), u[2] + (t[2] / tl) * (out / R)];
        const ul = Math.hypot(...u);
        u = [u[0] / ul, u[1] / ul, u[2] / ul];
      }
      const h = (terrain as { groundHeight(x: number, y: number, z: number): number }).groundHeight(u[0], u[1], u[2]);
      return [u[0] * (R + h), u[1] * (R + h), u[2] * (R + h)];
    };
    const ob = onboarding(g);
    const you = g.hud?.you ?? null;
    const item = you ? you.hotbar[you.selected] : null;
    const def = item ? S.WEAPON_BY_ID.get(item.id) : S.WEAPONS[me?.weapon ?? 0];

    return {
      ...base,
      body,
      gfx: {
        webgpu: !!g.ctx?.webgpu,
        tier: g.ctx?.tier ?? null,
        pixelRatio: g.ctx?.pixelRatio?.() ?? null,
        ladder: g.ctx?.ladder?.index ?? null,
        canvas: g.ctx?.renderer?.domElement ? [g.ctx.renderer.domElement.width, g.ctx.renderer.domElement.height] : null,
      },
      net: room ? { roomId: room.roomId, sessionId: room.sessionId, rtt: g.net?.rtt ?? null } : null,
      player: {
        pos: pos.map(r1),
        heading: r1(headingOf(pos, fwd)),
        pitch: Math.round(p.camPitch * 1000) / 1000,
        anim: p.anim,
        clip: g.self?.currentName ?? null,
        onGround: p.onGround,
        swimming: p.swimming,
        frozen: p.frozen,
        mounted: p.mounted,
        name: me?.name ?? null,
        starter: me?.starter ?? null,
        hp: me?.hp ?? null,
        maxHp: me?.maxHp ?? null,
        level: me?.level ?? null,
        flags,
        protected: (flags & PF.PROTECTED!) !== 0,
        inCombat: (flags & PF.IN_COMBAT!) !== 0,
        dead: (flags & PF.DEAD!) !== 0 || !!g.combat?.deadUntilRespawn,
        admin: (flags & PF.ADMIN!) !== 0,
      },
      zone: {
        server: me ? ((flags & PF.SAFE!) !== 0 ? "safe" : "danger") : null,
        label: label && visible(label) ? (label.dataset.zone ?? label.getAttribute("data-zone")) : null,
        labelText: label ? (label.textContent ?? "").trim() : null,
        chip: visible(document.querySelector(".fl-me__safe")),
        local: bodyDef ? (S.isSafe(bodyDef, pos[0], pos[1], pos[2]) ? "safe" : "danger") : null,
        kind: bodyDef ? S.zoneAt(bodyDef, pos[0], pos[1], pos[2]).kind : null,
        padIndex,
        padDist: r1(padDist),
        safeRadius: S.PAD_SAFE_RADIUS,
        /** Metres to the nearest way into safety (a pad ring's edge, or a Portus town gate). */
        toSafe: bodyDef ? r1(surfaceDistance(pos, [...S.nearestSafeEntry(bodyDef, pos[0], pos[1], pos[2]).dir] as V3, R) - S.nearestSafeEntry(bodyDef, pos[0], pos[1], pos[2]).edge) : null,
      },
      // The nearest pad's centre (Portus: the plaza, the town's open middle).
      pad: bodyDef && padIndex >= 0 && terrain ? target(...onGround(pads[padIndex]!, 0)) : null,
      // The walled zone's gates (the safe border runs through them: Portus' two town gates, a planet's
      // outpost gates, D-b2-1) and a point 25 m outside each (away from the town's pole / pad 0).
      gates:
        body === "portus" && terrain
          ? S.TOWN_GATES.map((d) => ({ ...target(...onGround(d, 0)), out: target(...onGround(d, 25)) }))
          : bodyDef && terrain && pads[0]
            ? S.safeGates(bodyDef).map((d) => ({ ...target(...onGround(d, 0)), out: target(...onGround(d, 25, pads[0]!)) }))
            : [],
      // The planet's mission guide by the main pad (QuestClient's interactables).
      guide: (() => {
        const q = (g.systems ?? []).find((x) => !!x && typeof x === "object" && Array.isArray((x as { interactables?: unknown }).interactables)) as
          | { interactables: { def: { look?: string; name?: string }; pos: [number, number, number] }[] }
          | undefined;
        const o = q?.interactables.find((i) => i.def.look === "guide");
        return o ? { name: o.def.name ?? null, ...target(...o.pos) } : null;
      })(),
      mission: (() => {
        const mp = missionPointer(g);
        if (!mp) return null;
        const t = mp.target;
        return { shown: !mp.callout.hidden, title: mp.title.textContent ?? "", creep: t?.creep ?? false, at: t?.at ?? null, ...(t ? target(...t.at) : {}) };
      })(),
      you: you ? { xp: you.xp, xpToNext: you.xpToNext, coins: you.coins, level: you.level, dead: you.dead } : null,
      weapon: def ? { id: def.id, name: def.name, delivery: def.delivery, range: def.range, tier: item?.tier ?? 1, slot: you?.selected ?? 0 } : null,
      hotbar: you ? you.hotbar.map((h) => (h ? { id: h.id, tier: h.tier, qty: h.qty } : null)) : null,
      combat: { training: !!g.combat?.training, deadUntilRespawn: !!g.combat?.deadUntilRespawn },
      onboarding: ob
        ? { active: ob.active, paid: ob.paid, ended: ob.ended, step: ob.progress.steps.current?.id ?? null, done: ob.progress.steps.doneCount, allDone: ob.progress.steps.allDone }
        : null,
      // Aimed at the chest (1.1 m up the 1.9 m dummy), like the NPCs.
      dummies: ob
        ? ob.dummies.dummies.map((d, i) => {
            const k = 1 + 1.1 / (Math.hypot(d.pos.x, d.pos.y, d.pos.z) || 1);
            return { ...target(d.pos.x * k, d.pos.y * k, d.pos.z * k), down: d.down, hits: you?.onboarding?.hits?.[i] ?? null };
          })
        : [],
      portals,
      npcs: npcs.slice(0, 40),
      npcCount: room?.state.npcs?.size ?? 0,
      // Other players in this copy (journeys run side by side in one copy: don't shoot through them).
      players: (() => {
        const out: Record<string, unknown>[] = [];
        room?.state.players?.forEach((o, id) => {
          if (id !== room.sessionId) out.push({ id, name: o.name, dead: (o.flags & PF.DEAD!) !== 0, ...target(o.x, o.y, o.z) });
        });
        return out;
      })(),
    };
  };

  const hudRects = () => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [name, sel] of HUD_PARTS) {
      const e = document.querySelector(sel);
      if (e && visible(e)) out[name] = rectOf(e);
    }
    for (const e of document.querySelectorAll<HTMLElement>("[data-e2e]")) if (visible(e)) out[`e2e:${e.dataset.e2e}`] = rectOf(e);
    return out;
  };

  const auth = async () => {
    if (new URLSearchParams(location.search).has("devguest")) {
      const id = localStorage.getItem("firstlight.devGuest") ?? "";
      authState = { kind: "dev-guest", admin: id.split(":")[2] === "admin" };
      return authState;
    }
    try {
      const { authClient } = await import("../net/auth.ts");
      const s = await authClient().getSession();
      const user = s.data?.user as { name?: string; email?: string; isAnonymous?: boolean } | undefined;
      authState = !user ? { kind: "none" } : { kind: user.isAnonymous ? "guest" : "saved", name: user.name ?? null, hasEmail: !!user.email && !user.isAnonymous };
    } catch (e) {
      authState = { kind: "error", message: String(e) };
    }
    return authState;
  };

  const api = {
    version: 1,
    snapshot,
    events: (since = -Infinity) => log.filter((e) => e.t >= since),
    clearEvents: () => void (log.length = 0),
    frames: {
      stats: (since = -Infinity) => frameStats(frames.since(since)),
      raw: (since = -Infinity) => frames.since(since).map((f) => Math.round(f.v * 10) / 10),
    },
    probe: { start: startProbe, stop: stopProbe, running: () => !!probe },
    /** Distance, bearing and camera aim from the player to a world point (null before the game). */
    targetOf: (x: number, y: number, z: number) => targetFrom(game())?.(x, y, z) ?? null,
    /**
     * How far the player could walk straight along each bearing (degrees from the camera's heading,
     * right = +) before a structure or prop the movement collides with, up to `max` metres: the same
     * colliders movement uses (structures, breakables, tree trunks and rocks: D-solid-1), cast at knee and
     * chest height. Journeys steer round buildings and trees with it.
     */
    clearance: (bearings: number[], max = 12) => {
      const p = game()?.player;
      if (!p) return null;
      const cols = [p.getStructures?.(), p.getColliders?.()].filter((c): c is RayCollider => !!c?.raycast);
      // Tree trunks are thin: they're cast for along the body's edges too (a ray down the middle misses
      // a trunk the body still walks into). Walls are cast down the middle only, as before.
      const nature = p.getNature?.();
      const l = Math.hypot(p.pos.x, p.pos.y, p.pos.z) || 1;
      const up = { x: p.pos.x / l, y: p.pos.y / l, z: p.pos.z / l };
      const k = p.camForward.x * up.x + p.camForward.y * up.y + p.camForward.z * up.z;
      const f0 = { x: p.camForward.x - k * up.x, y: p.camForward.y - k * up.y, z: p.camForward.z - k * up.z };
      const fl = Math.hypot(f0.x, f0.y, f0.z) || 1;
      const f = { x: f0.x / fl, y: f0.y / fl, z: f0.z / fl };
      const r = { x: f.y * up.z - f.z * up.y, y: f.z * up.x - f.x * up.z, z: f.x * up.y - f.y * up.x }; // f × up: right
      return bearings.map((deg) => {
        const a = (deg * Math.PI) / 180;
        const d = { x: f.x * Math.cos(a) + r.x * Math.sin(a), y: f.y * Math.cos(a) + r.y * Math.sin(a), z: f.z * Math.cos(a) + r.z * Math.sin(a) };
        let clear = max;
        // The ray's sideways unit (d × up) for the body's half-width either side of its centre line.
        const sx = d.y * up.z - d.z * up.y, sy = d.z * up.x - d.x * up.z, sz = d.x * up.y - d.y * up.x;
        for (const h of [0.5, 1.2]) {
          const o = { x: p.pos.x + up.x * h, y: p.pos.y + up.y * h, z: p.pos.z + up.z * h };
          for (const c of cols) clear = Math.min(clear, c.raycast!(o, d, max));
          if (nature?.raycast) {
            for (const w of [0, -0.4, 0.4]) clear = Math.min(clear, nature.raycast({ x: o.x + sx * w, y: o.y + sy * w, z: o.z + sz * w }, d, max));
          }
        }
        return { bearing: deg, clear: r1(clear) };
      });
    },
    hudRects,
    auth,
    act: {
      browserEscape: () => {
        if (document.pointerLockElement) document.exitPointerLock();
        return !!document.pointerLockElement;
      },
      admin: (cmd: string, args: Record<string, unknown> = {}) => {
        const room = game()?.net?.room;
        if (!room) return false;
        room.send("admin", { cmd, args });
        return true;
      },
      ladderStep: (dir: 1 | -1 = 1) => {
        const ladder = game()?.ctx?.ladder;
        if (!ladder?.forceStep) return false;
        ladder.forceStep(dir);
        return true;
      },
      /**
       * An NPC admin command (`list`, `spawn`…; server world/npc/NpcSystem.ts). `list` resolves with
       * the server's whole NPC list (not view-filtered); others resolve true once sent.
       */
      npc: (cmd: string, args: Record<string, unknown> = {}) => {
        const room = game()?.net?.room;
        if (!room) return Promise.resolve(null);
        const req = `e2e-${++npcReq}`;
        if (cmd !== "list") {
          room.send("npc", { ...args, cmd, req });
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          npcWaiters.set(req, resolve);
          room.send("npc", { ...args, cmd, req });
          setTimeout(() => {
            if (npcWaiters.delete(req)) resolve(null);
          }, 5000);
        });
      },
    },
  };
  Object.defineProperty(win, "__fl", { value: Object.freeze(api), configurable: false, enumerable: false, writable: false });
}
