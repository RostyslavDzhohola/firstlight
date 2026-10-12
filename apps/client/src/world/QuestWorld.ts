// World props for the quests lane on the current body: Juno Vale's stall, the planet guides, the
// Hall of Firsts hologram wall, mission pickups (only while that mission is active) and the subtle
// Easter-egg parts. Placeholder geometry until the art lane replaces it; positions come from the
// shared world-object table so they match the server's triggers exactly.

import * as THREE from "three/webgpu";
import { materialColor, materialEmissive } from "three/tsl";
import { atmo } from "../render/atmosphere.ts";
import type { BodyId, Terrain } from "@firstlight/shared";
import { PLAQUES, type HallLine } from "@firstlight/shared/content/secrets";
import { objectPos, objectsOn, type WorldObjectDef } from "@firstlight/shared/content/world";
import { ANIM } from "@firstlight/shared/net/schema";
import { AvatarView } from "../render/Avatars.ts";
import { disposeTree } from "../render/dispose.ts";

/** Materials shared by every body's props (never freed); everything else a QuestWorld builds is its own. */
const mats = new Map<string, THREE.Material>();
const shared = new WeakSet<object>();
function std(color: number, opts: { emissive?: number; metal?: number; rough?: number; opacity?: number } = {}): THREE.Material {
  const key = `s${color}:${opts.emissive ?? 0}:${opts.metal ?? 0}:${opts.rough ?? 0.6}:${opts.opacity ?? 1}`;
  let m = mats.get(key);
  if (!m) {
    const s = new THREE.MeshStandardNodeMaterial({ color, roughness: opts.rough ?? 0.6, metalness: opts.metal ?? 0.05, transparent: (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1 });
    if (opts.emissive) {
      s.emissive = new THREE.Color(color);
      s.emissiveIntensity = opts.emissive;
      s.emissiveNode = materialEmissive.mul(atmo.glowBoost); // brighter at night
    }
    m = s;
    mats.set(key, m);
    shared.add(m);
  }
  return m;
}
function glow(color: number, k = 2, opacity = 1): THREE.Material {
  const key = `g${color}:${k}:${opacity}`;
  let m = mats.get(key);
  if (!m) {
    const b = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(k), transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    b.colorNode = materialColor.mul(atmo.glowBoost); // brighter at night
    m = b;
    mats.set(key, m);
    shared.add(m);
  }
  return m;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Text on a canvas, as a sprite (labels) or a texture (plaques). */
function textCanvas(lines: { text: string; font: string; color: string }[], w: number, h: number, bg?: string, mirror = false): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
  }
  if (mirror) {
    g.translate(w, 0);
    g.scale(-1, 1);
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  const step = h / (lines.length + 1);
  lines.forEach((l, i) => {
    g.font = l.font;
    g.fillStyle = l.color;
    g.shadowColor = "#000";
    g.shadowBlur = 6;
    g.fillText(l.text, w / 2, step * (i + 1));
  });
  return c;
}

function label(text: string, sub: string, color = "#ffd8a8"): THREE.Sprite {
  const c = textCanvas(
    [
      { text, font: "700 46px ui-sans-serif, system-ui, sans-serif", color: "#ffffff" },
      ...(sub ? [{ text: sub, font: "600 30px ui-sans-serif, system-ui, sans-serif", color }] : []),
    ],
    640,
    sub ? 150 : 96,
  );
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(4.2, sub ? 1 : 0.63, 1);
  return s;
}

function iconPlate(icon: string, color: string): THREE.Mesh {
  const c = textCanvas([{ text: icon, font: "110px serif", color }], 128, 128, "#1a1426");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), new THREE.MeshBasicNodeMaterial({ map: tex }));
}

const ICONS: Record<string, string> = { rain: "💧", leaf: "🍃", sun: "☀", flame: "🔥", skull: "☠", lantern: "🏮", candle: "🕯" };

export interface QuestWorldState {
  activeMissions: Set<string>;
}

interface Prop {
  def: WorldObjectDef;
  root: THREE.Group;
  pos: THREE.Vector3;
  spin?: THREE.Object3D;
  bob?: THREE.Object3D;
  lampBulb?: THREE.Mesh;
  /** A standing NPC figure (animated avatar in world space) and the way it faces. */
  npc?: AvatarView;
  facing?: THREE.Vector3;
}

