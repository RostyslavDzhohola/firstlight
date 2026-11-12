// The hologram scoreboard in Portus' plaza (D-gfx-hub-3): an emitter on the paving, a cone of light
// and a tall projected panel that lists the top travellers, facing the arrival pad from the
// south-east, between the Meridian court and the training yard (clear of the four streets' lines).
// Purely visual: no collider, nothing on the server. Three draws (base, cone, panel).
//
// The panel's text is drawn once to a canvas (both pages side by side) whenever the data changes; a
// frame costs two uniform writes (which page, how far into a flip). The data is the home page's
// public board (GET /api/home), asked for on arrival and every few minutes while the board is on
// (world/holoFeed.ts).

import * as THREE from "three/webgpu";
import { abs, float, floor, fract, frontFacing, max, min, mix, positionLocal, select, sin, smoothstep, texture, time, uniform, uv, vec2, vec3 } from "three/tsl";
import type { HomeData } from "@firstlight/shared/net/home";
import { townDir, townFrame, type TownPlacement } from "@firstlight/shared/planet/townFrame";
import { config, flags } from "../config.ts";
import type { Game } from "../game/Game.ts";
import type { ClientSystem, ClientSystemFactory } from "../game/systems.ts";
import { atmo } from "../render/atmosphere.ts";
import { disposeTree } from "../render/dispose.ts";
import type { ResolvedSettings } from "../render/quality.ts";
import { drawHoloPages, HOLO_PAGE } from "./holoBoardDraw.ts";
import { HOLO_PAGE_SECONDS, holoPageAt, holoPages, type HoloFlip, type HoloHunt } from "./holoBoardModel.ts";
import { HoloFeed } from "./holoFeed.ts";

/** Where the emitter stands (east, north of the plaza's centre, m) and what the panel faces. */
export const HOLO_AT: readonly [number, number] = [7.2, -12.6];
export const HOLO_FACES: readonly [number, number] = [0, 0];
/** The panel: width, height and how high its lower edge floats (m). */
export const HOLO_PANEL = { w: 5.0, h: 6.56, lift: 2.7 } as const;
const TINT = 0x7fe9ff;

/** Yaw (degrees, townFrame's: 0 faces south, counter-clockwise from above) that turns a front at `at` towards `to`. */
export function holoYaw(at: readonly [number, number], to: readonly [number, number]): number {
  return (Math.atan2(to[0] - at[0], -(to[1] - at[1])) * 180) / Math.PI;
}

let live: HoloBoard | null = null;
let huntLines: HoloHunt | null = null;

/**
 * The hunt's block on the board's second page (the missions lane's three-trial hunt, or the lead at
 * integration): pass its lines whenever they change, null for the sealed placeholder.
 */
export function setHoloHunt(hunt: HoloHunt | null) {
  huntLines = hunt;
  live?.redraw();
}

export class HoloBoard implements ClientSystem {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly tex: THREE.CanvasTexture;
  private readonly uPage = uniform(0);
  private readonly uFlip = uniform(0);
  private readonly cone: THREE.Mesh;
  private data: HomeData | null = null;
  private drawn = "";
  private t = 0;
  /** Scratch for holoPageAt (nothing is allocated per frame). */
  private readonly flip: HoloFlip = { page: 0, flip: 0 };
  /** The loop's clock at the last frame (ms): what the feed's refresh interval is measured on. */
  private clock = performance.now();
  private readonly feed: HoloFeed;
  private readonly off: () => void;

