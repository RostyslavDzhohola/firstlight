// Breakable props on the client (SPEC §6.9): intact meshes (one InstancedMesh per archetype,
// filled only with props near the camera), the server's broken set, shatter debris and the
// light-particle rebuild. Placement, intact meshes and pre-fractured pieces come from the fracture
// worker (cached per body and quality for the session); this file never touches three-piñata.
//
// Sync: `broke` (sent to clients near the prop) shatters it; BodyState.broken (synced to everyone,
// late joiners included) hides props that broke elsewhere; `rebuilt` (or the id leaving the map)
// brings it back with a re-materialise burst.
//
// Intact props are solid: the view is the local player's MoveColliders (shared planet/collide).

import * as THREE from "three/webgpu";
import { attribute, uniform } from "three/tsl";
import { BREAKABLE_ARCHETYPES, type BodyId, type Breakable } from "@firstlight/shared";
import { BreakableCollider, resetContact, type PropContact } from "@firstlight/shared/planet/collide";
import type { Game } from "../game/Game.ts";
import type { MoveColliders } from "../game/PlayerController.ts";
import type { ClientSystem } from "../game/systems.ts";
import { Debris, type DebrisPiece } from "../render/debris.ts";
import type { ResolvedSettings } from "../render/quality.ts";
import type { BreakableAssets, MeshArrays } from "./breakableShapes.ts";
import type { FractureRequest, FractureResponse } from "./fracture.worker.ts";

// ------------------------------------------------------------------------------------ material

/** Fracture-face glow per body (the planet accent), kept well under the bloom threshold. */
const ACCENT: Record<BodyId, number> = { portus: 0xffd8a8, arcadia: 0x36f9f6, hollowmere: 0x5effc8, meridian: 0x49e0e8 };
const accent = uniform(new THREE.Color(ACCENT.arcadia));
let material: THREE.MeshStandardNodeMaterial | null = null;

/** One shared material for intact props and debris; `inner` = 1 on fresh fracture faces. */
export function breakableMaterial(): THREE.MeshStandardNodeMaterial {
  if (!material) {
    material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.84, metalness: 0 });
    material.name = "breakables";
    material.emissiveNode = accent.mul(attribute("inner", "float").mul(0.07));
  }
  return material;
}

// ------------------------------------------------------------------------------------ worker + cache

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, (r: FractureResponse) => void>();
const assetCache = new Map<string, Promise<BreakableAssets | null>>();

