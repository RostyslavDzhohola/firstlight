# FIRSTLIGHT starter characters: Hexwick, Brother Ash, Kappa, Unit 7 on one shared skeleton.
#
#   blender -b --disable-autoexec --factory-startup --python build_characters.py -- \
#       --ual1 UAL1_Standard.glb --ubc Superhero_Male_FullBody.gltf --out <dir> [--preview <dir>]
#
# Base: Quaternius Universal Animation Library rig (CC0) + Universal Base Characters male body (CC0),
# fitted to the rig, restyled (new anime-leaning head, trimmed/recoloured, re-proportioned) and
# dressed in procedurally modelled outfits. Everything authored here is our own work (CC BY 4.0).

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector, Matrix  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

import fl_atlas as A  # noqa: E402
import fl_geo as G  # noqa: E402
import fl_rig as R  # noqa: E402
from fl_geo import Part, ring, smoothstep, lerp  # noqa: E402

V = Vector
X, Y, Z = V((1, 0, 0)), V((0, 1, 0)), V((0, 0, 1))

TORSO = {"pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r"}
UPPER = {"spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r"}
ARMS = {"upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"}
LEGS = {"thigh_l", "thigh_r", "calf_l", "calf_r"}
FEET = {"foot_l", "foot_r", "ball_l", "ball_r"}


def is_hand(d):
    return d is not None and (d.startswith("hand_") or any(d.startswith(f) for f in ("index", "middle", "ring", "pinky", "thumb")))


# ---------------------------------------------------------------------------------------------
# atlas


def build_atlas():
    at = A.Atlas()
    sw = at.swatch
    # skin and hair
    sw("skin_hex", "#efc4a0")
    sw("skin_ash", "#b07a52")
    sw("kappa_skin", "#6f8f3c")
    sw("kappa_skin_dark", "#56722e")
    sw("hair_hex", "#4b2f25")
    sw("hair_hex_hi", "#6b4433")
    # neutral palette-driven tiles (values multiply the palette colour)
    sw("prim", (0.92, 0.92, 0.92), "primary")
    sw("prim_light", (1.0, 1.0, 1.0), "primary")
    sw("prim_dark", (0.70, 0.70, 0.70), "primary")
    sw("sec", (0.92, 0.92, 0.92), "secondary")
    sw("sec_dark", (0.66, 0.66, 0.66), "secondary")
    sw("accent", (1.0, 1.0, 1.0), "accent")
    # fixed materials
    sw("leather", "#6b4428")
    sw("leather_dark", "#3a2a20")
    sw("boot", "#2c2420")
    sw("brass", "#c0913d")
    sw("brass_dark", "#8a6428")
    sw("straw", "#d8b866")
    sw("straw_dark", "#a8873f")
    sw("wood", "#7a5332")
    sw("gunmetal", "#3b4047")
    sw("gunmetal_light", "#5b636d")
    sw("quill", "#efe7d6")
    sw("ink", "#1b1f36")
    sw("cloth_dark", "#2b2d3a")
    sw("ash_trousers", "#4a3f36")
    sw("kappa_plastron", "#b4ab78")
    sw("kappa_beak", "#5e5a2c")
    sw("hood_inner", "#3a2f27")
    sw("cord", "#c9b48a")
    sw("lens_ring", "#24282e")
    # big tiles
    at.big("face_hex", "fixed", A.paint_face("#efc4a0", "#2f86a6", brow="#4b2f25"))
    at.big("face_ash", "fixed", A.paint_face("#b07a52", "#c7832c", brow="#2b1d16", mouth=False,
                                                eye_h=0.13, eye_y=0.52, blush=False))
    at.big("face_kappa", "fixed", A.paint_face("#6f8f3c", "#e0a526", brows=False, mouth=False, blush=False,
                                                  eye_w=0.15, eye_h=0.16, eye_y=0.55, eye_dx=0.2,
                                                  lash="#1d2410", sclera="#f4f0dc"))
    at.big("hex_robe", "primary", A.paint_constellation())
    at.big("ash_stripes", "secondary", A.paint_stripes())
    at.big("kappa_shell", "fixed", A.paint_stones())
    at.big("u7_plate", "primary", A.paint_seams())
    at.big("u7_plate07", "primary", A.paint_plate07())
    at.big("hex_cuff", "secondary", A.paint_ink_cuff())
    at.big("straw_weave", "fixed", A.paint_weave())
    at.big("kappa_plates", "fixed", lambda u, v, rng: _plastron(u, v))
    at.big("ash_cloth", "primary", lambda u, v, rng: _linen(u, v, rng))
    return at


def _plastron(u, v):
    import numpy as np
    base = np.array(A.hex_rgb("#b4ab78"), dtype=np.float32)
    out = np.zeros(u.shape + (3,), dtype=np.float32) + base
    line = np.zeros(u.shape, dtype=np.float32)
    for lv in (0.2, 0.4, 0.6, 0.8):
        line = np.maximum(line, np.clip(1 - np.abs(v - lv) / 0.012, 0, 1))
    line = np.maximum(line, np.clip(1 - np.abs(u - 0.5) / 0.01, 0, 1))
    out *= (1 - 0.45 * line)[..., None]
    out *= (0.92 + 0.08 * np.sin(v * 40))[..., None]
    return out


def _linen(u, v, rng):
    import numpy as np
    out = np.zeros(u.shape + (3,), dtype=np.float32) + 0.9
    weave = (np.sin(u * 300) * 0.5 + 0.5) * 0.04 + (np.sin(v * 300) * 0.5 + 0.5) * 0.04
    out -= weave[..., None]
    out *= (1 + (rng.random(u.shape + (1,)) - 0.5) * 0.05)
    return out


# ---------------------------------------------------------------------------------------------
# helpers using the fitted body


