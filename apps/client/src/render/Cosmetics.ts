// Cosmetics on avatars (procedural placeholder shapes until cosmetic models exist) and name + title
// plates over other players' heads.
//
// Cosmetics ride the avatar's bone sockets (AvatarView.attach: head / face / back / belt, mapped from
// item slots by items.ts COSMETIC_SOCKET). Each shape is built around its socket point; cape and
// backpack share the back socket, so each socket gets one group holding everything worn there.

import * as THREE from "three/webgpu";
import { COSMETIC_BY_ID, COSMETIC_SOCKET, type CosmeticSlot, type Socket } from "@firstlight/shared/content/items";
import { disposeTree } from "./dispose.ts";

/** Anything with sockets (AvatarView). */
export interface Socketed {
  attach(slot: Socket, obj: THREE.Object3D | null): void;
}

/** Per-slot nudges from the socket point (the back socket sits on the spine; capes hang lower, packs sit out). */
const SLOT_OFFSET: Record<CosmeticSlot, THREE.Vector3> = {
  hat: new THREE.Vector3(0, -0.04, 0),
  mask: new THREE.Vector3(0, -0.05, 0.1),
  cape: new THREE.Vector3(0, 0.15, -0.12),
  backpack: new THREE.Vector3(0, -0.05, -0.16),
};

/** Materials shared by every rig (never freed); geometry and the static texture are per build. */
const mats = new Map<string, THREE.Material>();
const sharedMats = new WeakSet<object>();
const isShared = (r: object) => sharedMats.has(r);
function m(color: number, emissive = 0, opacity = 1, metal = 0.1, double = false): THREE.Material {
  const key = `${color}:${emissive}:${opacity}:${metal}:${double}`;
  let x = mats.get(key);
  if (!x) {
    const s = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.55, metalness: metal, transparent: opacity < 1, opacity, side: opacity < 1 || double ? THREE.DoubleSide : THREE.FrontSide });
    if (emissive) {
      s.emissive = new THREE.Color(color);
      s.emissiveIntensity = emissive;
    }
    x = s;
    mats.set(key, x);
    sharedMats.add(x);
  }
  return x;
}

function add(g: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = true;
  g.add(mesh);
  return mesh;
}

const dome = (r: number) => new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);

function staticTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const img = g.createImageData(64, 64);
  for (let i = 0; i < 64 * 64; i++) {
    const v = Math.random() * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Things that animate (halo spin, static scroll, key turn). */
interface Anim {
  obj: THREE.Object3D;
  kind: "spin" | "static" | "turn" | "orbit";
  tex?: THREE.Texture;
}

/** Build one cosmetic, positioned relative to its socket origin. */
export function buildCosmetic(id: string, anims: Anim[]): THREE.Object3D | null {
  const def = COSMETIC_BY_ID.get(id);
  if (!def) return null;
  const g = new THREE.Group();
  g.name = `cosmetic:${id}`;
  const cape = (color: number, emissive = 0, mat?: THREE.Material) => add(g, new THREE.PlaneGeometry(0.72, 1.05), mat ?? m(color, emissive, 1, 0.1, true), 0, -0.48, -0.03, 0.16);
  switch (id) {
    // ---- hats (origin on top of the head)
    case "woolly_beanie":
      add(g, dome(0.27), m(0xc0482e), 0, -0.1, 0);
      add(g, new THREE.SphereGeometry(0.07, 8, 6), m(0xf2efe6), 0, 0.2, 0);
      break;
    case "wide_straw_hat":
      add(g, new THREE.CylinderGeometry(0.52, 0.52, 0.02, 24), m(0xd8b56a), 0, -0.06, 0);
      add(g, new THREE.ConeGeometry(0.22, 0.22, 16), m(0xd8b56a), 0, 0.05, 0);
      break;
    case "winged_cap":
      add(g, dome(0.27), m(0xc9ced6, 0, 1, 0.6), 0, -0.1, 0);
      add(g, new THREE.BoxGeometry(0.02, 0.12, 0.26), m(0xffffff), 0.28, 0.0, -0.02, 0, 0, -0.5);
      add(g, new THREE.BoxGeometry(0.02, 0.12, 0.26), m(0xffffff), -0.28, 0.0, -0.02, 0, 0, 0.5);
      break;
    case "hard_hat":
      add(g, dome(0.28), m(0xf2b544), 0, -0.1, 0);
      add(g, new THREE.CylinderGeometry(0.34, 0.34, 0.02, 20), m(0xf2b544), 0, -0.1, 0.03);
      break;
    case "antler_crown":
      add(g, new THREE.TorusGeometry(0.22, 0.03, 6, 20), m(0x6b4a32), 0, -0.04, 0, Math.PI / 2);
      for (const s of [-1, 1]) {
        add(g, new THREE.CylinderGeometry(0.025, 0.035, 0.4, 6), m(0x8a6a43), s * 0.15, 0.14, 0, 0, 0, -s * 0.5);
        add(g, new THREE.CylinderGeometry(0.02, 0.025, 0.2, 6), m(0x8a6a43), s * 0.28, 0.3, 0, 0, 0, -s * 1.1);
        add(g, new THREE.SphereGeometry(0.04, 6, 5), m(0xff9ad0, 0.4), s * 0.36, 0.36, 0);
      }
      break;
    case "heron_plume_hat":
      add(g, new THREE.CylinderGeometry(0.2, 0.24, 0.16, 16), m(0x7a6a8a), 0, 0.0, 0);
      add(g, new THREE.ConeGeometry(0.04, 0.7, 6), m(0xd8d0e8), 0, 0.3, -0.18, -0.7);
      break;
    case "coral_crown":
      add(g, new THREE.TorusGeometry(0.22, 0.035, 6, 20), m(0x2a2a30), 0, -0.04, 0, Math.PI / 2);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(g, new THREE.ConeGeometry(0.04, 0.26, 6), m(0xff7a5a), Math.cos(a) * 0.22, 0.1, Math.sin(a) * 0.22);
        add(g, new THREE.SphereGeometry(0.025, 6, 5), m(0x36f9f6, 2.5), Math.cos(a) * 0.22, 0.24, Math.sin(a) * 0.22);
      }
      break;
    case "hollow_crown":
      add(g, new THREE.TorusGeometry(0.22, 0.03, 6, 20), m(0xeae2d0), 0, -0.04, 0, Math.PI / 2);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        add(g, new THREE.ConeGeometry(0.025, 0.42, 5), m(0xeae2d0), Math.cos(a) * 0.22, 0.17, Math.sin(a) * 0.22);
        add(g, new THREE.SphereGeometry(0.03, 6, 5), m(0xc9a46a, 0.3, 1, 0.8), Math.cos(a) * 0.22, 0.06, Math.sin(a) * 0.22);
      }
      break;
    case "pixel_halo": {
      const ring = new THREE.Group();
      ring.position.y = 0.22;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        add(ring, new THREE.BoxGeometry(0.06, 0.06, 0.06), m(0xffd166, 3), Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26);
      }
      g.add(ring);
      anims.push({ obj: ring, kind: "spin" });
      break;
    }
    case "candle_crown":
      add(g, new THREE.TorusGeometry(0.22, 0.03, 6, 20), m(0x3a3a42, 0, 1, 0.7), 0, -0.04, 0, Math.PI / 2);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
        add(g, new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8), m(0xf2efe6), Math.cos(a) * 0.22, 0.06, Math.sin(a) * 0.22);
        add(g, new THREE.ConeGeometry(0.022, 0.07, 6), m(0xff8a3d, 4), Math.cos(a) * 0.22, 0.18, Math.sin(a) * 0.22);
      }
      break;
    case "ticket_000_helmet":
      add(g, new THREE.SphereGeometry(0.29, 16, 12), m(0x5a5e68, 0, 1, 0.4), 0, -0.18, 0);
      add(g, new THREE.BoxGeometry(0.34, 0.04, 0.05), m(0xf2b544, 3), 0, -0.16, 0.27);
      break;
    // ---- capes (origin at the back socket)
    case "travellers_cloak":
      cape(0x7a5a3a);
      break;
    case "wolfpelt_cape":
      cape(0x8a8a8a);
      add(g, new THREE.TorusGeometry(0.22, 0.06, 6, 16, Math.PI), m(0x9a9a9a), 0, 0.06, 0.08, Math.PI / 2, 0, 0);
      break;
    case "tide_cape":
      cape(0x1f8a8a, 0.3);
      break;
    case "court_mantle":
      cape(0x4a3260);
      add(g, new THREE.TorusGeometry(0.24, 0.05, 6, 16, Math.PI), m(0xc9a46a, 0, 1, 0.7), 0, 0.06, 0.08, Math.PI / 2);
      break;
    case "saltplate_mantle":
      cape(0xe6e2d6);
      for (let i = 0; i < 3; i++) add(g, new THREE.BoxGeometry(0.6, 0.18, 0.04), m(0xcfc8b8, 0, 1, 0.3), 0, -0.2 - i * 0.28, -0.08 - i * 0.04, 0.16);
      break;
    case "static_cloak": {
      const tex = staticTexture();
      const mat = new THREE.MeshBasicNodeMaterial({ map: tex, side: THREE.DoubleSide });
      const c = cape(0, 0, mat);
      anims.push({ obj: c, kind: "static", tex });
      break;
    }
    // ---- masks (origin at the face socket)
    case "fox_mask":
      add(g, new THREE.ConeGeometry(0.17, 0.26, 4), m(0xf2efe6), 0, -0.02, 0.06, Math.PI / 2, 0, Math.PI / 4);
      add(g, new THREE.ConeGeometry(0.05, 0.12, 4), m(0xff8a3d), 0.12, 0.17, -0.04);
      add(g, new THREE.ConeGeometry(0.05, 0.12, 4), m(0xff8a3d), -0.12, 0.17, -0.04);
      break;
    case "voxel_visor":
      add(g, new THREE.BoxGeometry(0.38, 0.1, 0.06), m(0x36f9f6, 2.5), 0, 0.02, 0.02);
      break;
    case "crowbeak_mask":
      add(g, new THREE.ConeGeometry(0.08, 0.36, 8), m(0x1a1a20), 0, -0.04, 0.16, Math.PI / 2);
      break;
    case "funeral_veil":
      add(g, new THREE.PlaneGeometry(0.42, 0.5), m(0x2a1a3a, 0, 0.75), 0, -0.1, 0.04);
      break;
    case "executive_visor":
      add(g, new THREE.BoxGeometry(0.4, 0.09, 0.07), m(0xf2b544, 2.5, 1, 0.5), 0, 0.02, 0.02);
      break;
    // ---- backpacks (origin at the back socket)
    case "bedroll":
      add(g, new THREE.CylinderGeometry(0.11, 0.11, 0.56, 12), m(0xa88a5a), 0, 0.12, -0.06, 0, 0, Math.PI / 2);
      break;
    case "woolback_plushie":
      add(g, new THREE.SphereGeometry(0.15, 12, 10), m(0xf2efe6), 0, 0, -0.08);
      add(g, new THREE.SphereGeometry(0.08, 10, 8), m(0x3a3030), 0, 0.12, -0.2);
      break;
    case "wind_up_key": {
      const key = new THREE.Group();
      key.position.set(0, 0.05, -0.14);
      add(key, new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8), m(0xc9a46a, 0, 1, 0.8), 0, 0, -0.1, Math.PI / 2);
      add(key, new THREE.TorusGeometry(0.1, 0.025, 6, 16), m(0xc9a46a, 0, 1, 0.8), 0.11, 0, -0.22, 0, Math.PI / 2);
      add(key, new THREE.TorusGeometry(0.1, 0.025, 6, 16), m(0xc9a46a, 0, 1, 0.8), -0.11, 0, -0.22, 0, Math.PI / 2);
      g.add(key);
      anims.push({ obj: key, kind: "turn" });
      break;
    }
    case "signal_dish":
      add(g, new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), m(0x8a8e98, 0, 1, 0.6), 0, 0.2, -0.08);
      add(g, new THREE.SphereGeometry(0.22, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3), m(0xc8ccd6, 0, 1, 0.6), 0, 0.42, -0.12, -Math.PI / 2.4);
      break;
    case "tidewrath_tooth":
      add(g, new THREE.ConeGeometry(0.1, 0.55, 8), m(0xeae2d0), 0, 0.1, -0.1, 0, 0, 0.3);
      add(g, new THREE.SphereGeometry(0.04, 6, 5), m(0x36f9f6, 3), 0.05, -0.12, -0.1);
      break;
    case "receiver_floodlamp":
      add(g, new THREE.BoxGeometry(0.3, 0.3, 0.2), m(0x3a3f48, 0, 1, 0.6), 0, 0.15, -0.1);
      add(g, new THREE.CircleGeometry(0.11, 16), m(0xf2b544, 4), 0, 0.17, -0.205, 0, Math.PI);
      break;
    case "lantern_of_lacefall": {
      add(g, new THREE.BoxGeometry(0.18, 0.24, 0.18), m(0x6a5a3a, 0, 0.6, 0.6), 0, 0.3, -0.12);
      add(g, new THREE.SphereGeometry(0.06, 8, 6), m(0xfff2c0, 4), 0, 0.3, -0.12);
      const motes = new THREE.Group();
      motes.position.set(0, 0.3, -0.12);
      for (let i = 0; i < 4; i++) add(motes, new THREE.SphereGeometry(0.018, 5, 4), m(0xfff2c0, 4), Math.cos(i * 1.6) * 0.22, i * 0.08, Math.sin(i * 1.6) * 0.22);
      g.add(motes);
      anims.push({ obj: motes, kind: "orbit" });
      break;
    }
    case "golden_hopbit":
      add(g, new THREE.BoxGeometry(0.22, 0.22, 0.22), m(0xffc94a, 1.2, 1, 0.6), 0, 0.42, -0.06);
      add(g, new THREE.BoxGeometry(0.05, 0.12, 0.05), m(0xffc94a, 1.2, 1, 0.6), 0.06, 0.6, -0.06);
      add(g, new THREE.BoxGeometry(0.05, 0.12, 0.05), m(0xffc94a, 1.2, 1, 0.6), -0.06, 0.6, -0.06);
      break;
    case "bone_bell":
      add(g, new THREE.ConeGeometry(0.12, 0.2, 10), m(0xeae2d0), 0, 0.05, -0.1);
      break;
    default:
      add(g, new THREE.BoxGeometry(0.2, 0.2, 0.2), m(0xffffff));
  }
  return g;
}