function requestAssets(body: BodyId, quality: 0 | 1, fracture: boolean): Promise<BreakableAssets | null> {
  const key = `${body}:${quality}:${fracture ? 1 : 0}`;
  let p = assetCache.get(key);
  if (p) return p;
  if (!worker) {
    worker = new Worker(new URL("./fracture.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<FractureResponse>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    worker.onerror = (e) => console.error("[breakables] fracture worker error", e.message);
  }
  const w = worker;
  p = new Promise<BreakableAssets | null>((resolve) => {
    const id = ++reqId;
    pending.set(id, (r) => {
      if (r.error) console.warn("[breakables] fracture failed", r.error);
      else if (r.assets) console.info(`[breakables] ${body}: ${r.assets.breakables.length} props, q${quality}, ${r.assets.ms.toFixed(0)} ms in the worker${r.assets.failures ? `, ${r.assets.failures} fracture fallbacks` : ""}`);
      resolve(r.assets);
    });
    const req: FractureRequest = { id, body, quality, fracture };
    w.postMessage(req);
  });
  assetCache.set(key, p);
  p.then((a) => a ?? assetCache.delete(key));
  return p;
}

function geometryFrom(m: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute("color", new THREE.BufferAttribute(m.colors, 3));
  g.setAttribute("inner", new THREE.BufferAttribute(m.inner, 1));
  g.computeBoundingSphere();
  return g;
}

let placeholderGeo: THREE.BufferGeometry | null = null;
/**
 * Same attribute layout as the real meshes. The archetype meshes are created with it before the
 * warm-up (so their shaders compile behind the loading screen) and get the real geometry later:
 * swapping geometry keeps the render object, while a new InstancedMesh would need a new node build.
 */
function placeholder(): THREE.BufferGeometry {
  if (!placeholderGeo) {
    const g = new THREE.TetrahedronGeometry(0.01); // polyhedra are already non-indexed
    g.deleteAttribute("uv");
    const n = g.getAttribute("position").count;
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    g.setAttribute("inner", new THREE.BufferAttribute(new Float32Array(n), 1));
    placeholderGeo = g;
  }
  return placeholderGeo;
}

// ------------------------------------------------------------------------------------ the view

interface BrokeMsg {
  id: string;
  archetype: number;
  variant: number;
  ix: number;
  iy: number;
  iz: number;
  f?: number;
}

/** Re-materialise: light corpuscles first, then the prop grows back in (s). */
const REBUILD_S = 1.0;
const REBUILD_DELAY_S = 0.3;
const STREAM_MAX = 260;
/** Instances per archetype mesh (the most of one archetype on a planet is under 100). */
const CAPACITY = 256;
const FX_RANGE = 140;
const BUDGET: Record<ResolvedSettings["tier"], number> = { low: 60, medium: 120, high: 150, ultra: 150 };
/** Rotation/scale elements of a column-major 4×4 matrix. */
const LINEAR = [0, 1, 2, 4, 5, 6, 8, 9, 10] as const;

export class BreakablesView implements ClientSystem, MoveColliders {
  readonly group = new THREE.Group();
  private readonly game: Game;
  private readonly body: BodyId;
  private list: Breakable[] = [];
  private readonly ids = new Map<string, number>();
  /** Per archetype index: InstancedMesh + its breakable indices. */
  private meshes: { mesh: THREE.InstancedMesh; members: Int32Array }[] = [];
  private base = new Float32Array(0);
  private hidden = new Uint8Array(0);
  private inMap = new Uint8Array(0);
  private hiddenAt = new Float64Array(0);
  private present = new Uint8Array(0);
  private appear = new Float32Array(0);
  private appearing = 0;
  private readonly debris: Debris;
  private settings: ResolvedSettings;
  /** Debris piece set installed / last requested (0 full, 1 Low), null = none. */
  private debrisQuality: 0 | 1 | null = null;
  private requested: 0 | 1 | null = null;
  private ready = false;
  private disposed = false;
  private dirty = true;
  private lastFill = new THREE.Vector3(1e9, 0, 0);
  private lastPoll = 0;
  private breakSeq = 0;
  private readonly early: BrokeMsg[] = [];
  /**
   * Worker results wait here and are installed from update(): the frame loop never runs during a
   * warm-up, whose compileAsync yields mid-traversal (swapping meshes then would break it).
   */
  private readonly inbox: BreakableAssets[] = [];
  private readonly unsub: (() => void)[] = [];
  private readonly scratch = new THREE.Vector3();
  /** Movement collision against the intact props (null until the worker's list arrives). */
  private collider: BreakableCollider | null = null;
  private readonly solid = (i: number) => this.hidden[i] === 0;

  constructor(game: Game) {
    this.game = game;
    this.body = game.bodyId;
    this.group.name = "breakables";
    game.ctx.scene.add(this.group);
    accent.value.setHex(ACCENT[this.body]);
    this.settings = game.ctx.settings;
    // Every archetype's mesh exists from the start (placeholder geometry until the worker answers).
    for (let a = 0; a < BREAKABLE_ARCHETYPES.length; a++) {
      const mesh = new THREE.InstancedMesh(placeholder(), breakableMaterial(), CAPACITY);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.name = `breakable:${BREAKABLE_ARCHETYPES[a]}`;
      this.group.add(mesh);
      this.meshes.push({ mesh, members: new Int32Array(0) });
    }
    this.debris = new Debris(this.group, breakableMaterial());
    this.applySettings(this.settings);
    this.unsub.push(game.ctx.onChange((s) => this.applySettings(s)));

    const room = game.net.room;
    if (room) {
      this.unsub.push(room.onMessage("broke", (m: BrokeMsg) => this.onBroke(m)));
      this.unsub.push(room.onMessage("rebuilt", (m: { id: string }) => this.onRebuilt(m.id)));
    }
    const q = this.wantedQuality();
    if (this.settings.on.destruct) this.requested = q;
    void requestAssets(this.body, q, this.settings.on.destruct).then((a) => a && this.inbox.push(a));
    (window as unknown as { __breakables?: BreakablesView }).__breakables = this;
  }

  // ------------------------------------------------------------------ setup

  private install(a: BreakableAssets) {
    if (this.disposed) return;
    if (!this.ready) {
      this.list = a.breakables;
      const n = this.list.length;
      this.base = new Float32Array(n * 16);
      this.hidden = new Uint8Array(n);
      this.inMap = new Uint8Array(n);
      this.hiddenAt = new Float64Array(n);
      this.present = new Uint8Array(n);
      this.appear = new Float32Array(n).fill(-1);
      const m = new THREE.Matrix4();
      const r = new THREE.Vector3(), u = new THREE.Vector3(), f = new THREE.Vector3();
      for (const b of this.list) {
        this.ids.set(b.id, b.index);
        m.makeBasis(r.set(b.rx, b.ry, b.rz), u.set(b.ux, b.uy, b.uz), f.set(b.fx, b.fy, b.fz));
        m.scale(this.scratch.set(b.scale, b.scale, b.scale));
        m.setPosition(b.px, b.py, b.pz);
        m.toArray(this.base, b.index * 16);
      }
      const byArch = new Map<number, number[]>();
      for (const b of this.list) {
        let l = byArch.get(b.archetype);
        if (!l) byArch.set(b.archetype, (l = []));
        l.push(b.index);
      }
      for (const [arch, members] of byArch) {
        const arrays = a.intact[arch];
        const slot = this.meshes[arch];
        if (!arrays || !slot) continue;
        slot.mesh.geometry = geometryFrom(arrays);
        slot.members = Int32Array.from(members);
      }
      this.ready = true;
      this.dirty = true;
      this.collider = new BreakableCollider(this.list);
      this.game.player?.setColliders(this);
      this.pollBroken(performance.now());
      // Shatters that arrived before the assets: just hide them (they're long gone).
      for (const m of this.early.splice(0)) this.hide(m.id, performance.now());
    }
    if (Object.keys(a.fragments).length) this.installDebris(a);
    else this.wantDebris();
  }

  private wantedQuality(): 0 | 1 {
    return this.settings.tier === "low" ? 1 : 0;
  }

  /** Fetch (or reuse) the debris pieces for the current tier: Low uses fewer pieces per prop. */
  private wantDebris() {
    if (!this.ready || !this.settings.on.destruct) return;
    const q = this.wantedQuality();
    if (this.debrisQuality === q || this.requested === q) return;
    this.requested = q;
    void requestAssets(this.body, q, true).then((a) => a && this.requested === q && this.inbox.push(a));
  }

  private installDebris(a: BreakableAssets) {
    if (this.debrisQuality === a.quality) return;
    this.debrisQuality = a.quality;
    const sets = new Map<number, DebrisPiece[]>();
    for (const [arch, variants] of Object.entries(a.fragments)) {
      variants.forEach((pieces, v) => sets.set(Number(arch) * 16 + v, pieces));
    }
    this.debris.install(sets);
    this.debris.setBudget(this.settings.on.destruct ? BUDGET[this.settings.tier] : 0);
  }

  private castShadow(): boolean {
    return this.settings.on.shadows && this.settings.shadows.mode === "map";
  }

  private applySettings(s: ResolvedSettings) {
    this.settings = s;
    for (const m of this.meshes) m.mesh.castShadow = this.castShadow();
    // ?nodestruct / the F3 toggle: no debris at all (intact props stay: they're cover).
    this.debris.setBudget(s.on.destruct ? BUDGET[s.tier] : 0);
    this.wantDebris();
    this.dirty = true;
  }

  /** MoveColliders: intact props block the local player; broken (hidden) ones don't. */
  resolve(pos: THREE.Vector3, out: PropContact): boolean {
    if (!this.collider) {
      resetContact(out);
      return false;
    }
    return this.collider.resolve(pos, this.solid, out);
  }

  // ------------------------------------------------------------------ server events

  private onBroke(m: BrokeMsg) {
    if (!this.ready) {
      this.early.push(m);
      return;
    }
    const i = this.ids.get(m.id);
    if (i === undefined || this.hidden[i]) return;
    const now = performance.now();
    this.hide(m.id, now);
    const b = this.list[i]!;
    const cam = this.game.ctx.camera.position;
    const d = Math.hypot(b.cx - cam.x, b.cy - cam.y, b.cz - cam.z);
    if (d > FX_RANGE) return;
    this.shatter(b, m.variant, m.ix, m.iy, m.iz, m.f ?? 1);
  }

  private onRebuilt(id: string) {
    const i = this.ids.get(id);
    if (i === undefined || !this.hidden[i]) return;
    this.show(i, true);
  }

  private hide(id: string, now: number) {
    const i = this.ids.get(id);
    if (i === undefined || this.hidden[i]) return;
    this.hidden[i] = 1;
    this.hiddenAt[i] = now;
    if (this.appear[i]! >= 0) {
      this.appear[i] = -1;
      this.appearing--;
    }
    this.dirty = true;
  }

  private show(i: number, fx: boolean) {
    this.hidden[i] = 0;
    this.inMap[i] = 0;
    this.dirty = true;
    const b = this.list[i]!;
    const cam = this.game.ctx.camera.position;
    if (!fx || Math.hypot(b.cx - cam.x, b.cy - cam.y, b.cz - cam.z) > FX_RANGE) return;
    // Digital matter is light (look rule 4): the prop re-materialises from glowing corpuscles.
    this.appear[i] = 0;
    this.appearing++;
    const c = this.scratch.set(b.cx, b.cy, b.cz);
    this.game.burst(c, ACCENT[this.body], Math.round(24 + 12 * b.h), { speed: [0.3, 1.2], life: [0.6, 1.3], size: [0.04, 0.1], lift: 0.7, spread: 1 });
    this.game.audio.play("portal", c, 0.35, 1.8);
  }

  /** Mirror BodyState.broken: hide what broke elsewhere (late join, far away), show what came back. */
  private pollBroken(now: number) {
    const state = this.game.net.room?.state as { broken?: { forEach(cb: (v: number, k: string) => void): void } } | undefined;
    const map = state?.broken;
    if (!map || !this.ready) return;
    const seen = this.inMap;
    const present = this.present;
    present.fill(0);
    map.forEach((_until, id) => {
      const i = this.ids.get(id);
      if (i === undefined) return;
      present[i] = 1;
      seen[i] = 1;
      if (!this.hidden[i]) this.hide(id, now);
    });
    for (let i = 0; i < this.list.length; i++) {
      if (!this.hidden[i] || present[i]) continue;
      // Hidden but no longer broken on the server: rebuilt (if we ever saw it in the map, or the
      // patch is long overdue after a `broke` message).
      if (seen[i] || now - this.hiddenAt[i]! > 4000) this.show(i, true);
    }
  }

  // ------------------------------------------------------------------ effects

  private shatter(b: Breakable, variant: number, ix: number, iy: number, iz: number, force: number) {
    const seed = (b.index * 7919 + ++this.breakSeq * 104729) >>> 0;
    if (this.settings.on.destruct) this.debris.spawn(b, b.archetype, variant, ix, iy, iz, force, seed);
    const c = this.scratch.set(b.cx, b.cy, b.cz);
    this.game.burst(c, 0xe8dcc8, 10 + Math.round(4 * b.h), { speed: [1, 3.5], life: [0.25, 0.6], size: [0.03, 0.07], intensity: 1.3, lift: -0.6 });
    this.game.audio.play(b.size === "heavy" ? "explosion" : "meleeHit", c, b.size === "heavy" ? 0.45 : 0.9, b.size === "heavy" ? 1.5 : 0.7);
  }

  /** Debug / offline: shatter the prop nearest to the camera locally (no server state). */
  breakNearest(): string | null {
    if (!this.ready) return null;
    const cam = this.game.ctx.camera.position;
    let best = -1, bd = Infinity;
    for (const b of this.list) {
      if (this.hidden[b.index]) continue;
      const d = Math.hypot(b.cx - cam.x, b.cy - cam.y, b.cz - cam.z);
      if (d < bd) {
        bd = d;
        best = b.index;
      }
    }
    if (best < 0) return null;
    const b = this.list[best]!;
    const dl = Math.hypot(b.cx - cam.x, b.cy - cam.y, b.cz - cam.z) || 1;
    this.hide(b.id, performance.now());
    this.shatter(b, this.breakSeq % 3, (b.cx - cam.x) / dl, (b.cy - cam.y) / dl, (b.cz - cam.z) / dl, 1.5);
    return b.id;
  }

  /** Debug / offline: bring every locally broken prop back. */
  rebuildAll() {
    for (let i = 0; i < this.list.length; i++) if (this.hidden[i]) this.show(i, true);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, now: number) {
    while (this.inbox.length) this.install(this.inbox.shift()!);
    if (!this.ready) return;
    if (now - this.lastPoll > 250) {
      this.lastPoll = now;
      this.pollBroken(now);
    }
    if (this.appearing > 0) {
      for (let i = 0; i < this.appear.length; i++) {
        const t = this.appear[i]!;
        if (t < 0) continue;
        const nt = t + dt;
        if (nt >= REBUILD_S) {
          this.appear[i] = -1;
          this.appearing--;
        } else this.appear[i] = nt;
      }
      this.dirty = true;
    }
    const cam = this.game.ctx.camera.position;
    if (this.dirty || cam.distanceToSquared(this.lastFill) > 64) this.fill(cam);
    this.debris.update(dt, this.game.planet.terrain, this.game.planet.body.waterLevel);
  }

  /** Stream: instance only the intact props within range of the camera. */
  private fill(cam: THREE.Vector3) {
    this.dirty = false;
    this.lastFill.copy(cam);
    const r = Math.min(STREAM_MAX, this.game.planet.loadRadius);
    const r2 = r * r;
    for (const { mesh, members } of this.meshes) {
      const arr = mesh.instanceMatrix.array as Float32Array;
      let n = 0;
      for (let k = 0; k < members.length && n < CAPACITY; k++) {
        const i = members[k]!;
        if (this.hidden[i]) continue;
        const b = this.list[i]!;
        const dx = b.cx - cam.x, dy = b.cy - cam.y, dz = b.cz - cam.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        const o = n * 16;
        arr.set(this.base.subarray(i * 16, i * 16 + 16), o);
        const t = this.appear[i]!;
        if (t >= 0) {
          // Re-materialise: corpuscles first, then grow from the base with a little overshoot.
          const x = Math.max(0, (t - REBUILD_DELAY_S) / (REBUILD_S - REBUILD_DELAY_S));
          const k2 = Math.max(0.01, 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2));
          for (const e of LINEAR) arr[o + e] = arr[o + e]! * k2;
        }
        n++;
      }
      mesh.count = n;
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Live counts for the perf overlay / tests. */
  stats() {
    let instances = 0;
    for (const m of this.meshes) instances += m.mesh.count;
    let broken = 0;
    for (let i = 0; i < this.hidden.length; i++) broken += this.hidden[i]!;
    let draws = 1;
    for (const m of this.meshes) if (m.mesh.count > 0) draws++;
    return { props: this.list.length, instances, broken, debris: this.debris.count, draws };
  }

  dispose() {
    this.disposed = true;
    if (this.game.player?.getColliders() === this) this.game.player.setColliders(null);
    this.collider = null;
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.debris.dispose();
    for (const { mesh } of this.meshes) {
      if (mesh.geometry !== placeholderGeo) mesh.geometry.dispose();
      mesh.dispose();
    }
    this.meshes = [];
    this.group.removeFromParent();
    const w = window as unknown as { __breakables?: BreakablesView };
    if (w.__breakables === this) w.__breakables = undefined;
  }
}

/** CLIENT_SYSTEMS entry. Works offline too (props are deterministic; nothing breaks without a server). */
export function createBreakables(game: Game): ClientSystem | null {
  if (game.bodyId === "portus") return null;
  return new BreakablesView(game);
}
createBreakables.offline = true;