class Ctx:
    def __init__(self, rig, body, atlas):
        self.rig = rig
        self.body = body
        self.atlas = atlas
        self.B = R.Bones(rig)
        self.bw = R.BodyWeights(body)
        self.info = R.vertex_info(body)
        me = body.data
        self.bvh_all = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in me.polygons])
        doms = [d for (_, _, _, d) in self.info]
        torso_polys = [p.vertices[:] for p in me.polygons if all(doms[i] in TORSO for i in p.vertices)]
        self.bvh_torso = BVHTree.FromPolygons([v.co for v in me.vertices], torso_polys)

    def obj(self, part, weights):
        ob = G.part_to_object(part, self.atlas)
        if weights == "body":
            R.set_weights(ob, lambda co: self.bw(co))
        elif isinstance(weights, str):
            R.set_weights(ob, R.rigid(weights))
        else:
            R.set_weights(ob, weights)
        return ob

    def surface(self, p, off, torso=True):
        """Nearest point on the body (torso only by default) pushed out along the normal."""
        bvh = self.bvh_torso if torso else self.bvh_all
        loc, nrm, idx, dist = bvh.find_nearest(p)
        if loc is None:
            return p
        return loc + nrm * off

    def chain(self, *names):
        return [(n, self.B.head(n), self.B.tail(n)) for n in names]

    def section(self, z, doms=TORSO | LEGS, dz=0.03):
        pts = [co for (co, n, w, d) in self.info if d in doms and abs(co.z - z) < dz]
        if not pts:
            return (0.1, -0.1, 0.1)
        return (max(abs(p.x) for p in pts), min(p.y for p in pts), max(p.y for p in pts))


def body_copy(ctx, name, keep=None):
    ob = R.dup(ctx.body, name)
    if keep:
        R.keep_faces(ob, keep)
    return ob


def boots(ctx, body, top=0.3, tile="boot", cuff_tile=None, objs=None, width=1.0):
    """Replace the bare feet with modelled boots: a rounded sole/toe block on each foot and a shaft
    up to `top`. The body's feet (and the calf inside the shaft) are removed."""
    R.keep_faces(body, lambda c, n, doms: not (all(d in FEET for d in doms) or
                                                (all(d in FEET | {"calf_l", "calf_r"} for d in doms) and c.z < top - 0.04)))
    for s, side in ((1, "l"), (-1, "r")):
        fx = 0.089 * s
        shoe = G.superellipsoid(f"boot_{side}", V((fx + 0.004 * s, -0.045, 0.058)), (0.056 * width, 0.128, 0.06), 0.45,
                                0.75, 14, 8, tile,
                                deform=lambda q, th, t: q + V((0, 0, -q.z * 0.25 if q.z < 0 else 0)))
        sole = G.superellipsoid("sole", V((fx + 0.004 * s, -0.045, 0.012)), (0.06 * width, 0.132, 0.012), 0.3, 0.75, 14, 3,
                                "leather_dark")
        shoe.extend(sole)
        a = ctx.B.head(f"foot_{side}")
        shaft = G.loft("shaft", [ring((fx, 0.03, 0.07), X, Y, 0.06 * width, 0.068), ring((fx, 0.03, 0.16), X, Y, 0.06 * width, 0.062),
                                 ring((fx, 0.025, top - 0.02), X, Y, 0.066 * width, 0.068),
                                 ring((fx, 0.025, top + 0.005), X, Y, 0.072 * width, 0.074)], 14, cuff_tile or tile)
        if cuff_tile:
            shaft.retile(lambda q: q.z < top - 0.03, tile)
        objs.append(ctx.obj(shoe, lambda co, side=side: {f"ball_{side}": smoothstep(-0.09, -0.13, co.y),
                                                         f"foot_{side}": 1 - smoothstep(-0.09, -0.13, co.y)}))
        objs.append(ctx.obj(shaft, lambda co, side=side: {f"calf_{side}": smoothstep(0.08, 0.16, co.z),
                                                          f"foot_{side}": 1 - smoothstep(0.08, 0.16, co.z)}))


def shell(ctx, name, keep, off, tile_fn, uv_fn=None, thick=None, smooth=12):
    """A garment/armour piece cut from the body surface and pushed outwards (keeps body weights)."""
    ob = body_copy(ctx, name, keep)
    if len(ob.data.polygons) == 0:
        bpy.data.objects.remove(ob)
        return None
    R.smooth_boundary(ob, 8)
    if smooth:
        R.smooth_verts(ob, lambda co, d: True, 0.5, smooth)
    R.offset(ob, off)
    if thick:
        R.solidify(ob, thick, offset_=1.0)
    R.tile_object(ob, ctx.atlas, tile_fn, uv_fn)
    return ob


def cyl_uv(cz, h, cy=0.0):
    def fn(co, tname):
        u = (math.atan2(co.y - cy, co.x) / math.tau) % 1.0
        return (u, (co.z - cz) / h + 0.5)
    return fn


def band(ctx, name, loop, across, half_w, off, tile, closed=True, n_across=2, torso=True, uv=True):
    """A strap/belt/wrap lying on the body: loop = points along the band centre, across = function
    i -> unit vector across the band."""
    p = Part(name, tile)
    rows = []
    for i, c in enumerate(loop):
        a = across(i)
        row = []
        for j in range(n_across + 1):
            t = -1 + 2 * j / n_across
            q = ctx.surface(c + a * (half_w * t), off, torso)
            row.append(p.v(q))
        rows.append(row)
    nl = len(loop)
    segs = nl if closed else nl - 1
    a0, a1, b0 = p.verts[rows[0][0]], p.verts[rows[1][0]], p.verts[rows[0][1]]
    loc, sn, _, _ = (ctx.bvh_torso if torso else ctx.bvh_all).find_nearest(a0)
    flip = sn is not None and (a1 - a0).cross(b0 - a0).dot(sn) > 0
    for i in range(segs):
        i1 = (i + 1) % nl
        for j in range(n_across):
            uvs = None
            if uv:
                uvs = [(i / segs, j / n_across), ((i + 1) / segs, j / n_across), ((i + 1) / segs, (j + 1) / n_across),
                       (i / segs, (j + 1) / n_across)]
            idx = (rows[i][j], rows[i1][j], rows[i1][j + 1], rows[i][j + 1])
            if flip:
                idx = tuple(reversed(idx))
                uvs = list(reversed(uvs)) if uvs else None
            p.f(idx, uvs=uvs)
    return p


def ellipse_loop(c, ax, ay, rx, ry, n):
    return [c + ax * (rx * math.cos(math.tau * i / n)) + ay * (ry * math.sin(math.tau * i / n)) for i in range(n)]


# ---------------------------------------------------------------------------------------------
# the anime-leaning head


HEAD_C = V((0.0, 0.004, 1.705))
FACE = dict(x0=-0.105, x1=0.105, z0=1.585, z1=1.795)


