# FIRSTLIGHT sculpted props: the Winged Boarspear (docs/content.md §2.3, melee; any starter can carry it).
#
# Brief: a hunter's short spear, made to hold a charging boar off. A leaf-shaped blade with a raised
# midrib on a forged socket; just under the blade two stubby wings (lugs) stick out sideways as a
# crossbar, so nothing runs up the shaft; an ash shaft with long grain, two rows of iron rivets through
# the socket, a waxed-cord binding where the socket ends, a leather grip and an iron butt cap.
# Feel: a farmhouse boar spear on two pegs over a hearth; a garden fork's honest forging; a fence post.
# Tie-breakers: plain and purposeful; at 10 m it reads as a long line ending in a bright cross: the leaf
# blade over the dark wings. That cross is the signature.
# Avoid (IP): a red tassel under a long, wavy blade (Chinese opera spears, Zhao Yun in Dynasty
# Warriors); a trident or any three-pointed head (Aquaman, Poseidon); a glowing blade or a lightning
# shape (Odin's Gungnir in Marvel films); a double-ended blade; runes, glyphs or any lettering. No glow:
# a plain tool. The palette tints only the grip leather (secondary).
# Weapon space (hold.py): origin = the grip, +Z = towards the blade, +Y = the blade's edge (up at rest).
# Our own code: MIT. The model and textures are CC BY 4.0.

import math

import numpy as np

import paint as PT
import ppaint as PP
import sdf as S
import shapes as SH
from part import Part

F = np.float32
SCAN = ((-0.07, -0.09, -0.62), (0.07, 0.09, 1.16))
VIEW = {"up": "z", "side": "y"}

Z_BUTT, Z_SOCK = -0.56, 0.80   # the shaft runs into the socket
Z_WING, Z_TIP = 0.865, 1.115
IRON, IRON_HI, IRON_LO = "#3f4348", "#b2bcc6", "#15171a"
STEEL, EDGE = "#a8b2bc", "#eef2f6"

# the leaf blade in the (y, z) plane, one side (mirrored): widest a third of the way up
LEAF = [(0.0, 0.875), (0.013, 0.885), (0.026, 0.915), (0.032, 0.950), (0.030, 0.990), (0.022, 1.040),
        (0.011, 1.085), (0.0, Z_TIP)]


def shaft_r(z):
    t = (z - Z_BUTT) / (Z_SOCK - Z_BUTT)
    return 0.0168 - 0.0018 * t


def shaft():
    zs = np.linspace(Z_BUTT + 0.02, Z_SOCK + 0.02, 12)
    f = S.tube([(0.0012 * math.sin(z * 4.3) * S.smoothstep(0.2, 0.4, abs(z)), 0, z) for z in zs], [shaft_r(z) for z in zs])
    # long, shallow grain: stretched along the shaft (short stretches read as bamboo nodes)
    return S.displace(f, lambda P: 0.0003 * S.fbm(P * F((1, 1, 0.035)), 110.0, 2, 21), 1.25)


def paint_shaft(ctx):
    P = ctx.P
    rgb = PP.wood(P, (0, 0, 1), "#c99a62", "#8a5f38", seed=21, knots=0.04)
    # darker where hands and earth have worked it: the butt end and around the grip
    grime = (1 - S.smoothstep(0.0, 0.12, P[:, 2] - Z_BUTT)) * 0.4 + (1 - S.smoothstep(0.14, 0.24, np.abs(P[:, 2]))) * 0.2
    rgb = PT.mix(rgb, PT.hexc("#4e3420"), np.clip(grime, 0, 0.6))
    return PP.shade(ctx, rgb, ao_amt=0.55, cav_amt=0.45, edge_amt=0.12)


_LEAF = SH.spline(LEAF, 30)
_PROFILE = SH.poly2d(np.concatenate([_LEAF, (_LEAF * F((-1, 1)))[::-1][1:-1]]))


def blade():
    def f(P):
        Q = P[:, 1:3]
        # a diamond section: 5 mm thick along the midrib, 0.9 mm at the edges
        half = 0.0009 + 0.0016 * np.clip(1 - np.abs(Q[:, 0]) / 0.03, 0, 1) ** 1.3 * 1.0
        rib = 0.0016 * np.clip(1 - np.abs(Q[:, 0]) / 0.006, 0, 1)
        return np.maximum(_PROFILE(Q), np.abs(P[:, 0]) - (half + rib)) / 1.2
    b = S.bounded(f, (-0.01, -0.04, 0.86), (0.01, 0.04, Z_TIP + 0.01), 0.008)
    return b


def wings():
    """Two stubby lugs out to the sides (±Y, in the blade's plane), forged out of a collar."""
    bar = S.capsule((0, -0.052, Z_WING), (0, 0.052, Z_WING), 0.0075)
    flat = lambda P: np.maximum(bar(P), np.abs(P[:, 0]) - 0.0055)  # noqa: E731
    collar = S.round_cone((0, 0, Z_WING - 0.012), (0, 0, Z_WING + 0.012), 0.0145, 0.0105)
    tips = [S.sphere((0, s * 0.053, Z_WING), 0.0085) for s in (-1, 1)]
    return S.smin_all([flat, collar] + tips, 0.006)


