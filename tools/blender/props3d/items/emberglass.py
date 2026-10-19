# FIRSTLIGHT sculpted props: the Emberglass Staff (docs/content.md §2.3, magic; any starter can carry it).
#
# Brief: a glassblower's staff. A long shaft of dark, heat-stained ash banded in copper ends in a
# hand-blown glass bulb with a live ember swirling inside, cupped by three forged copper tines that curl
# up around it like a flame and almost meet above it. A leather wrap where the hand goes, soot towards
# the head, a copper ferrule at the butt.
# Feel: the glowing gather on the end of a glassblower's pipe; a blacksmith's tongs; a firefly in a jar.
# Tie-breakers: warm and handmade; the glow is the point; at 10 m it reads as a long line with a bright
# teardrop at the top inside a three-pronged flame.
# Avoid (IP): a knotted wizard's staff gripping a white stone, or a black orb held in a claw (the
# Tolkien films); spiral-horn or crescent-moon heads; floating crystals; skulls; runes, glyphs or any
# lettering. The glass is always ember orange whatever the palette (like the Sunbrand blade, §8.2); the
# palette tints only the grip wrap (secondary).
# Weapon space (hold.py): origin = the grip, +Z = towards the head, +Y = up at rest. Metres.
# Our own code: MIT. The model and textures are CC BY 4.0.

import math

import numpy as np

import paint as PT
import ppaint as PP
import sdf as S
import shapes as SH
from part import Part

F = np.float32
SCAN = ((-0.12, -0.12, -0.5), (0.12, 0.12, 1.3))
VIEW = {"up": "z", "side": "y"}

Z_BUTT, Z_TOP = -0.40, 0.95
WOOD_L, WOOD_D = "#8a5e3c", "#4e3222"
COPPER, COPPER_HI, COPPER_LO = "#b8653a", "#ffc79a", "#4a2416"


def shaft_axis(z):
    """The shaft wanders a few millimetres (hand-cut), but stays straight through the grip."""
    w = S.smoothstep(0.22, 0.45, abs(z))
    return np.array((0.0025 * math.sin(z * 5.1 + 0.7) * w, 0.002 * math.sin(z * 3.7 + 2.0) * w, z), F)


def shaft_r(z):
    t = (z - Z_BUTT) / (Z_TOP - Z_BUTT)
    return 0.0186 - 0.0026 * t


def shaft():
    zs = np.linspace(Z_BUTT + 0.01, Z_TOP, 12)
    f = S.tube([shaft_axis(z) for z in zs], [shaft_r(z) for z in zs])
    # long, shallow grain: noise stretched ~30x along the shaft (short stretches read as bamboo nodes)
    return S.displace(f, lambda P: 0.00035 * S.fbm(P * F((1, 1, 0.035)), 110.0, 2, 4), 1.05)


def paint_shaft(ctx):
    P = ctx.P
    rgb = PP.wood(P, (0, 0, 1), WOOD_L, WOOD_D, seed=2, knots=0.05)
    soot = S.smoothstep(0.62, 0.93, P[:, 2]) * (0.65 + 0.35 * S.fbm(P, 60.0, 2, 9))
    rgb = PT.mix(rgb, PT.hexc("#1d1612"), np.clip(soot, 0, 0.85))
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5, edge_amt=0.1)


def wrap():
    a, b = (0, 0, -0.13), (0, 0, 0.15)
    body = S.cyl((0, 0, 0.01), 0.0218, 0.14, rad=0.003)

    def f(P):
        s, _, th = PP.axis_coords(P, a, b)
        _, gap = PP.helix(s, th, 0.024, 0.84)
        return body(P) + 0.0011 * gap
    return S.bounded(lambda P: f(P) / 1.6, (-0.03, -0.03, -0.14), (0.03, 0.03, 0.16), 0.01)


def paint_wrap(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -0.13), (0, 0, 0.15))
    ph, gap = PP.helix(s, th, 0.024, 0.84)
    rgb = PT.fill(ctx.n, PT.hexc("#ece6dc"))
    rgb = rgb * (1 - 0.35 * gap)[:, None] * (0.92 + 0.08 * np.sin(ph * math.pi))[:, None]
    rgb = PT.variation(rgb, ctx.P, 0.08, 70.0, 5)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5)


def bands():
    fs = []
    for z in (0.30, 0.58, 0.80):
        c = shaft_axis(z)
        fs.append(S.cyl(c, shaft_r(z) + 0.0032, 0.0065, rad=0.0022))
        fs.append(S.torus(c, shaft_r(z) + 0.003, 0.0016))
    # butt ferrule: a cap with a bead at its top
    fs.append(S.round_cone((0, 0, Z_BUTT + 0.075), (0, 0, Z_BUTT - 0.004), 0.0205, 0.0172))
    fs.append(S.torus((0, 0, Z_BUTT + 0.074), 0.0205, 0.0022))
    return S.union(*fs)


def paint_copper(ctx, dents=0.0):
    return PP.worked_metal(ctx, COPPER, COPPER_HI, COPPER_LO, dents=dents, band_dir=(0.4, 0.7, 0.3), band=0.4, seed=3)