/** Keeps the cosmetics on one avatar in sync with a comma-separated id list (PlayerState.cosmetics). */
export class CosmeticRig {
  private current = "";
  private readonly used = new Set<Socket>();
  private anims: Anim[] = [];
  private readonly avatar: Socketed;
  /** What the current list built (freed when the list changes or the rig goes). */
  private built: THREE.Group[] = [];

  constructor(avatar: Socketed) {
    this.avatar = avatar;
  }

  set(list: string) {
    if (list === this.current) return;
    this.current = list;
    for (const s of this.used) this.avatar.attach(s, null);
    this.used.clear();
    for (const g of this.built) disposeTree(g, isShared);
    this.built = [];
    this.anims = [];
    const groups = new Map<Socket, THREE.Group>();
    for (const id of list.split(",").filter(Boolean)) {
      const def = COSMETIC_BY_ID.get(id);
      if (!def) continue;
      const obj = buildCosmetic(id, this.anims);
      if (!obj) continue;
      obj.position.copy(SLOT_OFFSET[def.slot]);
      const socket = COSMETIC_SOCKET[def.slot];
      let g = groups.get(socket);
      if (!g) groups.set(socket, (g = new THREE.Group()));
      g.add(obj);
    }
    for (const [socket, g] of groups) {
      this.avatar.attach(socket, g);
      this.used.add(socket);
      this.built.push(g);
    }
  }