  constructor(private readonly game: Game) {
    this.group.name = "holoBoard";
    this.canvas.width = HOLO_PAGE.w * 2;
    this.canvas.height = HOLO_PAGE.h;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.redraw();
    this.feed = new HoloFeed(`${config.apiUrl}/api/home`, (data) => {
      this.data = data;
      this.redraw();
    });

    const tint = vec3(...new THREE.Color(TINT).toArray());
    const flick = sin(time.mul(31)).mul(sin(time.mul(7.3))).mul(0.05).add(0.95);
    const { w, h, lift } = HOLO_PANEL;

    // The panel.
    const panelMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
    panelMat.name = "holo_panel";
    {
      const u = uv();
      // A flip tears the rows sideways for a moment.
      const row = floor(u.y.mul(42));
      const tear = fract(sin(row.mul(91.7).add(floor(time.mul(24)).mul(13.1))).mul(43758.5453)).sub(0.5).mul(0.12).mul(this.uFlip);
      const ux = u.x.add(tear).clamp(0, 1);
      const ink = texture(this.tex, vec2(ux.add(this.uPage).mul(0.5), u.y)).rgb.mul(select(frontFacing, float(1), float(0)));
      const lines = sin(u.y.mul(Math.PI * 2 * 150)).mul(0.14).add(0.86);
      const sweep = smoothstep(0.05, 0.0, abs(fract(u.y.add(time.mul(0.07))).sub(0.5)));
      const ex = min(u.x, float(1).sub(u.x)).mul(w);
      const ey = min(u.y, float(1).sub(u.y)).mul(h);
      const d = min(ex, ey);
      const frame = smoothstep(0.075, 0.04, d).mul(smoothstep(0.0, 0.02, d));
      const inkMax = max(ink.r, max(ink.g, ink.b));
      const back = tint.mul(0.07);
      // By night the lamplit town is dim: a little more punch, never a white-out by day.
      const punch = mix(float(1.75), float(2.1), atmo.lamps);
      panelMat.colorNode = ink.mul(punch).add(tint.mul(frame.mul(1.5))).add(tint.mul(sweep.mul(0.1))).add(back).mul(lines).mul(flick);
      panelMat.opacityNode = max(max(inkMax, frame), float(0.5)).mul(float(1).sub(this.uFlip.mul(0.25))).mul(smoothstep(0.0, 0.02, d));
    }
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), panelMat);
    panel.name = "holo_panel";
    panel.position.y = lift + h / 2;
    panel.renderOrder = 5;

    // The cone of light from the emitter's lens up to the panel's lower edge (an elliptical fan).
    const coneH = lift - 0.42;
    const coneMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
    coneMat.name = "holo_cone";
    {
      const v = positionLocal.y.div(coneH).add(0.5);
      const rays = sin(uv().x.mul(Math.PI * 2 * 14).add(time.mul(0.6))).mul(0.25).add(0.75);
      coneMat.colorNode = tint.mul(mix(float(0.5), float(0.05), v).mul(rays).mul(flick).mul(mix(float(0.6), float(1.1), atmo.lamps)));
    }
    const cone = (this.cone = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.09, coneH, 24, 1, true), coneMat));
    cone.name = "holo_cone";
    cone.scale.set(w / 2, 1, 0.5);
    cone.position.y = 0.42 + coneH / 2;
    cone.renderOrder = 4;

    // The emitter: a dark drum with a glowing band and lens.
    const baseMat = new THREE.MeshBasicNodeMaterial();
    baseMat.name = "holo_base";
    {
      const y = positionLocal.y; // -0.21 … 0.21
      const band = smoothstep(0.035, 0.02, abs(y.sub(0.09)));
      const lens = smoothstep(0.2, 0.209, y).mul(smoothstep(0.62, 0.3, positionLocal.xz.length()));
      baseMat.colorNode = mix(vec3(0.045, 0.055, 0.075), tint.mul(2.4), max(band, lens)).mul(flick);
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.98, 0.42, 24), baseMat);
    base.name = "holo_base";
    base.position.y = 0.21;
    this.group.add(base, cone, panel);

    // Stand it on the paving, upright on the local up, the panel's front towards the pad.
    const R = game.planet.body.radius;
    const f: TownPlacement = { item: -1, prefab: -1, scale: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0 };
    townFrame(HOLO_AT[0], HOLO_AT[1], holoYaw(HOLO_AT, HOLO_FACES), R, f);
    const d = townDir(HOLO_AT[0], HOLO_AT[1], R);
    const r = R + game.planet.terrain.groundHeight(d[0], d[1], d[2]);
    this.group.position.set(d[0] * r, d[1] * r, d[2] * r);
    this.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(f.rx, f.ry, f.rz), new THREE.Vector3(f.ux, f.uy, f.uz), new THREE.Vector3(f.fx, f.fy, f.fz)));
    game.ctx.scene.add(this.group);
    this.applySettings(game.ctx.settings);
    this.off = game.ctx.onChange((s) => this.applySettings(s));
    live = this;
  }

  private applySettings(s: ResolvedSettings) {
    this.group.visible = s.on.holo;
    this.cone.visible = s.tier !== "low";
    // The feed follows the board: off, it asks for nothing and drops a request under way.
    this.feed.setEnabled(s.on.holo && !flags.has("offline"), this.clock);
  }

  /** Draw the pages again if what they say has changed (data or hunt lines). */
  redraw() {
    const pages = holoPages(this.data, huntLines);
    const key = JSON.stringify(pages);
    if (key === this.drawn) return;
    this.drawn = key;
    drawHoloPages(this.canvas, pages);
    this.tex.needsUpdate = true;
  }

  update(dt: number, now: number) {
    this.clock = now;
    if (!this.group.visible) return;
    this.feed.tick(now);
    this.t += dt;
    const p = holoPageAt(this.t, HOLO_PAGE_SECONDS, undefined, this.flip);
    this.uPage.value = p.page;
    this.uFlip.value = p.flip;
  }

  dispose() {
    this.feed.dispose();
    this.off();
    if (live === this) live = null;
    this.group.removeFromParent();
    disposeTree(this.group);
    this.tex.dispose();
  }
}

/** Client system: the board exists in Portus only (offline too: it shows its empty state). */
export const createHoloBoard: ClientSystemFactory = (game) => (game.planet.body.terrain.kind === "hub" ? new HoloBoard(game) : null);
createHoloBoard.offline = true;
