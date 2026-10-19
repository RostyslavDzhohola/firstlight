# FIRSTLIGHT sculpted props: the Bearded Axe (docs/content.md §2.3, melee; any starter can carry it).
#
# Brief: a shipwright's bearded axe, a working tool. A hand-forged head whose long hooked beard drops
# back towards the haft, a bright honed band along the edge, dark hammer-dimpled cheeks and a squared
# poll; two riveted iron straps (langets) down the haft; a pale ash haft with a gentle curve and a
# flared knob at the butt, the end grain and its wedge showing on top of the eye; a leather grip bound
# with hemp cord at both ends.
# Feel: a shipwright's adze worn smooth; a cast-iron kettle (chunky, dark, friendly); a felling axe
# hung by a cabin door.
# Tie-breakers: chunky and honest; the bright edge against the dark head is what reads at 10 m.
# Avoid (IP): frost runes or a blue-glowing edge, a knotted leather wrap under the head (God of War's
# Leviathan Axe); a hammer head on the back or a branch for a haft (Marvel's Stormbreaker); dwarven
# knotwork (the Tolkien films); double-headed battle axes; runes, valknuts or any lettering. No glow:
# it is a plain tool. The palette tints only the grip leather (secondary).
# Weapon space (hold.py): origin = the grip, +Z = towards the head, +Y = the edge side (up at rest).
# Our own code: MIT. The model and textures are CC BY 4.0.

import math

import numpy as np

import paint as PT
import ppaint as PP
import sdf as S
import shapes as SH
from part import Part

F = np.float32
SCAN = ((-0.07, -0.09, -0.24), (0.07, 0.24, 0.68))
VIEW = {"up": "z", "side": "y"}

Z_BUTT, Z_TOP = -0.165, 0.593
EYE_Z0, EYE_Z1 = 0.442, 0.585
IRON, IRON_HI, IRON_LO = "#41454b", "#b4bec9", "#16181b"
EDGE = "#e3e9ef"

# blade profile in the (y, z) plane: top line, the cutting edge (toe to beard tip), the beard's underside
EDGE_PTS = [(0.150, 0.603), (0.163, 0.578), (0.169, 0.537), (0.167, 0.492), (0.158, 0.447), (0.142, 0.400),
            (0.124, 0.356), (0.104, 0.318)]
# the beard: a deep hook, its underside sweeping back up close to the haft
UNDER_PTS = [(0.104, 0.318), (0.095, 0.336), (0.081, 0.372), (0.063, 0.407), (0.045, 0.431), (0.031, 0.443),
             (0.024, 0.448)]  # scooped above the straight line: that notch is what makes it a beard
TOP_PTS = [(0.024, 0.574), (0.09, 0.588), (0.150, 0.603)]


def haft_off(z):
    """A gentle curve: the butt swings a little towards the edge side, the throat away from it."""
    return 0.007 * math.sin((z - 0.2) * 4.2)


def haft():
    zs = np.linspace(Z_BUTT + 0.02, Z_TOP, 10)
    core = S.tube([(0, haft_off(z), z) for z in zs], [0.0175] * len(zs))
    # oval section: 15.5 mm across, 20.5 mm deep (the edge direction)
    sx, sy = 0.0155 / 0.0175, 0.0205 / 0.0175
    oval = lambda P: core(P * F((1 / sx, 1 / sy, 1))) * min(sx, sy)  # noqa: E731
    knob = S.ellipsoid((0, haft_off(Z_BUTT) + 0.006, Z_BUTT + 0.012), (0.0185, 0.0255, 0.021))
    return S.smin_all([oval, knob], 0.02)


def paint_haft(ctx):
    P = ctx.P
    rgb = PP.wood(P, (0, 0, 1), "#d2a46c", "#94663d", seed=5)
    grime = (1 - S.smoothstep(0.12, 0.2, np.abs(P[:, 2] + 0.02))) * 0.25
    rgb = PT.mix(rgb, PT.hexc("#5a3c24"), grime)
    # end grain and the wedge on top of the eye
    top = S.smoothstep(Z_TOP - 0.004, Z_TOP - 0.001, P[:, 2])
    rings = 0.5 + 0.5 * np.sin(np.sqrt(P[:, 0] ** 2 + (P[:, 1] - haft_off(Z_TOP)) ** 2) * 900)
    end = PT.mix(PT.fill(ctx.n, PT.hexc("#c79a63")), PT.hexc("#8e6239"), rings * 0.5)
    wedge = (np.abs(P[:, 0]) < 0.0022) * top
    end = PT.mix(end, PT.hexc("#3b2a1c"), wedge)
    rgb = PT.mix(rgb, end, top)
    return PP.shade(ctx, rgb, ao_amt=0.55, cav_amt=0.45, edge_amt=0.12)


_EDGE = SH.spline(EDGE_PTS, 40)
_PROFILE = SH.poly2d(np.concatenate([SH.spline(TOP_PTS, 10)[:-1], _EDGE[:-1], SH.spline(UNDER_PTS, 14)[:-1],
                                     [(0.02, 0.52)]]))


def edge_dist(Q):
    """Distance (in the profile plane) to the cutting edge polyline."""
    d = np.full(len(Q), np.inf, F)
    for a, b in zip(_EDGE[:-1], _EDGE[1:]):
        e = b - a
        w = Q - a
        t = np.clip((w @ e) / float(e @ e), 0, 1)
        q = w - t[:, None] * e
        d = np.minimum(d, np.einsum("ij,ij->i", q, q))
    return np.sqrt(d)


