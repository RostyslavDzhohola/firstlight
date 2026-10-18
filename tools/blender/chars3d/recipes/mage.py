# Orla the Lampwarden (working name; test character for the "models as code" method, 2026-10-18 report).
#
# Brief: a tall, slim elder who keeps the lamps lit for travellers. Calm, patient, a little wry; she
# moves slowly and precisely, then acts quickly when she means it.
# Feel references (how she should feel, not how to build her):
#   1. A heron standing in shallow water: tall, thin, still, a slight forward stoop, then a sudden strike.
#   2. A lighthouse keeper at dusk: unhurried, carries light for other people; the lantern is the character.
#   3. Paper lanterns at a night festival: warm light through layered cloth, soft swinging.
# Look: a floor-skimming plum robe built from separate panels (an under-robe split at the front and
# sides, a long front and back tabard that swing), a short scalloped capelet, a tall hood whose long tip
# droops down her back to a small copper bell, a long silver braid over her left shoulder, a wide sash
# knotted at the left hip with two trailing tails, wide trumpet sleeves, a caged copper lantern hanging
# from the sash at her right hip (accent glow), soft pointed slippers.
# Avoid (IP): a pointed brimmed hat; a long white beard; a grey robe with a grey hat; half-moon
# spectacles; a staff topped by a crystal ball or orb; a cobra staff; anything from Hexwick's list
# (round glasses, striped scarves, owls, brooms) and Brother Ash's (brown robe over a cream tunic with a
# belted sash, face guard). She carries no weapon in the mesh: the game's weapons attach to the hand.
#
# Extra bones (added on top of the shared 65-joint skeleton, see EXTRA_BONES): hood tip, braid, front
# and back tabard, sash tails, lantern. The shared clips leave them at rest; tools/blender/chars3d
# swing.py bakes their follow-through into every clip for this character.
# Our own code: MIT. The model is CC BY 4.0.

import numpy as np

import anat as A
import kit as K
import paint as PT
import sdf as S
from part import Part
from skel import Skel
from sdf import vec

F = np.float32
SKIN = "#d9a988"
HAIR = "#c9ccd4"
HAIR_DARK = "#8d93a0"
COPPER = "#c4703c"

# name: (parent, head, tail) in the rest pose (metres, T-pose, facing -Y)
EXTRA_BONES = {
    "hood_01": ("Head", (0.0, 0.12, 1.86), (0.0, 0.215, 1.80)),
    "hood_02": ("hood_01", (0.0, 0.215, 1.80), (0.0, 0.25, 1.62)),
    "braid_01": ("Head", (0.085, 0.0, 1.64), (0.115, -0.085, 1.44)),
    "braid_02": ("braid_01", (0.115, -0.085, 1.44), (0.115, -0.12, 1.24)),
    "braid_03": ("braid_02", (0.115, -0.12, 1.24), (0.112, -0.13, 1.06)),
    "panel_f_01": ("pelvis", (0.0, -0.13, 0.98), (0.0, -0.17, 0.56)),
    "panel_f_02": ("panel_f_01", (0.0, -0.17, 0.56), (0.0, -0.2, 0.08)),
    "panel_b_01": ("pelvis", (0.0, 0.15, 0.98), (0.0, 0.2, 0.56)),
    "panel_b_02": ("panel_b_01", (0.0, 0.2, 0.56), (0.0, 0.24, 0.06)),
    "sash_01": ("pelvis", (0.15, -0.09, 0.98), (0.18, -0.11, 0.74)),
    "sash_02": ("sash_01", (0.18, -0.11, 0.74), (0.19, -0.12, 0.5)),
    "lantern_01": ("pelvis", (-0.2, -0.06, 0.975), (-0.25, -0.068, 0.77)),
}


# vertex sets the clip check watches besides the hands: (bones whose dominant weight marks the set, tolerance m)
CLIP_CHECK_SETS = {
    "lantern": (["lantern_01"], 0.015),
    "braid": (["braid_02", "braid_03"], 0.015),
    "hood_tip": (["hood_02"], 0.015),
    "tabard_f": (["panel_f_02"], 0.02),
    "tabard_b": (["panel_b_02"], 0.02),
    "sash": (["sash_02"], 0.015),
}


