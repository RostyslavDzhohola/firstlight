# Brother Ash, the hooded desert monk-knight (docs/content.md §8.2): tall; a deep asymmetric hood with
# a forward peak; layered sand cloth with a striped mantle wrapped over the left shoulder; a hammered
# brass face-guard over the nose and mouth (his eyes stay visible: no dark hood with glowing eyes);
# brass prayer beads; a leather belt with brass rings and a sun-disc buckle; umber forearm and shin
# wraps; wrapped sandal boots. Avoid: brown robe over a cream tunic with a belted sash, a plain cylinder
# hilt, the words Jedi/lightsaber. Our own code: MIT. The model is CC BY 4.0.

import math

import numpy as np

import anat as A
import kit as K
import paint as PT
import sdf as S
from part import Part
from skel import Skel
from sdf import vec

F = np.float32
SKIN = "#b47c56"
BRASS = "#c9973f"


def stripes(P, base=0.9):
    """Woven sun-and-ash stripes: alternating broad and narrow bands with a weave (luminance)."""
    z = P[:, 2] * 1.0 + P[:, 0] * 0.35
    band = np.sin(z * 95)
    broad = band > 0.55
    narrow = np.abs(np.sin(z * 95 * 3)) > 0.93
    v = np.full(len(P), base, F)
    v = np.where(broad, base * 0.62, v)
    v = np.where(narrow & ~broad, base * 1.08, v)
    return np.clip(v, 0, 1)


