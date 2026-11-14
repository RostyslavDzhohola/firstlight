# FIRSTLIGHT sculpted props: the Windlass Crossbow (docs/content.md §2.3, ranged; any starter can carry it).
#
# Brief: a heavy hunting crossbow with a steel prod. A long walnut tiller with an iron-shod butt, a broad
# flat steel prod lashed to the front with cord, a steel stirrup ahead of it for the foot when spanning, a
# horn nut holding the drawn string, a long iron trigger bar under the stock, and a small crank wheel
# on the butt's side (the windlass that spans it). A bolt sits loaded in the groove.
# Feel: a well-used farm tool with weight; a ship's capstan; a cast-iron mangle.
# Tie-breakers: heavy and mechanical; at 10 m it reads as a wide steel bar across a dark stock with a
# loop in front. The bright prod against the dark tiller is the signature.
# Avoid (IP): a repeating crossbow with a box magazine (Zhuge nu as in Dynasty Warriors, Van Helsing's
# rapid-fire one); a pistol crossbow on the wrist (Assassin's Creed); a compound bow's cams and
# scopes (The Walking Dead's Daryl Dixon); dragon or skull carvings; runes or lettering. No glow. The
# palette tints only the leather cheek wrap (secondary).
# Weapon space (hold.py): held like the guns (GUN = True: Avatars.ts GUN_GRIP): origin = the hand under
# the stock, +Z = forward (where the bolt flies), +Y = up (the stock's top), +X = right. Metres.
# Our own code: MIT. The model and textures are CC BY 4.0.

import math

import numpy as np

import paint as PT
import ppaint as PP
import sdf as S
import shapes as SH
from part import Part

F = np.float32
SCAN = ((-0.36, -0.12, -0.42), (0.36, 0.12, 0.50))
VIEW = {"up": "y", "side": "z"}
GUN = True

Y_TOP = 0.062          # the top of the tiller (the bolt groove)
Z_BUTT, Z_NOSE = -0.38, 0.33
Z_PROD = 0.30
Z_NUT = 0.02
HALF_SPAN = 0.33       # the prod's tips
STEEL, STEEL_HI, STEEL_LO = "#9aa5b0", "#eef3f7", "#2c3237"
IRON, IRON_HI, IRON_LO = "#3d4146", "#aab4be", "#141618"


def tiller_section(z):
    """Half width and the bottom of the stock along it: deep at the butt (for the shoulder), slim in
    front; the hand rests under it at the origin."""
    t = (z - Z_BUTT) / (Z_NOSE - Z_BUTT)
    half_w = 0.024 - 0.006 * t
    bottom = -0.035 + (0.012 if z > 0.06 else 0.0)
    if z < -0.12:  # the butt drops down for the shoulder
        bottom = -0.035 - 0.035 * S.smoothstep(-0.12, Z_BUTT + 0.04, z)
    return half_w, bottom


def tiller():
    zs = np.linspace(Z_BUTT, Z_NOSE, 12)
    secs = [tiller_section(float(z)) for z in zs]
    zz = np.array(zs, F)
    hw = np.array([s[0] for s in secs], F)
    bt = np.array([s[1] for s in secs], F)

    def f(P):
        z = np.clip(P[:, 2], Z_BUTT, Z_NOSE)
        w = np.interp(z, zz, hw)
        b = np.interp(z, zz, bt)
        yc, hy = (Y_TOP + b) / 2, (Y_TOP - b) / 2
        r = 0.008
        qx = np.abs(P[:, 0]) - (w - r)
        qy = np.abs(P[:, 1] - yc) - (hy - r)
        qz = np.abs(P[:, 2] - (Z_BUTT + Z_NOSE) / 2) - ((Z_NOSE - Z_BUTT) / 2 - r)
        q = np.stack([qx, qy, qz], 1)
        out = np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(np.max(q, axis=1), 0) - r
        # the bolt groove along the top, 5 mm wide and 3 mm deep, from the nut forward
        groove = np.maximum(np.abs(P[:, 0]) - 0.0026, np.maximum(-(P[:, 1] - (Y_TOP - 0.003)), np.maximum(Z_NUT - P[:, 2], P[:, 2] - Z_NOSE - 0.01)))
        return np.maximum(out, -groove) / 1.1
    return S.bounded(f, (-0.03, -0.1, Z_BUTT - 0.01), (0.03, 0.075, Z_NOSE + 0.01), 0.01)


def paint_tiller(ctx):
    P = ctx.P
    rgb = PP.wood(P, (0, 0, 1), "#7a4e2e", "#3f2615", seed=31, knots=0.03)
    worn = (1 - S.smoothstep(0.0, 0.08, np.abs(P[:, 2] + 0.02))) * 0.25
    rgb = PT.mix(rgb, PT.hexc("#a8774a"), worn)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5, edge_amt=0.15)