  update(t: number) {
    for (const a of this.anims) {
      if (a.kind === "spin") a.obj.rotation.y = t * 1.2;
      else if (a.kind === "turn") a.obj.rotation.z = t * 2;
      else if (a.kind === "orbit") a.obj.rotation.y = t * 0.9;
      else if (a.kind === "static" && a.tex) a.tex.offset.set(Math.random(), Math.random());
    }
  }

  dispose() {
    this.set("");
  }
}

/** DOM name + title plates over other players within range. */
export class Nameplates {
  private readonly root = document.createElement("div");
  private readonly plates = new Map<string, { el: HTMLDivElement; key: string }>();

  constructor() {
    this.root.className = "fl-plates";
    this.root.dataset.hud = ""; // photo mode hides HUD roots
    document.body.appendChild(this.root);
  }

  update(camera: THREE.Camera, entries: { id: string; pos: THREE.Vector3; name: string; title: string }[], me: THREE.Vector3) {
    const seen = new Set<string>();
    const v = new THREE.Vector3();
    for (const e of entries) {
      const d = e.pos.distanceTo(me);
      if (d > 45) continue;
      v.copy(e.pos).addScaledVector(e.pos.clone().normalize(), 2.15).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
      seen.add(e.id);
      let p = this.plates.get(e.id);
      if (!p) {
        p = { el: document.createElement("div"), key: "" };
        p.el.className = "fl-plate";
        this.root.appendChild(p.el);
        this.plates.set(e.id, p);
      }
      const key = `${e.name}|${e.title}`;
      if (p.key !== key) {
        p.key = key;
        p.el.textContent = e.name;
        if (e.title) {
          const i = document.createElement("i");
          i.textContent = e.title;
          p.el.appendChild(i);
        }
      }
      p.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      p.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
      p.el.style.opacity = String(Math.max(0.35, 1 - d / 50));
    }
    for (const [id, p] of this.plates) {
      if (seen.has(id)) continue;
      p.el.remove();
      this.plates.delete(id);
    }
  }

  dispose() {
    this.root.remove();
  }
}
