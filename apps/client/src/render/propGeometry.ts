// Procedural low-poly prop meshes (no downloads): faceted geometry with vertex colours, two LODs per
// kind. Built per body so palettes can differ (rock colours, foliage tints).

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hash01, type BodyId, type PropKind } from "@firstlight/shared";

type Hex = number;

interface Palette {
  bark: Hex;
  leaf: Hex;
  leaf2: Hex;
  pine: Hex;
  rock: Hex;
  rock2: Hex;
  dead: Hex;
  reed: Hex;
  scrub: Hex;
  blossom: Hex;
  blossom2: Hex;
  spire: Hex[];
}

const PALETTES: Record<BodyId, Palette> = {
  portus: { bark: 0x6b4a2f, leaf: 0x5fae4a, leaf2: 0x8ccf5a, pine: 0x2e6b3a, rock: 0xc9b8a0, rock2: 0xe0d2bc, dead: 0x6a5a50, reed: 0x8a9a5a, scrub: 0x9a8a5a, blossom: 0xf6a8cc, blossom2: 0xfff0f6, spire: [0xc9b8a0] },
  arcadia: { bark: 0x6b4a2f, leaf: 0x3f9a3a, leaf2: 0x7cc84a, pine: 0x2a6a3c, rock: 0x7d8a80, rock2: 0xa3ada6, dead: 0x6a5a50, reed: 0x7a9a4a, scrub: 0x8a9a4a, blossom: 0xffd27a, blossom2: 0xfff0b0, spire: [0x7d8a80] },
  hollowmere: { bark: 0x4a3a40, leaf: 0x4f5a3c, leaf2: 0x6e6a4a, pine: 0x2f3a30, rock: 0x5a5068, rock2: 0x7a6e8c, dead: 0x5e5060, reed: 0x6b7a4a, scrub: 0x5a5a40, blossom: 0x9effd8, blossom2: 0xc8ffe8, spire: [0x5a5068] },
  meridian: { bark: 0x6a4a30, leaf: 0x8a8a4a, leaf2: 0xa89a5a, pine: 0x5a6a3a, rock: 0xa8452c, rock2: 0xc9663a, dead: 0x7a5a40, reed: 0x9a8a5a, scrub: 0x9a8048, blossom: 0xffc7a0, blossom2: 0xffe8d0, spire: [0xb24a2c, 0xd27a44, 0x8e3524, 0xe09a5a, 0xa5402a] },
};

const _c = new THREE.Color();

