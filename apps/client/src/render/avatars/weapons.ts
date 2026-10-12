// Procedural held-item models, one per weapon id (original designs). Built once per id from a few
// primitives, merged per material (1–3 draws each) and shared by every avatar holding that item.
// Socket space: origin = centre of the grip, +Z = forward (blade tip / muzzle), +Y = up.

import * as THREE from "three/webgpu";
import { color, float, mix, mx_noise_float, smoothstep, time, uv, vec2 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PALETTES } from "./material.ts";

type MatKey = "metal" | "metalLight" | "brass" | "wood" | "leather" | "cord" | "ivory" | "feather" | "glass" | "accent" | "blade";

const mats = new Map<string, THREE.Material>();
function mat(key: MatKey, palette: number): THREE.Material {
  const k = key === "accent" ? `accent:${palette}` : key;
  let m = mats.get(k);
  if (m) return m;
  const std = (c: number, rough: number, metal: number) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: rough, metalness: metal });
  switch (key) {
    case "metal": m = std(0x3b4047, 0.45, 0.7); break;
    case "metalLight": m = std(0x7a828c, 0.35, 0.8); break;
    case "brass": m = std(0xc39440, 0.35, 0.85); break;
    case "wood": m = std(0x7a5332, 0.8, 0); break;
    case "leather": m = std(0x3a2a20, 0.85, 0); break;
    case "cord": m = std(0xc9b48a, 0.9, 0); break;
    case "ivory": m = std(0xe6e0d2, 0.5, 0.05); break;
    case "feather": m = std(0xf1ebde, 0.9, 0); break;
    case "glass": {
      const g = std(0xff8a3d, 0.2, 0);
      g.emissive = new THREE.Color(0xff6a20);
      g.emissiveIntensity = 1.6;
      m = g;
      break;
    }
    case "accent": {
      const acc = PALETTES[((palette % 6) + 6) % 6]![2];
      const a = new THREE.MeshStandardNodeMaterial({ color: acc, roughness: 0.4, metalness: 0 });
      a.emissive = new THREE.Color(acc);
      a.emissiveIntensity = 2.4;
      m = a;
      break;
    }
    case "blade": {
      // Sunbrand core: amber-white whatever the palette (content.md §8.2)
      const b = new THREE.MeshBasicNodeMaterial();
      b.colorNode = color(0xffe2a8).mul(3.2);
      m = b;
      break;
    }
  }
  mats.set(k, m!);
  return m!;
}

let flameMat: THREE.MeshBasicNodeMaterial | null = null;
/** Sunbrand's flame ribbon: scrolling noise flicker, white-hot centre to amber edges, additive. */
function flameMaterial(): THREE.MeshBasicNodeMaterial {
  if (flameMat) return flameMat;
  const m = new THREE.MeshBasicNodeMaterial();
  const p = uv();
  const across = p.x.sub(0.5).abs().mul(2); // 0 centre → 1 edge
  const n = mx_noise_float(vec2(p.x.mul(3), p.y.mul(7).sub(time.mul(2.6)))).mul(0.5).add(0.5);
  const tipFade = smoothstep(1.0, 0.72, p.y).mul(smoothstep(0.0, 0.06, p.y));
  const body = smoothstep(1.0, 0.25, across.add(n.mul(0.45)));
  const hot = mix(color(0xff7a1a), color(0xfff1d0), smoothstep(0.55, 0.0, across));
  m.colorNode = hot.mul(body.mul(tipFade).mul(float(2.6)));
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  flameMat = m;
  return m;
}

interface Piece {
  geo: THREE.BufferGeometry;
  mat: MatKey;
}

function P(geo: THREE.BufferGeometry, m: MatKey, pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0], scale?: [number, number, number]): Piece {
  const g = geo.index ? geo : geo;
  const mtx = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...(scale ?? [1, 1, 1])));
  g.applyMatrix4(mtx);
  return { geo: g, mat: m };
}