def collar():
    cup = S.round_cone((0, 0, 0.905), (0, 0, 0.972), shaft_r(0.9) + 0.0012, 0.034)
    lip = S.torus((0, 0, 0.972), 0.034, 0.0045)
    beads = [S.sphere((0.0205 * math.cos(a), 0.0205 * math.sin(a), 0.935), 0.0035) for a in (0.5, 0.5 + 2.094, 0.5 + 4.189)]
    return S.smin_all([cup, lip] + beads, 0.003)


def paint_collar(ctx):
    rgb = paint_copper(ctx, dents=260.0)
    soot = S.smoothstep(0.93, 0.975, ctx.P[:, 2]) * 0.45
    return PT.mix(rgb, PT.hexc("#2a1810"), soot)


HS = 1.3  # head scale: at 1.0 the bulb (8 cm) read as a dot at character scale; today's crystal is 12 cm
Z_HEAD = 0.958


def hz(z):
    return Z_HEAD + (z - Z_HEAD) * HS


def bulb():
    body = S.ellipsoid((0, 0, hz(1.072)), (0.040 * HS, 0.040 * HS, 0.049 * HS))
    tip = S.round_cone((0, 0, hz(1.095)), (0, 0, hz(1.15)), 0.032 * HS, 0.008 * HS)
    neck = S.round_cone((0, 0, 0.962), (0, 0, hz(1.03)), 0.0165, 0.03 * HS)
    return S.smin_all([body, tip, neck], 0.03)


def paint_bulb(ctx):
    """Molten glass: a white-hot core seen through orange glass, swirling streaks, deep red at the neck."""
    P, N = ctx.P, ctx.N
    s, r, th = PP.axis_coords(P, (0, 0, 0.96), (0, 0, hz(1.17)), ref=(0, 1, 0))
    h = np.clip(s / (hz(1.17) - 0.96), 0, 1)
    swirl = np.sin(th * 2.0 + s * 70.0 + 2.5 * S.fbm(P, 40.0, 2, 11))
    streak = S.smoothstep(0.55, 0.95, swirl)
    core = S.smoothstep(0.75, 0.15, np.abs(h - 0.5) * 2) * (0.6 + 0.4 * streak)
    deep, mid, hot = PT.hexc("#b02c14"), PT.hexc("#ff7a22"), PT.hexc("#fff0bf")
    rgb = PT.mix(PT.fill(ctx.n, deep), mid, S.smoothstep(0.02, 0.35, h))
    rgb = PT.mix(rgb, PT.hexc("#ffb347"), streak * 0.7)
    rgb = PT.mix(rgb, hot, core * 0.85)
    # a cooler, glassier skin where the surface turns away (fresnel-ish on the side normals)
    side = 1 - np.abs(N[:, 2])
    glow = np.clip(0.55 + 0.45 * core + 0.2 * streak - 0.15 * (1 - h) * (h < 0.25), 0, 1)
    # a small painted catch-light, so it reads as glass and not as a lamp
    spec = S.smoothstep(0.9, 0.97, np.clip(N @ S.norm((0.35, 0.6, 0.72)), 0, 1))
    rgb = PT.mix(rgb, PT.hexc("#fffaf0"), spec * 0.8)
    return np.clip(rgb * (0.92 + 0.08 * side)[:, None], 0, 1), glow


def tine(k):
    """A forged tine rising from the collar, bellying out around the bulb and curling back in over its
    tip with a twist (the flame), ending in a small hammered ball."""
    a0 = math.radians(30 + 120 * k)
    zs = [0.958, 0.99, 1.03, 1.072, 1.11, 1.142, 1.165, 1.178]
    rs = [0.027, 0.044, 0.056, 0.058, 0.05, 0.036, 0.022, 0.014]
    tw = [0.0, 0.08, 0.18, 0.3, 0.42, 0.54, 0.66, 0.76]
    pts = [(r * HS * math.cos(a0 + t), r * HS * math.sin(a0 + t), hz(z)) for z, r, t in zip(zs, rs, tw)]
    radii = [0.0078, 0.0072, 0.0066, 0.006, 0.0054, 0.0048, 0.0043, 0.004]
    ball = S.sphere(pts[-1], 0.0062)
    return S.smin_all([SH.smooth_tube(pts, radii, 22), ball], 0.004)


def tines():
    return S.union(tine(0), tine(1), tine(2))


def parts():
    return [
        Part("shaft", shaft(), "fixed", vox=0.0012, tris=420, paint=paint_shaft, texel=0.8, uv_angle=70),
        Part("wrap", wrap(), "secondary", vox=0.0007, tris=300, paint=paint_wrap, texel=1.2),
        Part("bands", bands(), "fixed", vox=0.0008, tris=320, paint=paint_copper, texel=1.0),
        Part("collar", collar(), "fixed", vox=0.0008, tris=220, paint=paint_collar, texel=1.3),
        Part("bulb", bulb(), "fixed", vox=0.001, tris=380, paint=paint_bulb, texel=1.6),
        Part("tines", tines(), "fixed", vox=0.0007, tris=380, paint=lambda c: paint_copper(c, 300.0), texel=1.3),
    ]
