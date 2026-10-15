# Unit 7, the white-armour trooper (docs/content.md §8.2): compact and solid. Rounded ivory ceramic
# plates with panel seams over a quilted GREY undersuit (never black); a big rounded helmet with ONE
# round amber lens; a "07" stencil on the left pauldron; a small power pack on the back. Avoid: T visor,
# mouth grille, black undersuit, bucket helmet with ear caps; stay distinct from Meridian's slate
# slit-visor Associates. Our own code: MIT. The model is CC BY 4.0.

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
GUN = "#3d434b"


def plate(base, region, off=0.008, t=0.012, k=0.006):
    """A slab of thickness t lying off metres above base's surface, cut to region (SDF < 0 inside)."""
    def f(P):
        d = np.abs(base(P) - (off + t * 0.5)) - t * 0.5
        return S.smax(d, region(P), k)
    return f


def parts():
    sk = Skel()
    c = vec((0.0, 0.0, 1.725))

    # --- undersuit (secondary grey, quilted) ---------------------------------------------------
    torso = A.torso(chest=(0.16, 0.115, 0.13), belly=(0.14, 0.105, 0.11), hips=(0.158, 0.118, 0.1))
    arms = A.arms(sk, upper=(0.056, 0.048), fore=(0.046, 0.038))
    legs = A.legs(sk, thigh=(0.096, 0.07), calf=(0.066, 0.05), knee=0.064)
    neck = S.round_cone(vec((0, 0.01, 1.42)), vec((0, 0.008, 1.62)), 0.062, 0.056)

    def suit(P):
        d = S.smin(torso(P), arms(P), 0.05)
        d = S.smin(d, legs(P), 0.05)
        d = S.smin(d, neck(P), 0.03)
        d = S.smax(d, 0.13 - P[:, 2], 0.01)
        ax = np.abs(P[:, 0])
        d = S.smax(d, ax - 0.745, 0.01)  # sleeves end at the gloves
        # quilting: a diamond lattice of soft puffs
        q = (np.sin((P[:, 0] + P[:, 2]) * 140) * np.sin((P[:, 0] - P[:, 2] + P[:, 1]) * 140))
        return d - 0.0018 * np.abs(q)

    def paint_suit(ctx):
        rgb = PT.fill(ctx.n, (0.9, 0.9, 0.9))
        rgb = rgb * PT.weave(ctx.P, 700, 0.05)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#404a58", ao_amt=0.7, top_light=0.12,
                        cav_amt=0.55, edge_amt=0.15, z_range=(0, 1.8))

    # --- armour plates (primary ivory) ---------------------------------------------------------
    base = suit

    def region_box(c_, half, R=None, rad=0.02):
        return S.box(c_, half, R, rad)

    chest = plate(base, region_box((0, -0.04, 1.33), (0.17, 0.12, 0.13), rad=0.04), off=0.006, t=0.016)
    back_p = plate(base, region_box((0, 0.1, 1.32), (0.15, 0.06, 0.13), rad=0.04), off=0.006, t=0.014)
    abd = plate(base, region_box((0, -0.1, 1.11), (0.1, 0.06, 0.06), rad=0.02), off=0.005, t=0.012)
    pauld = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        sh = sk.head(f"upperarm_{sd}")
        pc = sh + vec((s * 0.03, -0.005, 0.02))
        dome = S.ellipsoid(pc, (0.09, 0.085, 0.075), S.rot((0, 1, 0), -16 * s))
        inner = S.ellipsoid(pc + vec((0, 0, -0.012)), (0.078, 0.073, 0.063), S.rot((0, 1, 0), -16 * s))
        cut = S.plane(pc + vec((0, 0, -0.035)), (0, 0, -1))
        pauld.append(S.sinter(S.ssub(dome, inner, 0.004), cut, 0.006))
    limbs = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        ua = sk.mid(f"upperarm_{sd}", 0.6)
        fa = sk.mid(f"lowerarm_{sd}", 0.5)
        limbs.append(plate(base, S.ellipsoid(ua, (0.07, 0.07, 0.07)), off=0.005, t=0.011))
        limbs.append(plate(base, S.ellipsoid(fa, (0.1, 0.07, 0.07)), off=0.005, t=0.012))
        th = sk.mid(f"thigh_{sd}", 0.45)
        sh_ = sk.mid(f"calf_{sd}", 0.45)
        limbs.append(plate(base, S.ellipsoid(th + vec((0, -0.05, 0)), (0.11, 0.08, 0.13)), off=0.005, t=0.012))
        limbs.append(plate(base, S.ellipsoid(sh_ + vec((0, -0.05, 0)), (0.09, 0.07, 0.13)), off=0.005, t=0.012))
        kn = sk.tail(f"thigh_{sd}")
        limbs.append(S.ellipsoid(kn + vec((0, -0.068, 0.0)), (0.052, 0.03, 0.055)))

    def plates(P):
        d = np.minimum(chest(P), back_p(P))
        d = np.minimum(d, abd(P))
        for f in pauld + limbs:
            d = np.minimum(d, f(P))
        # panel seams: a centre line, a chest line, and rings on the limb plates
        seam = np.exp(-((np.abs(P[:, 0]) - 0.0) / 0.0018) ** 2) * (P[:, 1] < 0) * (P[:, 2] > 1.2)
        seam = np.maximum(seam, np.exp(-((P[:, 2] - 1.24) / 0.0018) ** 2) * (np.abs(P[:, 0]) < 0.2))
        return d + 0.0014 * seam

    def paint_plates(ctx):
        rgb = PT.fill(ctx.n, (1.0, 1.0, 1.0))
        rgb = PT.variation(rgb, ctx.P, 0.03, 8, 3, 0.0)
        # "07" stencil on the left pauldron (the character's left = +X), facing outwards
        P = ctx.P
        on = (P[:, 0] > 0.2) & (P[:, 2] > 1.43) & (ctx.N[:, 0] > 0.45)
        u = -(P[:, 1] - 0.065) / 0.05  # across (forward = -Y reads left to right from outside)
        v = (P[:, 2] - 1.475) / 0.05
        zero = (np.abs(np.sqrt(((u + 0.45) / 0.33) ** 2 + (v / 0.5) ** 2) - 1.0) < 0.28)
        seven = ((np.abs(v - 0.42) < 0.11) & (u > 0.12) & (u < 0.82)) | \
                ((np.abs((u - 0.82) + (v - 0.42) * 0.55) < 0.12) & (v < 0.45) & (v > -0.52))
        st = (zero | seven) & on
        rgb[st] = PT.hexc("#4a4f57")
        wear = np.clip(ctx.cav, 0, 1)
        rgb = PT.mix(rgb, PT.hexc("#c9c1b0"), wear * 0.4)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#6a6050", ao_amt=0.6, top_light=0.12,
                        cav_amt=0.6, edge_amt=0.12, z_range=(0, 1.9))

    # --- helmet, lens, collar ------------------------------------------------------------------
    hc = c + vec((0, 0.006, 0.02))
    dome = S.ellipsoid(hc, (0.142, 0.15, 0.158))
    jaw = S.ellipsoid(hc + vec((0, -0.03, -0.085)), (0.12, 0.12, 0.09))
    lens_c = c + vec((0.0, -0.148, 0.0))
    lens_hole = S.cyl(lens_c, 0.06, 0.04, S.frame((0, 1, 0), (0, 0, 1)) @ S.rot((1, 0, 0), 0))

    def helmet(P):
        d = S.smin(dome(P), jaw(P), 0.05)
        d = S.smax(d, (hc[2] - 0.155) - P[:, 2], 0.02)  # open bottom (neck)
        # recess for the lens
        q = P - lens_c
        rr = np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2)
        recess = np.maximum(rr - 0.066, q[:, 1] - 0.03)
        d = S.smax(d, -recess, 0.006)
        # brow ridge and a cheek seam
        d = d - 0.006 * np.exp(-((P[:, 2] - (c[2] + 0.075)) / 0.012) ** 2) * (P[:, 1] < c[1] - 0.06)
        seam = np.exp(-((P[:, 2] - (c[2] - 0.055)) / 0.0018) ** 2)
        return d + 0.0015 * seam

    def lens(P):
        q = P - lens_c
        # a domed amber lens sitting in the recess, with a gunmetal ring
        disc = S.ellipsoid(lens_c + vec((0, 0.012, 0)), (0.056, 0.03, 0.056))(P)
        return disc

    def lens_ring(P):
        q = P - lens_c
        rr = np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2)
        ring = np.maximum(np.abs(rr - 0.062) - 0.006, np.abs(q[:, 1] - 0.012) - 0.012)
        return ring

    def paint_lens(ctx):
        P = ctx.P
        q = P - lens_c
        r = np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2) / 0.056
        rgb = PT.mix(PT.fill(ctx.n, (1.0, 0.95, 0.85)), PT.fill(ctx.n, (0.7, 0.62, 0.5)), np.clip(r, 0, 1) ** 2)
        hl = np.exp(-(((q[:, 0] + 0.02) / 0.012) ** 2 + ((q[:, 2] - 0.022) / 0.009) ** 2))
        rgb = rgb + hl[:, None] * 0.5
        glow = np.clip(1.15 - r * 0.6, 0, 1)
        return np.clip(rgb, 0, 1), glow

    def paint_gun(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(GUN))
        rgb = PT.variation(rgb, ctx.P, 0.06, 20, 4, 0.0)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.4, edge_amt=0.35)

    # --- gloves, boots, belt, pack ----------------------------------------------------------
    gloves = S.union(A.hand(sk, 1, scale=1.15, finger_r=0.012), A.hand(sk, -1, scale=1.15, finger_r=0.012))
    cuffs = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        w = sk.head(f"hand_{sd}")
        cuffs.append(S.cyl(w + vec((-0.012 * s, 0, 0)), 0.05, 0.02, S.frame((1, 0, 0), (0, 0, 1)) @ S.rot((1, 0, 0), 90),
                           rad=0.008))
    glove_f = S.sunion(gloves, S.union(*cuffs), 0.01)
    hand_bones = []
    for sd in ("l", "r"):
        hand_bones += [f"lowerarm_{sd}", f"hand_{sd}"] + [f"{f}_0{i}_{sd}" for f in ("index", "middle", "ring", "pinky", "thumb") for i in (1, 2, 3)]

    boots = S.union(K.boot(sk, 1, top=0.24, width=1.12, shaft_r=0.07, cuff=0.012),
                    K.boot(sk, -1, top=0.24, width=1.12, shaft_r=0.07, cuff=0.012))

    def paint_boots(ctx):
        rgb = PT.fill(ctx.n, (1, 1, 1))
        sole = ctx.P[:, 2] < 0.03
        rgb[sole] = PT.hexc(GUN)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.5, edge_amt=0.12, z_range=(0, 0.3))

    belt = K.belt_ring(0.985, 0.2, 0.148, cy=0.02, h=0.05, t=0.016)
    pouches = []
    for s in (1, -1):
        pouches.append(S.box((s * 0.15, -0.09, 0.97), (0.035, 0.022, 0.035), S.rot((0, 0, 1), s * 30), rad=0.01))
    buckle = S.box((0, -0.15, 0.985), (0.03, 0.01, 0.024), rad=0.006)

    def belt_f(P):
        d = belt(P)
        for p in pouches:
            d = S.smin(d, p(P), 0.004)
        return S.smin(d, buckle(P), 0.003)

    pack_c = vec((0.0, 0.2, 1.28))
    pack = S.box(pack_c, (0.1, 0.045, 0.12), rad=0.03)
    cell = S.cyl(pack_c + vec((0.0, 0.03, 0.06)), 0.03, 0.03, S.frame((0, 0, 1), (0, 1, 0)), rad=0.008)

    def pack_f(P):
        d = S.smin(pack(P), cell(P), 0.006)
        d = d + 0.0015 * np.exp(-((P[:, 2] - pack_c[2]) / 0.002) ** 2)
        return d

    def paint_pack(ctx):
        rgb = paint_gun(ctx)
        glow = (np.abs(ctx.P[:, 0] - 0.06) < 0.012) & (np.abs(ctx.P[:, 2] - (pack_c[2] - 0.06)) < 0.012) & (ctx.P[:, 1] > 0.24)
        return rgb, glow.astype(F) * 0.9

    upper_bones = ["spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r", "upperarm_l",
                   "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r", "pelvis", "thigh_l", "thigh_r",
                   "calf_l", "calf_r", "foot_l", "foot_r"]
    foot_bones = ["calf_l", "foot_l", "ball_l", "calf_r", "foot_r", "ball_r"]

    return [
        Part("helmet", helmet, "primary", vox=0.0013, tris=2000, weights=("rigid", "Head"), paint=paint_plates, texel=1.8),
        Part("lens", lens, "fixed", vox=0.001, tris=400, weights=("rigid", "Head"), paint=paint_lens, texel=1.4,
             cull=True),
        Part("lensring", lens_ring, "fixed", vox=0.001, tris=400, weights=("rigid", "Head"), paint=paint_gun, texel=1.0),
        Part("suit", suit, "secondary", vox=0.0022, tris=3800, weights=("auto", upper_bones, "spine_02"),
             paint=paint_suit, texel=0.9),
        Part("plates", plates, "primary", vox=0.0016, tris=3600, weights=("copy", "suit"),
             paint=paint_plates, texel=1.1),
        Part("gloves", glove_f, "fixed", vox=0.0012, tris=1400, weights=("auto", hand_bones, "hand_l"), paint=paint_gun,
             texel=1.0),
        Part("boots", boots, "primary", vox=0.0018, tris=1000, weights=("auto", foot_bones, "foot_l"), paint=paint_boots,
             texel=0.9),
        Part("belt", belt_f, "fixed", vox=0.0014, tris=600, weights=("rigid", "pelvis"), paint=paint_gun, texel=0.8),
        Part("pack", pack_f, "fixed", vox=0.0014, tris=500, weights=("rigid", "spine_03"), paint=paint_pack, texel=0.9),
    ]