// primitives oriented along +Z
const cylZ = (r0: number, r1: number, len: number, seg = 8) => new THREE.CylinderGeometry(r1, r0, len, seg).rotateX(Math.PI / 2);
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const sph = (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const torus = (r: number, t: number, seg = 12) => new THREE.TorusGeometry(r, t, 5, seg);

const H = Math.PI / 2;

function design(id: string): Piece[] {
  switch (id) {
    case "sunbrand": {
      // lantern-cage brass hilt: grip, two guard rings, four cage bars around a glowing core
      const ps: Piece[] = [
        P(cylZ(0.017, 0.017, 0.2, 10), "leather", [0, 0, -0.02]),
        P(cylZ(0.03, 0.03, 0.016, 12), "brass", [0, 0, 0.09]),
        P(cylZ(0.03, 0.03, 0.016, 12), "brass", [0, 0, 0.19]),
        P(sph(0.02), "accent", [0, 0, 0.14]),
        P(cylZ(0.02, 0.012, 0.03, 8), "brass", [0, 0, -0.135]),
        P(box(0.014, 0.004, 0.62), "blade", [0, 0, 0.52]),
      ];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        ps.push(P(cylZ(0.004, 0.004, 0.1, 4), "brass", [Math.cos(a) * 0.026, Math.sin(a) * 0.026, 0.14]));
      }
      return ps;
    }
    case "riverstaff": {
      const ps: Piece[] = [P(cylZ(0.022, 0.02, 1.75, 8), "wood", [0, 0, 0.25])];
      for (const z of [-0.5, -0.1, 0.12, 0.62, 1.05]) ps.push(P(torus(0.024, 0.006, 10), "cord", [0, 0, z]));
      ps.push(P(sph(0.026, 8, 6), "wood", [0, 0, 1.12]), P(sph(0.026, 8, 6), "wood", [0, 0, -0.62]));
      return ps;
    }
    case "hexquill": {
      // quill-shaped wand: dark shaft, long feather vane, glowing nib that writes glyphs
      return [
        P(cylZ(0.009, 0.006, 0.34, 6), "leather", [0, 0, 0.06]),
        P(new THREE.ConeGeometry(0.008, 0.06, 6).rotateX(H), "accent", [0, 0, 0.26]),
        P(sph(1, 10, 6), "feather", [0, 0.012, -0.12], [0, 0, 0], [0.012, 0.045, 0.16]),
        P(torus(0.011, 0.003, 8), "brass", [0, 0, 0.2]),
      ];
    }
    case "carbine": {
      // Pocket Carbine: boxy compact receiver, short barrel, stubby stock, top battery cell
      return [
        P(box(0.06, 0.09, 0.3), "ivory", [0, 0.04, 0.08]),
        P(box(0.05, 0.03, 0.28), "metal", [0, 0.005, 0.08]),
        P(cylZ(0.016, 0.016, 0.16, 8), "metal", [0, 0.05, 0.3]),
        P(box(0.04, 0.12, 0.05), "metal", [0, -0.05, -0.0], [0.25, 0, 0]),
        P(box(0.045, 0.07, 0.12), "metal", [0, 0.03, -0.14]),
        P(cylZ(0.022, 0.022, 0.12, 10), "metalLight", [0, 0.105, 0.06]),
        P(cylZ(0.0235, 0.0235, 0.02, 10), "accent", [0, 0.105, 0.11]),
      ];
    }
    case "axe":
      return [
        P(cylZ(0.018, 0.016, 0.7, 8), "wood", [0, 0, 0.2]),
        P(box(0.02, 0.2, 0.1), "metalLight", [0, 0.09, 0.5], [0.15, 0, 0]),
        P(box(0.024, 0.06, 0.08), "metal", [0, 0.0, 0.5]),
      ];
    case "hammer":
      return [
        P(cylZ(0.02, 0.018, 0.75, 8), "wood", [0, 0, 0.22]),
        P(box(0.12, 0.12, 0.2), "metal", [0, 0, 0.6], [0, H, 0]),
        P(box(0.13, 0.03, 0.13), "metalLight", [0, 0.065, 0.6]),
      ];
    case "emberglass":
      return [
        P(cylZ(0.02, 0.016, 1.4, 8), "wood", [0, 0, 0.3]),
        P(new THREE.OctahedronGeometry(0.06, 0), "glass", [0, 0, 1.06], [0, 0, 0], [1, 1, 1.6]),
        P(torus(0.04, 0.008, 10), "brass", [0, 0, 0.97]),
      ];
    case "stormcoil":
      return [
        P(cylZ(0.016, 0.014, 0.32, 8), "metal", [0, 0, 0.06]),
        P(torus(0.035, 0.007, 12), "brass", [0, 0, 0.2]),
        P(torus(0.03, 0.007, 12), "brass", [0, 0, 0.24]),
        P(sph(0.022), "accent", [0, 0, 0.3]),
      ];
    case "scatterpipe":
      return [
        P(cylZ(0.022, 0.022, 0.42, 8), "metal", [0.022, 0.03, 0.22]),
        P(cylZ(0.022, 0.022, 0.42, 8), "metal", [-0.022, 0.03, 0.22]),
        P(box(0.05, 0.1, 0.05), "wood", [0, -0.04, 0], [0.3, 0, 0]),
        P(box(0.06, 0.07, 0.2), "wood", [0, 0.01, -0.1]),
      ];
    case "longbow": {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12 - 0.5;
        pts.push(new THREE.Vector3(0, t * 1.5, -0.12 * Math.cos(t * Math.PI) + 0.05));
      }
      return [
        P(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.014, 5), "wood"),
        P(cylZ(0.002, 0.002, 1.44, 3), "cord", [0, 0, -0.08], [H, 0, 0]),
        P(cylZ(0.02, 0.02, 0.12, 8), "leather", [0, 0, 0.0], [H, 0, 0]),
      ];
    }
    case "stillshot":
      return [
        P(box(0.05, 0.08, 0.36), "metal", [0, 0.03, 0.1]),
        P(cylZ(0.012, 0.012, 0.62, 8), "metal", [0, 0.05, 0.58]),
        P(cylZ(0.022, 0.022, 0.2, 10), "metalLight", [0, 0.11, 0.12]),
        P(box(0.035, 0.11, 0.05), "wood", [0, -0.05, 0], [0.25, 0, 0]),
        P(box(0.045, 0.09, 0.26), "wood", [0, 0.01, -0.22]),
      ];
    case "comet":
      return [
        P(cylZ(0.065, 0.065, 0.95, 12), "metal", [0, 0.08, 0.1]),
        P(cylZ(0.075, 0.07, 0.08, 12), "ivory", [0, 0.08, 0.58]),
        P(box(0.04, 0.12, 0.05), "metal", [0, -0.03, 0.0]),
      ];
    case "grenade":
      return [P(sph(0.045, 10, 8), "metal", [0, 0.02, 0.02]), P(cylZ(0.015, 0.015, 0.03, 6), "accent", [0, 0.07, 0.02], [H, 0, 0])];
    case "patchkit":
      return [P(box(0.12, 0.08, 0.16), "ivory", [0, 0.02, 0.04]), P(box(0.125, 0.02, 0.165), "accent", [0, 0.02, 0.04])];
    case "bubble":
      return [P(sph(0.05, 12, 10), "glass", [0, 0.03, 0.05]), P(torus(0.05, 0.006, 12), "brass", [0, 0.03, 0.05], [H, 0, 0])];
    case "radio":
      return [P(box(0.07, 0.13, 0.04), "metal", [0, 0.04, 0.02]), P(cylZ(0.004, 0.003, 0.16, 4), "metalLight", [0.025, 0.17, 0.02], [H, 0, 0])];
    case "tonic_small":
    case "tonic_large": {
      const s = id === "tonic_large" ? 1.3 : 1;
      return [
        P(new THREE.CylinderGeometry(0.03 * s, 0.035 * s, 0.09 * s, 10), "glass", [0, 0.03, 0.03]),
        P(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 8), "cord", [0, 0.09 * s, 0.03]),
      ];
    }
    default:
      return [];
  }
}