def chain_w(pts, bones, base, blend=0.25, reach=(0.06, 0.1)):
    """Weights along a bone chain: pts has len(bones)+1 points (bone i spans pts[i]..pts[i+1]); points
    near the start of the chain, or farther than reach (metres, soft) from it, belong to `base` (the bone
    the chain hangs from)."""
    pts = [np.asarray(p, F) for p in pts]

    def f(P):
        best = np.full(len(P), np.inf, F)
        s = np.zeros(len(P), F)
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            ab = b - a
            t = np.clip(((P - a) @ ab) / float(ab @ ab), 0, 1)
            q = a + t[:, None] * ab
            d = np.linalg.norm(P - q, axis=1)
            m = d < best
            best[m] = d[m]
            s[m] = i + t[m]
        on = S.smoothstep(0.0, blend, s) * (1 - S.smoothstep(reach[0], reach[1], best))
        out = {base: 1 - on}
        for i, b in enumerate(bones):
            # each bone owns its span, blending into the next across the joint
            w = np.clip(1 - np.abs(s - (i + 0.5)) / 0.75, 0, 1)
            if i == len(bones) - 1:
                w = np.maximum(w, (s > i + 0.5).astype(F))
            if i == 0:
                w = np.maximum(w, (s < 0.5).astype(F))
            out[b] = w * on
        return out
    return f