export class QuestWorld {
  readonly group = new THREE.Group();
  readonly props: Prop[] = [];
  private readonly byId = new Map<string, Prop>();
  private hallTexture: THREE.CanvasTexture | null = null;
  private hallCanvas: HTMLCanvasElement | null = null;
  private t = 0;
  private readonly body: BodyId;
  private readonly litLanterns = new Map<string, number>();

  constructor(scene: THREE.Scene, body: BodyId, terrain: Terrain) {
    this.body = body;
    scene.add(this.group);
    for (const def of objectsOn(body)) {
      const p = objectPos(def, (x, y, z) => terrain.groundHeight(x, y, z));
      const pos = new THREE.Vector3(p[0], p[1], p[2]);
      const root = new THREE.Group();
      root.position.copy(pos);
      // Stand on local up, oriented to the local north/east frame (NPCs and the wall turn inward below).
      const up = pos.clone().normalize();
      const ref = Math.abs(up.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const north = ref.addScaledVector(up, -ref.dot(up)).normalize();
      // Right-handed basis (x = up × north): a proper rotation, not a mirror.
      const x = new THREE.Vector3().crossVectors(up, north).normalize();
      root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, north));
      const prop: Prop = { def, root, pos };
      this.build(prop);
      this.group.add(root);
      this.props.push(prop);
      this.byId.set(def.id, prop);
    }
    this.faceInward();
  }

  /** Turn NPCs and the hall wall to face the plaza / pad centre. */
  private faceInward() {
    for (const p of this.props) {
      if (p.def.look !== "keeper" && p.def.look !== "guide" && p.def.look !== "hall") continue;
      const up = p.pos.clone().normalize();
      const centreDir = this.body === "portus" ? new THREE.Vector3(0, 1, 0) : p.pos.clone().normalize();
      let toward = centreDir.clone().multiplyScalar(p.pos.length()).sub(p.pos);
      if (this.body !== "portus") {
        // Guides face the pad centre (the place anchor): approximate with the opposite of their offset.
        const ref = Math.abs(up.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        const north = ref.addScaledVector(up, -ref.dot(up)).normalize();
        const east = new THREE.Vector3().crossVectors(north, up).normalize();
        toward = east.multiplyScalar(-(p.def.east ?? 0)).addScaledVector(north, -(p.def.north ?? 0));
      }
      toward.addScaledVector(up, -toward.dot(up));
      if (toward.lengthSq() < 1e-6) continue;
      toward.normalize();
      const right = new THREE.Vector3().crossVectors(up, toward).normalize();
      p.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, toward));
      p.facing = toward.clone();
    }
  }

  private build(p: Prop) {
    const r = p.root;
    const d = p.def;
    switch (d.look) {
      case "keeper": {
        p.npc = new AvatarView(1, 2);
        this.group.add(p.npc.root);
        const counter = mesh(new THREE.BoxGeometry(2.6, 1.0, 0.8), std(0x7a5a3a, { rough: 0.8 }), 0, 0.5, 1.1);
        const top = mesh(new THREE.BoxGeometry(2.8, 0.08, 1.0), std(0xd8b98a), 0, 1.04, 1.1);
        const awning = mesh(new THREE.BoxGeometry(3.2, 0.06, 1.8), std(0xc0482e), 0, 2.7, 0.6);
        awning.rotation.x = -0.18;
        const postL = mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.7, 8), std(0x5a4030), -1.5, 1.35, 1.4);
        const postR = mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.7, 8), std(0x5a4030), 1.5, 1.35, 1.4);
        const crate = mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), std(0x9a7a4a), -1.0, 1.33, 1.1);
        const orb = mesh(new THREE.IcosahedronGeometry(0.18, 1), glow(0xffd166, 2.5), 0.8, 1.3, 1.1);
        r.add(counter, top, awning, postL, postR, crate, orb);
        p.bob = orb;
        const l = label("Juno Vale", "Portus Exchange · E to trade");
        l.position.set(0, 3.4, 0.6);
        r.add(l);
        break;
      }
      case "guide": {
        p.npc = new AvatarView(d.body === "arcadia" ? 3 : d.body === "hollowmere" ? 5 : 4, d.body === "meridian" ? 3 : 1);
        this.group.add(p.npc.root);
        const staff = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.9, 6), std(0x6b4a32), 0.45, 0.95, 0.1);
        const lamp = mesh(new THREE.SphereGeometry(0.1, 10, 8), glow(0xffd8a8, 2.5), 0.45, 1.95, 0.1);
        r.add(staff, lamp);
        const l = label(d.name, "Missions · E to talk");
        l.position.set(0, 2.5, 0);
        r.add(l);
        break;
      }
      case "hall": {
        const c = document.createElement("canvas");
        c.width = 1024;
        c.height = 768;
        this.hallCanvas = c;
        this.hallTexture = new THREE.CanvasTexture(c);
        this.hallTexture.colorSpace = THREE.SRGBColorSpace;
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), new THREE.MeshBasicNodeMaterial({ map: this.hallTexture, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false }));
        wall.position.set(0, 3.6, 0);
        const frame = mesh(new THREE.BoxGeometry(8.4, 0.2, 0.3), std(0xc9a46a, { metal: 0.6, rough: 0.35 }), 0, 0.5, 0);
        const frameTop = mesh(new THREE.BoxGeometry(8.4, 0.12, 0.2), glow(0xff7edb, 2), 0, 6.7, 0);
        const pillarL = mesh(new THREE.BoxGeometry(0.25, 6.4, 0.3), std(0xc9a46a, { metal: 0.6, rough: 0.35 }), -4.2, 3.6, 0);
        const pillarR = mesh(new THREE.BoxGeometry(0.25, 6.4, 0.3), std(0xc9a46a, { metal: 0.6, rough: 0.35 }), 4.2, 3.6, 0);
        r.add(wall, frame, frameTop, pillarL, pillarR);
        this.setHall([]);
        break;
      }
      case "bell":
      case "ledger":
      case "memo": {
        const g = d.look === "bell" ? new THREE.ConeGeometry(0.16, 0.26, 12, 1, true) : d.look === "ledger" ? new THREE.BoxGeometry(0.34, 0.08, 0.26) : new THREE.BoxGeometry(0.12, 0.04, 0.2);
        const item = mesh(g, std(d.look === "bell" ? 0xc9a46a : d.look === "ledger" ? 0x5a2a2a : 0x2a3a4a, { metal: d.look === "bell" ? 0.7 : 0.1, emissive: 0.4 }), 0, 0.6, 0);
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 6, 12, 1, true), glow(0xffd166, 1.2, 0.18));
        beam.position.y = 3;
        if (d.look === "ledger") r.add(mesh(new THREE.BoxGeometry(0.9, 0.9, 0.6), std(0x8a8494, { rough: 0.9 }), 0, 0.45 - 0.35, 0));
        if (d.look === "memo") r.add(mesh(new THREE.BoxGeometry(1.4, 0.75, 0.7), std(0x3a3f48, { metal: 0.3 }), 0, 0.375 - 0.2, 0));
        r.add(item, beam);
        p.bob = item;
        break;
      }
      case "bowl": {
        r.add(mesh(new THREE.CylinderGeometry(0.28, 0.18, 0.14, 16), std(0x8a7a5a, { metal: 0.3 }), 0, 0.5, 0));
        r.add(mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.42, 10), std(0x6a6a72, { rough: 0.9 }), 0, 0.21, 0));
        const shrine = mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), std(0x6fd36f, { emissive: 0.25 }), 0, 0.25, -0.9);
        r.add(shrine);
        const mote = mesh(new THREE.SphereGeometry(0.05, 6, 6), glow(0xfff2c0, 3), 0, 1.0, 0);
        r.add(mote);
        p.bob = mote;
        break;
      }
      case "cabinet": {
        r.add(mesh(new THREE.BoxGeometry(1.4, 2.2, 0.9), std(0x2a2440, { rough: 0.7 }), 0, 1.1, 0));
        r.add(mesh(new THREE.PlaneGeometry(1.0, 0.7), glow(0x36f9f6, 1.1, 0.85), 0, 1.75, -0.46).rotateY(Math.PI));
        const plaque = mesh(new THREE.BoxGeometry(0.9, 0.3, 0.04), std(0xc9a46a, { metal: 0.6 }), 0, 0.6, -0.47);
        r.add(plaque);
        break;
      }
      case "button": {
        const base = mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.9, 12), std(0x2a2440), 0, 0.45, 0);
        const cap = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 16), std(0xff5a6a, { emissive: 0.6 }), 0, 0.93, 0);
        const icon = iconPlate(ICONS[d.part ?? ""] ?? "?", "#ffffff");
        icon.position.set(0, 1.25, 0);
        r.add(base, cap, icon);
        p.spin = icon;
        break;
      }
      case "plaque":
        r.add(mesh(new THREE.BoxGeometry(0.8, 0.5, 0.06), std(0xc9a46a, { metal: 0.6 }), 0, 1.2, 0));
        r.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6), std(0x4a4a52), 0, 0.5, 0));
        break;
      case "burrow": {
        const trunk = mesh(new THREE.CylinderGeometry(0.45, 0.7, 4.5, 10), std(0x5a4030, { rough: 0.95 }), -1.5, 2.25, 0);
        const crown = mesh(new THREE.IcosahedronGeometry(3.2, 1), std(0x4f8a3a, { rough: 0.9 }), -1.5, 6.0, 0);
        const hole = mesh(new THREE.CircleGeometry(0.4, 16), std(0x140e08, { rough: 1 }), 0, 0.04, 0);
        hole.rotation.x = -Math.PI / 2;
        r.add(trunk, crown, hole);
        break;
      }
      case "lantern": {
        r.add(mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.6, 6), std(0x3a3030), 0, 0.8, 0));
        const bulb = mesh(new THREE.BoxGeometry(0.22, 0.3, 0.22), std(0x5a6a6a, { opacity: 0.85 }), 0, 1.75, 0);
        r.add(bulb);
        p.lampBulb = bulb;
        break;
      }
      case "ferry": {
        const hull = mesh(new THREE.BoxGeometry(1.6, 0.4, 4.2), std(0x9fe8ff, { emissive: 0.6, opacity: 0.35 }), 0, 0.3, 0);
        const post = mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.8, 6), std(0x9fe8ff, { emissive: 0.6, opacity: 0.35 }), 0, 1.2, 1.6);
        const pier = mesh(new THREE.BoxGeometry(1.2, 0.15, 3), std(0x4a3a2a, { rough: 0.95 }), 0, 0.2, -3.2);
        r.add(hull, post, pier);
        p.bob = hull;
        break;
      }
      case "chest":
        r.add(mesh(new THREE.BoxGeometry(0.9, 0.55, 0.6), std(0x5a4030), 0, 0.28, 0));
        r.add(mesh(new THREE.BoxGeometry(0.92, 0.12, 0.62), std(0x9a8a6a, { metal: 0.5 }), 0, 0.6, 0));
        break;
      case "rope": {
        r.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 6), std(0x8a7a5a, { rough: 1 }), 0, 1.6, 0));
        r.add(mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), std(0x8a7a5a), 0, 0.3, 0));
        const icon = iconPlate(ICONS[d.part ?? ""] ?? "?", "#ffffff");
        icon.position.set(0, 1.0, 0.08);
        r.add(icon);
        if (d.part === "skull") r.add(mesh(new THREE.BoxGeometry(3.4, 0.15, 0.15), std(0x4a3a2a), 1, 2.9, 0));
        p.spin = icon;
        break;
      }
      case "well": {
        const ring = mesh(new THREE.TorusGeometry(1.2, 0.25, 8, 24), std(0x7a7470, { rough: 0.95 }), 0, 0.4, 0);
        ring.rotation.x = Math.PI / 2;
        const hole = mesh(new THREE.CircleGeometry(1.05, 24), std(0x050505, { rough: 1 }), 0, 0.12, 0);
        hole.rotation.x = -Math.PI / 2;
        r.add(ring, hole);
        break;
      }
      case "altar": {
        r.add(mesh(new THREE.BoxGeometry(1.4, 0.9, 0.7), std(0xd8d0c0, { rough: 0.9 }), 0, 0.45, 0));
        const bell = mesh(new THREE.ConeGeometry(0.14, 0.24, 10), std(0xeae2d0), 0, 2.4, 0);
        bell.rotation.x = Math.PI;
        r.add(bell, mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.9, 4), std(0x8a7a5a), 0, 2.95, 0));
        p.bob = bell;
        break;
      }
      case "safe": {
        r.add(mesh(new THREE.BoxGeometry(0.8, 0.8, 0.5), std(0x4a4f58, { metal: 0.7, rough: 0.4 }), 0, 1.2, 0));
        r.add(mesh(new THREE.PlaneGeometry(0.22, 0.3), glow(0xf2b544, 1.4), 0.2, 1.25, 0.26));
        r.add(mesh(new THREE.BoxGeometry(1.6, 0.75, 0.8), std(0x3a2a20), 0, 0.375, 1.4));
        break;
      }
      case "poster": {
        const c = textCanvas([{ text: "REFLECT ON", font: "800 64px ui-sans-serif, system-ui", color: "#f2b544" }, { text: "YOUR PERFORMANCE", font: "800 64px ui-sans-serif, system-ui", color: "#f2b544" }], 768, 320, "#202630");
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.75), new THREE.MeshBasicNodeMaterial({ map: tex, side: THREE.DoubleSide }));
        m.position.set(0, 1.7, 0);
        r.add(m);
        break;
      }
      case "mirror": {
        // A baked mirror (works on Low): the opposite wall's mirror-painted digits read correctly here.
        const wallC = textCanvas([{ text: "7041", font: "800 150px ui-monospace, monospace", color: "#c8ccd6" }], 512, 256, "#2a2f38", true);
        const wallTex = new THREE.CanvasTexture(wallC);
        wallTex.colorSpace = THREE.SRGBColorSpace;
        const painted = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshBasicNodeMaterial({ map: wallTex, side: THREE.DoubleSide }));
        painted.position.set(0, 1.6, -3);
        const mirC = textCanvas([{ text: "7041", font: "800 150px ui-monospace, monospace", color: "#7a8494" }], 512, 256, "#9fb0c0");
        const mirTex = new THREE.CanvasTexture(mirC);
        mirTex.colorSpace = THREE.SRGBColorSpace;
        const mirror = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.4), new THREE.MeshBasicNodeMaterial({ map: mirTex, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
        mirror.position.set(0, 1.6, 0);
        r.add(painted, mirror);
        break;
      }
      case "lamp": {
        const bulb = mesh(new THREE.SphereGeometry(0.4, 12, 10), glow(0xfff2c0, 4), 0, 0, 0);
        r.add(bulb);
        p.lampBulb = bulb;
        if (d.part === "3") {
          // The billboard itself, behind the middle lamp, on two posts down to the mesa.
          const board = mesh(new THREE.BoxGeometry(16, 7, 0.4), std(0x2a2e36, { metal: 0.4 }), 0, 1.5, -1.2);
          const face = textCanvas([{ text: "MERIDIAN OVERSIGHT", font: "800 72px ui-sans-serif, system-ui", color: "#f2b544" }, { text: "COMPLIANCE IS FREEDOM", font: "700 52px ui-sans-serif, system-ui", color: "#c8ccd6" }], 1024, 448, "#1a1e26");
          const tex = new THREE.CanvasTexture(face);
          tex.colorSpace = THREE.SRGBColorSpace;
          const facePlane = new THREE.Mesh(new THREE.PlaneGeometry(15.2, 6.4), new THREE.MeshBasicNodeMaterial({ map: tex }));
          facePlane.position.set(0, 1.5, -0.99);
          const lift = d.lift ?? 60;
          const postL = mesh(new THREE.CylinderGeometry(0.4, 0.5, lift, 8), std(0x4a4f58, { metal: 0.6 }), -6, -lift / 2, -1.2);
          const postR = mesh(new THREE.CylinderGeometry(0.4, 0.5, lift, 8), std(0x4a4f58, { metal: 0.6 }), 6, -lift / 2, -1.2);
          r.add(board, facePlane, postL, postR);
        }
        break;
      }
      case "hatch":
        r.add(mesh(new THREE.BoxGeometry(1.2, 1.6, 0.25), std(0x4a4f58, { metal: 0.7 }), 0, 0.8, 0));
        r.add(mesh(new THREE.BoxGeometry(0.2, 0.1, 0.1), std(0xf2b544, { emissive: 0.8 }), 0.4, 0.9, 0.15));
        break;
      case "pod": {
        // An Oversight storage locker, not a cloning tube: a hexagonal slate frame with a smoked amber
        // window, hazard-banded base and the helmet on a hook inside (F12 review, IP).
        r.add(mesh(new THREE.CylinderGeometry(0.62, 0.62, 2.3, 6, 1, true), std(0xd9a54a, { opacity: 0.22, emissive: 0.1 }), 0, 1.25, 0));
        for (const y of [0.15, 2.4]) r.add(mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.22, 6), std(0x4a525c), 0, y, 0));
        r.add(mesh(new THREE.BoxGeometry(0.12, 2.3, 0.12), std(0x3a424b), 0.66, 1.25, 0));
        r.add(mesh(new THREE.BoxGeometry(0.12, 2.3, 0.12), std(0x3a424b), -0.66, 1.25, 0));
        r.add(mesh(new THREE.BoxGeometry(1.2, 0.08, 0.05), std(0xf2b544, { emissive: 0.6 }), 0, 0.3, 0.62));
        r.add(mesh(new THREE.BoxGeometry(0.34, 0.34, 0.36), std(0x56606b), 0, 1.45, 0));
        break;
      }
    }
  }

  setHall(lines: HallLine[]) {
    const c = this.hallCanvas;
    if (!c || !this.hallTexture) return;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, "#2a0f3acc");
    grad.addColorStop(1, "#0a1a2acc");
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#ff7edb88";
    g.lineWidth = 4;
    g.strokeRect(8, 8, c.width - 16, c.height - 16);
    g.textAlign = "center";
    g.fillStyle = "#ffffff";
    g.font = "800 54px ui-sans-serif, system-ui, sans-serif";
    g.fillText("HALL OF FIRSTS", c.width / 2, 72);
    const by = new Map(lines.map((l) => [l.id, l]));
    const rowH = (c.height - 120) / PLAQUES.length;
    PLAQUES.forEach((p, i) => {
      const y = 120 + rowH * i + rowH * 0.6;
      const got = by.get(p.id);
      g.textAlign = "left";
      g.font = "600 28px ui-sans-serif, system-ui, sans-serif";
      g.fillStyle = got ? "#ffd8a8" : "#8f88a8";
      g.fillText(got ? p.label : p.hiddenLabel, 48, y);
      g.textAlign = "right";
      g.font = got ? "800 28px ui-sans-serif, system-ui, sans-serif" : "italic 26px ui-sans-serif, system-ui, sans-serif";
      g.fillStyle = got ? "#36f9f6" : "#6a6482";
      g.fillText(got ? got.name.slice(0, 40) : "unclaimed", c.width - 48, y);
    });
    this.hallTexture.needsUpdate = true;
  }

  setLamp(id: string, on: boolean) {
    const p = this.byId.get(id);
    if (p?.lampBulb) p.lampBulb.visible = on;
  }

  /** Light a marsh lantern locally for the egg's 180 s window (the server keeps the truth). */
  lightLantern(id: string) {
    this.litLanterns.set(id, performance.now() + 180_000);
    const p = this.byId.get(id);
    if (p?.lampBulb) p.lampBulb.material = glow(0x9fffd8, 3);
  }

  update(dt: number, st: QuestWorldState) {
    this.t += dt;
    const now = performance.now();
    for (const p of this.props) {
      if (p.npc && p.facing) p.npc.set(p.pos.x, p.pos.y, p.pos.z, p.facing.x, p.facing.y, p.facing.z, ANIM.IDLE, dt);
      if (p.def.mission) p.root.visible = st.activeMissions.has(p.def.mission);
      if (p.bob) p.bob.position.y = (p.def.look === "ferry" ? 0.3 : p.def.look === "altar" ? 2.4 : p.def.look === "bowl" ? 1.0 : p.def.look === "keeper" ? 1.3 : 0.6) + Math.sin(this.t * 2 + p.pos.x) * 0.06;
      if (p.spin) p.spin.rotation.y = Math.sin(this.t * 0.8) * 0.4;
    }
    for (const [id, until] of this.litLanterns) {
      if (until > now) continue;
      this.litLanterns.delete(id);
      const p = this.byId.get(id);
      if (p?.lampBulb) p.lampBulb.material = std(0x5a6a6a, { opacity: 0.85 });
    }
  }

  /** Leaving the body: NPC figures, then every geometry, label texture and one-off material here. */
  dispose() {
    for (const p of this.props) p.npc?.dispose();
    this.group.removeFromParent();
    disposeTree(this.group, (r) => shared.has(r));
    this.hallTexture = null;
    this.hallCanvas = null;
  }
}