const built = new Map<string, THREE.Object3D | null>();

/** A fresh Object3D for this weapon id (shares geometry/materials with every other copy). */
export function weaponModel(id: string, palette: number): THREE.Object3D | null {
  const key = `${id}:${palette}`;
  let proto = built.get(key);
  if (proto === undefined) {
    proto = build(id, palette);
    built.set(key, proto);
  }
  return proto ? proto.clone() : null;
}

function build(id: string, palette: number): THREE.Object3D | null {
  const pieces = design(id);
  if (!pieces.length) return null;
  const g = new THREE.Group();
  g.name = `weapon:${id}`;
  const byMat = new Map<MatKey, THREE.BufferGeometry[]>();
  for (const p of pieces) {
    const geo = p.geo.index ? p.geo : p.geo;
    for (const name of Object.keys(geo.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") geo.deleteAttribute(name);
    (byMat.get(p.mat) ?? byMat.set(p.mat, []).get(p.mat)!).push(geo.index ? geo : geo);
  }
  for (const [k, geos] of byMat) {
    const merged = mergeGeometries(geos.map((x) => (x.index ? x : x)), false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat(k, palette));
    mesh.castShadow = k !== "blade";
    g.add(mesh);
  }
  if (id === "sunbrand") {
    // flame ribbon: two crossed, gently twisted strips around the core blade
    for (const rot of [0, Math.PI / 2]) {
      const geo = new THREE.PlaneGeometry(0.11, 0.78, 1, 12);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const tw = (y + 0.39) * 0.9;
        const x = pos.getX(i);
        pos.setXYZ(i, x * Math.cos(tw), y, x * Math.sin(tw));
      }
      geo.computeVertexNormals();
      geo.rotateX(H).rotateZ(rot).translate(0, 0, 0.57);
      const ribbon = new THREE.Mesh(geo, flameMaterial());
      ribbon.renderOrder = 2;
      g.add(ribbon);
    }
  }
  return g;
}