def socket():
    cone = S.round_cone((0, 0, Z_SOCK - 0.075), (0, 0, Z_WING - 0.01), 0.0195, 0.0132)
    rivets = [S.sphere((sx * 0.0192, 0, z), 0.0034) for sx in (-1, 1) for z in (Z_SOCK - 0.05, Z_SOCK - 0.01)]
    ring = S.torus((0, 0, Z_SOCK - 0.072), 0.0196, 0.0024)
    return S.smin_all([cone, ring] + rivets, 0.002)


def paint_iron(ctx):
    return PP.worked_metal(ctx, IRON, IRON_HI, IRON_LO, dents=200.0, band_dir=(0.5, 0.3, 0.8), band=0.3, seed=22)


def paint_blade(ctx):
    P = ctx.P
    rgb = PP.worked_metal(ctx, STEEL, "#e9eef3", "#3d4349", dents=0.0, band_dir=(0.1, 0.3, 1.0), band=0.25, seed=23)
    edge_d = -_PROFILE(P[:, 1:3])  # distance in from the edge
    honed = 1 - S.smoothstep(0.004, 0.008, edge_d)
    scratches = 0.9 + 0.1 * np.sin(PP.streaks(P, (0, 0.2, 1), 380.0, 30.0, 24) * 12)
    rgb = PT.mix(rgb, PT.fill(ctx.n, PT.hexc(EDGE)) * scratches[:, None], honed)
    # a darker fuller line either side of the midrib
    fuller = S.smoothstep(0.002, 0.0045, np.abs(P[:, 1])) * (1 - S.smoothstep(0.0045, 0.007, np.abs(P[:, 1])))
    fuller = fuller * S.smoothstep(0.89, 0.92, P[:, 2]) * (1 - S.smoothstep(1.05, 1.08, P[:, 2]))
    rgb = PT.mix(rgb, PT.hexc("#59616a"), fuller * 0.5)
    return np.clip(rgb, 0, 1)


def wrap():
    a, b = (0, 0, -0.12), (0, 0, 0.14)
    zc = (a[2] + b[2]) / 2
    body = S.cyl((0, 0, zc), 0.0205, (b[2] - a[2]) / 2, rad=0.003)

    def f(P):
        s, _, th = PP.axis_coords(P, a, b)
        _, gap = PP.helix(s, th, 0.022, 0.85)
        return body(P) + 0.001 * gap
    return S.bounded(lambda P: f(P) / 1.6, (-0.03, -0.03, -0.13), (0.03, 0.03, 0.15), 0.01)


def paint_wrap(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -0.12), (0, 0, 0.14))
    ph, gap = PP.helix(s, th, 0.022, 0.85)
    rgb = PT.fill(ctx.n, PT.hexc("#efe7da"))
    rgb = rgb * (1 - 0.4 * gap)[:, None] * (0.9 + 0.1 * np.sin(ph * math.pi))[:, None]
    rgb = PT.variation(rgb, ctx.P, 0.1, 60.0, 25)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5)


def cord():
    """Waxed cord: four turns just below the socket, three above the butt cap."""
    zs = [Z_SOCK - 0.09 - 0.0052 * i for i in range(4)] + [Z_BUTT + 0.07 + 0.0052 * i for i in range(3)]
    return S.union(*[S.torus((0, 0, z), shaft_r(z) + 0.0012, 0.0027) for z in zs])


def paint_cord(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -0.7), (0, 0, 0.9))
    twist = 0.5 + 0.5 * np.sin(th * 7 + s * 1400)
    rgb = PT.mix(PT.fill(ctx.n, PT.hexc("#6b4a2e")), PT.hexc("#3a2716"), twist * 0.6)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5)


def butt():
    cap = S.round_cone((0, 0, Z_BUTT + 0.055), (0, 0, Z_BUTT - 0.012), shaft_r(Z_BUTT) + 0.0022, 0.012)
    bead = S.torus((0, 0, Z_BUTT + 0.054), shaft_r(Z_BUTT) + 0.0024, 0.0021)
    return S.smin_all([cap, bead], 0.002)


def parts():
    shaft_p = Part("shaft", shaft(), "fixed", vox=0.0012, tris=380, paint=paint_shaft, texel=0.8, uv_angle=70, cull_eps=0.005)
    shaft_p.uv_bands = (2, 5)
    return [
        shaft_p,
        Part("blade", blade(), "fixed", vox=0.0006, tris=420, paint=paint_blade, texel=1.5),
        Part("wings", wings(), "fixed", vox=0.0007, tris=260, paint=paint_iron, texel=1.2),
        Part("socket", socket(), "fixed", vox=0.0007, tris=300, paint=paint_iron, texel=1.2),
        Part("wrap", wrap(), "secondary", vox=0.0007, tris=260, paint=paint_wrap, texel=1.1),
        Part("cord", cord(), "fixed", vox=0.0006, tris=220, paint=paint_cord, texel=0.9),
        Part("butt", butt(), "fixed", vox=0.0008, tris=140, paint=paint_iron, texel=1.0),
    ]