/** Prepare a primitive: non-indexed, no uv, a flat vertex colour with slight jitter, transformed. */
function part(geo: THREE.BufferGeometry, color: Hex, m: THREE.Matrix4, jitterSeed = 0, displace = 0): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  g.deleteAttribute("normal");
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  if (displace > 0) {
    // Position-keyed displacement keeps shared corners together (no cracks).
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const kx = Math.round(x * 1000), ky = Math.round(y * 1000), kz = Math.round(z * 1000);
      const d = (hash01(kx, ky, kz, jitterSeed) - 0.5) * 2 * displace;
      const l = Math.hypot(x, y, z) || 1;
      pos.setXYZ(i, x + (x / l) * d, y + (y / l) * d, z + (z / l) * d);
    }
  }
  g.applyMatrix4(m);
  const colors = new Float32Array(pos.count * 3);
  _c.setHex(color);
  for (let i = 0; i < pos.count; i += 3) {
    // One shade per face for a faceted, hand-painted look.
    const k = 0.9 + hash01(i, jitterSeed, 17) * 0.2;
    for (let j = 0; j < 3 && i + j < pos.count; j++) {
      colors[(i + j) * 3] = _c.r * k;
      colors[(i + j) * 3 + 1] = _c.g * k;
      colors[(i + j) * 3 + 2] = _c.b * k;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

const M = (x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0, ry = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function build(kind: PropKind, lod: 0 | 1, p: Palette, seed: number): THREE.BufferGeometry {
  const hi = lod === 0;
  switch (kind) {
    case "oak": {
      const parts = [part(new THREE.CylinderGeometry(0.18, 0.3, 2.8, hi ? 6 : 4), p.bark, M(0, 1.4, 0), seed)];
      if (hi) {
        parts.push(part(new THREE.IcosahedronGeometry(1.55, 1), p.leaf, M(0, 3.7, 0), seed + 1, 0.18));
        parts.push(part(new THREE.IcosahedronGeometry(1.15, 1), p.leaf2, M(0.95, 3.1, 0.35), seed + 2, 0.15));
        parts.push(part(new THREE.IcosahedronGeometry(1.2, 1), p.leaf, M(-0.75, 3.2, -0.5), seed + 3, 0.15));
      } else {
        parts.push(part(new THREE.IcosahedronGeometry(1.9, 0), p.leaf, M(0, 3.5, 0, 1, 0.9, 1), seed + 1));
      }
      return finish(parts);
    }
    case "pine": {
      const parts = [part(new THREE.CylinderGeometry(0.12, 0.22, 1.8, hi ? 5 : 4), p.bark, M(0, 0.9, 0), seed)];
      if (hi) {
        parts.push(part(new THREE.ConeGeometry(1.6, 2.6, 7), p.pine, M(0, 2.8, 0), seed + 1, 0.06));
        parts.push(part(new THREE.ConeGeometry(1.25, 2.3, 7), p.pine, M(0, 4.1, 0, 1, 1, 1, 0, 0, 0.4), seed + 2, 0.05));
        parts.push(part(new THREE.ConeGeometry(0.85, 2.0, 7), p.pine, M(0, 5.3, 0, 1, 1, 1, 0, 0, 0.8), seed + 3, 0.04));
      } else {
        parts.push(part(new THREE.ConeGeometry(1.6, 5.4, 5), p.pine, M(0, 3.9, 0), seed + 1));
      }
      return finish(parts);
    }
    case "bush": {
      if (!hi) return finish([part(new THREE.IcosahedronGeometry(0.75, 0), p.leaf, M(0, 0.45, 0, 1, 0.75, 1), seed)]);
      return finish([
        part(new THREE.IcosahedronGeometry(0.6, 1), p.leaf, M(0, 0.45, 0), seed, 0.08),
        part(new THREE.IcosahedronGeometry(0.45, 1), p.leaf2, M(0.45, 0.35, 0.2), seed + 1, 0.06),
        part(new THREE.IcosahedronGeometry(0.42, 1), p.leaf, M(-0.35, 0.32, -0.3), seed + 2, 0.06),
      ]);
    }
    case "rock":
      return finish([part(new THREE.IcosahedronGeometry(0.7, hi ? 1 : 0), p.rock, M(0, 0.18, 0, 1.1, 0.7, 0.9), seed, hi ? 0.14 : 0.08)]);
    case "boulder":
      return finish([
        part(new THREE.DodecahedronGeometry(1.6, hi ? 1 : 0), p.rock2, M(0, 0.6, 0, 1, 0.75, 1.1), seed, hi ? 0.28 : 0.15),
        ...(hi ? [part(new THREE.IcosahedronGeometry(0.6, 0), p.rock, M(1.3, 0.2, 0.6, 1, 0.7, 1), seed + 1, 0.1)] : []),
      ]);
    case "deadtree": {
      const trunk = new THREE.CylinderGeometry(0.1, 0.3, 4.6, hi ? 6 : 4, hi ? 6 : 2);
      // Twist the trunk.
      const tp = trunk.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < tp.count; i++) {
        const y = tp.getY(i);
        tp.setX(i, tp.getX(i) + Math.sin((y + 2.3) * 0.9) * 0.28);
        tp.setZ(i, tp.getZ(i) + Math.cos((y + 2.3) * 0.7) * 0.18);
      }
      const parts = [part(trunk, p.dead, M(0, 2.3, 0), seed)];
      const branches = hi ? 4 : 2;
      for (let b = 0; b < branches; b++) {
        const len = 1.4 + hash01(seed, b, 1) * 1.0;
        const ang = (b / branches) * Math.PI * 2 + hash01(seed, b, 2);
        const y = 2.4 + b * 0.55;
        const br = new THREE.CylinderGeometry(0.025, 0.08, len, hi ? 4 : 3);
        br.translate(0, len / 2, 0);
        const m = new THREE.Matrix4().makeRotationY(ang).multiply(new THREE.Matrix4().makeRotationZ(-0.9 - hash01(seed, b, 3) * 0.4));
        m.premultiply(new THREE.Matrix4().makeTranslation(Math.sin((y + 2.3) * 0.9) * 0.28 - 0.0, y, 0));
        parts.push(part(br, p.dead, m, seed + 10 + b));
      }
      return finish(parts);
    }
    case "reed": {
      const parts: THREE.BufferGeometry[] = [];
      const blades = hi ? 7 : 3;
      for (let b = 0; b < blades; b++) {
        const a = hash01(seed, b, 5) * Math.PI * 2, r = 0.08 + hash01(seed, b, 6) * 0.28;
        const h = 1.1 + hash01(seed, b, 7) * 0.7;
        const tilt = (hash01(seed, b, 8) - 0.5) * 0.35;
        const cone = new THREE.ConeGeometry(0.035, h, 3);
        cone.translate(0, h / 2, 0);
        parts.push(part(cone, p.reed, M(Math.cos(a) * r, 0, Math.sin(a) * r, 1, 1, 1, tilt, -tilt), seed + b));
        if (hi && b % 2 === 0) {
          parts.push(part(new THREE.CylinderGeometry(0.05, 0.05, 0.24, 4), 0x4a3020, M(Math.cos(a) * r - tilt * h * 0.85, h * 0.85, Math.sin(a) * r + tilt * h * 0.85 * 0, 1, 1, 1, tilt, -tilt), seed + b));
        }
      }
      return finish(parts);
    }
    case "scrub": {
      if (!hi) return finish([part(new THREE.IcosahedronGeometry(0.6, 0), p.scrub, M(0, 0.3, 0, 1, 0.6, 1), seed)]);
      return finish([
        part(new THREE.IcosahedronGeometry(0.5, 1), p.scrub, M(0, 0.32, 0, 1, 0.7, 1), seed, 0.1),
        part(new THREE.IcosahedronGeometry(0.38, 1), p.dead, M(0.4, 0.25, 0.15, 1, 0.7, 1), seed + 1, 0.08),
        part(new THREE.IcosahedronGeometry(0.35, 0), p.scrub, M(-0.3, 0.22, -0.25, 1, 0.7, 1), seed + 2),
      ]);
    }
    case "spire": {
      const segs = hi ? 7 : 3;
      const parts: THREE.BufferGeometry[] = [];
      // Stacked, slightly offset frusta with banded canyon colours.
      for (let s = 0; s < segs; s++) {
        const h = 15 / segs;
        const r0 = 1.8 - (s / segs) * 1.3, r1 = 1.8 - ((s + 1) / segs) * 1.3;
        const off = (hash01(seed, s, 9) - 0.5) * 0.25;
        parts.push(part(new THREE.CylinderGeometry(r1, r0, h, hi ? 6 : 4), p.spire[s % p.spire.length]!, M(off, h * s + h / 2, -off), seed + s, hi ? 0.05 : 0));
      }
      return finish(parts);
    }
    case "blossom": {
      const parts = [part(new THREE.CylinderGeometry(0.15, 0.25, 2.4, hi ? 6 : 4), p.bark, M(0, 1.2, 0), seed)];
      if (hi) {
        parts.push(part(new THREE.IcosahedronGeometry(1.35, 1), p.blossom, M(0, 3.2, 0), seed + 1, 0.16));
        parts.push(part(new THREE.IcosahedronGeometry(0.95, 1), p.blossom2, M(0.8, 2.7, 0.4), seed + 2, 0.12));
      } else {
        parts.push(part(new THREE.IcosahedronGeometry(1.6, 0), p.blossom, M(0, 3.0, 0), seed + 1));
      }
      return finish(parts);
    }
  }
}

export function propGeometry(body: BodyId, kind: PropKind, lod: 0 | 1): THREE.BufferGeometry {
  const g = build(kind, lod, PALETTES[body], 1000 + kind.length * 37 + lod);
  g.name = `${body}:${kind}:L${lod}`;
  return g;
}