def head_part(ctx, face_tile, skin_tile, r=(0.102, 0.112, 0.125), ears=True, kappa=False):
    rx, ry, rz = r

    def deform(q, th, t):
        q = q.copy()
        if q.z < 0:
            f = -q.z / rz
            q.x *= 1 - 0.40 * f ** 1.6
            if q.y > 0:
                q.y *= 1 - 0.55 * f ** 1.3
            q.y -= 0.055 * f ** 1.6
            if kappa:
                q.x *= 1 + 0.12 * f
        else:
            f = q.z / rz
            q.y *= 1 + 0.06 * f  # slightly longer skull towards the back-top
        if q.y < 0 and abs(q.z) < 0.7 * rz:
            q.y *= 0.93  # flatter face plane
        return q

    p = G.superellipsoid("head", HEAD_C, (rx, ry, rz), 1.0, 1.0, 24, 16, skin_tile, deform=deform)

    # front projection for the painted face
    fw, fh = FACE["x1"] - FACE["x0"], FACE["z1"] - FACE["z0"]
    for fi, f in enumerate(p.faces):
        c = sum((p.verts[i] for i in f), V()) / len(f)
        if c.y < HEAD_C.y - 0.035 and FACE["x0"] < c.x < FACE["x1"] and FACE["z0"] < c.z < FACE["z1"]:
            p.ftile[fi] = face_tile
            p.fuv[fi] = [((p.verts[i].x - FACE["x0"]) / fw, (p.verts[i].z - FACE["z0"]) / fh) for i in f]
    parts = [p]
    if ears:
        for s in (1, -1):
            e = G.superellipsoid("ear", HEAD_C + V((s * (rx - 0.004), 0.012, -0.022)), (0.014, 0.022, 0.03), 0.8, 0.8,
                                 8, 6, skin_tile)
            parts.append(e)
    whole = parts[0]
    for q in parts[1:]:
        whole.extend(q)
    return whole


def head_weights(ctx):
    neck = ctx.B.head("Head").z

    def fn(co):
        t = smoothstep(neck - 0.03, neck + 0.03, co.z)
        return {"Head": t, "neck_01": 1 - t}
    return fn


# ---------------------------------------------------------------------------------------------
# character recipes


def hexwick(ctx):
    B, at = ctx.B, ctx.atlas
    objs = []
    # body: hands, neck and legs stay (legs become trousers + boots); torso and arms are covered.
    def keep(c, n, doms):
        if all(d in UPPER for d in doms):
            return False
        if all(d in ARMS for d in doms) and abs(c.x) < 0.66:
            return False
        return True
    body = body_copy(ctx, "hex_body", keep)
    boots(ctx, body, 0.3, "boot", "leather", objs)
    R.tile_object(body, at, lambda c, n: "boot" if c.z < 0.3 else ("cloth_dark" if c.z < 1.1 and abs(c.x) < 0.4 else "skin_hex"))
    objs.append(body)

    # robe upper: torso shell
    def keep_t(c, n, doms):
        return all(d in TORSO for d in doms) and 0.97 < c.z < 1.50
    up = shell(ctx, "hex_robe_top", keep_t, 0.02, lambda c, n: "hex_robe", cyl_uv(1.2, 0.7))
    objs.append(up)

    # robe skirt: open at the front, flaring to the ankles; silver trim on the hem and the opening
    rings = []
    zs = [1.04, 0.95, 0.82, 0.66, 0.5, 0.34, 0.2, 0.13]
    for i, z in enumerate(zs):
        t = i / (len(zs) - 1)
        sx, symin, symax = ctx.section(z)
        rx = max(sx + 0.035, lerp(0.19, 0.34, t ** 1.1))
        ry = lerp(0.135, 0.27, t ** 1.1)
        gap = lerp(0.03, 0.11, smoothstep(0.1, 1.0, t))
        rings.append(ring((0, 0.02, z), X, Y, rx, ry, arc=(0.75 + gap / 2, 1.75 - gap / 2)))
    skirt = G.loft("hex_skirt", rings, 26, "hex_robe", closed=False, uv_rect=(0, 0, 1, 1))
    n = 26
    for fi in range(len(skirt.faces)):
        ri, k = divmod(fi, n)
        if ri >= len(zs) - 2 or k in (0, n - 1):
            skirt.ftile[fi] = "sec"
            skirt.fuv[fi] = None

    def skirt_w(co):
        side = "thigh_l" if co.x > 0 else "thigh_r"
        t = smoothstep(1.0, 0.45, co.z)
        a = smoothstep(0.02, 0.14, abs(co.x)) * (0.9 if co.y < 0.05 else 0.55)
        wt = a * t
        return {side: wt, "pelvis": 1 - wt}
    objs.append(ctx.obj(skirt, skirt_w))

    # bell sleeves
    for s, side in ((1, "l"), (-1, "r")):
        sh, wr = B.head(f"upperarm_{side}"), B.head(f"hand_{side}")
        xs = [0.13, 0.22, 0.34, 0.47, 0.58, 0.68, 0.75, 0.79]
        rads = [0.085, 0.078, 0.07, 0.066, 0.075, 0.095, 0.115, 0.125]
        rr = []
        for x, r0 in zip(xs, rads):
            droop = smoothstep(0.5, 0.8, x)
            c = V((s * x, sh.y, lerp(sh.z, wr.z, (x - 0.13) / 0.66) - 0.025 * droop))
            rr.append(ring(c, Z, Y, r0 * (1 + 0.25 * droop), r0,
                           off=lambda th, d=droop: V((0, 0, -0.035 * d * max(0.0, -math.cos(th))))))
        sl = G.loft(f"hex_sleeve_{side}", rr, 14, "hex_robe", uv_rect=(0, 0, 1, 0.5))
        for fi in range(len(sl.faces)):
            ri = fi // 14
            if ri >= len(xs) - 3:
                sl.ftile[fi] = "hex_cuff"
        objs.append(ctx.obj(sl, R.chain_weights(ctx.chain(f"clavicle_{side}", f"upperarm_{side}", f"lowerarm_{side}"), 0.07)))

    # belt with a small buckle
    zb = 1.03
    sx, ymin, ymax = ctx.section(zb)
    belt = G.loft("hex_belt", [ring((0, 0.02, zb - 0.025), X, Y, 0.2, 0.142), ring((0, 0.02, zb + 0.025), X, Y, 0.198, 0.14)],
                  24, "leather")
    objs.append(ctx.obj(belt, "pelvis"))
    buckle = G.superellipsoid("buckle", (0, -0.125, zb), (0.025, 0.008, 0.02), 0.3, 0.3, 8, 4, "sec")
    objs.append(ctx.obj(buckle, "pelvis"))

    # scarf: neck wrap + one long tail trailing down the back
    nk = B.head("neck_01")
    wrap = G.loft("hex_scarf", [ring((0, 0.015, 1.445), X, Y, 0.1, 0.095), ring((0, 0.012, 1.485), X, Y, 0.108, 0.1),
                                ring((0, 0.008, 1.525), X, Y, 0.09, 0.085), ring((0, 0.008, 1.55), X, Y, 0.075, 0.07)],
                  18, "prim_light")
    objs.append(ctx.obj(wrap, lambda co: {"neck_01": 0.6, "spine_03": 0.4}))
    tail_pts = [V((0.05, 0.085, 1.47)), V((0.07, 0.15, 1.36)), V((0.075, 0.18, 1.18)), V((0.07, 0.21, 0.98)),
                V((0.06, 0.25, 0.8)), V((0.05, 0.29, 0.66))]
    tail = G.tube("hex_scarf_tail", tail_pts, [0.06, 0.062, 0.064, 0.064, 0.062, 0.06], 6, "prim_light", up=Y, ry_scale=0.18)
    objs.append(ctx.obj(tail, R.chain_weights(ctx.chain("pelvis", "spine_01", "spine_02", "spine_03"), 0.08)))
    clasp = G.superellipsoid("clasp", (0.03, -0.1, 1.475), (0.016, 0.008, 0.016), 0.6, 0.6, 8, 4, "accent")
    objs.append(ctx.obj(clasp, "spine_03"))

    # satchel on the right hip with a strap over the left shoulder and quills poking out
    sc = V((-0.25, 0.03, 0.9))
    bag = G.superellipsoid("satchel", sc, (0.04, 0.1, 0.08), 0.35, 0.3, 12, 6, "leather")
    flap = G.superellipsoid("flap", sc + V((-0.012, 0, 0.03)), (0.032, 0.104, 0.055), 0.35, 0.3, 12, 4, "leather_dark",
                            vrange=(0.5, 1.0))
    bag.extend(flap)
    for i, (dy, dz, ang) in enumerate(((-0.05, 0.0, 0.25), (-0.015, 0.01, 0.1), (0.025, 0.0, -0.12), (0.06, -0.01, -0.3))):
        base = sc + V((0.0, dy, 0.05 + dz))
        tip = base + V((-0.03, 0.07 * ang + 0.02, 0.17 + 0.02 * i))
        q = G.tube("quill", [base, base.lerp(tip, 0.5), tip], [0.004, 0.004, 0.002], 4, "quill", cap0=False)
        vane = G.superellipsoid("vane", base.lerp(tip, 0.72), (0.004, 0.018, 0.05), 1.0, 1.0, 6, 4, "quill",
                                frame=G.frame_from_dir(tip - base, X))
        bag.extend(q).extend(vane)
    objs.append(ctx.obj(bag, "pelvis"))
    strap_pts = []
    a0, a1 = V((0.12, -0.02, 1.50)), V((-0.22, -0.03, 0.97))
    for i in range(9):
        strap_pts.append(a0.lerp(a1, i / 8))
    back = [V((-0.22, 0.12, 0.98)).lerp(V((0.12, 0.08, 1.5)), i / 8) for i in range(9)]
    loop = strap_pts + back[1:-1]
    across = lambda i: V((0.55, 0.0, 0.83)).normalized() if i < 9 else V((-0.55, 0.0, 0.83)).normalized()
    st = band(ctx, "strap", loop, across, 0.022, 0.032, "leather_dark", closed=True, uv=False)
    objs.append(ctx.obj(st, "body"))

    # head + clumped hair
    hd = head_part(ctx, "face_hex", "skin_hex")
    objs.append(ctx.obj(hd, head_weights(ctx)))
    objs.append(ctx.obj(hex_hair(), "Head"))
    return objs


