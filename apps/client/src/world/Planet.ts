// One body's world: streamed terrain chunks (worker), water patches, grass, props, sky, fog, sky
// planets, sun and fill light. The sun follows the player so every place keeps the body's best
// time of day (R4 Q10 extra #4). Every system re-applies itself when the graphics settings change.

import * as THREE from "three/webgpu";
import { BODIES, CHUNK_QUADS, createTerrain, gridDir, type BodyDef, type BodyId, type Face, type Terrain } from "@firstlight/shared";
import type { BakeResult, ChunkRequest, ChunkResult } from "./terrain.worker.ts";
import { applyLook, atmo, radialFogNode, skyBackgroundNode, sunRigFor, type SunRig } from "../render/atmosphere.ts";
import { applyGrassLook, GrassSystem, type GrassChunk } from "../render/grass.ts";
import { LOOKS, type BodyLook } from "../render/looks.ts";
import { postUniforms, setGrade } from "../render/post.ts";
import { PropSystem } from "../render/props.ts";
import type { RenderCtx, ResolvedSettings } from "../render/renderer.ts";
import { applySkyLut } from "../render/skyLut.ts";
import { skyPlanetsFor, type SkyPlanets } from "../render/skyPlanets.ts";
import { localFrame, type V3 } from "../render/sunFrame.ts";
import { applyTerrainSettings, terrainMaterialFor, terrainUniforms } from "../render/terrainMaterial.ts";
import { applyWaterLook, createWaterMesh, waterMaterialFor } from "../render/water.ts";

export { LOOKS, type BodyLook };

interface ChunkInfo {
  key: string;
  face: Face;
  cx: number;
  cy: number;
  dir: [number, number, number];
}

interface LoadedChunk {
  key: string;
  face: Face;
  cx: number;
  cy: number;
  mesh: THREE.Mesh | null;
  /** The bake attribute includes sun visibility (Low tier). */
  sunBaked: boolean;
  rebaking: boolean;
  water: THREE.Mesh | null;
  pending: boolean;
  grass: GrassChunk | null;
  /** Unit centre direction, angular radius (rad) and max radius from the planet centre. */
  dir: THREE.Vector3;
  angle: number;
  topR: number;
}

// Scene-level nodes are built once and shared by every body (all inputs are shared uniforms),
// so arriving on a new planet never invalidates material caches.
let skyNode: THREE.Node | null = null;
let fogNode: THREE.Node | null = null;

export class Planet {
  readonly body: BodyDef;
  readonly terrain: Terrain;
  readonly group = new THREE.Group();
  readonly look: BodyLook;
  readonly rig: SunRig;
  readonly skyPlanets: SkyPlanets;
  readonly grass: GrassSystem;
  readonly props: PropSystem;
  readonly waterGroup = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly chunkInfos: ChunkInfo[] = [];
  private readonly loaded = new Map<string, LoadedChunk>();
  private readonly workers: Worker[] = [];
  private nextWorker = 0;
  private reqId = 0;
  private material: THREE.MeshStandardNodeMaterial;
  private waterMaterial: THREE.MeshBasicNodeMaterial;
  private readonly waterDummy: THREE.Mesh;
  private settings: ResolvedSettings;
  private lastStream = 0;
  private readonly unsubscribe: () => void;
  private readonly focus = new THREE.Vector3();
  private readonly east: V3 = [1, 0, 0];
  private readonly wind = new THREE.Vector3();
  private readonly north: V3 = [0, 0, 1];
  loadRadius: number;
  /** Chunks drawn after horizon culling (stats). */
  visibleChunks = 0;