def parts():
    sk = Skel()
    HS = 1.06  # a slightly smaller head than the young starters: reads older and taller
    head = A.Head(c=(0.0, 0.0, 1.742), scale=HS, eye_w=0.034, eye_h=0.036, neck_r=0.042,
                  profile={"w": [(-0.104, 0.044), (-0.081, 0.068), (-0.054, 0.088), (-0.027, 0.1), (0.0, 0.106),
                                 (0.03, 0.112)]},
                  chin={"z": -0.104, "y": -0.064, "r": (0.042, 0.034, 0.03)},
                  nose=(0.0, -0.126, -0.03), nose_r=(0.011, 0.013, 0.02), nose_tip=0.008, brow=0.004)
    c = head.c
    face = PT.Face(iris="#7c9a6a", iris_dark="#2e4030", lash="#4a4a52", brow="#a8acb6", brow_w=0.0038,
                   brow_tilt=0.0025, brow_lift=0.002, smile=0.0035, eye_w=0.034, eye_h=0.036, iris_r=0.0138,
                   lid=0.28, lower_lid=0.1, blush_amt=0.22, look=(0.05, -0.02), mouth_w=0.013)

    def paint_head(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        rgb = PT.variation(rgb, ctx.P, 0.035, 14, 2, 0.01)
        rgb = PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#a0605a", ao_amt=0.35, top_light=0.05,
                       cav_amt=0.18, edge_amt=0.06, z_range=(1.45, 1.9))
        u, v = head.face_uv(ctx.P)
        front = head.front(ctx.P, ctx.N)
        rgb, _ = face.paint(rgb, u, v, front)
        # age lines: crow's feet at the outer eye corners and soft smile lines (painted, not sculpted)
        au = np.abs(u)
        crow = sum(PT.stroke(au, v, [(0.064, 0.004 + dv), (0.074, 0.008 + dv * 1.6)], [0.0007, 0.0003])
                   for dv in (-0.006, 0.0, 0.006))
        smile = PT.stroke(au, v, [(0.024, -0.035), (0.03, -0.055), (0.026, -0.072)], [0.0009, 0.0011, 0.0004])
        rgb = PT.mix(rgb, rgb * 0.78, np.clip(crow + smile * 0.8, 0, 1) * front)
        return rgb

    # --- hands: long and thin ----------------------------------------------------------------------
    hands = S.union(A.hand(sk, 1, scale=1.06, finger_r=0.0092, palm=(0.046, 0.016)),
                    A.hand(sk, -1, scale=1.06, finger_r=0.0092, palm=(0.046, 0.016)))

    def paint_hands(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(SKIN))
        rgb = PT.mix(rgb, PT.hexc("#c98a78"), np.clip(ctx.cav, 0, 1) * 0.35)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#904050", ao_amt=0.45, top_light=0.0,
                        cav_amt=0.3, edge_amt=0.1)

    hand_bones = []
    for sd in ("l", "r"):
        hand_bones += [f"lowerarm_{sd}", f"hand_{sd}"] + [f"{f}_0{i}_{sd}" for f in ("index", "middle", "ring", "pinky", "thumb") for i in (1, 2, 3)]

    # --- legs (dark leggings, mostly hidden) and soft pointed slippers ----------------------------
    legs = A.legs(sk, thigh=(0.078, 0.056), calf=(0.054, 0.038), knee=0.05)

    def leggings(P):
        d = legs(P) - 0.002
        d = S.smax(d, P[:, 2] - 0.98, 0.02)
        return S.smax(d, 0.2 - P[:, 2], 0.01)

    def paint_leggings(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#2b2433"))
        rgb = rgb * PT.weave(ctx.P, 600, 0.06)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.5, cav_amt=0.3, edge_amt=0.1, z_range=(0, 1.0))

    def slipper(s):
        sd = "l" if s > 0 else "r"
        fx = float(sk.head(f"foot_{sd}")[0])
        base = K.boot(sk, s, top=0.24, width=0.86, toe=0.15, heel=0.07, round_toe=0.7, shaft_r=0.05)
        # the toe curls up into a soft point
        tip = S.round_cone(vec((fx, -0.15, 0.035)), vec((fx, -0.215, 0.07)), 0.03, 0.007)
        return lambda P: S.smin(base(P), tip(P), 0.03)
    slippers = S.union(slipper(1), slipper(-1))

    def paint_slippers(ctx):
        rgb = PT.fill(ctx.n, PT.hexc("#5b3a4a"))
        rgb[ctx.P[:, 2] < 0.018] = PT.hexc("#2a1c20")
        rgb = PT.variation(rgb, ctx.P, 0.08, 20, 3, 0.02)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=0.6, top_light=0.1, cav_amt=0.4, edge_amt=0.2,
                        z_range=(0, 0.3))


    # --- robe: slim closed upper body, high collar, trumpet sleeves --------------------------------
    # a smooth column rather than a body shape: chest and hips blended with a wide radius
    chest_e = S.ellipsoid((0, 0.008, 1.31), (0.15, 0.104, 0.17))
    hips_e = S.ellipsoid((0, 0.015, 1.0), (0.158, 0.118, 0.13))
    shoulders = S.capsule((0.14, 0.028, 1.43), (-0.14, 0.028, 1.43), 0.06)

    def robe_body(P):
        d = S.smin(chest_e(P), hips_e(P), 0.16)
        return S.smin(d, shoulders(P), 0.07)
    collar = S.round_cone(vec((0, 0.012, 1.44)), vec((0, 0.008, 1.6)), 0.078, 0.07)
    collar_hole = S.round_cone(vec((0, 0.014, 1.4)), vec((0, 0.01, 1.66)), 0.05, 0.052)
    sleeve_r = (0.058, 0.052, 0.062, 0.086)
    sleeves = S.union(K.sleeve(sk, 1, radii=sleeve_r, ext=0.13, open_depth=0.17, droop=0.07, folds=0.003),
                      K.sleeve(sk, -1, radii=sleeve_r, ext=0.13, open_depth=0.17, droop=0.07, folds=0.003))

    def robe_up(P):
        d = robe_body(P)
        d = S.smin(d, collar(P), 0.03)
        d = S.smax(d, -collar_hole(P), 0.008)
        d = S.smin(d, sleeves(P), 0.035)
        d = S.smax(d, 0.95 - P[:, 2], 0.01)  # ends under the sash
        # a few long vertical pulls (big, readable folds only)
        fold = 0.003 * np.sin(np.arctan2(P[:, 0], -P[:, 1] + 0.02) * 7 + S.vnoise(P, 6, 4) * 1.2)
        return d + fold * S.smoothstep(1.32, 1.0, P[:, 2]) * (np.abs(P[:, 0]) < 0.22)

    def paint_cloth(ctx, base=0.92, freq=520):
        rgb = PT.fill(ctx.n, (base, base, base))
        rgb = rgb * PT.weave(ctx.P, freq, 0.05)[:, None]
        rgb = PT.variation(rgb, ctx.P, 0.06, 6, 11, 0.0)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#5a4a6a", ao_amt=0.6, top_light=0.14,
                        cav_amt=0.4, edge_amt=0.16, z_range=(0.05, 1.6))

    # no hand bones: the wide sleeves follow the forearms (a cuff turning with the wrist looks broken)
    upper_bones = ["spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r", "upperarm_l",
                   "upperarm_r", "lowerarm_l", "lowerarm_r", "pelvis"]

    # --- under-robe: long, open at the front (the legs step through under the front tabard) ---------
    skirt = K.skirt(1.0, 0.07, rx=(0.16, 0.29), ry=(0.128, 0.25), cy=0.02, thick=0.012, gap=(12, 26), folds=8,
                    fold_amp=0.011, fold_phase=0.3, hem_wave=0.008, flare=1.3)

    def skirt_w(P):
        side_l = P[:, 0] > 0
        t = S.smoothstep(0.98, 0.45, P[:, 2])
        a = S.smoothstep(0.02, 0.14, np.abs(P[:, 0])) * np.where(P[:, 1] < 0.05, 0.9, 0.5)
        w = a * t
        low = S.smoothstep(0.55, 0.2, P[:, 2]) * a * 0.45
        return {"thigh_l": np.where(side_l, w - low, 0), "thigh_r": np.where(side_l, 0, w - low),
                "calf_l": np.where(side_l, low, 0), "calf_r": np.where(side_l, 0, low), "pelvis": 1 - w}

    # --- tabards: one long panel in front, one behind, each a slice of a slightly wider robe ----------
    def tabard(centre_deg, half_deg, z_hem, point):
        shell = K.skirt(1.0, z_hem - 0.05, rx=(0.172, 0.305), ry=(0.14, 0.27), cy=0.02, thick=0.014, flare=1.3)

        def f(P):
            d = shell(P)
            th = np.degrees(np.arctan2(P[:, 0], -(P[:, 1] - 0.02)))
            dth = np.abs((th - centre_deg + 180) % 360 - 180)
            r = np.sqrt(P[:, 0] ** 2 + (P[:, 1] - 0.02) ** 2)
            half = half_deg + 4 * S.smoothstep(0.95, 0.2, P[:, 2])  # widens a little towards the hem
            d = S.smax(d, np.radians(dth - half) * r, 0.004)
            hem = z_hem - point * (1 - np.clip(dth / half_deg, 0, 1))  # pointed hem
            return S.smax(d, hem - P[:, 2], 0.004)
        return f
    tab_f = tabard(0, 20, 0.11, 0.05)
    tab_b = tabard(180, 26, 0.09, 0.04)

    def panel_w(bone):
        def f(P):
            z = P[:, 2]
            top = S.smoothstep(0.98, 0.8, z)  # pelvis-held at the waist
            lower = S.smoothstep(0.62, 0.42, z)
            return {"pelvis": 1 - top, f"{bone}_01": top * (1 - lower), f"{bone}_02": top * lower}
        return f

    def paint_tabard(ctx):
        rgb = paint_cloth(ctx, 0.92, 480)
        # a woven border just inside the edges and the hem: lamp-flame lozenges (secondary-ish, darker)
        th = np.degrees(np.arctan2(ctx.P[:, 0], -(ctx.P[:, 1] - 0.02)))
        side = np.minimum(np.abs(np.abs(th) - 20), np.abs(np.abs(th) - 154))
        border = (side < 3.5) | (ctx.P[:, 2] < 0.2)
        rgb[border] *= 0.72
        loz = (np.abs(np.sin(ctx.P[:, 2] * 70)) + np.abs(np.sin(th * 0.6))) < 0.5
        return PT.mix(rgb, PT.fill(ctx.n, (1, 1, 1)), (loz & border) * 0.5)

    # --- capelet: a short scalloped shoulder cape over the robe; it rides on the shoulders only (following
    #     the upper arms turned it into square pads once the arms come down from the T-pose) ---------------------------------------
    def capelet(P):
        base = robe_up(P)
        d = S.smax(base - 0.02, -(base - 0.007), 0.004)
        x, y = P[:, 0], P[:, 1] - 0.02
        th = np.arctan2(x, -y)
        r = np.sqrt(x * x + y * y)
        reach = 0.255 + 0.012 * np.cos(th * 8)  # scalloped edge out along the arms
        d = S.smax(d, r - reach, 0.006)
        low = 1.3 + 0.014 * np.cos(th * 8)
        d = S.smax(d, low - P[:, 2], 0.006)
        return S.smax(d, P[:, 2] - 1.6, 0.01)

    def paint_capelet(ctx):
        rgb = paint_cloth(ctx, 0.9, 400)
        x, y = ctx.P[:, 0], ctx.P[:, 1] - 0.02
        th = np.arctan2(x, -y)
        r = np.sqrt(x * x + y * y)
        edge = (r > 0.255 + 0.012 * np.cos(th * 8) - 0.018) | (ctx.P[:, 2] < 1.3 + 0.014 * np.cos(th * 8) + 0.018)
        rgb[edge] = rgb[edge] * 0.75
        return rgb

    # --- hood: tall, framing the face, the tip drooping down the back to a bell -----------------------
    hood_o = S.ellipsoid(c + vec((0.0, 0.018, 0.04)), (0.148, 0.162, 0.172))
    hood_i = S.ellipsoid(c + vec((0.0, 0.02, 0.03)), (0.13, 0.146, 0.156))
    tip_pts = [vec((0.0, 0.03, 1.93)), vec((0.0, 0.12, 1.875)), vec((0.0, 0.215, 1.8)), vec((0.0, 0.25, 1.64))]
    tip = S.tube(tip_pts, [0.075, 0.05, 0.034, 0.015], k=0.01, flat=0.75, up=(1, 0, 0))
    drape_o = S.round_cone(c + vec((0.0, 0.03, -0.29)), c + vec((0.0, 0.025, -0.07)), 0.16, 0.13)
    drape_i = S.round_cone(c + vec((0.0, 0.03, -0.32)), c + vec((0.0, 0.025, -0.07)), 0.145, 0.115)
    face_hole = S.ellipsoid(c + vec((0.0, -0.17, -0.02)), (0.098, 0.13, 0.14))

    def hood(P):
        d = S.smin(hood_o(P), tip(P), 0.04)
        d = S.smin(d, drape_o(P), 0.05)
        inner = S.smin(hood_i(P), drape_i(P), 0.04)
        d = S.smax(d, -inner, 0.006)
        d = S.smax(d, -face_hole(P), 0.012)
        d = S.smax(d, 1.47 - P[:, 2], 0.01)  # tucks into the capelet
        return d + 0.0025 * np.sin(np.arctan2(P[:, 0], P[:, 1]) * 6 + S.vnoise(P, 8, 5)) * S.smoothstep(1.7, 1.5, P[:, 2])

    hood_w_chain = chain_w([vec((0.0, 0.1, 1.885)), vec((0.0, 0.215, 1.8)), vec((0.0, 0.25, 1.62))],
                           ["hood_01", "hood_02"], "Head", blend=0.35,
                           reach=(0.06, 0.1))

    def hood_w(P):
        w = hood_w_chain(P)
        # the drape below the head follows the neck and upper spine
        low = S.smoothstep(1.62, 1.5, P[:, 2])
        out = {k: v * (1 - low) for k, v in w.items()}
        out["neck_01"] = low * 0.6
        out["spine_03"] = low * 0.4
        return out

    def paint_hood(ctx):
        rgb = paint_cloth(ctx, 0.9, 420)
        # a darker lining inside the face opening
        towards_face = np.einsum("ij,ij->i", ctx.N, ctx.P - c) < 0  # the inner surface faces the head
        inside = (head.field(ctx.P) < 0.035) & towards_face
        rgb[inside] *= 0.55
        return rgb

    bell = S.union(S.round_cone(vec((0.0, 0.252, 1.635)), vec((0.0, 0.256, 1.585)), 0.012, 0.022),
                   S.sphere(vec((0.0, 0.257, 1.578)), 0.007))

    def paint_copper(ctx):
        rgb = PT.fill(ctx.n, PT.hexc(COPPER))
        rgb = PT.variation(rgb, ctx.P, 0.1, 40, 8, 0.03)
        rgb = PT.mix(rgb, PT.hexc("#6fa08a"), np.clip(-ctx.cav, 0, 1) * 0.5)  # verdigris in the recesses
        rgb = PT.mix(rgb, PT.hexc("#ffd0a0"), np.clip(ctx.cav, 0, 1) * 0.4)
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#3a2010", ao_amt=0.6, cav_amt=0.5, edge_amt=0.3)

    # --- hair: a swept front under the hood and one long braid over the left shoulder -----------------
    def hairline(az, el):
        a = np.abs(az)
        return np.interp(a, [0, 30, 70, 110, 180], [12, 8, -8, -30, -50]).astype(F)

    hair = K.Hair(head, cap=0.012, hairline=hairline, k=0.01)
    for sgn in (1, -1):  # centre parting, swept back to each side under the hood
        for az, el, L in ((6, 52, 0.11), (24, 44, 0.11), (44, 32, 0.1)):
            hair.clump(sgn * az, el, (sgn * 0.8, 0.45, -0.25), L, 0.05, bend=(0, 0.1, -0.15), lift=0.003,
                       tip_lift=0.008, flat=0.6)
    hair_cap = hair.field()
    braid_pts = [vec((0.088, 0.005, 1.63)), vec((0.112, -0.07, 1.47)), vec((0.118, -0.115, 1.33)),
                 vec((0.117, -0.128, 1.2)), vec((0.113, -0.132, 1.08))]
    lobes = []
    n_lobes = 11
    seg = np.array([np.linalg.norm(braid_pts[i + 1] - braid_pts[i]) for i in range(4)])
    cum = np.concatenate([[0], np.cumsum(seg)])
    for k in range(n_lobes):
        L = cum[-1] * (k + 0.5) / n_lobes
        i = min(int(np.searchsorted(cum, L) - 1), 3)
        t = (L - cum[i]) / seg[i]
        p = braid_pts[i] * (1 - t) + braid_pts[i + 1] * t
        ax = S.norm(braid_pts[i + 1] - braid_pts[i])
        side = S.norm(np.cross(ax, vec((0, -1, 0))))
        w = 0.042 * (1 - 0.3 * k / n_lobes)
        sgn = 1 if k % 2 == 0 else -1
        R = S.frame(ax + side * sgn * 0.35, (0, -1, 0))
        lobes.append(S.ellipsoid(p + side * sgn * w * 0.22, (w * 0.8, w * 1.2, w * 0.62), R))
    braid_tuft = S.round_cone(vec((0.113, -0.133, 1.06)), vec((0.112, -0.13, 0.98)), 0.02, 0.006)
    braid_core = S.smin_all(lobes, 0.01)

    def hair_all(P):
        d = S.smax(hair_cap(P), hood_o(P) + 0.008, 0.006)  # the front hair stays inside the hood
        d = S.smin(d, braid_core(P), 0.012)
        return S.smin(d, braid_tuft(P), 0.008)

    braid_w_chain = chain_w([vec((0.085, 0.0, 1.64)), vec((0.115, -0.085, 1.44)), vec((0.115, -0.12, 1.24)),
                             vec((0.11, -0.13, 0.96))],
                            ["braid_01", "braid_02", "braid_03"], "Head", blend=0.3,
                            reach=(0.05, 0.08))

    def hair_w(P):
        w = braid_w_chain(P)
        on_head = S.smoothstep(1.6, 1.66, P[:, 2]) * (head.field(P) < 0.03)
        out = {k: v * (1 - on_head) for k, v in w.items()}
        out["Head"] = out.get("Head", 0) + on_head
        return out

    def paint_hair(ctx):
        base = PT.fill(ctx.n, PT.hexc(HAIR))
        rgb = PT.mix(base, PT.hexc(HAIR_DARK), np.clip(-ctx.cav * 2, 0, 1) * 0.6)
        rgb = rgb * PT.strands(ctx.P, (0, 0, 1), 650, 0.16)[:, None]
        return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_tint="#404660", ao_amt=0.55, top_light=0.12,
                        cav_amt=0.45, edge_amt=0.12, z_range=(1.0, 1.9))

    braid_ring = S.torus(vec((0.113, -0.132, 1.07)), 0.019, 0.006, S.frame(vec((0, -0.03, -1.0)), (0, -1, 0)))

    # --- sash: wide band, a knot at the left hip, two tails ----------------------------------------------
    sash_band = K.belt_ring(1.0, 0.178, 0.142, cy=0.016, h=0.075, t=0.018, k=0.008)
    knot = S.ellipsoid(vec((0.158, -0.092, 0.995)), (0.035, 0.028, 0.04), S.rot((0, 1, 0), 20))
    tail_a = S.tube([vec((0.158, -0.105, 0.97)), vec((0.178, -0.122, 0.74)), vec((0.19, -0.14, 0.5))],
                    [0.04, 0.042, 0.046], k=0.004, flat=0.22, up=(0.35, -1, 0))
    tail_b = S.tube([vec((0.175, -0.088, 0.97)), vec((0.21, -0.105, 0.8)), vec((0.226, -0.118, 0.63))],
                    [0.032, 0.034, 0.036], k=0.004, flat=0.22, up=(0.6, -1, 0))

    def sash(P):
        d = S.smin(sash_band(P), knot(P), 0.02)
        d = S.smin(d, tail_a(P), 0.015)
        d = S.smin(d, tail_b(P), 0.015)
        return d

    sash_chain = chain_w([vec((0.158, -0.1, 0.96)), vec((0.18, -0.115, 0.74)), vec((0.19, -0.13, 0.5))],
                         ["sash_01", "sash_02"], "pelvis", blend=0.2,
                         reach=(0.05, 0.08))

    def sash_w(P):
        on_band = S.smoothstep(0.93, 0.96, P[:, 2])
        w = sash_chain(P)
        out = {k: v * (1 - on_band) for k, v in w.items()}
        out["pelvis"] = out.get("pelvis", 0) + on_band
        return out

    def paint_sash(ctx):
        rgb = paint_cloth(ctx, 0.9, 360)
        z = ctx.P[:, 2]
        stripe = (np.abs(z - 1.0) > 0.026) & (np.abs(z - 1.0) < 0.033)
        rgb[stripe] *= 0.7
        return rgb

    # --- lantern: a caged copper lamp hanging from the sash at the right hip (the glass glows) ----------
    lx, ly, ls = -0.25, -0.068, 1.3  # ls: lantern scale
    hook = S.capsule(vec((-0.2, -0.06, 0.975)), vec((lx, ly, 0.928)), 0.005)
    z0 = 0.925  # top of the cage; everything below hangs from here

    def lz(dz):
        return z0 - dz * ls
    cap_top = S.round_cone(vec((lx, ly, lz(0.025))), vec((lx, ly, lz(0.007))), 0.034 * ls, 0.012 * ls)
    ring_top = S.torus(vec((lx, ly, lz(0.0))), 0.009 * ls, 0.003 * ls, S.rot((1, 0, 0), 90))
    cap_bot = S.cyl(vec((lx, ly, lz(0.113))), 0.032 * ls, 0.008 * ls, rad=0.004)
    glass = S.ellipsoid(vec((lx, ly, lz(0.069))), (0.025 * ls, 0.025 * ls, 0.04 * ls))
    bars = [S.capsule(vec((lx + 0.029 * ls * np.cos(a), ly + 0.029 * ls * np.sin(a), lz(0.11))),
                      vec((lx + 0.029 * ls * np.cos(a), ly + 0.029 * ls * np.sin(a), lz(0.025))), 0.0038)
            for a in np.radians([45, 135, 225, 315])]

    def lantern_metal(P):
        d = S.union(hook, cap_top, ring_top, cap_bot, *bars)(P)
        return d

    def lantern(P):
        return np.minimum(lantern_metal(P), glass(P))

    def paint_lantern(ctx):
        metal = lantern_metal(ctx.P) < glass(ctx.P)
        rgb = paint_copper(ctx)
        rgb[~metal] = PT.hexc("#ffe6b0")
        emis = (~metal).astype(F) * 0.95
        return rgb, emis

    boot_bones = ["calf_l", "foot_l", "ball_l", "calf_r", "foot_r", "ball_r"]
    leg_bones = ["pelvis", "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r"]

    return [
        Part("leggings", leggings, "fixed", vox=0.0025, tris=600, weights=("auto", leg_bones, "pelvis"),
             paint=paint_leggings, texel=0.5),
        Part("slippers", slippers, "secondary", vox=0.0016, tris=800, weights=("auto", boot_bones, "foot_l"),
             paint=paint_slippers, texel=0.9),
        Part("robe_top", robe_up, "primary", vox=0.0022, tris=1900, weights=("auto", upper_bones, "spine_03"),
             paint=paint_cloth, texel=1.0, single_side=True),
        Part("skirt", skirt, "secondary", vox=0.0025, tris=1400, weights=("fn", skirt_w), paint=paint_cloth,
             texel=0.8, single_side=True),
        Part("tabard_f", tab_f, "primary", vox=0.0022, tris=500, weights=("fn", panel_w("panel_f")),
             paint=paint_tabard, texel=0.9, single_side=True),
        Part("tabard_b", tab_b, "primary", vox=0.0022, tris=550, weights=("fn", panel_w("panel_b")),
             paint=paint_tabard, texel=0.9, single_side=True),
        Part("head", head.field, "fixed", vox=0.0011, tris=1900, weights=("auto", ["neck_01", "Head"], "Head"),
             paint=paint_head, texel=2.6, uv_angle=70),
        Part("capelet", capelet, "secondary", vox=0.002, tris=1100,
             weights=("auto", ["spine_03", "neck_01", "clavicle_l", "clavicle_r"], "spine_03"),
             paint=paint_capelet, texel=0.9, single_side=True),
        Part("hood", hood, "primary", vox=0.0018, tris=1800, weights=("fn", hood_w), paint=paint_hood, texel=1.0),
        Part("bell", bell, "fixed", vox=0.001, tris=160, weights=("rigid", "hood_02"), paint=paint_copper,
             texel=0.6, occlude=False, cull=False),
        Part("hair", hair_all, "fixed", vox=0.0013, tris=2200, weights=("fn", hair_w), paint=paint_hair, texel=1.1),
        Part("braid_ring", braid_ring, "fixed", vox=0.001, tris=160, weights=("rigid", "braid_03"),
             paint=paint_copper, texel=0.5, occlude=False, cull=False),
        Part("sash", sash, "secondary", vox=0.0018, tris=1000, weights=("fn", sash_w), paint=paint_sash, texel=0.9),
        Part("lantern", lantern, "fixed", vox=0.0009, tris=600, weights=("rigid", "lantern_01"),
             paint=paint_lantern, texel=0.8, occlude=False, cull=False),
        Part("hands", hands, "fixed", vox=0.001, tris=1800, weights=("auto", hand_bones, "hand_l"), paint=paint_hands,
             texel=1.4),
    ]