def hex_hair():
    c = HEAD_C
    cap = G.superellipsoid("hair_cap", c + V((0, 0.006, 0.006)), (0.112, 0.124, 0.134), 1.0, 1.0, 22, 12, "hair_hex",
                           vrange=(0.36, 1.0))
    cap.keep_faces(lambda q: q.z > 1.775 or (q.y > c.y - 0.01 and q.z > 1.6) or (abs(q.x) > 0.085 and q.z > 1.7))
    hair = cap

    def clump(root, d, L, w, th, bend=V(), tile="hair_hex"):
        d = d.normalized()
        nrm = (root - c).normalized()
        xax = d.cross(nrm)
        if xax.length < 1e-4:
            xax = X.copy()
        xax.normalize()
        yax = xax.cross(d).normalized()
        rs = []
        for i, s in enumerate((0.0, 0.3, 0.62, 0.88)):
            ctr = root + d * (L * s) + bend * (L * s * s)
            k = (1 - s) ** 0.7
            rs.append(ring(ctr, xax, yax, w * k + 0.002, th * k + 0.001))
        tip = root + d * L + bend * L
        rs.append(ring(tip, xax, yax, 0.001, 0.001))
        return G.loft("clump", rs, 5, tile, cap0=False)

    import random
    rnd = random.Random(11)
    # fringe over the forehead, swept to the character's right
    for i, a in enumerate((-58, -36, -16, 4, 22, 42, 60)):
        ar = math.radians(a)
        root = c + V((math.sin(ar) * 0.1, -math.cos(ar) * 0.1, 0.085))
        d = V((math.sin(ar) * 0.35 - 0.25, -0.55, -1.0))
        hair.extend(clump(root, d, 0.12 + 0.02 * rnd.random(), 0.026, 0.01, V((0, -0.02, 0)),
                          "hair_hex_hi" if i % 3 == 1 else "hair_hex"))
    # sides over the ears
    for s in (1, -1):
        for a, L in ((80, 0.15), (105, 0.16)):
            ar = math.radians(a)
            root = c + V((s * math.sin(ar) * 0.11, -math.cos(ar) * 0.11, 0.06))
            hair.extend(clump(root, V((s * 0.25, 0.05, -1)), L, 0.03, 0.011, V((s * 0.03, 0, 0))))
    # back, flaring at the nape
    for a in (130, 155, 180, 205, 230):
        ar = math.radians(a)
        root = c + V((math.sin(ar) * 0.11, -math.cos(ar) * 0.115, 0.07))
        out = V((math.sin(ar), -math.cos(ar), 0)) * 0.35
        hair.extend(clump(root, out + V((0, 0.1, -1)), 0.18 + 0.02 * rnd.random(), 0.034, 0.012, out * 0.12))
    # messy crown spikes and one stray strand
    for a, el in ((150, 0.3), (190, 0.4), (215, 0.2)):
        ar = math.radians(a)
        root = c + V((math.sin(ar) * 0.06, -math.cos(ar) * 0.06, 0.13))
        hair.extend(clump(root, V((math.sin(ar) * 0.6, -math.cos(ar) * 0.9, el)), 0.1, 0.028, 0.01, V((0, 0, -0.04))))
    hair.extend(clump(c + V((0.02, -0.02, 0.138)), V((0.2, -0.6, 0.8)), 0.08, 0.008, 0.005, V((0, 0.05, -0.02))))
    return hair


