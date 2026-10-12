// One body's world: streamed terrain chunks, water, sky, sun and hemisphere light.
// The sun follows the player so every place keeps the body's best time of day (R4 Q10 extra #4).

import * as THREE from "three/webgpu";
import { color, mix, normalWorld, positionWorldDirection, uniform, vec3, vertexColor, dot, max, pow, float } from "three/tsl";
import { BODIES, CHUNK_QUADS, createTerrain, gridDir, type BodyDef, type BodyId, type Face, type Terrain } from "@firstlight/shared";
import type { ChunkRequest, ChunkResult } from "./terrain.worker.ts";
import { flags } from "../config.ts";

export interface BodyLook {
  sky: number;
  horizon: number;
  sun: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  water: number;
  fog: number;
  /** Sun elevation (radians above the local horizon) and azimuth. */
  sunElev: number;
  sunAz: number;
}

export const LOOKS: Record<BodyId, BodyLook> = {
  portus: { sky: 0x6a8cff, horizon: 0xffd2b0, sun: 0xfff1d6, sunIntensity: 3.2, hemiSky: 0x9fb8ff, hemiGround: 0x5a4a3a, hemiIntensity: 1.1, water: 0x2e8fa0, fog: 0xf0c8b0, sunElev: 0.75, sunAz: 0.6 },
  arcadia: { sky: 0x3f8cff, horizon: 0xbff4ff, sun: 0xffe2a8, sunIntensity: 3.4, hemiSky: 0x9fe8ff, hemiGround: 0x3f5a2a, hemiIntensity: 1.0, water: 0x1fb5b0, fog: 0xc8f0f0, sunElev: 0.55, sunAz: 0.9 },
  hollowmere: { sky: 0x2a1d5a, horizon: 0xc77dc8, sun: 0xffb0d8, sunIntensity: 1.8, hemiSky: 0x8a6ad0, hemiGround: 0x2a2030, hemiIntensity: 0.9, water: 0x2c3f5a, fog: 0x8a6aa8, sunElev: 0.12, sunAz: 2.2 },
  meridian: { sky: 0x2f6fd0, horizon: 0xffc7a0, sun: 0xffffff, sunIntensity: 4.0, hemiSky: 0xa8c8ff, hemiGround: 0x6a2a18, hemiIntensity: 0.9, water: 0x3fa8b0, fog: 0xf0b890, sunElev: 0.95, sunAz: 1.4 },
};

interface ChunkInfo {
  face: Face;
  cx: number;
  cy: number;
  dir: [number, number, number];
}

interface LoadedChunk {
  key: string;
  mesh: THREE.Mesh | null;
  pending: boolean;
}

export class Planet {
  readonly body: BodyDef;
  readonly terrain: Terrain;
  readonly group = new THREE.Group();
  readonly look: BodyLook;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly chunkInfos: ChunkInfo[] = [];
  private readonly loaded = new Map<string, LoadedChunk>();
  private readonly workers: Worker[] = [];
  private nextWorker = 0;
  private reqId = 0;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly upUniform = uniform(new THREE.Vector3(0, 1, 0));
  private lastStream = 0;
  water: THREE.Mesh | null = null;
  loadRadius: number;