def prod_curve(n=20):
    """The prod's centre line: across X, curving forward at the middle (a recurve's belly) and back at the tips."""
    pts = []
    for i in range(n):
        t = i / (n - 1) * 2 - 1
        x = t * HALF_SPAN
        z = Z_PROD + 0.012 - 0.07 * t * t + 0.02 * t ** 4
        pts.append((x, Y_TOP - 0.008, z))
    return pts


def prod():
    """A flat steel band: 9 mm thick, 32 mm tall at the middle tapering to 16 mm at the tips."""
    yc = Y_TOP - 0.008
    core = S.tube(prod_curve(), [0.0045] * 20)

    def f(P):
        Q = P.copy()
        Q[:, 1] = yc  # distance across the band's thickness only (in the XZ plane)
        t = np.clip(np.abs(P[:, 0]) / HALF_SPAN, 0, 1)
        half_h = 0.016 - 0.008 * t
        return np.maximum(core(Q), np.abs(P[:, 1] - yc) - half_h)
    tips = [S.sphere((s * HALF_SPAN, yc, Z_PROD + 0.012 - 0.05), 0.0075) for s in (-1, 1)]
    flat = S.bounded(f, (-HALF_SPAN - 0.02, yc - 0.022, Z_PROD - 0.08), (HALF_SPAN + 0.02, yc + 0.022, Z_PROD + 0.03), 0.01)
    return S.smin_all([flat] + tips, 0.004)


def paint_prod(ctx):
    rgb = PP.worked_metal(ctx, STEEL, STEEL_HI, STEEL_LO, dents=60.0, band_dir=(1.0, 0.2, 0.1), band=0.35, seed=32)
    # blued temper at the middle, fading out along the limbs
    blue = (1 - S.smoothstep(0.03, 0.12, np.abs(ctx.P[:, 0]))) * 0.35
    return np.clip(PT.mix(rgb, PT.hexc("#4b5d78"), blue), 0, 1)


def string():
    """The drawn string: from each prod tip back to the nut."""
    tip_z = Z_PROD + 0.012 - 0.05
    nut = (0, Y_TOP + 0.004, Z_NUT)
    return S.union(*[S.capsule((s * (HALF_SPAN - 0.004), Y_TOP - 0.006, tip_z - 0.004), nut, 0.0022) for s in (-1, 1)])


def paint_string(ctx):
    s, _, th = PP.axis_coords(ctx.P, (-0.3, 0.06, 0.02), (0.3, 0.06, 0.02))
    twist = 0.5 + 0.5 * np.sin(th * 5 + s * 900)
    rgb = PT.mix(PT.fill(ctx.n, PT.hexc("#e4d6b4")), PT.hexc("#a8956a"), twist * 0.5)
    return PP.shade(ctx, rgb, ao_amt=0.4, cav_amt=0.3)


def lashing():
    """Cord binding the prod to the tiller's nose: three turns round the prod either side of the stock."""
    fs = []
    for x in (-0.034, -0.028, -0.022, 0.022, 0.028, 0.034):
        z = Z_PROD + 0.012 - 0.07 * (x / HALF_SPAN) ** 2
        fs.append(S.torus((x, Y_TOP - 0.008, z), 0.0145, 0.0026, Rm=S.rot((0, 1, 0), 90)))
    return S.union(*fs)


def stirrup():
    """A steel D-loop ahead of the prod, angled down, for the foot when spanning."""
    y0 = Y_TOP - 0.03
    half = [(0.018, y0, Z_NOSE - 0.01), (0.04, y0 - 0.008, Z_NOSE + 0.035), (0.042, y0 - 0.024, Z_NOSE + 0.08), (0.0, y0 - 0.034, Z_NOSE + 0.1)]
    pts = half + [(-x, y, z) for x, y, z in reversed(half[:-1])]
    return SH.smooth_tube(pts, [0.0058] * len(pts), 30)


def paint_iron(ctx):
    return PP.worked_metal(ctx, IRON, IRON_HI, IRON_LO, dents=220.0, band_dir=(0.5, 0.3, 0.8), band=0.3, seed=33)


def irons():
    """The nut (a horn roller on the top), the long trigger bar under the stock, the butt plate."""
    roll = S.capsule((-0.017, Y_TOP + 0.001, Z_NUT - 0.004), (0.017, Y_TOP + 0.001, Z_NUT - 0.004), 0.0095)
    bar = S.capsule((0, -0.036, -0.03), (0, -0.075, -0.17), 0.0055)
    pivot = S.capsule((-0.026, -0.03, -0.03), (0.026, -0.03, -0.03), 0.004)
    plate = S.box((0, (Y_TOP + tiller_section(Z_BUTT)[1]) / 2, Z_BUTT - 0.003), (0.026, (Y_TOP - tiller_section(Z_BUTT)[1]) / 2 + 0.002, 0.006), rad=0.003)
    return S.union(roll, bar, pivot, plate)