def brother_ash(ctx):
    B, at = ctx.B, ctx.atlas
    objs = []

    def keep(c, n, doms):
        if all(d in UPPER for d in doms):
            return False
        if all(d in ARMS for d in doms) and abs(c.x) < 0.42:
            return False
        return True
    body = body_copy(ctx, "ash_body", keep)
    boots(ctx, body, 0.13, "leather_dark", None, objs)
    # forearm and shin wraps sit slightly proud of the skin
    R.offset(body, lambda co, n: 0.009 if (0.42 < abs(co.x) < 0.72 and co.z > 1.2) or (co.z < 0.34 and co.z > 0.12) else 0.0)
    R.tile_object(body, at, lambda c, n: ("leather_dark" if c.z < 0.12 else "ash_stripes" if c.z < 0.34 else
                                          "ash_trousers" if c.z < 1.15 else
                                          "ash_stripes" if 0.42 < abs(c.x) < 0.72 else "skin_ash"),
                  lambda co, t: ((co.x * 4) % 1.0, (co.z * 3) % 1.0) if t == "ash_stripes" else None)
    objs.append(body)

    def keep_t(c, n, doms):
        return all(d in TORSO for d in doms) and 0.97 < c.z < 1.50
    objs.append(shell(ctx, "ash_tunic", keep_t, 0.022, lambda c, n: "ash_cloth", cyl_uv(1.2, 0.8)))

    # robe skirt: front and back panels with side slits, umber hem
    zs = [1.04, 0.92, 0.78, 0.62, 0.48, 0.36, 0.3]
    for panel, base in (("front", 0.5), ("back", 0.0)):
        rr = []
        for i, z in enumerate(zs):
            t = i / (len(zs) - 1)
            sx, _, _ = ctx.section(z)
            rx = max(sx + 0.035, lerp(0.2, 0.3, t))
            ry = lerp(0.14, 0.22, t)
            s = lerp(-0.02, 0.06, smoothstep(0.35, 1.0, t))
            rr.append(ring((0, 0.02, z), X, Y, rx, ry, arc=(base + s, base + 0.5 - s)))
        sk = G.loft(f"ash_skirt_{panel}", rr, 12, "ash_cloth", closed=False, uv_rect=(0, 0, 1, 1))
        for fi in range(len(sk.faces)):
            if fi // 12 >= len(zs) - 2:
                sk.ftile[fi] = "sec_dark"
                sk.fuv[fi] = None

        def skirt_w(co):
            side = "thigh_l" if co.x > 0 else "thigh_r"
            t = smoothstep(1.0, 0.5, co.z)
            a = smoothstep(0.03, 0.15, abs(co.x)) * (0.85 if co.y < 0.05 else 0.5)
            return {side: a * t, "pelvis": 1 - a * t}
        objs.append(ctx.obj(sk, skirt_w))

    # loose upper sleeves to just past the elbow
    for s, side in ((1, "l"), (-1, "r")):
        sh = B.head(f"upperarm_{side}")
        xs = [0.13, 0.24, 0.36, 0.46, 0.53]
        rads = [0.088, 0.08, 0.075, 0.078, 0.088]
        rr = [ring(V((s * x, sh.y, sh.z - 0.01 * (x - 0.13))), Z, Y, r0, r0 * 0.95) for x, r0 in zip(xs, rads)]
        sl = G.loft(f"ash_sleeve_{side}", rr, 12, "ash_cloth", uv_rect=(0, 0, 0.5, 0.4))
        objs.append(ctx.obj(sl, R.chain_weights(ctx.chain(f"clavicle_{side}", f"upperarm_{side}", f"lowerarm_{side}"), 0.07)))

    # deep asymmetric hood, opening at the face, draping lower on the left shoulder
    hz = [1.40, 1.47, 1.55, 1.64, 1.73, 1.80, 1.86, 1.9]
    hr = [(0.225, 0.19), (0.18, 0.165), (0.162, 0.168), (0.16, 0.175), (0.152, 0.172), (0.13, 0.155), (0.088, 0.118),
          (0.022, 0.034)]
    gaps = [0.0, 0.1, 0.2, 0.21, 0.19, 0.1, 0.0, 0.0]
    rr = []
    for i, (z, (rx, ry), g) in enumerate(zip(hz, hr, gaps)):
        def off(th, i=i, z=z):
            o = V()
            front = max(0.0, -math.sin(th))
            if 2 <= i <= 5:
                o.y -= 0.075 * front ** 0.7  # deep hood peak reaching past the face
            if i == 5:
                o.z -= 0.045 * front
                o.y -= 0.03 * front
            if i <= 1:
                left = max(0.0, math.cos(th))
                o.z -= 0.07 * left ** 2  # drapes onto the left shoulder
                o.x += 0.03 * left ** 2
            return o
        cy = 0.03 if i < 6 else 0.06
        rr.append(ring((0, cy, z), X, Y, rx, ry, arc=(0.75 + g / 2, 1.75 - g / 2), off=off))
    hood = G.loft("ash_hood", rr, 20, "ash_cloth", closed=False, uv_rect=(0, 0, 1, 0.8))
    for fi in range(len(hood.faces)):
        ri, k = divmod(fi, 20)
        if (k in (0, 19) and 1 <= ri <= 5) or ri == 0:
            hood.ftile[fi] = "sec_dark"
            hood.fuv[fi] = None

    def hood_w(co):
        t = smoothstep(1.47, 1.6, co.z)
        side = "clavicle_l" if co.x > 0 else "clavicle_r"
        low = 1 - t
        return {"Head": t * 0.85, "neck_01": t * 0.15 + low * 0.3, "spine_03": low * 0.5, side: low * 0.2}
    objs.append(ctx.obj(hood, hood_w))

    # striped shoulder wrap: over the left shoulder, under the right arm (woven sun-and-ash stripes)
    nrm = V((-math.sin(math.radians(38)), 0.0, math.cos(math.radians(38))))
    ax = nrm.cross(Y).normalized()
    loop = ellipse_loop(V((0.0, 0.015, 1.24)), ax, Y, 0.3, 0.2, 28)
    wrap = band(ctx, "ash_wrap", loop, lambda i: nrm, 0.085, 0.045, "ash_stripes", closed=True, n_across=3)
    objs.append(ctx.obj(wrap, "body"))

    # belt with brass rings
    belt = G.loft("ash_belt", [ring((0, 0.02, 1.0), X, Y, 0.205, 0.148), ring((0, 0.02, 1.055), X, Y, 0.2, 0.145)], 24,
                  "leather")
    for s in (1, -1):
        belt.extend(G.disc("ring", (s * 0.12, -0.14, 1.028), V((s * 0.4, -1, 0)), 0.022, 10, "brass", inner=0.014))
    objs.append(ctx.obj(belt, "pelvis"))

    # prayer beads on the chest
    beads = Part("beads", "brass")
    pts = []
    for i in range(15):
        a = math.pi * (0.08 + 0.84 * i / 14)
        p0 = V((math.cos(a) * 0.1, -0.0, 1.47 - math.sin(a) * 0.24))
        pts.append(ctx.surface(p0 + V((0, -0.2, 0)), 0.03))
    for i, q in enumerate(pts):
        big = i == 7
        r0 = 0.02 if big else 0.012
        beads.extend(G.superellipsoid("bead", q, (r0, r0 * 0.8, r0), 1.0, 1.0, 6 if not big else 8, 4,
                                      "brass_dark" if i % 2 else "brass"))
    objs.append(ctx.obj(beads, "body"))

    # head with eyes in the hood's shadow and a brass face-guard
    hd = head_part(ctx, "face_ash", "skin_ash")
    objs.append(ctx.obj(hd, head_weights(ctx)))
    guard = head_part(ctx, "brass", "brass", r=(0.109, 0.121, 0.13), ears=False)
    guard.ftile = ["brass"] * len(guard.faces)
    guard.fuv = [None] * len(guard.faces)
    eye_z = FACE["z0"] + 0.47 * (FACE["z1"] - FACE["z0"])
    guard.keep_faces(lambda q: q.y < HEAD_C.y - 0.045 and q.z < eye_z - 0.03 and q.z > 1.56)
    guard.retile(lambda q: abs(q.x) < 0.012 or abs(q.z - (eye_z - 0.075)) < 0.006, "brass_dark")
    objs.append(ctx.obj(guard, "Head"))
    return objs