  constructor(private readonly ctx: RenderCtx, bodyId: BodyId) {
    this.scene = ctx.scene;
    this.body = BODIES[bodyId];
    this.terrain = createTerrain(this.body);
    this.look = LOOKS[bodyId];
    this.loadRadius = Math.min(520, this.body.radius * 1.2);
    this.settings = ctx.settings;
    this.group.name = `planet:${bodyId}`;
    this.waterGroup.name = "water";
    this.scene.add(this.group);
    this.group.add(this.waterGroup);

    const n = this.terrain.n;
    const d: [number, number, number] = [0, 0, 0];
    for (let f = 0; f < 6; f++) {
      for (let cy = 0; cy < this.body.chunksPerFace; cy++) {
        for (let cx = 0; cx < this.body.chunksPerFace; cx++) {
          gridDir(f as Face, cx * CHUNK_QUADS + CHUNK_QUADS / 2, cy * CHUNK_QUADS + CHUNK_QUADS / 2, n, d);
          this.chunkInfos.push({ key: `${f}:${cx}:${cy}`, face: f as Face, cx, cy, dir: [d[0], d[1], d[2]] });
        }
      }
    }

    const workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<ChunkResult | BakeResult>) => {
        if (e.data.kind === "bake") this.onBake(e.data);
        else this.onChunk(e.data);
      };
      w.onerror = (e) => console.error("[planet] terrain worker error", e.message);
      this.workers.push(w);
    }

    // Look: shared uniforms, scene nodes, post parameters.
    applyLook(this.look, this.body.radius, this.body.waterLevel, this.settings);
    applySkyLut(bodyId, this.look);
    applyWaterLook(this.look);
    applyGrassLook(this.look);
    skyNode ??= skyBackgroundNode();
    fogNode ??= radialFogNode();
    ctx.renderer.toneMappingExposure = this.look.exposure;
    postUniforms.bloomThreshold.value = this.look.bloomThreshold;
    postUniforms.bloomStrength.value = this.look.bloomStrength;
    setGrade(this.look.grade);

    // Lights and sky planets live as long as the renderer (light ids are in three's lighting
    // cache key; new ones per planet would rebuild every lit material on each travel).
    this.rig = sunRigFor(this.scene, this.look, ctx.renderer);
    this.skyPlanets = skyPlanetsFor(this.scene, this.look.skyPlanets);
    this.grass = new GrassSystem(this.body.radius, n);
    this.group.add(this.grass.group);
    this.props = new PropSystem(bodyId);
    this.group.add(this.props.group);
    this.material = terrainMaterialFor(this.settings);
    this.waterMaterial = waterMaterialFor(this.settings.water);
    // A hidden one-triangle water patch at the planet centre: the warm-up protocol shows hidden
    // objects, so the water shader compiles even when no lake is in range yet.
    this.waterDummy = createWaterMesh(
      { positions: new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]), depth: new Float32Array([1, 1, 1]), indices: new Uint16Array([0, 1, 2]) },
      this.waterMaterial,
    );
    this.waterDummy.name = "waterWarmupDummy";
    this.waterDummy.visible = false;
    this.waterDummy.frustumCulled = false;
    this.waterGroup.add(this.waterDummy);

    this.applySettings(this.settings);
    this.unsubscribe = ctx.onChange((s) => this.applySettings(s));
  }

  /** Back-compat accessors. */
  get sun(): THREE.DirectionalLight {
    return this.rig.sun;
  }
  get hemi(): THREE.HemisphereLight {
    return this.rig.hemi;
  }

  applySettings(s: ResolvedSettings) {
    this.settings = s;
    if (s.on.sky) {
      this.scene.background = null;
      this.scene.backgroundNode = skyNode;
    } else {
      this.scene.backgroundNode = null;
      this.scene.background = new THREE.Color(this.look.horizon);
    }
    this.scene.fogNode = s.on.fog ? fogNode : null;
    atmo.fogHeight.value = s.fog.height ? 1 : 0;
    atmo.scatterMix.value = s.sky.scatterSteps[0] > 0 ? this.look.scatter.mix : 0;
    applyTerrainSettings(s);
    if (terrainUniforms.bakedSun.value > 0) this.rebakeSun();
    const mat = terrainMaterialFor(s);
    if (mat !== this.material) {
      this.material = mat;
      for (const c of this.loaded.values()) if (c.mesh) c.mesh.material = mat;
    }
    const wm = waterMaterialFor(s.water);
    if (wm !== this.waterMaterial) {
      this.waterMaterial = wm;
      for (const c of this.loaded.values()) if (c.water) c.water.material = wm;
      this.waterDummy.material = wm;
    }
    this.waterGroup.visible = s.on.water;
    this.rig.applySettings(s);
    this.skyPlanets.applySettings(s);
    this.grass.applySettings(s);
    this.props.applySettings(s);
  }

  /**
   * Per frame: sun, sky planets, streaming, culling, grass and props. `px,py,pz` is the focus
   * (player); vegetation follows the camera. Returns how many chunks near the focus are loading.
   */
  update(px: number, py: number, pz: number, camera: THREE.Camera, now: number, dt = 1 / 60): number {
    const l = Math.hypot(px, py, pz);
    const ux = px / l, uy = py / l, uz = pz / l;
    this.focus.set(px, py, pz);
    this.rig.update(this.focus, dt);
    this.skyPlanets.update(camera);
    localFrame(ux, uy, uz, this.east, this.north);
    this.grass.setWind(this.wind.set(this.east[0] * 0.8 + this.north[0] * 0.6, this.east[1] * 0.8 + this.north[1] * 0.6, this.east[2] * 0.8 + this.north[2] * 0.6).normalize());
    this.cullHorizon(camera.position);
    this.grass.update(camera.position, this.grassChunks(), now);
    this.props.update(camera.position, now);

    if (now - this.lastStream < 200) return this.pendingNear(ux, uy, uz);
    this.lastStream = now;
    const R = this.body.radius;
    const cosLimit = Math.cos(Math.min(Math.PI, this.loadRadius / R));
    const cosUnload = Math.cos(Math.min(Math.PI, (this.loadRadius + 80) / R));
    const wanted: { info: ChunkInfo; dot: number }[] = [];
    for (const info of this.chunkInfos) {
      const dtp = info.dir[0] * ux + info.dir[1] * uy + info.dir[2] * uz;
      const key = info.key;
      if (dtp >= cosLimit) {
        if (!this.loaded.has(key)) wanted.push({ info, dot: dtp });
      } else if (dtp < cosUnload) {
        const c = this.loaded.get(key);
        if (c && !c.pending) this.unload(c);
      }
    }
    wanted.sort((a, b) => b.dot - a.dot);
    let inflight = 0;
    for (const c of this.loaded.values()) if (c.pending) inflight++;
    for (const w of wanted) {
      if (inflight >= this.workers.length * 3) break;
      this.request(w.info);
      inflight++;
    }
    return this.pendingNear(ux, uy, uz);
  }

  private *grassChunks(): Iterable<GrassChunk> {
    for (const c of this.loaded.values()) if (c.grass && c.mesh?.visible !== false) yield c.grass;
  }

  /** Hide chunks entirely below the horizon (the planet itself occludes them). */
  private cullHorizon(cam: THREE.Vector3) {
    const R = this.body.radius;
    const rMin = R - 25;
    const rc = Math.max(cam.length(), rMin + 0.01);
    const thetaC = Math.acos(Math.min(1, rMin / rc));
    const cdx = cam.x / rc, cdy = cam.y / rc, cdz = cam.z / rc;
    let vis = 0;
    for (const c of this.loaded.values()) {
      if (!c.mesh) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, c.dir.x * cdx + c.dir.y * cdy + c.dir.z * cdz)));
      const thetaT = Math.acos(Math.min(1, rMin / c.topR));
      const visible = ang - c.angle <= thetaC + thetaT;
      c.mesh.visible = visible;
      if (c.water) c.water.visible = visible;
      if (visible) vis++;
    }
    this.visibleChunks = vis;
  }

  private unload(c: LoadedChunk) {
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    if (c.water) {
      this.waterGroup.remove(c.water);
      c.water.geometry.dispose();
    }
    this.grass.dropChunk(c.key);
    this.props.removeChunk(c.key);
    this.loaded.delete(c.key);
  }

  private pendingNear(ux: number, uy: number, uz: number): number {
    const cos = Math.cos(Math.min(Math.PI, 160 / this.body.radius));
    let n = 0;
    for (const info of this.chunkInfos) {
      if (info.dir[0] * ux + info.dir[1] * uy + info.dir[2] * uz < cos) continue;
      const c = this.loaded.get(info.key);
      if (!c || c.pending) n++;
    }
    return n;
  }

  private request(info: ChunkInfo) {
    const key = info.key;
    this.loaded.set(key, {
      key, face: info.face, cx: info.cx, cy: info.cy, mesh: null, water: null, pending: true, grass: null,
      sunBaked: false, rebaking: false, dir: new THREE.Vector3(...info.dir), angle: 0, topR: this.body.radius,
    });
    const req: ChunkRequest = {
      kind: "full", id: ++this.reqId, body: this.body.id, face: info.face, cx: info.cx, cy: info.cy,
      bakeSun: this.settings.terrain.bakedSun,
    };
    this.workers[this.nextWorker++ % this.workers.length]!.postMessage(req);
  }

  /**
   * The Low tier darkens terrain by baked sun visibility. Chunks built on another tier don't
   * have it: ask the workers for just the bake attribute (cheap; heights are cached there).
   */
  private rebakeSun() {
    for (const c of this.loaded.values()) this.requestBake(c);
  }

  private requestBake(c: LoadedChunk) {
    if (c.pending || c.sunBaked || c.rebaking || !c.mesh) return;
    c.rebaking = true;
    const req: ChunkRequest = { kind: "bake", id: ++this.reqId, body: this.body.id, face: c.face, cx: c.cx, cy: c.cy, bakeSun: true };
    this.workers[this.nextWorker++ % this.workers.length]!.postMessage(req);
  }

  private onBake(r: BakeResult) {
    if (r.body !== this.body.id) return;
    const c = this.loaded.get(`${r.face}:${r.cx}:${r.cy}`);
    if (!c) return;
    c.rebaking = false;
    const attr = c.mesh?.geometry.getAttribute("bake") as THREE.BufferAttribute | undefined;
    if (!attr || attr.array.length !== r.bake.length) return;
    (attr.array as Float32Array).set(r.bake);
    attr.needsUpdate = true;
    c.sunBaked = r.bakedSun;
  }

  private onChunk(r: ChunkResult) {
    if (r.body !== this.body.id) return;
    const key = `${r.face}:${r.cx}:${r.cy}`;
    const entry = this.loaded.get(key);
    if (!entry || !entry.pending) return; // unloaded while in flight
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(r.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(r.colors, 3));
    geo.setAttribute("bake", new THREE.BufferAttribute(r.bake, 2));
    geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
    const c = r.center;
    const R = this.body.radius;
    const mid = R + (r.minHeight + r.maxHeight) / 2;
    const center = new THREE.Vector3(c[0] * mid, c[1] * mid, c[2] * mid);
    geo.boundingSphere = new THREE.Sphere(center.clone(), r.boundRadius + 1);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `chunk:${key}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    (mesh as unknown as { static: boolean }).static = true;
    this.group.add(mesh);
    entry.mesh = mesh;
    entry.pending = false;
    entry.sunBaked = r.bakedSun;
    // Requested before a switch to Low: fetch the sun bake now.
    if (!r.bakedSun && terrainUniforms.bakedSun.value > 0) this.requestBake(entry);
    entry.dir.set(c[0], c[1], c[2]);
    entry.angle = (r.boundRadius + 2) / R;
    entry.topR = R + r.maxHeight + 2;

    if (r.water) {
      const wm = createWaterMesh(r.water, this.waterMaterial);
      wm.name = `water:${key}`;
      this.waterGroup.add(wm);
      entry.water = wm;
    }
    entry.grass = { key, face: r.face, cx: r.cx, cy: r.cy, positions: r.positions, grass: r.grass, center, radius: r.boundRadius };
    this.props.addChunk(key, r.props, center, r.boundRadius);
  }

  /** Counts for the perf overlay and bench. */
  stats() {
    let chunks = 0, water = 0;
    for (const c of this.loaded.values()) {
      if (c.mesh) chunks++;
      if (c.water) water++;
    }
    return { chunks, visibleChunks: this.visibleChunks, water, grassBlades: this.grass.blades, props: this.props.instances };
  }

  /** Local east/north at the focus (for camera paths and wind). */
  frame(): { east: THREE.Vector3; north: THREE.Vector3 } {
    return { east: new THREE.Vector3(...this.east), north: new THREE.Vector3(...this.north) };
  }

  dispose() {
    this.unsubscribe();
    for (const w of this.workers) w.terminate();
    for (const c of [...this.loaded.values()]) this.unload(c);
    this.grass.dispose();
    this.props.dispose();
    // The sun rig and sky planets are shared across bodies (re-skinned by the next Planet).
    this.waterDummy.geometry.dispose();
    this.scene.remove(this.group);
  }
}