def crank():
    """The windlass: a small spoked wheel on the butt's right side with a turned handle."""
    c = (0.034, 0.0, -0.27)
    wheel = S.torus(c, 0.03, 0.0045, Rm=S.rot((0, 1, 0), 90))
    hub = S.capsule((0.024, 0.0, -0.27), (0.04, 0.0, -0.27), 0.009)
    spokes = [S.capsule((0.034, 0.0, -0.27), (0.034, 0.03 * math.cos(a), -0.27 + 0.03 * math.sin(a)), 0.0028) for a in (0.3, 0.3 + 2.094, 0.3 + 4.189)]
    handle = S.capsule((0.034, 0.03 * math.cos(0.3), -0.27 + 0.03 * math.sin(0.3)), (0.062, 0.03 * math.cos(0.3), -0.27 + 0.03 * math.sin(0.3)), 0.0048)
    return S.smin_all([wheel, hub, handle] + spokes, 0.003)


def bolt():
    """The loaded bolt: a short, thick shaft in the groove, a square steel head, two leather vanes."""
    y = Y_TOP + 0.002
    shaft = S.capsule((0, y, Z_NUT + 0.012), (0, y, Z_NOSE + 0.02), 0.0042)
    head = S.round_cone((0, y, Z_NOSE + 0.018), (0, y, Z_NOSE + 0.06), 0.0068, 0.0012)
    vanes = S.box((0, y + 0.007, Z_NUT + 0.04), (0.0012, 0.006, 0.022), rad=0.0008)
    return S.smin_all([shaft, head, vanes], 0.002)


def paint_bolt(ctx):
    P = ctx.P
    rgb = PP.wood(P, (0, 0, 1), "#c9a06a", "#8a6a44", seed=34)
    head = S.smoothstep(Z_NOSE + 0.014, Z_NOSE + 0.02, P[:, 2])
    rgb = PT.mix(rgb, PT.hexc("#8b949c"), head)
    vane = (1 - S.smoothstep(Z_NUT + 0.06, Z_NUT + 0.066, P[:, 2])) * S.smoothstep(Y_TOP + 0.005, Y_TOP + 0.007, P[:, 1])
    rgb = PT.mix(rgb, PT.hexc("#5a3b22"), vane)
    return PP.shade(ctx, rgb, ao_amt=0.5, cav_amt=0.4)


def wrap():
    """A leather cheek wrap round the stock behind the nut, where the face rests."""
    zc, hz = -0.13, 0.05
    hw, bt = tiller_section(zc)
    body = S.box((0, (Y_TOP + bt) / 2, zc), (hw + 0.0025, (Y_TOP - bt) / 2 + 0.0025, hz), rad=0.009)

    def f(P):
        ridge = 0.0008 * np.abs(np.sin((P[:, 2] - zc) * 260.0))
        return body(P) + ridge
    return S.bounded(lambda P: f(P) / 1.3, (-0.04, -0.09, zc - hz - 0.01), (0.04, 0.08, zc + hz + 0.01), 0.01)


def paint_wrap(ctx):
    rgb = PT.fill(ctx.n, PT.hexc("#ece4d6"))
    stitch = S.smoothstep(0.75, 0.95, np.sin((ctx.P[:, 2] + 0.13) * 260.0))
    rgb = rgb * (1 - 0.25 * stitch)[:, None]
    rgb = PT.variation(rgb, ctx.P, 0.1, 60.0, 35)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5)


def parts():
    till = Part("tiller", tiller(), "fixed", vox=0.0012, tris=460, paint=paint_tiller, texel=0.9, uv_angle=60, cull_eps=0.004)
    till.uv_bands = (2, 3)
    prod_p = Part("prod", prod(), "fixed", vox=0.0008, tris=380, paint=paint_prod, texel=1.2)
    prod_p.uv_bands = (0, 3)
    return [
        till,
        prod_p,
        Part("string", string(), "fixed", vox=0.0006, tris=90, paint=paint_string, texel=0.7),
        Part("lashing", lashing(), "fixed", vox=0.0006, tris=160, paint=paint_string, texel=0.9),
        Part("stirrup", stirrup(), "fixed", vox=0.0008, tris=200, paint=paint_iron, texel=1.0),
        Part("irons", irons(), "fixed", vox=0.0007, tris=300, paint=paint_iron, texel=1.1),
        Part("crank", crank(), "fixed", vox=0.0006, tris=260, paint=paint_iron, texel=1.1),
        Part("bolt", bolt(), "fixed", vox=0.0006, tris=180, paint=paint_bolt, texel=1.1),
        Part("wrap", wrap(), "secondary", vox=0.0008, tris=200, paint=paint_wrap, texel=1.1),
    ]