def half_thickness(Q):
    """Edge 1.2 mm; a steep honed bevel for 12 mm, then the cheek, up to 13.5 mm by the eye."""
    d = edge_dist(Q)
    return np.minimum(0.0012 + 0.065 * np.minimum(d, 0.012) + 0.13 * np.clip(d - 0.012, 0, None), 0.0135)


def head():
    def blade(P):
        Q = P[:, 1:3]
        return np.maximum(_PROFILE(Q), np.abs(P[:, 0]) - half_thickness(Q)) / 1.15
    blade_b = S.bounded(blade, (-0.015, 0.015, 0.30), (0.015, 0.185, 0.615), 0.01)
    yc = haft_off(0.51)
    # the eye: a rounded socket, not a block; the cheeks flare out of it
    eye = S.box((0, yc + 0.002, (EYE_Z0 + EYE_Z1) / 2), (0.019, 0.027, (EYE_Z1 - EYE_Z0) / 2), rad=0.011)
    poll = S.box((0, yc - 0.034, 0.512), (0.017, 0.013, 0.044), rad=0.006)
    return S.smin_all([eye, poll, blade_b], 0.014)


def paint_head(ctx):
    rgb = PP.worked_metal(ctx, IRON, IRON_HI, IRON_LO, dents=170.0, band_dir=(0.6, 0.4, 0.7), band=0.3, seed=8)
    Q = ctx.P[:, 1:3]
    d = edge_dist(Q)
    honed = 1 - S.smoothstep(0.0105, 0.0125, d)
    scratches = 0.9 + 0.1 * np.sin(PP.streaks(ctx.P, (0, 0.3, 1), 400.0, 30.0, 4) * 12)
    steel = PT.mix(PT.fill(ctx.n, PT.hexc("#a9b3bd")), PT.hexc(EDGE), S.smoothstep(0.004, 0.0, d)) * scratches[:, None]
    rgb = PT.mix(rgb, steel, honed)
    # warm temper colours where the edge was heat-treated, just inside the honed band
    temper = S.smoothstep(0.012, 0.016, d) * (1 - S.smoothstep(0.016, 0.026, d))
    rgb = PT.mix(rgb, PT.hexc("#7b5a3a"), temper * 0.35)
    return np.clip(rgb, 0, 1)


def langets():
    fs = []
    for sx in (-1, 1):
        x = sx * 0.0162
        yc = haft_off(0.39)
        fs.append(S.box((x, yc, 0.392), (0.0016, 0.0072, 0.058), rad=0.0012))
        for z in (0.405, 0.36):
            fs.append(S.sphere((sx * 0.0176, yc, z), 0.0036))
    return S.union(*fs)


def paint_langets(ctx):
    return PP.worked_metal(ctx, IRON, IRON_HI, IRON_LO, dents=220.0, band=0.25, seed=12)


def wrap():
    a, b = (0, 0, -0.13), (0, 0, 0.095)
    zc = (a[2] + b[2]) / 2
    body = S.cyl((0, haft_off(zc), zc), 0.0215, (b[2] - a[2]) / 2, rad=0.003)

    def f(P):
        s, _, th = PP.axis_coords(P, a, b)
        _, gap = PP.helix(s, th, 0.021, 0.86)
        return body(P) + 0.0010 * gap
    return S.bounded(lambda P: f(P) / 1.6, (-0.03, -0.03, -0.14), (0.03, 0.04, 0.105), 0.01)


def paint_wrap(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -0.13), (0, 0, 0.095))
    ph, gap = PP.helix(s, th, 0.021, 0.86)
    rgb = PT.fill(ctx.n, PT.hexc("#f0e8dc"))
    rgb = rgb * (1 - 0.4 * gap)[:, None] * (0.9 + 0.1 * np.sin(ph * math.pi))[:, None]
    rgb = PT.variation(rgb, ctx.P, 0.1, 60.0, 6)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5)


def cord():
    """Three turns of hemp binding over each end of the leather."""
    zs = (-0.145, -0.1398, -0.1346, 0.0916, 0.0968, 0.102)
    return S.union(*[S.torus((0, haft_off(z), z), 0.0222, 0.0028) for z in zs])


def paint_cord(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -0.2), (0, 0, 0.2))
    twist = 0.5 + 0.5 * np.sin(th * 7 + s * 1400)
    rgb = PT.mix(PT.fill(ctx.n, PT.hexc("#d8c294")), PT.hexc("#9c8358"), twist * 0.6)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5)


def parts():
    return [
        Part("haft", haft(), "fixed", vox=0.0011, tris=380, paint=paint_haft, texel=0.9, uv_angle=70),
        Part("head", head(), "fixed", vox=0.0007, tris=720, paint=paint_head, texel=1.4),
        Part("langets", langets(), "fixed", vox=0.0006, tris=170, paint=paint_langets, texel=1.0),
        Part("wrap", wrap(), "secondary", vox=0.0007, tris=260, paint=paint_wrap, texel=1.1),
        Part("cord", cord(), "fixed", vox=0.0006, tris=200, paint=paint_cord, texel=0.9),
    ]