def kappa(ctx):
    B, at = ctx.B, ctx.atlas
    objs = []
    body = body_copy(ctx, "kappa_body", None)

    # squat and solid: thicker limbs and a round belly
    def fat(co, n):
        d = 0.012
        if co.z > 0.9 and co.z < 1.4 and co.y < 0.05 and abs(co.x) < 0.2:
            d += 0.035 * math.sin(math.pi * (co.z - 0.9) / 0.5) * smoothstep(0.2, 0.0, abs(co.x))
        return d
    R.offset(body, fat)
    R.offset(body, lambda co, n: 0.008 if (0.42 < abs(co.x) < 0.7 and co.z > 1.2) or (0.12 < co.z < 0.36) else 0.0)
    def kt(c, n):
        if 0.42 < abs(c.x) < 0.7 and c.z > 1.2:
            return "sec"
        if 0.12 < c.z < 0.36:
            return "sec"
        return "kappa_skin"
    R.tile_object(body, at, kt)
    objs.append(body)

    # plastron (front shell) with plate lines
    def keep_p(c, n, doms):
        return all(d in TORSO for d in doms) and 0.98 < c.z < 1.42 and c.y < -0.02 and abs(c.x) < 0.17

    def pl_uv(co, t):
        return (0.5 + co.x / 0.34, (co.z - 0.98) / 0.44)
    pl = shell(ctx, "plastron", keep_p, 0.05, lambda c, n: "kappa_plates", pl_uv, thick=0.012)
    objs.append(pl)

    # carapace: a domed, river-stone shell on the back with a palette-coloured rim
    cc = V((0.0, 0.11, 1.19))

    def dome(q, th, t):
        q = q.copy()
        if q.y < 0:
            q.y *= 0.15
        return q
    shell_p = G.superellipsoid("carapace", cc, (0.25, 0.33, 0.19), 0.9, 0.9, 20, 14, "kappa_shell",
                               frame=(X, Z, Y), uv_rect=(0, 0, 1, 1))
    # frame=(X, Z, Y) maps local (x, y, z) -> world (x, z, y): local z is the depth axis (back)
    shell_p.keep_faces(lambda q: q.y > cc.y - 0.01)
    rim = G.loft("rim", [ring(cc + V((0, 0.0, 0)), X, Z, 0.262, 0.342), ring(cc + V((0, 0.03, 0)), X, Z, 0.262, 0.342),
                         ring(cc + V((0, 0.045, 0)), X, Z, 0.24, 0.32)], 28, "prim")
    shell_p.extend(rim)
    objs.append(ctx.obj(shell_p, R.chain_weights(ctx.chain("spine_01", "spine_02", "spine_03"), 0.1)))

    # short hakama-like wrap and a sash
    zs = [1.05, 0.95, 0.85, 0.74]
    rr = []
    for i, z in enumerate(zs):
        sx, _, _ = ctx.section(z)
        rr.append(ring((0, 0.02, z), X, Y, max(sx + 0.04, 0.2 + 0.03 * i), 0.15 + 0.025 * i))
    sk = G.loft("kappa_wrap", rr, 22, "sec_dark")

    def sk_w(co):
        side = "thigh_l" if co.x > 0 else "thigh_r"
        t = smoothstep(1.0, 0.75, co.z)
        a = smoothstep(0.02, 0.12, abs(co.x)) * 0.8
        return {side: a * t, "pelvis": 1 - a * t}
    objs.append(ctx.obj(sk, sk_w))
    sash = G.loft("sash", [ring((0, 0.02, 1.0), X, Y, 0.235, 0.17), ring((0, 0.02, 1.07), X, Y, 0.23, 0.165)], 22, "sec")
    knot = G.superellipsoid("knot", (0.09, -0.16, 1.03), (0.03, 0.02, 0.03), 0.8, 0.8, 8, 5, "sec")
    sash.extend(knot)
    for dx in (0.07, 0.11):
        sash.extend(G.tube("tail", [V((dx, -0.17, 1.02)), V((dx + 0.01, -0.18, 0.9))], [0.016, 0.014], 4, "sec",
                           ry_scale=0.3))
    objs.append(ctx.obj(sash, "pelvis"))

    # head: wide, beaked, big round eyes
    hd = head_part(ctx, "face_kappa", "kappa_skin", r=(0.112, 0.116, 0.122), ears=False, kappa=True)
    objs.append(ctx.obj(hd, head_weights(ctx)))
    beak = G.superellipsoid("beak", HEAD_C + V((0, -0.112, -0.062)), (0.036, 0.04, 0.02), 0.8, 0.9, 12, 6, "kappa_beak",
                            deform=lambda q, th, t: q + V((0, 0, -0.35 * max(0.0, -q.y) * (1 if q.y < 0 else 0))))
    low = G.superellipsoid("beak_low", HEAD_C + V((0, -0.1, -0.088)), (0.028, 0.03, 0.011), 0.8, 0.9, 10, 4,
                           "kappa_beak")
    beak.extend(low)
    objs.append(ctx.obj(beak, "Head"))

    # wide straw kasa with a palette band, tilted a little forward
    hat = Part("kasa", "straw_weave")
    rs = [ring((0, 0, 1.975), X, Y, 0.012, 0.012), ring((0, 0, 1.955), X, Y, 0.07, 0.07),
          ring((0, 0, 1.9), X, Y, 0.18, 0.18), ring((0, 0, 1.845), X, Y, 0.3, 0.3), ring((0, 0, 1.83), X, Y, 0.35, 0.35)]
    cone = G.loft("cone", rs, 28, "straw_weave", cap0=True, uv_rect=(0, 0, 1, 1))
    hat.extend(cone)
    hb = G.loft("band", [ring((0, 0, 1.795), X, Y, 0.112, 0.118), ring((0, 0, 1.85), X, Y, 0.1, 0.106),
                         ring((0, 0, 1.87), X, Y, 0.085, 0.09)], 20, "prim")
    knob = G.superellipsoid("knob", (0, 0, 1.98), (0.02, 0.02, 0.014), 1.0, 1.0, 8, 4, "straw_dark")
    hat.extend(hb).extend(knob)
    tilt = Matrix.Translation(V((0, 0, 1.79))) @ Matrix.Rotation(math.radians(-7), 4, "X") @ Matrix.Translation(V((0, 0, -1.79)))
    hat.transform(Matrix.Translation(V((0, -0.01, -0.05))) @ tilt)
    hob = ctx.obj(hat, "Head")
    R.solidify(hob, 0.007, offset_=-1.0)
    objs.append(hob)
    # chin cord of the hat
    for s in (1, -1):
        cord = G.tube("cord", [V((s * 0.105, 0.0, 1.8)), V((s * 0.095, -0.02, 1.68)), V((s * 0.05, -0.06, 1.6))],
                      [0.004, 0.004, 0.004], 4, "cord")
        objs.append(ctx.obj(cord, "Head"))
    return objs