def parts():
    sk = Skel()
    head = A.Head(c=(0.0, 0.0, 1.725), eye_w=0.034, eye_h=0.036)
    c = head.c
    face = PT.Face(iris="#b9822e", iris_dark="#4a2a10", lash="#20140e", brow="#2a1c14", brow_w=0.0042,
                   brow_tilt=-0.002, mouth_on=False, blush_amt=0.0, eye_w=0.034, eye_h=0.036, iris_r=0.0145, lid=0.22,
                   look=(0.0, -0.05))

    def paint_head(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        rgb = PT.variation(rgb, ctx.P, 0.04, 14, 2, 0.01)
        rgb = PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#5a2a20", ao_amt=0.7, top_light=0.05,
                       cav_amt=0.3, edge_amt=0.08, z_range=(1.45, 1.9))
        u, v = head.face_uv(ctx.P)
        rgb, _ = face.paint(rgb, u, v, head.front(ctx.P, ctx.N))
        return rgb

    # --- face guard (brass) ----------------------------------------------------------------------
    g_shell = S.offset(head.field, 0.007)

    def guard(P):
        d = S.smax(g_shell(P), -head.field(P) - 0.001, 0.004)
        q = P - c
        d = S.smax(d, q[:, 2] - (-0.034 + 0.01 * np.abs(q[:, 0]) / 0.06), 0.004)
        d = S.smax(d, (-0.115) - q[:, 2], 0.006)
        d = S.smax(d, q[:, 1] + 0.035, 0.012)
        # hammered dents and two engraved lines
        d = d + 0.0008 * S.vnoise(P, 300, 4)
        d = d + 0.0012 * np.exp(-((q[:, 2] + 0.06) / 0.0018) ** 2) + 0.0012 * np.exp(-((q[:, 2] + 0.09) / 0.0018) ** 2)
        return d

    def paint_brass(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(BRASS))
        rgb = PT.variation(rgb, ctx.P, 0.1, 40, 8, 0.03)
        hi = np.clip(ctx.cav, 0, 1)
        rgb = PT.mix(rgb, PT.hexc("#ffe2a0"), hi * 0.45)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#3a2410", ao_amt=0.6, cav_amt=0.6, edge_amt=0.3)

    # --- hood: deep, peaked, draping onto the left shoulder ---------------------------------------
    hood_o = S.ellipsoid(c + vec((0.0, 0.0, 0.03)), (0.16, 0.175, 0.185))
    hood_i = S.ellipsoid(c + vec((0.0, 0.005, 0.02)), (0.142, 0.158, 0.168))
    peak = S.ellipsoid(c + vec((0.0, -0.1, 0.1)), (0.1, 0.09, 0.08))
    drape_o = S.round_cone(c + vec((0.02, 0.03, -0.33)), c + vec((0.0, 0.02, -0.08)), 0.2, 0.13)
    drape_i = S.round_cone(c + vec((0.02, 0.03, -0.42)), c + vec((0.0, 0.02, -0.06)), 0.175, 0.105)
    win_c = c + vec((0.0, -0.2, -0.03))

    def hood(P):
        d = S.smin(hood_o(P), peak(P), 0.05)
        d = S.smin(d, drape_o(P), 0.06)
        inner = S.smin(hood_i(P), drape_i(P), 0.05)
        d = S.smax(d, -inner, 0.006)
        q = P - win_c
        win = np.sqrt((q[:, 0] / 0.12) ** 2 + (q[:, 2] / 0.13) ** 2) - 1.0
        cut = np.maximum(win * 0.06, q[:, 1] - 0.12)
        d = S.smax(d, -cut, 0.01)
        d = S.smax(d, (c[2] - 0.38 - 0.06 * np.clip(P[:, 0] / 0.2, 0, 1)) - P[:, 2], 0.012)  # lower on the left
        fold = 0.004 * np.sin(np.arctan2(P[:, 0], P[:, 1] - c[1]) * 6 + S.vnoise(P, 8, 2) * 1.6)
        return d + fold

    def paint_cloth(ctx, base=0.9, weave=0.07):
        rgb = PT.fill(ctx.n, (base, base, base))
        rgb = rgb * PT.weave(ctx.P, 480, weave)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.08, 6, 21, 0.015)
        dust = np.clip(0.4 - ctx.P[:, 2], 0, 0.4) / 0.4
        rgb = PT.mix(rgb, PT.fill(ctx.n, (0.78, 0.74, 0.68)), dust * 0.5)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#6a4a30", ao_amt=0.7, top_light=0.14,
                        cav_amt=0.45, edge_amt=0.18, z_range=(0.0, 1.9))

    # --- under robe (primary): long, closed, with sleeves ------------------------------------------
    torso = A.torso(chest=(0.16, 0.112, 0.13), belly=(0.14, 0.105, 0.11), hips=(0.16, 0.118, 0.1))
    body_r = S.offset(torso, 0.018)
    sl = S.union(K.sleeve(sk, 1, radii=(0.062, 0.056, 0.058, 0.07), ext=-0.03, open_depth=0.07, droop=0.015),
                 K.sleeve(sk, -1, radii=(0.062, 0.056, 0.058, 0.07), ext=-0.03, open_depth=0.07, droop=0.015))
    neck_hole = S.round_cone(vec((0, 0.012, 1.42)), vec((0, 0.006, 1.62)), 0.058, 0.06)
    skirt = K.skirt(1.03, 0.11, rx=(0.18, 0.29), ry=(0.14, 0.24), cy=0.02, thick=0.014, gap=(0, 8), folds=8,
                    fold_amp=0.012, fold_phase=1.2, hem_wave=0.01, flare=1.4)

    def robe(P):
        d = S.smin(body_r(P), sl(P), 0.035)
        d = S.smax(d, -neck_hole(P), 0.01)
        d = S.smax(d, 0.98 - P[:, 2], 0.01)
        d = S.smin(d, skirt(P), 0.02)
        return d + 0.003 * np.sin(np.arctan2(P[:, 0], -P[:, 1]) * 7 + S.vnoise(P, 8, 6)) * S.smoothstep(1.3, 1.0, P[:, 2])

    def robe_w(P):
        """The skirt below the waist follows the pelvis and, softly, the thighs (not the heat solution)."""
        z = P[:, 2]
        blend = S.smoothstep(1.02, 0.9, z)
        low = S.smoothstep(1.0, 0.5, z)
        side_l = P[:, 0] > 0
        a = S.smoothstep(0.02, 0.14, np.abs(P[:, 0])) * np.where(P[:, 1] < 0.05, 0.8, 0.45) * low
        return blend, {"thigh_l": np.where(side_l, a, 0), "thigh_r": np.where(side_l, 0, a), "pelvis": 1 - a}

    full_band = K.skirt(1.03, 0.105, rx=(0.18, 0.29), ry=(0.14, 0.24), cy=0.02, thick=0.019, gap=(0, 8), folds=8,
                        fold_amp=0.012, fold_phase=1.2, hem_wave=0.01, flare=1.4)

    def skirt_band(P):
        d = full_band(P)
        return S.smax(d, P[:, 2] - 0.29, 0.004)

    def paint_stripes(ctx):
        v = stripes(ctx.P)
        rgb = np.stack([v, v * 0.97, v * 0.93], axis=1)
        rgb = rgb * PT.weave(ctx.P, 600, 0.08)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.4, edge_amt=0.15)

    # --- mantle: striped cloth over the left shoulder, across chest and back to the right hip -----
    nrm = S.norm(vec((-0.62, 0.0, 0.78)))

    def mantle(P):
        # a thick band around the body, tilted: distance from a tilted plane through the torso, limited to
        # a cloth slab hugging the robe
        on = body_r(P) - 0.02
        slab = np.abs((P - vec((0.0, 0.01, 1.25))) @ nrm) - 0.11
        d = S.smax(np.abs(on) - 0.011, slab, 0.01)
        d = S.smax(d, -(body_r(P) - 0.004), 0.004)
        # a fold of fabric hanging off the left shoulder
        flap = S.ellipsoid(vec((0.2, 0.0, 1.36)), (0.07, 0.12, 0.14), S.rot((0, 1, 0), 25))(P)
        flap = S.smax(np.abs(flap) - 0.01, -(body_r(P) - 0.012), 0.004)
        d = S.smin(d, flap, 0.02)
        return d + 0.004 * np.sin((P @ nrm) * 70 + S.vnoise(P, 10, 31) * 2)

    def paint_mantle(ctx):
        return paint_stripes(ctx)

    # --- beads, belt, wraps, hands, boots ---------------------------------------------------------
    beads = []
    for i in range(17):
        a = math.pi * (0.06 + 0.88 * i / 16)
        p0 = vec((math.cos(a) * 0.11, -0.25, 1.47 - math.sin(a) * 0.26))
        beads.append((p0, 0.021 if i == 8 else 0.0125))
    bead_pts = [K.ray_hit(lambda X: S.smin(body_r(X), mantle(X), 0.01), b[0] + vec((0, 0.0, 0)), (0, 1, 0), b[1] * 0.6)
                for b in beads]
    bead_fs = [S.sphere(p, r) for p, (_, r) in zip(bead_pts, beads)]
    lo_b = np.min(bead_pts, axis=0) - 0.03
    hi_b = np.max(bead_pts, axis=0) + 0.03
    bead_u = S.bounded(S.union(*bead_fs), lo_b, hi_b)

    belt_r = K.belt_ring(1.0, 0.2, 0.158, cy=0.02, h=0.055, t=0.016)
    sun_disc = S.cyl((0.0, -0.165, 1.0), 0.034, 0.006, S.frame((0, 0, 1), (0, 1, 0)) @ S.rot((1, 0, 0), 90), rad=0.004)
    rings = [S.torus((s * 0.13, -0.142, 0.985), 0.02, 0.0045, S.rot((1, 0, 0), 90) @ S.rot((0, 1, 0), s * 20)) for s in (1, -1)]

    def belt(P):
        d = belt_r(P)
        return d

    def brass_bits(P):
        d = bead_u(P)
        d = np.minimum(d, sun_disc(P) - 0.0015 * np.cos(np.arctan2(P[:, 0], P[:, 2] - 1.0) * 12))
        for r in rings:
            d = np.minimum(d, r(P))
        return d

    def paint_belt(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#5e3c24"))
        rgb = PT.variation(rgb, ctx.P, 0.1, 30, 3, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.5, edge_amt=0.3)

    hands = S.union(A.hand(sk, 1), A.hand(sk, -1))
    hand_bones = []
    for sd in ("l", "r"):
        hand_bones += [f"lowerarm_{sd}", f"hand_{sd}"] + [f"{f}_0{i}_{sd}" for f in ("index", "middle", "ring", "pinky", "thumb") for i in (1, 2, 3)]

    def paint_hands(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#5a2a20", ao_amt=0.55, top_light=0.0,
                        cav_amt=0.3, edge_amt=0.1)

    fw = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        a, b = sk.tail(f"upperarm_{sd}"), sk.tail(f"lowerarm_{sd}")
        fw.append(S.round_cone(a * 0.35 + b * 0.65, b + (b - a) * 0.05, 0.05, 0.036))
    armw = S.union(*fw)

    def wraps(P):
        return armw(P) + 0.0025 * np.abs(np.sin(np.abs(P[:, 0]) * 150 + P[:, 2] * 40 + P[:, 1] * 30))

    def paint_wraps(ctx):
        v = stripes(ctx.P, 0.85)
        rgb = np.stack([v, v * 0.95, v * 0.9], axis=1) * PT.weave(ctx.P, 700, 0.1)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.55, edge_amt=0.2)

    boots = S.union(K.boot(sk, 1, top=0.2, shaft_r=0.058), K.boot(sk, -1, top=0.2, shaft_r=0.058))

    def boots_f(P):
        d = boots(P)
        return d + 0.002 * np.abs(np.sin(P[:, 2] * 130 + P[:, 0] * 50)) * (P[:, 2] > 0.09)

    def paint_boots(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#6a4a30"))
        wrap = ctx.P[:, 2] > 0.09
        rgb[wrap] = PT.hexc("#a8865c")
        sole = ctx.P[:, 2] < 0.02
        rgb[sole] = PT.hexc("#3a2a1c")
        rgb = PT.variation(rgb, ctx.P, 0.1, 25, 13, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.5, edge_amt=0.25, z_range=(0, 0.3))

    upper_bones = ["spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r", "upperarm_l",
                   "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r", "pelvis"]
    foot_bones = ["calf_l", "foot_l", "ball_l", "calf_r", "foot_r", "ball_r"]

    return [
        Part("head", head.field, "fixed", vox=0.0011, tris=1800, weights=("auto", ["neck_01", "Head"], "Head"),
             paint=paint_head, texel=2.4, uv_angle=70),
        Part("guard", guard, "fixed", vox=0.001, tris=600, weights=("rigid", "Head"), paint=paint_brass, texel=1.3),
        Part("hood", hood, "primary", vox=0.0018, tris=2200, weights=("auto", ["Head", "neck_01", "spine_03", "clavicle_l", "clavicle_r"], "Head"),
             paint=paint_cloth, texel=1.2),
        Part("robe", robe, "primary", vox=0.0024, tris=3000, weights=("auto", upper_bones + ["thigh_l", "thigh_r"], "spine_02", robe_w),
             paint=paint_cloth, texel=0.95),
        Part("hem", skirt_band, "secondary", vox=0.0018, tris=800, weights=("copy", "robe"), paint=paint_stripes,
             texel=0.9),
        Part("mantle", mantle, "secondary", vox=0.0018, tris=1500, weights=("copy", "robe"), paint=paint_mantle,
             texel=1.0),
        Part("belt", belt, "fixed", vox=0.0014, tris=400, weights=("rigid", "pelvis"), paint=paint_belt, texel=0.8),
        Part("brass", brass_bits, "fixed", vox=0.001, tris=900, weights=("copy", "robe"), paint=paint_brass, texel=0.8,
             occlude=False),
        Part("hands", hands, "fixed", vox=0.001, tris=1300, weights=("auto", hand_bones, "hand_l"), paint=paint_hands,
             texel=1.2),
        Part("wraps", wraps, "secondary", vox=0.0014, tris=600,
             weights=("auto", ["lowerarm_l", "lowerarm_r", "hand_l", "hand_r", "upperarm_l", "upperarm_r"], "lowerarm_l"),
             paint=paint_wraps, texel=0.9),
        Part("boots", boots_f, "fixed", vox=0.0015, tris=900, weights=("auto", foot_bones, "foot_l"), paint=paint_boots,
             texel=0.9),
    ]
