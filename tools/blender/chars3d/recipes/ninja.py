# The ninja (5th starter, HANDOFF 6h; working name "Wren"): an original fire ninja. Lean and quick: a
# charcoal hooded cowl with a cloth face mask, sharp amber eyes and a few dark bangs; a long rust scarf
# whose two tattered tails trail behind; a short wrap-front jacket over baggy trousers, a wide belt
# with a knotted rope; bandage wraps on the forearms and shins; split-toe tabi boots; a kunai pouch on
# the right thigh; an original ember-in-a-ring emblem on the back. IP line (docs/content.md §8.2, §10):
# no orange jumpsuit, no forehead-plate headband, no leaf symbol, no whisker marks, no spiky blond hair.
# Our own code: MIT. The model is CC BY 4.0.

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
SKIN = "#e9bb98"
WRAP = "#d9cfbc"


def parts():
    sk = Skel()
    HS = 1.12  # stylised head scale
    head = A.Head(c=(0.0, 0.0, 1.742), scale=HS)
    c = head.c
    face = PT.Face(iris="#e0922a", iris_dark="#5a2a10", lash="#1a1414", brow="#231a18", brow_tilt=-0.004,
                   brow_lift=-0.001, brow_w=0.0036, mouth_on=False, blush_amt=0.15, lid=0.12, look=(0.05, 0.0))

    # --- head and face (mask covers the nose and mouth) ------------------------------------
    def paint_head(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        rgb = PT.variation(rgb, ctx.P, 0.03, 14, 2, 0.01)
        rgb = PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#9a4050", ao_amt=0.55, top_light=0.06,
                       cav_amt=0.25, edge_amt=0.08, z_range=(1.45, 1.9))
        u, v = head.face_uv(ctx.P)
        rgb, _ = face.paint(rgb, u, v, head.front(ctx.P, ctx.N))
        return rgb

    # --- hood (cowl) with the face opening, and the mask -----------------------------------
    hood_outer = S.offset(head.field, 0.024)
    open_c = c + vec((0.0, -0.16, -0.006)) * F(HS)

    def hood(P):
        d = hood_outer(P)
        d = S.smax(d, -head.field(P) - 0.004, 0.006)  # hollow
        # face opening: an oval window from the brow to below the eyes (the mask fills the rest)
        q = (P - open_c) / F(HS)
        win = A.ellipse2(q[:, 0], q[:, 2], F(0.088), F(0.05))  # an oval window from brow to cheekbones
        cut = np.maximum(win, q[:, 1] - 0.09) * F(HS)
        d = S.smax(d, -cut, 0.008)
        # cowl drapes onto the shoulders: widen below the jaw
        drape = S.round_cone(c + vec((0, 0.03, -0.34)), c + vec((0, 0.02, -0.13)), 0.17, 0.105)(P)
        drape = S.smax(drape, -(S.round_cone(c + vec((0, 0.03, -0.42)), c + vec((0, 0.02, -0.11)), 0.15, 0.08)(P)), 0.01)
        drape = S.smax(drape, (c[2] - 0.33) - P[:, 2], 0.01)
        d = S.smin(d, drape, 0.04)
        # soft folds radiating from the crown and across the back
        fold = 0.0035 * np.sin(np.arctan2(P[:, 0], P[:, 1] - c[1]) * 7 + S.vnoise(P, 10, 3) * 1.4)
        return d + fold * S.smoothstep(c[2] + 0.12, c[2] - 0.05, P[:, 2])

    mask_shell = S.offset(head.field, 0.006)

    def mask(P):
        d = S.smax(mask_shell(P), -head.field(P) - 0.002, 0.004)
        q = (P - c) / F(HS)
        top = (q[:, 2] - (-0.03 + 0.012 * np.abs(q[:, 0]) / 0.05))  # edge just under the eyes
        d = S.smax(d, top * F(HS), 0.004)
        d = S.smax(d, (q[:, 1] - 0.03) * F(HS), 0.01)  # front half only, tucks under the hood at the sides
        d = d + 0.0016 * np.sin(q[:, 2] * 180 + np.abs(q[:, 0]) * 60) * S.smoothstep(-0.04, -0.12, q[:, 2])
        return d

    def paint_cloth(ctx, base=0.86, weave=0.07):
        rgb = PT.fill(ctx.n, (base, base, base))
        rgb = rgb * PT.weave(ctx.P, 560, weave)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.08, 7, 13, 0.0)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#5a4a50", ao_amt=0.65, top_light=0.14,
                        cav_amt=0.45, edge_amt=0.18, z_range=(0.0, 1.9))

    # --- bangs ------------------------------------------------------------------------------
    bangs = K.Hair(head, cap=0.004, hairline=lambda az, el: np.full_like(az, 89.0), k=0.006)
    for az, L, sw in ((-28, 0.085, -0.15), (-8, 0.095, 0.05), (14, 0.09, 0.2), (32, 0.075, 0.3), (-44, 0.07, -0.3)):
        bangs.clump(az, 36, (sw, -0.6, -0.8), L, 0.026, bend=(0, -0.1, -0.2), lift=0.004, tip_lift=0.01, flat=0.45)
    bangs_f = bangs.field()

    def paint_hair(ctx):
        base = PT.fill(ctx.n, PT.hexc("#2a2224"))
        tip = np.clip((c[2] + 0.06 - ctx.P[:, 2]) / 0.06, 0, 1)
        rgb = PT.mix(base, PT.hexc("#6a2a1c"), tip * 0.5)  # ember-warm tips
        rgb = rgb * PT.strands(ctx.P, (0, -0.5, -1), 800, 0.25)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.4, edge_amt=0.2,
                        z_range=(1.6, 1.85))

    # --- scarf: thick neck wrap and two trailing tails --------------------------------------
    wrap = S.torus((0.0, 0.012, 1.505), 0.085, 0.034, S.rot((1, 0, 0), 6))
    wrap2 = S.torus((0.0, 0.016, 1.465), 0.098, 0.03, S.rot((1, 0, 0), -8))
    t1 = [vec((0.07, 0.09, 1.49)), vec((0.1, 0.17, 1.42)), vec((0.13, 0.26, 1.33)), vec((0.15, 0.34, 1.22)),
          vec((0.16, 0.41, 1.1)), vec((0.15, 0.46, 0.98))]
    t2 = [vec((0.03, 0.1, 1.48)), vec((0.03, 0.18, 1.39)), vec((0.02, 0.25, 1.28)), vec((0.0, 0.3, 1.17)),
          vec((-0.02, 0.33, 1.07))]
    tail1 = S.tube(t1, [0.055, 0.06, 0.062, 0.06, 0.056, 0.05], k=0.01, flat=0.2, up=(0, 0.6, 0.8))
    tail2 = S.tube(t2, [0.05, 0.052, 0.052, 0.05, 0.046], k=0.01, flat=0.2, up=(0, 0.6, 0.8))

    def scarf(P):
        d = S.smin(wrap(P), wrap2(P), 0.02)
        d = S.smin(d, tail1(P), 0.03)
        d = S.smin(d, tail2(P), 0.03)
        # tattered ends: notches cut into the tail tips
        tip = S.smoothstep(1.12, 1.0, P[:, 2]) * (P[:, 1] > 0.2)
        notch = 0.01 * np.maximum(np.sin(P[:, 0] * 220 + P[:, 1] * 60), 0) * tip
        d = d + notch
        return d + 0.003 * np.sin(P[:, 2] * 70 + P[:, 0] * 60 + S.vnoise(P, 18, 21) * 2)

    def scarf_w(P):
        z = P[:, 2]
        back = S.smoothstep(0.08, 0.2, P[:, 1])
        t = back * S.smoothstep(1.45, 1.2, z)
        return {"neck_01": (1 - t) * 0.55, "spine_03": (1 - t) * 0.45 + t * 0.6, "spine_02": t * 0.4}

    # --- jacket (short, wrap front, sleeves to mid forearm) ---------------------------------
    torso = A.torso(chest=(0.15, 0.104, 0.128), belly=(0.13, 0.096, 0.11), hips=(0.152, 0.11, 0.1))
    body_j = S.offset(torso, 0.016)
    sl = S.union(K.sleeve(sk, 1, radii=(0.058, 0.052, 0.06, 0.068), ext=-0.11, open_depth=0.06, droop=0.012),
                 K.sleeve(sk, -1, radii=(0.058, 0.052, 0.06, 0.068), ext=-0.11, open_depth=0.06, droop=0.012))
    neck_hole = S.round_cone(vec((0, 0.012, 1.42)), vec((0, 0.006, 1.62)), 0.06, 0.062)
    skirt_j = K.skirt(1.0, 0.72, rx=(0.17, 0.2), ry=(0.13, 0.155), cy=0.02, thick=0.012, folds=6, fold_amp=0.006,
                      flare=1.1)

    def jacket(P):
        d = S.smin(body_j(P), sl(P), 0.035)
        d = S.smax(d, -neck_hole(P), 0.01)
        d = S.smax(d, 0.98 - P[:, 2], 0.01)
        sk_ = skirt_j(P)
        # side slits on the jacket skirt
        slit = np.minimum(np.abs(P[:, 0]) - 0.0, 1.0)
        th = np.degrees(np.abs(np.arctan2(P[:, 0], -(P[:, 1] - 0.02))))
        sk_ = S.smax(sk_, -(np.abs(th - 90) * 0.0012 - 0.006 * S.smoothstep(0.95, 0.75, P[:, 2]) * 4), 0.003)
        d = S.smin(d, sk_, 0.02)
        # crossover lapel ridge: left panel over right, a diagonal from the right shoulder to the left hip
        lap = S.capsule(vec((-0.07, -0.118, 1.43)), vec((0.1, -0.15, 1.02)), 0.006)(P)
        d = S.smin(d, lap + 0.004, 0.012)
        fold = 0.003 * np.sin(np.arctan2(P[:, 0], -P[:, 1]) * 8 + S.vnoise(P, 9, 5) * 1.6) * S.smoothstep(1.25, 1.02, P[:, 2])
        return d + fold * (np.abs(P[:, 0]) < 0.3)

    def lapel_trim(P):
        a, b = vec((-0.075, -0.118, 1.47)), vec((0.11, -0.15, 1.02))
        band = S.capsule(a, b, 0.016)(P)
        on = S.offset(jacket, 0.003)(P)
        d = S.smax(np.abs(on) - 0.003, band, 0.004)
        # collar band around the neck
        col = S.torus((0, 0.012, 1.445), 0.072, 0.012, S.rot((1, 0, 0), 8))(P)
        return np.minimum(d, col)

    def paint_emblem(ctx):
        rgb, = (paint_cloth(ctx),)
        # back emblem: a ring with an ember flame inside (original), as an accent glow
        P = ctx.P
        on_back = (P[:, 1] > 0.05) & (np.abs(P[:, 0]) < 0.12) & (P[:, 2] > 1.12) & (P[:, 2] < 1.42)
        u = P[:, 0]
        v = P[:, 2] - 1.27
        r = np.sqrt(u * u + v * v)
        ring = (np.abs(r - 0.065) < 0.007)
        # flame: a teardrop tip pointing up, with a notch
        fl = (np.sqrt((u / 0.03) ** 2 + ((v + 0.012) / 0.034) ** 2) < 1.0) & (np.abs(u) < 0.03 * (1 - np.clip((v + 0.012) / 0.05, 0, 1)) + 0.012)
        inner = np.sqrt((u / 0.012) ** 2 + ((v + 0.02) / 0.016) ** 2) < 1.0
        em = (ring | (fl & ~inner)) & on_back
        e = em.astype(F)
        rgb = PT.mix(rgb, PT.fill(ctx.n, (1, 1, 1)), e * 0.6)
        return rgb, e * 0.55

    # --- belt (wide band) + rope with a side knot -------------------------------------------
    obi = K.belt_ring(1.0, 0.19, 0.148, cy=0.02, h=0.07, t=0.016)
    rope = S.torus((0.0, 0.018, 0.985), 0.2, 0.008, S.rot((1, 0, 0), 0) @ np.diag([1.0, 0.78, 1.0]).astype(F))
    knot = S.sphere((0.15, -0.115, 0.98), 0.02)
    rope_tails = S.union(S.capsule(vec((0.15, -0.12, 0.97)), vec((0.165, -0.13, 0.86)), 0.007),
                         S.capsule(vec((0.14, -0.125, 0.97)), vec((0.13, -0.14, 0.88)), 0.007))

    def belt(P):
        return obi(P)

    def rope_f(P):
        d = rope(P)
        d = np.minimum(d, knot(P))
        return np.minimum(d, rope_tails(P)) + 0.0012 * np.sin(np.arctan2(P[:, 0], -P[:, 1]) * 90 + P[:, 2] * 400)

    def paint_belt(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#3a2a24"))
        rgb = rgb * PT.weave(ctx.P, 700, 0.08)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.4, edge_amt=0.2)

    def paint_rope(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#c8a874"))
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.5, edge_amt=0.2)

    # --- hands (fingerless gloves painted on), forearm wraps --------------------------------
    hands = S.union(A.hand(sk, 1), A.hand(sk, -1))
    hand_bones = []
    for sd in ("l", "r"):
        hand_bones += [f"lowerarm_{sd}", f"hand_{sd}"] + [f"{f}_0{i}_{sd}" for f in ("index", "middle", "ring", "pinky", "thumb") for i in (1, 2, 3)]

    def paint_hands(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        # fingerless glove: covers the palm and back of the hand up to the knuckles
        ax = np.abs(ctx.P[:, 0])
        glove = ax < 0.865
        rgb[glove] = PT.hexc("#2b2627")
        rgb = PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#904050", ao_amt=0.5, top_light=0.0,
                       cav_amt=0.35, edge_amt=0.15)
        return rgb

    arm_wraps = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        a, b = sk.tail(f"upperarm_{sd}"), sk.tail(f"lowerarm_{sd}")
        arm_wraps.append(S.round_cone(a * 0.55 + b * 0.45, b + (b - a) * 0.06, 0.04, 0.034))
    wraps_arm = S.union(*arm_wraps)

    def forearm_wraps(P):
        d = wraps_arm(P)
        # spiral bandage turns
        ax = np.abs(P[:, 0])
        return d + 0.0022 * np.abs(np.sin(ax * 150 + P[:, 2] * 40 + P[:, 1] * 40))

    def paint_wraps(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(WRAP))
        rgb = rgb * PT.weave(ctx.P, 800, 0.08)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.08, 18, 7, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#6a5040", ao_amt=0.6, top_light=0.08,
                        cav_amt=0.55, edge_amt=0.2)

    # --- trousers, shin wraps, tabi ---------------------------------------------------------
    legs = A.legs(sk, thigh=(0.1, 0.075), calf=(0.07, 0.05), knee=0.068)

    def trousers(P):
        d = legs(P) - 0.01
        d = S.smax(d, P[:, 2] - 1.0, 0.02)
        d = S.smax(d, 0.3 - P[:, 2], 0.012)
        fold = 0.004 * np.sin(P[:, 2] * 55 + np.arctan2(P[:, 1], P[:, 0] - np.sign(P[:, 0]) * 0.09) * 3 +
                              S.vnoise(P, 10, 9) * 2)
        return d + fold

    shins = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        b, cc = sk.tail(f"thigh_{sd}"), sk.tail(f"calf_{sd}")
        shins.append(S.round_cone(b * 0.45 + cc * 0.55, cc + vec((0, 0, 0.02)), 0.056, 0.044))
    shin_u = S.union(*shins)

    def shin_wraps(P):
        return shin_u(P) + 0.0022 * np.abs(np.sin(P[:, 2] * 160 + P[:, 0] * 30))

    def tabi(P):
        d = S.union(K.boot(sk, 1, top=0.14, width=0.95, shaft_r=0.05), K.boot(sk, -1, top=0.14, width=0.95, shaft_r=0.05))(P)
        # the split toe: a groove between the big toe and the rest
        for s in (1, -1):
            fx = 0.089 * s
            g = S.box((fx + 0.018 * s, -0.16, 0.04), (0.003, 0.05, 0.05))(P)
            d = S.smax(d, -g, 0.006)
        return d

    def paint_tabi(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#2c2828"))
        sole = ctx.P[:, 2] < 0.02
        rgb[sole] = PT.hexc("#5a4a3a")
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.55, cav_amt=0.45, edge_amt=0.25, z_range=(0, 0.3))

    # --- kunai pouch on the right thigh ------------------------------------------------------
    th_r = sk.mid("thigh_r", 0.32)
    pouch_c = th_r + vec((-0.075, -0.02, 0.0))
    pouch = S.box(pouch_c, (0.022, 0.04, 0.05), rad=0.012)
    strap_t = S.torus(th_r + vec((0, 0.0, 0.0)), 0.088, 0.008, np.diag([1.0, 0.9, 1.0]).astype(F))
    handle = S.capsule(pouch_c + vec((0.0, -0.01, 0.045)), pouch_c + vec((0.0, -0.012, 0.1)), 0.006)
    ring_k = S.torus(pouch_c + vec((0.0, -0.012, 0.112)), 0.011, 0.003, S.rot((1, 0, 0), 90))

    def pouch_f(P):
        d = S.smin(pouch(P), strap_t(P), 0.006)
        return np.minimum(np.minimum(d, handle(P)), ring_k(P))

    def paint_pouch(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#5a3a26"))
        metal = ctx.P[:, 2] > th_r[2] + 0.05
        rgb[metal] = PT.hexc("#8a8e96")
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.4, edge_amt=0.35)

    upper_bones = ["spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r", "upperarm_l",
                   "upperarm_r", "lowerarm_l", "lowerarm_r", "pelvis"]
    leg_bones = ["pelvis", "thigh_l", "thigh_r", "calf_l", "calf_r"]
    foot_bones = ["calf_l", "foot_l", "ball_l", "calf_r", "foot_r", "ball_r"]

    def jacket_w(P):
        """The jacket skirt follows the pelvis and softly the thighs below the belt."""
        z = P[:, 2]
        blend = S.smoothstep(1.0, 0.92, z)
        side_l = P[:, 0] > 0
        a = S.smoothstep(0.02, 0.12, np.abs(P[:, 0])) * np.where(P[:, 1] < 0.05, 0.75, 0.45) * S.smoothstep(0.98, 0.75, z)
        return blend, {"thigh_l": np.where(side_l, a, 0), "thigh_r": np.where(side_l, 0, a), "pelvis": 1 - a}

    return [
        Part("head", head.field, "fixed", vox=0.0011, tris=2000, weights=("auto", ["neck_01", "Head"], "Head"),
             paint=paint_head, texel=2.6, uv_angle=70),
        Part("hood", hood, "primary", vox=0.0016, tris=1800, weights=("auto", ["Head", "neck_01", "spine_03"], "Head"),
             paint=paint_cloth, texel=1.3, single_side=True),
        Part("mask", mask, "primary", vox=0.0012, tris=700, weights=("auto", ["Head", "neck_01"], "Head"),
             paint=lambda ctx: paint_cloth(ctx, 0.78, 0.09), texel=1.6, single_side=True),
        Part("bangs", bangs_f, "fixed", vox=0.0011, tris=600, weights=("rigid", "Head"), paint=paint_hair, texel=1.2),
        Part("scarf", scarf, "secondary", vox=0.002, tris=1400, weights=("fn", scarf_w), paint=paint_cloth, texel=1.0,
             single_side=True),
        Part("jacket", jacket, "primary", vox=0.002, tris=2300, weights=("auto", upper_bones + ["thigh_l", "thigh_r"], "spine_02", jacket_w),
             paint=paint_emblem, texel=1.0, single_side=True),
        Part("lapel", lapel_trim, "secondary", vox=0.0014, tris=500, weights=("auto", ["spine_02", "spine_03", "neck_01", "spine_01"], "spine_03"),
             paint=paint_cloth, texel=0.8, occlude=False, single_side=True),
        Part("belt", belt, "fixed", vox=0.0015, tris=350, weights=("rigid", "pelvis"), paint=paint_belt, texel=0.8),
        Part("rope", rope_f, "fixed", vox=0.0012, tris=500, weights=("rigid", "pelvis"), paint=paint_rope, texel=0.6,
             occlude=False),
        Part("hands", hands, "fixed", vox=0.001, tris=1900, weights=("auto", hand_bones, "hand_l"), paint=paint_hands,
             texel=1.3),
        Part("armwraps", forearm_wraps, "fixed", vox=0.0014, tris=700,
             weights=("auto", ["lowerarm_l", "lowerarm_r", "hand_l", "hand_r", "upperarm_l", "upperarm_r"], "lowerarm_l"),
             paint=paint_wraps, texel=0.9),
        Part("trousers", trousers, "primary", vox=0.0022, tris=1500, weights=("auto", leg_bones, "pelvis"),
             paint=paint_cloth, texel=0.9),
        Part("shinwraps", shin_wraps, "fixed", vox=0.0014, tris=600, weights=("auto", ["calf_l", "calf_r", "foot_l", "foot_r"], "calf_l"),
             paint=paint_wraps, texel=0.9),
        Part("tabi", tabi, "fixed", vox=0.0015, tris=800, weights=("auto", foot_bones, "foot_l"), paint=paint_tabi,
             texel=0.9),
        Part("pouch", pouch_f, "fixed", vox=0.0012, tris=400, weights=("rigid", "thigh_r"), paint=paint_pouch,
             texel=0.7, cull=False),
    ]
