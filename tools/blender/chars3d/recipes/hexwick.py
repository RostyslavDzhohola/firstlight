# Hexwick, the young wizard (docs/content.md §8.2): slim; a long robe flaring at the hem, open at the
# front over dark trousers and boots; bell sleeves with ink-stained cuffs; one long single-colour scarf
# trailing behind; a satchel stuffed with quills; faint constellation embroidery (accent glow).
# Tousled dark-brown hair with a swept fringe, bright eyes, a confident little smile.
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
SKIN = "#f1c7a5"
HAIR = "#4a2e22"
HAIR_HI = "#7a4e36"


def parts():
    sk = Skel()
    head = A.Head(c=(0.0, 0.0, 1.725))
    c = head.c
    face = PT.Face(iris="#2f9fc8", iris_dark="#123c5c", lash="#24160f", brow="#3f281d", smile=0.0045,
                   brow_tilt=0.0015, look=(0.0, 0.05))

    def paint_head(ctx):
        n = ctx.n
        rgb = PT.fill(n, PT.hexc(SKIN))
        rgb = PT.variation(rgb, ctx.P, 0.03, 14, 2, 0.01)
        # warm the ears, nose and neck shadow
        u, v = head.face_uv(ctx.P)
        rgb = PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#b0505a", ao_amt=0.5, top_light=0.08,
                       cav_amt=0.25, edge_amt=0.08, z_range=(1.45, 1.9))
        rgb, _ = face.paint(rgb, u, v, head.front(ctx.P, ctx.N))
        return rgb

    # --- hair -----------------------------------------------------------------------------
    def hairline(az, el):
        a = np.abs(az)
        return np.interp(a, [0, 40, 80, 100, 135, 180], [9, 3, -12, -18, -42, -52]).astype(F)

    hair = K.Hair(head, cap=0.012, hairline=hairline, k=0.007)
    # swept fringe: from the crown-front, falling forward and sweeping to the character's right (-X)
    for i, (az, el, L, w, sw) in enumerate([(-35, 38, 0.13, 0.03, -0.25), (-15, 42, 0.14, 0.032, -0.35),
                                            (5, 44, 0.15, 0.033, -0.45), (25, 40, 0.14, 0.032, -0.5),
                                            (45, 34, 0.12, 0.03, -0.45), (-55, 30, 0.1, 0.028, -0.1)]):
        hair.clump(az, el, (sw, -0.75, -0.55), L, w, bend=(0, 0.25, -0.35), lift=0.003, tip_lift=0.012,
                   flat=0.42)
    # sides over the ears
    for s in (1, -1):
        for az, el, L in ((75, 22, 0.13), (100, 18, 0.14), (120, 15, 0.14)):
            hair.clump(s * az, el, (s * 0.15, 0.1, -1.0), L, 0.034, bend=(s * 0.05, 0.05, 0), lift=0.002,
                       tip_lift=0.016, flat=0.45)
    # back, flaring at the nape
    for az in (140, 160, 180, 200, 220):
        a = math.radians(az)
        hair.clump(az, 25, (math.sin(a) * 0.2, 0.35, -1.0), 0.17, 0.038, bend=(math.sin(a) * 0.08, 0.12, 0.0),
                   lift=0.002, tip_lift=0.02, flat=0.45)
    # messy crown tufts
    for az, el, d in ((150, 70, (0.3, 0.6, 0.6)), (200, 65, (-0.4, 0.7, 0.4)), (100, 62, (0.8, 0.2, 0.5)),
                      (250, 60, (-0.8, 0.3, 0.4)), (180, 80, (0.0, 0.8, 0.7))):
        hair.clump(az, el, d, 0.09, 0.03, bend=(0, 0, -0.3), lift=0.004, tip_lift=0.028, flat=0.5)
    hair_f = hair.field()

    def paint_hair(ctx):
        n = ctx.n
        base = PT.fill(n, PT.hexc(HAIR))
        # lighter towards the tips/outer layer, darker near the scalp
        outer = np.clip(head.field(ctx.P) / 0.03, 0, 1)
        rgb = PT.mix(base * 0.7, PT.hexc(HAIR_HI), outer * 0.55)
        rgb = rgb * PT.strands(ctx.P, (0, 0, 1), 700, 0.22)[:, None]
        # a soft sheen band around the crown
        sheen = np.exp(-((ctx.P[:, 2] - (c[2] + 0.11)) / 0.025) ** 2) * np.clip(ctx.N[:, 2], 0, 1)
        rgb = rgb + (PT.hexc("#c08a62") - rgb) * (sheen * 0.35)[:, None]
        rgb = PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#2a1010", ao_amt=0.55, top_light=0.1,
                       cav_amt=0.45, edge_amt=0.15, z_range=(1.6, 1.9))
        return rgb

    # --- hands ----------------------------------------------------------------------------
    hands = S.union(A.hand(sk, 1), A.hand(sk, -1))

    def paint_hands(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        # ink stains on the right fingertips
        tips = np.clip((-ctx.P[:, 0] - 0.9) / 0.06, 0, 1) * (ctx.P[:, 0] < 0)
        ink = (S.fbm(ctx.P, 60, 3, 9) > 0.15) * tips
        rgb = PT.mix(rgb, PT.hexc("#1d2340"), ink * 0.8)
        knuckle = np.clip(ctx.cav, 0, 1)
        rgb = PT.mix(rgb, PT.hexc("#e89a8a"), knuckle * 0.3)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#a04050", ao_amt=0.5, top_light=0.0,
                        cav_amt=0.3, edge_amt=0.1)

    hand_bones = []
    for sd in ("l", "r"):
        hand_bones += [f"lowerarm_{sd}", f"hand_{sd}"] + [f"{f}_0{i}_{sd}" for f in ("index", "middle", "ring", "pinky", "thumb") for i in (1, 2, 3)]

    # --- robe: upper body, sleeves, collar ------------------------------------------------
    torso = A.torso(chest=(0.15, 0.108, 0.13), belly=(0.135, 0.1, 0.11), hips=(0.155, 0.115, 0.1))
    robe_body = S.offset(torso, 0.018)
    collar = S.round_cone(vec((0, 0.01, 1.43)), vec((0, 0.005, 1.56)), 0.082, 0.07)
    collar_hole = S.round_cone(vec((0, 0.012, 1.4)), vec((0, 0.006, 1.62)), 0.052, 0.054)
    sleeves = S.union(K.sleeve(sk, 1, radii=(0.06, 0.054, 0.062, 0.088), ext=0.075, open_depth=0.09, droop=0.025),
                      K.sleeve(sk, -1, radii=(0.06, 0.054, 0.062, 0.088), ext=0.075, open_depth=0.09, droop=0.025))

    def robe_up(P):
        d = robe_body(P)
        d = S.smin(d, collar(P), 0.03)
        d = S.smax(d, -collar_hole(P), 0.008)
        d = S.smin(d, sleeves(P), 0.035)
        d = S.smax(d, 0.96 - P[:, 2], 0.01)  # ends under the belt
        # torso folds: soft vertical pulls from the belt, a crease across the chest
        fold = 0.0035 * np.sin(np.arctan2(P[:, 0], -P[:, 1] + 0.02) * 9 + S.vnoise(P, 8, 4) * 1.5)
        fold = fold * S.smoothstep(1.3, 1.02, P[:, 2]) * (np.abs(P[:, 0]) < 0.25)
        return d + fold

    def constellation(P, N):
        """Faint embroidered star dots and joining threads, on the robe (accent mask)."""
        f1, f2, cid = S.voronoi(P, 22, 5, 0.9)
        star = (f1 < 0.0045) & (cid > 0.55)
        star = star.astype(F) * (0.6 + 0.4 * (cid > 0.8))
        edge = (np.abs(f2 - f1) < 0.0012) & (cid > 0.75)
        return np.clip(star + edge * 0.35, 0, 1)

    def paint_robe(ctx, base=0.9):
        rgb = PT.fill(ctx.n, (base, base, base))
        rgb = rgb * PT.weave(ctx.P, 520, 0.06)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.07, 6, 11, 0.0)
        rgb = PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#6a6a8a", ao_amt=0.6, top_light=0.14,
                       cav_amt=0.4, edge_amt=0.18, z_range=(0.1, 1.6))
        st = constellation(ctx.P, ctx.N)
        rgb = PT.mix(rgb, PT.fill(ctx.n, (1, 1, 1)), st * 0.5)
        return rgb, st * 0.45

    # --- robe skirt (open front) ----------------------------------------------------------
    skirt = K.skirt(1.03, 0.13, rx=(0.175, 0.33), ry=(0.135, 0.27), cy=0.02, thick=0.013, gap=(4, 17), folds=9,
                    fold_amp=0.012, fold_phase=0.6, hem_wave=0.012, flare=1.25)
    trim_band = K.skirt(1.03, 0.124, rx=(0.175, 0.33), ry=(0.135, 0.27), cy=0.02, thick=0.019, gap=(4, 17), folds=9,
                        fold_amp=0.012, fold_phase=0.6, hem_wave=0.012, flare=1.25)

    def trim(P):
        d = trim_band(P)
        # keep only the hem band and the front opening edges
        z = P[:, 2]
        th = np.degrees(np.abs(np.arctan2(P[:, 0], -(P[:, 1] - 0.02))))
        t = np.clip((1.03 - z) / 0.9, 0, 1)
        g = 4 + 13 * t
        near_edge = th - g  # degrees from the opening edge
        hem = 0.13 + 0.012 * np.sin(np.radians(th) * 9 + 0.6) - z
        keep = np.maximum(hem + 0.03, -(near_edge * 0.002 - 0.016 * (0.6 + t)))
        return S.smax(d, -keep, 0.003)

    def skirt_w(P):
        side_l = P[:, 0] > 0
        t = S.smoothstep(1.0, 0.45, P[:, 2])
        a = S.smoothstep(0.02, 0.14, np.abs(P[:, 0])) * np.where(P[:, 1] < 0.05, 0.9, 0.5)
        w = a * t
        low = S.smoothstep(0.55, 0.25, P[:, 2]) * a * 0.45
        return {"thigh_l": np.where(side_l, w - low, 0), "thigh_r": np.where(side_l, 0, w - low),
                "calf_l": np.where(side_l, low, 0), "calf_r": np.where(side_l, 0, low), "pelvis": 1 - w}

    def paint_trim(ctx):
        rgb = PT.fill(ctx.n, (0.92, 0.92, 0.94))
        stitch = (np.sin(ctx.P[:, 2] * 900 + ctx.P[:, 0] * 900) > 0.6) * 0.12
        rgb = rgb * (1 - stitch)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, top_light=0.1, cav_amt=0.3, edge_amt=0.2)

    # --- cuffs (secondary, ink stained) ---------------------------------------------------
    def cuff_field():
        fs = []
        for s in (1, -1):
            sd = "l" if s > 0 else "r"
            c0 = sk.tail(f"lowerarm_{sd}")
            ax = S.norm(c0 - sk.tail(f"upperarm_{sd}"))
            e = c0 + ax * 0.075 + vec((0, 0, -0.025))
            ring = S.round_cone(e - ax * 0.045, e - ax * 0.002, 0.083, 0.093)
            inner = S.round_cone(e - ax * 0.06, e + ax * 0.03, 0.074, 0.084)
            fs.append(S.ssub(ring, inner, 0.004))
        return S.union(*fs)
    cuffs = cuff_field()

    def paint_cuffs(ctx):
        rgb = PT.fill(ctx.n, (0.9, 0.9, 0.92))
        ink = np.clip(S.fbm(ctx.P, 45, 4, 21) * 2.2 - 0.2, 0, 1)
        rgb = PT.mix(rgb, PT.hexc("#2a3058"), ink * 0.75)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, top_light=0.05, cav_amt=0.3, edge_amt=0.15)

    # --- trousers and boots ----------------------------------------------------------------
    legs = A.legs(sk, thigh=(0.092, 0.065), calf=(0.064, 0.048), knee=0.06)

    def trousers(P):
        d = legs(P) - 0.004
        d = S.smax(d, P[:, 2] - 1.0, 0.02)
        d = S.smax(d, 0.22 - P[:, 2], 0.01)
        return d + 0.002 * np.sin(P[:, 2] * 70 + S.vnoise(P, 12, 7) * 2) * S.smoothstep(0.62, 0.5, P[:, 2])

    def paint_trousers(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#2c2f45"))
        rgb = rgb * PT.weave(ctx.P, 600, 0.08)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.4, edge_amt=0.12, z_range=(0, 1.2))

    boots = S.union(K.boot(sk, 1, top=0.31, cuff=0.01), K.boot(sk, -1, top=0.31, cuff=0.01))

    def paint_boots(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#5a3a26"))
        sole = ctx.P[:, 2] < 0.022
        rgb[sole] = PT.hexc("#2a1c14")
        rgb = PT.variation(rgb, ctx.P, 0.1, 20, 3, 0.02)
        scuff = np.clip(ctx.cav, 0, 1)
        rgb = PT.mix(rgb, PT.hexc("#a07a58"), scuff * 0.45)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, top_light=0.1, cav_amt=0.4, edge_amt=0.2,
                        z_range=(0, 0.35))

    boot_bones = ["calf_l", "foot_l", "ball_l", "calf_r", "foot_r", "ball_r"]

    # --- belt, satchel, strap -------------------------------------------------------------
    belt_band = K.belt_ring(1.02, 0.198, 0.152, cy=0.02, h=0.048, t=0.014)
    buckle = S.box((0.0, -0.137, 1.02), (0.026, 0.008, 0.024), rad=0.004)
    buckle_hole = S.box((0.0, -0.145, 1.02), (0.016, 0.02, 0.014), rad=0.002)

    def belt(P):
        return S.smin(belt_band(P), S.ssub(buckle, buckle_hole, 0.002)(P), 0.004)

    def paint_belt(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#6b4428"))
        brass = (np.abs(ctx.P[:, 0]) < 0.03) & (ctx.P[:, 1] < -0.125)
        rgb[brass] = PT.hexc("#d6a64a")
        rgb = PT.variation(rgb, ctx.P, 0.08, 25, 5, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.4, edge_amt=0.3)

    sc_ = vec((-0.235, -0.0, 0.9))
    bag = S.box(sc_, (0.035, 0.09, 0.075), rad=0.022)
    flap = S.box(sc_ + vec((-0.012, 0.0, 0.035)), (0.03, 0.095, 0.05), rad=0.016)
    quills = []
    for i, (dy, ang) in enumerate(((-0.05, 0.25), (-0.02, 0.1), (0.015, -0.1), (0.05, -0.28))):
        base = sc_ + vec((0.0, dy, 0.05))
        tip = base + vec((-0.02, 0.06 * ang, 0.17 + 0.02 * i))
        quills.append(S.capsule(base, tip, 0.004))
        mid = base * 0.3 + tip * 0.7
        quills.append(S.ellipsoid(mid, (0.004, 0.016, 0.045), S.frame(tip - base, (1, 0, 0))))

    def satchel(P):
        d = S.smin(bag(P), flap(P), 0.006)
        for q in quills:
            d = np.minimum(d, q(P))
        return d

    def paint_satchel(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#7a4c2c"))
        quill = ctx.P[:, 2] > 0.97
        rgb[quill] = PT.hexc("#efe6d2")
        tipq = ctx.P[:, 2] > 1.12
        rgb[tipq & quill] = PT.hexc("#d9cdb4")
        rgb = PT.variation(rgb, ctx.P, 0.1, 18, 8, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, cav_amt=0.5, edge_amt=0.3)

    up_shell = robe_up
    strap_pts = [vec((0.13, -0.02, 1.49)), vec((0.07, -0.13, 1.36)), vec((-0.02, -0.15, 1.22)),
                 vec((-0.11, -0.14, 1.1)), vec((-0.2, -0.09, 0.98))]
    back_pts = [vec((-0.21, 0.1, 0.99)), vec((-0.12, 0.14, 1.12)), vec((-0.02, 0.15, 1.25)), vec((0.08, 0.12, 1.4)),
                vec((0.13, 0.04, 1.5))]
    strap_f1, _ = K.band_on(up_shell, strap_pts, 0.036, 0.008, off=0.002)
    strap_f2, _ = K.band_on(up_shell, back_pts, 0.036, 0.008, off=0.002)
    strap = S.union(strap_f1, strap_f2)

    def paint_strap(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#4a2e1c"))
        rgb = PT.variation(rgb, ctx.P, 0.1, 30, 12, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.4, edge_amt=0.3)

    # --- scarf: neck wrap + one long tail down the back -----------------------------------
    wrap = S.torus((0.0, 0.01, 1.53), 0.072, 0.03, S.rot((1, 0, 0), 8))
    wrap2 = S.torus((0.0, 0.012, 1.495), 0.08, 0.028, S.rot((1, 0, 0), -6))
    tail_pts = [vec((0.06, 0.07, 1.5)), vec((0.08, 0.15, 1.38)), vec((0.075, 0.17, 1.2)), vec((0.065, 0.2, 1.0)),
                vec((0.05, 0.24, 0.8)), vec((0.045, 0.27, 0.62))]
    tail = S.tube(tail_pts, [0.05, 0.055, 0.058, 0.058, 0.056, 0.054], k=0.01, flat=0.22, up=(0, 1, 0))

    def scarf(P):
        d = S.smin(wrap(P), wrap2(P), 0.02)
        d = S.smin(d, tail(P), 0.03)
        d = S.smax(d, 0.585 - P[:, 2], 0.004)
        fold = 0.003 * np.sin(P[:, 2] * 60 + P[:, 0] * 80 + S.vnoise(P, 20, 31) * 2)
        return d + fold

    def scarf_w(P):
        z = P[:, 2]
        t = S.smoothstep(1.45, 1.3, z)
        w = {"neck_01": (1 - t) * 0.6, "spine_03": (1 - t) * 0.4 + t * S.smoothstep(1.05, 1.3, z)}
        w["spine_02"] = t * (1 - S.smoothstep(1.05, 1.3, z)) * S.smoothstep(0.8, 1.05, z)
        w["spine_01"] = t * (1 - S.smoothstep(0.8, 1.05, z))
        return w

    def paint_scarf(ctx):
        rgb = PT.fill(ctx.n, (1.0, 1.0, 1.0))
        rgb = rgb * PT.weave(ctx.P, 380, 0.1)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.08, 9, 41, 0.0)
        fringe = ctx.P[:, 2] < 0.62
        rgb[fringe] *= 0.85
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, top_light=0.1, cav_amt=0.4, edge_amt=0.2)

    clasp = S.ellipsoid((0.045, -0.085, 1.52), (0.016, 0.009, 0.016))

    def paint_clasp(ctx):
        return PT.fill(ctx.n, (1, 1, 1)), np.full(ctx.n, 0.9, F)

    upper_bones = ["spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r", "upperarm_l",
                   "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r", "pelvis"]
    leg_bones = ["pelvis", "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r"]

    return [
        Part("head", head.field, "fixed", vox=0.0011, tris=2300, weights=("auto", ["neck_01", "Head"], "Head"),
             paint=paint_head, texel=2.6, uv_angle=70),
        Part("hair", hair_f, "fixed", vox=0.0012, tris=2600, weights=("rigid", "Head"), paint=paint_hair,
             texel=1.2, cull=False),
        Part("hands", hands, "fixed", vox=0.001, tris=1500, weights=("auto", hand_bones, "hand_l"), paint=paint_hands,
             texel=1.4),
        Part("robe_top", robe_up, "primary", vox=0.0022, tris=2200, weights=("auto", upper_bones, "spine_03"),
             paint=paint_robe, texel=1.0),
        Part("cuffs", cuffs, "secondary", vox=0.0015, tris=500, weights=("auto", ["lowerarm_l", "lowerarm_r", "hand_l", "hand_r"], "lowerarm_l"),
             paint=paint_cuffs, texel=1.2),
        Part("skirt", skirt, "primary", vox=0.0025, tris=1900, weights=("fn", skirt_w), paint=paint_robe, texel=0.9),
        Part("trim", trim, "secondary", vox=0.0018, tris=900, weights=("fn", skirt_w), paint=paint_trim, texel=0.9),
        Part("trousers", trousers, "fixed", vox=0.0025, tris=900, weights=("auto", leg_bones, "pelvis"),
             paint=paint_trousers, texel=0.6),
        Part("boots", boots, "fixed", vox=0.0018, tris=900, weights=("auto", boot_bones, "foot_l"), paint=paint_boots,
             texel=1.0),
        Part("belt", belt, "fixed", vox=0.0015, tris=400, weights=("rigid", "pelvis"), paint=paint_belt, texel=1.0),
        Part("satchel", satchel, "fixed", vox=0.0012, tris=700, weights=("rigid", "pelvis"), paint=paint_satchel,
             texel=1.0, cull=False),
        Part("strap", strap, "fixed", vox=0.0015, tris=500, weights=("auto", ["spine_01", "spine_02", "spine_03", "pelvis", "clavicle_l"], "spine_02"),
             paint=paint_strap, texel=0.8, occlude=False),
        Part("scarf", scarf, "primary", vox=0.002, tris=1100, weights=("fn", scarf_w), paint=paint_scarf, texel=1.0),
        Part("clasp", clasp, "accent", vox=0.001, tris=120, weights=("rigid", "spine_03"), paint=paint_clasp,
             texel=0.6, occlude=False, cull=False),
    ]