  constructor(readonly scene: THREE.Scene, bodyId: BodyId) {
    this.body = BODIES[bodyId];
    this.terrain = createTerrain(this.body);
    this.look = LOOKS[bodyId];
    this.loadRadius = Math.min(520, this.body.radius * 1.2);
    scene.add(this.group);

    const n = this.terrain.n;
    const d: [number, number, number] = [0, 0, 0];
    for (let f = 0; f < 6; f++) {
      for (let cy = 0; cy < this.body.chunksPerFace; cy++) {
        for (let cx = 0; cx < this.body.chunksPerFace; cx++) {
          gridDir(f as Face, cx * CHUNK_QUADS + CHUNK_QUADS / 2, cy * CHUNK_QUADS + CHUNK_QUADS / 2, n, d);
          this.chunkInfos.push({ face: f as Face, cx, cy, dir: [d[0], d[1], d[2]] });
        }
      }
    }

    const workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<ChunkResult>) => this.onChunk(e.data);
      this.workers.push(w);
    }

    this.material = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
    this.material.colorNode = vertexColor();

    // Sky: gradient from horizon to zenith around the player's local up.
    const look = this.look;
    if (!flags.has("nosky")) {
      const t = max(dot(positionWorldDirection, this.upUniform), float(0));
      scene.backgroundNode = mix(color(look.horizon), color(look.sky), pow(t, float(0.55)));
    } else {
      scene.background = new THREE.Color(look.sky);
    }
    if (!flags.has("nofog")) {
      scene.fog = new THREE.Fog(look.fog, Math.min(220, this.body.radius * 0.5), this.loadRadius * 0.95);
    }

    this.sun = new THREE.DirectionalLight(look.sun, look.sunIntensity);
    this.sun.castShadow = !flags.has("noshadows");
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 300;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(look.hemiSky, look.hemiGround, look.hemiIntensity);
    scene.add(this.hemi);

    if (!flags.has("nowater") && this.body.waterLevel > -50) {
      const wm = new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.86 });
      const fres = pow(float(1).sub(max(dot(normalWorld, positionWorldDirection.negate()), float(0))), float(3));
      wm.colorNode = mix(color(look.water), color(look.horizon), fres.mul(0.6));
      const geo = new THREE.SphereGeometry(this.body.radius + this.body.waterLevel, 256, 128);
      this.water = new THREE.Mesh(geo, wm);
      this.water.renderOrder = 1;
      this.group.add(this.water);
    }
    void vec3;
  }

  /** Stream chunks around a position; returns how many chunks near the player are still loading. */
  update(px: number, py: number, pz: number, camera: THREE.Camera, now: number): number {
    const l = Math.hypot(px, py, pz);
    const ux = px / l, uy = py / l, uz = pz / l;
    this.upUniform.value.set(ux, uy, uz);

    // Sun in the player's local frame.
    const up = new THREE.Vector3(ux, uy, uz);
    const ref = Math.abs(uz) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const east = ref.clone().sub(up.clone().multiplyScalar(ref.dot(up))).normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    const { sunElev, sunAz } = this.look;
    const sunDir = up.clone().multiplyScalar(Math.sin(sunElev))
      .add(east.multiplyScalar(Math.cos(sunElev) * Math.cos(sunAz)))
      .add(north.multiplyScalar(Math.cos(sunElev) * Math.sin(sunAz)));
    const focus = new THREE.Vector3(px, py, pz);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(sunDir, 150);
    this.hemi.position.copy(up);
    void camera;

    if (now - this.lastStream < 200) return this.pendingNear(ux, uy, uz);
    this.lastStream = now;
    const R = this.body.radius;
    const cosLimit = Math.cos(Math.min(Math.PI, this.loadRadius / R));
    const cosUnload = Math.cos(Math.min(Math.PI, (this.loadRadius + 80) / R));
    const wanted: { info: ChunkInfo; dot: number }[] = [];
    for (const info of this.chunkInfos) {
      const dt = info.dir[0] * ux + info.dir[1] * uy + info.dir[2] * uz;
      const key = `${info.face}:${info.cx}:${info.cy}`;
      if (dt >= cosLimit) {
        if (!this.loaded.has(key)) wanted.push({ info, dot: dt });
      } else if (dt < cosUnload) {
        const c = this.loaded.get(key);
        if (c && !c.pending) {
          if (c.mesh) {
            this.group.remove(c.mesh);
            c.mesh.geometry.dispose();
          }
          this.loaded.delete(key);
        }
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

  private pendingNear(ux: number, uy: number, uz: number): number {
    const cos = Math.cos(Math.min(Math.PI, 160 / this.body.radius));
    let n = 0;
    for (const info of this.chunkInfos) {
      if (info.dir[0] * ux + info.dir[1] * uy + info.dir[2] * uz < cos) continue;
      const c = this.loaded.get(`${info.face}:${info.cx}:${info.cy}`);
      if (!c || c.pending) n++;
    }
    return n;
  }

  private request(info: ChunkInfo) {
    const key = `${info.face}:${info.cx}:${info.cy}`;
    this.loaded.set(key, { key, mesh: null, pending: true });
    const req: ChunkRequest = { id: ++this.reqId, body: this.body.id, face: info.face, cx: info.cx, cy: info.cy };
    this.workers[this.nextWorker++ % this.workers.length]!.postMessage(req);
  }

  private onChunk(r: ChunkResult) {
    if (r.body !== this.body.id) return;
    const key = `${r.face}:${r.cx}:${r.cy}`;
    const entry = this.loaded.get(key);
    if (!entry) return; // unloaded while in flight
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(r.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(r.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
    const c = r.center;
    const mid = this.body.radius + (r.minHeight + r.maxHeight) / 2;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(c[0] * mid, c[1] * mid, c[2] * mid), r.boundRadius + 1);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    (mesh as unknown as { static: boolean }).static = true;
    this.group.add(mesh);
    entry.mesh = mesh;
    entry.pending = false;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const c of this.loaded.values()) c.mesh?.geometry.dispose();
    this.scene.remove(this.group, this.sun, this.sun.target, this.hemi);
    this.material.dispose();
    this.water?.geometry.dispose();
  }
}