def unit7(ctx):
    B, at = ctx.B, ctx.atlas
    objs = []
    body = body_copy(ctx, "u7_body", None)
    boots(ctx, body, 0.2, "u7_plate", "gunmetal", objs, width=1.1)
    R.smooth_verts(body, lambda co, d: d in TORSO | ARMS, 0.5, 8)
    R.offset(body, 0.004)
    R.tile_object(body, at, lambda c, n: "gunmetal" if c.z < 0.1 else "gunmetal_light" if abs(c.x) > 0.725 else "sec")
    objs.append(body)

    def tile_plate(c, n):
        return "u7_plate"
    plate_uv = cyl_uv(1.2, 0.7)

    def keep_chest(c, n, doms):
        return all(d in {"spine_03", "spine_02", "clavicle_l", "clavicle_r"} for d in doms) and c.z > 1.17 and abs(c.x) < 0.2
    objs.append(shell(ctx, "chest", keep_chest, 0.03, tile_plate, plate_uv, thick=0.016))

    def keep_abs(c, n, doms):
        return all(d in {"spine_01", "spine_02"} for d in doms) and 1.0 < c.z < 1.15 and c.y < -0.03
    objs.append(shell(ctx, "abs", keep_abs, 0.024, tile_plate, plate_uv, thick=0.012))

    for s, side in ((1, "l"), (-1, "r")):
        def keep_ua(c, n, doms, side=side):
            return all(d == f"upperarm_{side}" for d in doms) and 0.26 < abs(c.x) < 0.42 and c.z > B.head(f"upperarm_{side}").z - 0.02
        objs.append(shell(ctx, f"ua_{side}", keep_ua, 0.026, tile_plate, None, thick=0.01, smooth=4))

        def keep_fa(c, n, doms, side=side):
            return all(d == f"lowerarm_{side}" for d in doms) and 0.53 < abs(c.x) < 0.7
        objs.append(shell(ctx, f"fa_{side}", keep_fa, 0.028, tile_plate, None, thick=0.012, smooth=4))

        def keep_th(c, n, doms, side=side):
            return all(d == f"thigh_{side}" for d in doms) and 0.6 < c.z < 0.86 and c.y < 0.0 and s * c.x > 0.02
        objs.append(shell(ctx, f"th_{side}", keep_th, 0.03, tile_plate, None, thick=0.012, smooth=3))

        def keep_sh(c, n, doms, side=side):
            return all(d == f"calf_{side}" for d in doms) and 0.2 < c.z < 0.47 and c.y < 0.02
        objs.append(shell(ctx, f"sh_{side}", keep_sh, 0.026, tile_plate, None, thick=0.012, smooth=3))


        # knee cap
        kn = B.head(f"calf_{side}")
        cap = G.superellipsoid("knee", kn + V((0, -0.075, 0.0)), (0.055, 0.03, 0.06), 0.6, 0.7, 10, 6, "u7_plate")
        objs.append(ctx.obj(cap, f"calf_{side}"))

        # shoulder pauldron; the left one carries the 07 stencil
        pc = V((s * 0.215, 0.055, 1.455))
        pd = G.superellipsoid(f"pauldron_{side}", pc, (0.1, 0.095, 0.075), 0.55, 0.7, 14, 7,
                              "u7_plate07" if side == "l" else "u7_plate", vrange=(0.3, 1.0))
        pd.transform(Matrix.Translation(pc) @ Matrix.Rotation(math.radians(-18 * s), 4, "Y") @ Matrix.Translation(-pc))
        if side == "l":
            for fi, f in enumerate(pd.faces):
                pd.fuv[fi] = [(0.5 + (pd.verts[i].y - pc.y) / 0.2, 0.5 + (pd.verts[i].z - pc.z) / 0.14) for i in f]
        objs.append(ctx.obj(pd, lambda co, side=side: {f"upperarm_{side}": 0.55, f"clavicle_{side}": 0.45}))

    # belt with pouches
    belt = G.loft("u7_belt", [ring((0, 0.02, 0.96), X, Y, 0.195, 0.14), ring((0, 0.02, 1.02), X, Y, 0.19, 0.137)], 24,
                  "gunmetal")
    for s in (1, -1):
        belt.extend(G.superellipsoid("pouch", (s * 0.16, 0.1, 0.97), (0.035, 0.03, 0.04), 0.3, 0.3, 8, 4,
                                     "gunmetal_light"))
    belt.extend(G.superellipsoid("buckle", (0, -0.14, 0.99), (0.035, 0.012, 0.026), 0.3, 0.3, 8, 4, "u7_plate"))
    objs.append(ctx.obj(belt, "pelvis"))

    # radio pack on the back with an antenna
    rp = G.superellipsoid("radio", (0.0, 0.205, 1.27), (0.1, 0.045, 0.12), 0.25, 0.25, 12, 6, "gunmetal")
    rp.extend(G.superellipsoid("radio_lid", (0.0, 0.252, 1.3), (0.07, 0.01, 0.07), 0.25, 0.25, 8, 4, "u7_plate"))
    rp.extend(G.tube("antenna", [V((0.07, 0.22, 1.38)), V((0.08, 0.24, 1.66))], [0.006, 0.003], 4, "gunmetal_light"))
    objs.append(ctx.obj(rp, "spine_03"))

    # helmet: rounded, one round amber lens, no ear caps
    hc = HEAD_C + V((0, 0.004, 0.0))
    helm = G.superellipsoid("helmet", hc, (0.128, 0.138, 0.15), 0.72, 0.85, 22, 14, "u7_plate", vrange=(0.18, 1.0),
                            uv_rect=(0, 0, 1, 1),
                            deform=lambda q, th, t: q + V((0, -0.012 * max(0.0, -q.y / 0.138) ** 2, 0)))
    objs.append(ctx.obj(helm, "Head"))
    face = Part("u7_face", "gunmetal")
    lc = hc + V((0, -0.147, 0.005))
    face.extend(G.disc("lens_ring", lc + V((0, -0.006, 0)), V((0, -1, 0)), 0.07, 20, "lens_ring", inner=0.054))
    lens = G.superellipsoid("lens", lc + V((0, -0.002, 0)), (0.055, 0.055, 0.014), 1.0, 1.0, 16, 6, "accent",
                            frame=(X, Z, -Y), vrange=(0.5, 1.0))
    face.extend(lens)
    chin = G.superellipsoid("chin", hc + V((0, -0.105, -0.098)), (0.075, 0.045, 0.04), 0.5, 0.6, 12, 6, "u7_plate")
    face.extend(chin)
    for dx in (-0.025, 0.025):
        face.extend(G.box("vent", hc + V((dx, -0.148, -0.1)), (0.008, 0.01, 0.035), "lens_ring"))
    objs.append(ctx.obj(face, "Head"))
    neck = G.loft("u7_neck", [ring((0, 0.01, 1.47), X, Y, 0.085, 0.08), ring((0, 0.008, 1.57), X, Y, 0.075, 0.07)], 16,
                  "gunmetal")
    objs.append(ctx.obj(neck, lambda co: {"neck_01": 0.7, "spine_03": 0.3} if co.z < 1.52 else {"neck_01": 0.6, "Head": 0.4}))
    return objs


