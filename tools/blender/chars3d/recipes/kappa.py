# Kappa, the folklore turtle-shell ninja (docs/content.md §8.2): ONE character, squat and wide. Matte
# moss-green skin; a domed tortoise shell patterned like river stones with a palette-coloured rim; a
# cream plastron with plate lines; a round head with big amber eyes and a hooked beak; webbed hands and
# feet; a short bark-brown wrap at the hips; a wide straw kasa (it covers the kappa's water dish, ringed
# by a dark bob of hair). Avoid: coloured bandana masks, letter buckles, elbow/knee pads, sneakers, a
# yellow-skinned spiky shell. Our own code: MIT. The model is CC BY 4.0.

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
SKIN = "#6f9443"
SKIN_DARK = "#4d6e2e"
BELLY = "#c9c08a"


def parts():
    sk = Skel()
    prof = {
        "w": [(-0.104, 0.07), (-0.081, 0.092), (-0.054, 0.108), (-0.027, 0.115), (0.0, 0.118), (0.03, 0.12)],
        "yf": [(-0.104, -0.09), (-0.081, -0.104), (-0.054, -0.114), (-0.027, -0.12), (0.0, -0.12), (0.03, -0.118)],
    }
    HS = 1.15  # stylised head scale
    head = A.Head(c=(0.0, 0.0, 1.735), scale=HS, profile=prof, crown={"r": (0.122, 0.128, 0.115)},
                  chin={"z": -0.098, "y": -0.05, "r": (0.065, 0.045, 0.03)}, ears=None, nose_r=(0.001, 0.001, 0.001),
                  nose_tip=0.0005, eye_x=0.052, eye_w=0.046, eye_h=0.05, socket=0.0025, neck_r=0.06)
    c = head.c
    face = PT.Face(iris="#e6b21e", iris_dark="#6a4a08", lash="#1d2410", brows=False, mouth_on=False,
                   eye_x=0.052, eye_w=0.046, eye_h=0.05, iris_r=0.019, blush="#e08a6a", blush_amt=0.0,
                   sclera="#f4f0dc", lash_w=0.0028, look=(0.0, 0.04))

    # --- beak --------------------------------------------------------------------------------
    up_b = S.ellipsoid(c + vec((0, -0.112, -0.046)) * F(HS), vec((0.042, 0.042, 0.022)) * F(HS), S.rot((1, 0, 0), -12))
    hook = S.ellipsoid(c + vec((0, -0.146, -0.058)) * F(HS), vec((0.016, 0.014, 0.016)) * F(HS))
    lo_b = S.ellipsoid(c + vec((0, -0.103, -0.071)) * F(HS), vec((0.034, 0.034, 0.013)) * F(HS), S.rot((1, 0, 0), 8))

    def beak(P):
        d = S.smin(up_b(P), hook(P), 0.02)
        d = np.minimum(d, lo_b(P))
        # nostrils
        for s in (1, -1):
            n = S.sphere(c + vec((s * 0.012, -0.146, -0.036)) * F(HS), 0.0035)(P)
            d = S.smax(d, -n, 0.002)
        return d

    def paint_beak(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#a29a48"))
        tip = np.clip((-(ctx.P[:, 1] - c[1]) / HS - 0.11) / 0.04, 0, 1)
        rgb = PT.mix(rgb, PT.hexc("#5e5a2c"), tip * 0.6)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.6, edge_amt=0.25)

    def paint_skin(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        # darker back and top, lighter belly-ish undersides; mottled spots
        top = np.clip(ctx.N[:, 2] * 0.5 + 0.5, 0, 1)
        rgb = PT.mix(rgb, PT.hexc(SKIN_DARK), (top * 0.35 + np.clip(ctx.P[:, 1] * 4, 0, 1) * 0.25))
        sp = np.clip(S.fbm(ctx.P, 30, 3, 33) * 3 - 0.6, 0, 1)
        rgb = PT.mix(rgb, PT.hexc("#3f5a26"), sp * 0.35)
        rgb = PT.variation(rgb, ctx.P, 0.05, 10, 5, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#203018", ao_amt=0.6, top_light=0.1,
                        cav_amt=0.45, edge_amt=0.12, z_range=(0, 1.9))

    def paint_head(ctx):
        rgb = paint_skin(ctx)
        u, v = head.face_uv(ctx.P)
        rgb, _ = face.paint(rgb, u, v, head.front(ctx.P, ctx.N))
        return rgb

    # --- body: squat, wide, thick limbs; webbed hands and feet ---------------------------------
    torso = A.torso(chest=(0.18, 0.13, 0.14), belly=(0.17, 0.14, 0.13), hips=(0.18, 0.13, 0.11), k=0.08)
    arms = A.arms(sk, upper=(0.062, 0.055), fore=(0.055, 0.045))
    legs = A.legs(sk, thigh=(0.11, 0.08), calf=(0.075, 0.056), knee=0.072, calf_bulge=0.015)
    feet = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        fx = float(sk.head(f"foot_{sd}")[0])
        fo = S.ellipsoid((fx, -0.04, 0.045), (0.062, 0.12, 0.045))
        toes = [S.capsule(vec((fx + dx, -0.09, 0.025)), vec((fx + dx * 1.6, -0.19, 0.02)), 0.018)
                for dx in (-0.035, 0.0, 0.035)]
        feet.append(S.smin_all([fo] + toes, 0.03))
    feet_u = S.union(*feet)

    def body(P):
        d = S.smin(torso(P), arms(P), 0.05)
        d = S.smin(d, legs(P), 0.05)
        d = S.smin(d, feet_u(P), 0.04)
        d = S.smax(d, np.abs(P[:, 0]) - 0.75, 0.01)
        d = S.smax(d, -P[:, 2], 0.004)
        return d

    hands = S.union(A.hand(sk, 1, scale=1.18, finger_r=0.0125, k=0.022),
                    A.hand(sk, -1, scale=1.18, finger_r=0.0125, k=0.022))
    hand_bones = []
    for sd in ("l", "r"):
        hand_bones += [f"lowerarm_{sd}", f"hand_{sd}"] + [f"{f}_0{i}_{sd}" for f in ("index", "middle", "ring", "pinky", "thumb") for i in (1, 2, 3)]

    # --- shell, rim, plastron --------------------------------------------------------------------
    cc = vec((0.0, 0.1, 1.18))
    dome = S.ellipsoid(cc, (0.27, 0.17, 0.34))

    def carapace(P):
        d = dome(P)
        d = S.smax(d, (cc[1] - 0.02) - P[:, 1], 0.03)  # back half only
        f1, f2, cid = S.voronoi(P, 16, 7, 0.8)
        groove = np.exp(-((f2 - f1) / 0.004) ** 2)
        return d + 0.004 * groove

    def rim(P):
        d = S.ellipsoid(cc + vec((0, -0.01, 0)), (0.285, 0.12, 0.355))(P)
        d = np.abs(d) - 0.012
        band = np.abs(P[:, 1] - (cc[1] - 0.02)) - 0.03
        return S.smax(d, band, 0.006)

    def paint_shell(ctx):
        f1, f2, cid = S.voronoi(ctx.P, 16, 7, 0.8)
        stones = [PT.hexc(h) for h in ("#7a7f6a", "#8b8a76", "#6a7258", "#9a9480", "#5f6a5a", "#857a62")]
        idx = np.minimum((cid * len(stones)).astype(int), len(stones) - 1)
        rgb = np.stack(stones)[idx]
        edge = np.clip((f2 - f1) / 0.01, 0, 1)
        rgb = rgb * (0.7 + 0.3 * edge)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.1, 30, 9, 0.02)
        moss = np.clip(S.fbm(ctx.P, 12, 3, 77) * 2.5 - 0.5, 0, 1) * (1 - edge)
        rgb = PT.mix(rgb, PT.hexc("#5a7a32"), moss * 0.35)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.6, edge_amt=0.25, z_range=(0.8, 1.6))

    pl_c = vec((0.0, -0.05, 1.18))

    def plastron(P):
        d = torso(P) - 0.03
        d = S.smax(d, P[:, 1] - (-0.02), 0.02)
        d = S.smax(d, np.abs(P[:, 0]) - 0.15, 0.03)
        d = S.smax(d, np.abs(P[:, 2] - 1.2) - 0.22, 0.03)
        lines = np.exp(-(np.minimum(np.abs((P[:, 2] - 1.2) % 0.09 - 0.045), 1) / 0.003) ** 2) * 0
        seg = np.abs(((P[:, 2] - 0.98) / 0.088) % 1.0 - 0.5) * 0.088
        groove = np.exp(-(((0.044 - seg)) / 0.003) ** 2)
        groove = np.maximum(groove, np.exp(-(P[:, 0] / 0.003) ** 2))
        return d + 0.0025 * groove

    def paint_plastron(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(BELLY))
        rgb = PT.variation(rgb, ctx.P, 0.06, 14, 12, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#6a5a30", ao_amt=0.6, cav_amt=0.6, edge_amt=0.2)

    # --- hip wrap and arm wraps (secondary) -------------------------------------------------------
    wrap_sk = K.skirt(1.07, 0.74, rx=(0.205, 0.25), ry=(0.16, 0.2), cy=0.02, thick=0.014, folds=7, fold_amp=0.008,
                      hem_wave=0.01, flare=1.2)
    sash = K.belt_ring(1.04, 0.215, 0.172, cy=0.02, h=0.06, t=0.018)
    knot = S.ellipsoid((0.1, -0.165, 1.03), (0.03, 0.02, 0.03))
    tails = S.union(S.tube([(0.1, -0.17, 1.02), (0.11, -0.185, 0.94), (0.105, -0.19, 0.86)], [0.018, 0.017, 0.015],
                           flat=0.3, up=(0, -1, 0)),
                    S.tube([(0.085, -0.17, 1.02), (0.07, -0.185, 0.95), (0.06, -0.19, 0.89)], [0.016, 0.015, 0.013],
                           flat=0.3, up=(0, -1, 0)))

    def wraps(P):
        d = np.minimum(wrap_sk(P), sash(P))
        d = S.smin(d, knot(P), 0.008)
        return S.smin(d, tails(P), 0.006)

    def wrap_w(P):
        side_l = P[:, 0] > 0
        t = S.smoothstep(1.02, 0.8, P[:, 2])
        a = S.smoothstep(0.03, 0.14, np.abs(P[:, 0])) * 0.7
        w = a * t
        return {"thigh_l": np.where(side_l, w, 0), "thigh_r": np.where(side_l, 0, w), "pelvis": 1 - w}

    def paint_wrap(ctx):
        rgb = PT.fill(ctx.n, (0.9, 0.9, 0.9))
        rgb = rgb * PT.weave(ctx.P, 500, 0.1)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.08, 8, 4, 0.0)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.5, edge_amt=0.2, z_range=(0.6, 1.2))

    fw = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        a, b = sk.tail(f"upperarm_{sd}"), sk.tail(f"lowerarm_{sd}")
        fw.append(S.round_cone(a * 0.4 + b * 0.6, b + (b - a) * 0.03, 0.058, 0.05))
    armw = S.union(*fw)

    def arm_wraps(P):
        return armw(P) + 0.0025 * np.abs(np.sin(np.abs(P[:, 0]) * 140 + P[:, 2] * 50))

    # --- hair bob and kasa -----------------------------------------------------------------------
    bob = K.Hair(head, cap=0.014, hairline=lambda az, el: np.where(np.abs(az) < 60, 25.0, -5.0 - 0.15 * np.abs(az)).astype(F), k=0.008)
    for az in range(-150, 181, 30):
        a = math.radians(az)
        bob.clump(az, 30, (math.sin(a) * 0.25, -math.cos(a) * 0.25, -1.0), 0.09, 0.04, lift=0.003, tip_lift=0.012,
                  flat=0.5)
    bob_f = bob.field()
    dish = S.cyl(c + vec((0, 0.006, 0.168)) * F(HS), 0.06, 0.008, rad=0.004)

    def hair(P):
        d = bob_f(P)
        top = (c[2] + 0.13) - P[:, 2]  # shaved crown where the dish sits
        d = S.smax(d, -top - 0.0, 0.006) if False else d
        return d

    def paint_hair(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#1f2a22"))
        rgb = rgb * PT.strands(ctx.P, (0, 0, 1), 700, 0.25)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.4, edge_amt=0.25)

    hat_c = c + vec((0.0, -0.01, 0.105)) * F(HS)
    tilt = S.rot((1, 0, 0), -8)

    def kasa(P):
        q = (P - hat_c) @ tilt
        r = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
        R = 0.38
        H = 0.17
        # a gently convex cone: height falls with radius, slight upturn at the rim
        prof = H * (1 - (r / R) ** 0.9) - 0.01 * S.smoothstep(R * 0.8, R, r)
        d = np.abs(q[:, 2] - prof) - 0.006
        d = S.smax(d, r - R, 0.006)
        weave = 0.0012 * np.sin(np.arctan2(q[:, 1], q[:, 0]) * 160) * np.sin(r * 300)
        knob = S.sphere((0, 0, H + 0.004), 0.018)(q)
        return S.smin(d + weave, knob, 0.01)

    def kasa_band(P):
        q = (P - hat_c) @ tilt
        r = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
        band = np.maximum(np.abs(r - 0.112 * HS) - 0.008, np.abs(q[:, 2] - 0.0) - 0.022)
        return band

    def paint_straw(ctx):
        q = (ctx.P - hat_c) @ tilt
        ang = np.arctan2(q[:, 1], q[:, 0])
        r = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
        rgb = PT.fill(ctx.n, PT.hexc("#d8b866"))
        stripe = 0.5 + 0.5 * np.sin(ang * 160)
        rgb = rgb * (0.85 + 0.15 * stripe)[:, None]
        ring = 0.5 + 0.5 * np.sin(r * 300)
        rgb = rgb * (0.9 + 0.1 * ring)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.08, 9, 66, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#6a4a20", ao_amt=0.55, cav_amt=0.4, edge_amt=0.2)

    cords = S.union(*[S.tube([c + vec((sx * 0.1, -0.0, 0.08)) * F(HS), c + vec((sx * 0.098, -0.03, -0.03)) * F(HS),
                              c + vec((sx * 0.05, -0.07, -0.1)) * F(HS)], [0.0035] * 3) for sx in (1, -1)])

    upper = ["spine_01", "spine_02", "spine_03", "neck_01", "Head", "clavicle_l", "clavicle_r", "upperarm_l", "upperarm_r",
             "lowerarm_l", "lowerarm_r", "hand_l", "hand_r", "pelvis", "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l",
             "foot_r", "ball_l", "ball_r"]

    return [
        Part("head", head.field, "fixed", vox=0.0011, tris=2000, weights=("auto", ["neck_01", "Head"], "Head"),
             paint=paint_head, texel=2.2, uv_angle=70),
        Part("beak", beak, "fixed", vox=0.001, tris=500, weights=("rigid", "Head"), paint=paint_beak, texel=1.4),
        Part("bob", hair, "fixed", vox=0.0012, tris=900, weights=("rigid", "Head"), paint=paint_hair, texel=0.8,
             cull=False),
        Part("kasa", kasa, "fixed", vox=0.0016, tris=1300, weights=("rigid", "Head"), paint=paint_straw, texel=1.0,
             cull=False, single_side=True),
        Part("band", kasa_band, "primary", vox=0.0012, tris=300, weights=("rigid", "Head"), paint=paint_wrap, texel=0.6),
        Part("cords", cords, "fixed", vox=0.001, tris=200, weights=("rigid", "Head"),
             paint=lambda ctx: PT.fill(ctx.n, PT.hexc("#c9b48a")), texel=0.4, occlude=False),
        Part("body", body, "fixed", vox=0.0022, tris=3600, weights=("auto", upper, "spine_02"), paint=paint_skin,
             texel=0.9),
        Part("hands", hands, "fixed", vox=0.001, tris=1800, weights=("auto", hand_bones, "hand_l"), paint=paint_skin,
             texel=1.1),
        Part("shell", carapace, "fixed", vox=0.002, tris=1600, weights=("auto", ["spine_01", "spine_02", "spine_03"], "spine_02"),
             paint=paint_shell, texel=1.1),
        Part("rim", rim, "primary", vox=0.0016, tris=700, weights=("copy", "shell"), paint=paint_wrap, texel=0.7,
             single_side=True),
        Part("plastron", plastron, "fixed", vox=0.0018, tris=700, weights=("copy", "body"), paint=paint_plastron,
             texel=0.9),
        Part("wraps", wraps, "secondary", vox=0.002, tris=1200, weights=("fn", wrap_w), paint=paint_wrap, texel=0.8,
             single_side=True),
        Part("armwraps", arm_wraps, "secondary", vox=0.0015, tris=600, weights=("copy", "body"), paint=paint_wrap,
             texel=0.7),
    ]