# ---------------------------------------------------------------------------------------------


CHARACTERS = [("hexwick", hexwick), ("ash", brother_ash), ("kappa", kappa), ("unit7", unit7)]


def build(args):
    R.reset()
    rig = R.import_rig(args.ual1)
    body = R.import_body(args.ubc, rig)
    # the new head replaces the base head; the base body is lightly decimated once for every starter
    R.keep_verts(body, lambda co, n, w, d: d != "Head")
    R.decimate(body, args.body_ratio)
    for p in body.data.polygons:
        p.use_smooth = True
    print("BASE body tris", G.tri_count(body))
    atlas = build_atlas()
    os.makedirs(args.out, exist_ok=True)
    atlas.save(os.path.join(args.out, "starters_atlas.png"))
    ctx = Ctx(rig, body, atlas)
    body.hide_render = True
    results = {}
    for name, fn in CHARACTERS:
        if args.only and name not in args.only.split(","):
            continue
        objs = [o for o in fn(ctx) if o is not None]
        ob = G.join(objs, name)
        orphans = R.finalize_weights(ob, rig)
        tris = G.tri_count(ob)
        results[name] = (tris, len(rig.data.bones), orphans)
        print(f"CHAR {name}: tris={tris} bones={len(rig.data.bones)} orphans={orphans}")
        R.export_glb(rig, ob, os.path.join(args.out, f"{name}.glb"))
        ob.hide_render = True
        ob.hide_set(True)
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=args.blend, compress=True)
    return results


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--ual1", required=True)
    ap.add_argument("--ubc", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--blend", default="")
    ap.add_argument("--body-ratio", type=float, default=0.7)
    build(ap.parse_args(argv))
