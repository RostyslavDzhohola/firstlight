# FIRSTLIGHT sculpted props: the Shepherd's Lantern (docs/content.md §2.3, magic; any starter can carry it).
#
# Brief: a night shepherd's crook with a lantern hung from its hook. A tall hazel staff, smooth from
# years of hands, bent over at the top into a crook; from the crook's tip a short iron chain holds a
# small tin lantern: a pierced cap with a carry ring, four slim bars round a pale glass chimney, and
# inside it a soft gold light. A leather grip, a copper ring under the crook, an iron butt spike.
# Feel: a lamp carried across a field at dusk; a beekeeper's smoker; a lighthouse seen from a hill.
# Tie-breakers: gentle and warm; at 10 m it reads as a hook with a small bright lamp hanging from it.
# The hanging light is the signature: always warm gold whatever the palette.
# Avoid (IP): a bishop's crozier with a spiral (the Catholic regalia itself, and Diablo's clerics); a
# lantern holding a soul or a face (Hades, Thresh's lantern in League of Legends); a skull, a flame-
# shaped crystal, floating orbs; the Lantern Corps' ring-lantern (DC's Green Lantern) and any green
# light; runes, glyphs or any lettering. The palette tints only the grip leather (secondary).
# Weapon space (hold.py): origin = the grip, +Z = towards the crook, +Y = up at rest (the crook bends
# towards +Y and the lantern hangs on that side). Metres.
# Our own code: MIT. The model and textures are CC BY 4.0.

import math

import numpy as np

import paint as PT
import ppaint as PP
import sdf as S
import shapes as SH
from part import Part

F = np.float32
SCAN = ((-0.08, -0.08, -0.56), (0.08, 0.22, 1.16))
VIEW = {"up": "z", "side": "y"}

Z_BUTT, Z_BEND = -0.50, 0.92
CROOK_R = 0.075          # the hook's radius
LAMP = (0.0, 2 * CROOK_R, Z_BEND - 0.13)  # the lantern's centre, hanging under the crook's tip
TIN, TIN_HI, TIN_LO = "#5c5a55", "#c9c4b8", "#1d1c1a"
COPPER, COPPER_HI, COPPER_LO = "#b8653a", "#ffc79a", "#4a2416"


def staff_pts():
    """Up the straight staff, then over the crook: a half circle towards +Y, ending pointing down."""
    pts = [(0.0, 0.0, z) for z in np.linspace(Z_BUTT + 0.02, Z_BEND, 8)]
    for a in np.linspace(0, math.pi * 0.95, 9)[1:]:
        pts.append((0.0, CROOK_R - CROOK_R * math.cos(a), Z_BEND + CROOK_R * math.sin(a)))
    pts.append((0.0, 2 * CROOK_R + 0.002, Z_BEND - 0.012))
    return pts


def staff_r(i, n):
    t = i / (n - 1)
    return 0.0172 - 0.006 * t


def staff():
    pts = staff_pts()
    f = SH.smooth_tube(pts, [staff_r(i, len(pts)) for i in range(len(pts))], 40)
    return S.displace(f, lambda P: 0.0003 * S.fbm(P * F((1, 1, 0.04)), 100.0, 2, 41), 1.25)


def paint_staff(ctx):
    P = ctx.P
    rgb = PP.wood(P, (0, 0, 1), "#a77a4e", "#6a4528", seed=41, knots=0.06)
    # hands have polished it pale round the grip, and soot darkens it under the lamp
    polish = 1 - S.smoothstep(0.12, 0.3, np.abs(P[:, 2] - 0.02))
    rgb = PT.mix(rgb, PT.hexc("#c79a6a"), polish * 0.3)
    soot = S.smoothstep(Z_BEND - 0.02, Z_BEND + 0.06, P[:, 2]) * S.smoothstep(0.06, 0.14, P[:, 1]) * 0.45
    rgb = PT.mix(rgb, PT.hexc("#2a1d14"), soot)
    return PP.shade(ctx, rgb, ao_amt=0.55, cav_amt=0.45, edge_amt=0.1)


def fittings():
    """A copper ring under the crook, an iron butt spike with a collar."""
    ring = S.cyl((0, 0, Z_BEND - 0.04), 0.0155, 0.012, rad=0.003)
    bead = S.torus((0, 0, Z_BEND - 0.052), 0.0158, 0.0022)
    spike = S.round_cone((0, 0, Z_BUTT + 0.05), (0, 0, Z_BUTT - 0.04), 0.0185, 0.003)
    collar = S.torus((0, 0, Z_BUTT + 0.05), 0.0188, 0.0026)
    return S.union(S.smin_all([ring, bead], 0.002), S.smin_all([spike, collar], 0.002))


def paint_fittings(ctx):
    copper = PP.worked_metal(ctx, COPPER, COPPER_HI, COPPER_LO, dents=200.0, band=0.35, seed=42)
    iron = PP.worked_metal(ctx, "#3f4348", "#aab4be", "#141618", dents=200.0, band=0.3, seed=43)
    return np.where((ctx.P[:, 2] > 0)[:, None], copper, iron)


def chain():
    """Three oval links from the crook's tip down to the lantern's carry ring, alternating planes."""
    x, y, z0 = LAMP[0], LAMP[1], Z_BEND - 0.018
    fs = []
    for i in range(3):
        zc = z0 - 0.012 - i * 0.017
        R = S.rot((1, 0, 0), 90) if i % 2 == 0 else S.rot((0, 1, 0), 90) @ S.rot((1, 0, 0), 90)
        link = S.torus((x, y, zc), 0.0065, 0.0018, Rm=R)
        fs.append(link)
    ring = S.torus((x, y, LAMP[2] + 0.062), 0.009, 0.0022, Rm=S.rot((1, 0, 0), 90))
    return S.union(*fs, ring)


def lamp_frame():
    """The tin: a pierced conical cap with a rim, a base dish, four slim bars between them."""
    x, y, z = LAMP
    cap = S.round_cone((x, y, z + 0.034), (x, y, z + 0.056), 0.031, 0.008)
    rim = S.torus((x, y, z + 0.034), 0.031, 0.0035)
    base = S.cyl((x, y, z - 0.04), 0.031, 0.006, rad=0.003)
    foot = S.torus((x, y, z - 0.046), 0.026, 0.003)
    bars = [S.capsule((x + 0.028 * math.cos(a), y + 0.028 * math.sin(a), z - 0.036), (x + 0.028 * math.cos(a), y + 0.028 * math.sin(a), z + 0.034), 0.0028)
            for a in (math.pi / 4 + k * math.pi / 2 for k in range(4))]
    return S.smin_all([cap, rim, base, foot] + bars, 0.003)


def paint_frame(ctx):
    rgb = PP.worked_metal(ctx, TIN, TIN_HI, TIN_LO, dents=300.0, band_dir=(0.2, 0.3, 1.0), band=0.3, seed=44)
    # the cap's piercings: a ring of small dark holes, lit from inside
    x, y, z = LAMP
    s, r, th = PP.axis_coords(ctx.P, (x, y, z + 0.034), (x, y, z + 0.056), ref=(1, 0, 0))
    holes = S.smoothstep(0.6, 0.9, np.cos(th * 8)) * S.smoothstep(0.004, 0.006, s) * (1 - S.smoothstep(0.012, 0.014, s))
    rgb = PT.mix(rgb, PT.hexc("#ffd27a"), holes * 0.9)
    return np.clip(rgb, 0, 1), np.clip(holes * 0.9, 0, 1)


def glass():
    x, y, z = LAMP
    body = S.round_cone((x, y, z - 0.034), (x, y, z + 0.03), 0.022, 0.017)
    return body


def paint_glass(ctx):
    """A pale glass chimney, gold light inside: brightest at the middle where the wick burns."""
    x, y, z = LAMP
    h = np.clip((ctx.P[:, 2] - (z - 0.034)) / 0.064, 0, 1)
    core = 1 - np.clip(np.abs(h - 0.4) / 0.5, 0, 1)
    swirl = 0.5 + 0.5 * np.sin(ctx.P[:, 2] * 260 + 2.0 * S.fbm(ctx.P, 50.0, 2, 45))
    rgb = PT.mix(PT.fill(ctx.n, PT.hexc("#ffb84a")), PT.hexc("#fff6d6"), core * (0.7 + 0.3 * swirl))
    spec = S.smoothstep(0.9, 0.97, np.clip(ctx.N @ S.norm((0.4, -0.5, 0.75)), 0, 1))
    rgb = PT.mix(rgb, PT.hexc("#ffffff"), spec * 0.7)
    glow = np.clip(0.6 + 0.4 * core, 0, 1)
    return np.clip(rgb, 0, 1), glow


def wrap():
    a, b = (0, 0, -0.12), (0, 0, 0.16)
    zc = (a[2] + b[2]) / 2
    body = S.cyl((0, 0, zc), 0.0205, (b[2] - a[2]) / 2, rad=0.003)

    def f(P):
        s, _, th = PP.axis_coords(P, a, b)
        _, gap = PP.helix(s, th, 0.024, 0.85)
        return body(P) + 0.001 * gap
    return S.bounded(lambda P: f(P) / 1.6, (-0.03, -0.03, -0.13), (0.03, 0.03, 0.17), 0.01)


def paint_wrap(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -0.12), (0, 0, 0.16))
    ph, gap = PP.helix(s, th, 0.024, 0.85)
    rgb = PT.fill(ctx.n, PT.hexc("#efe7da"))
    rgb = rgb * (1 - 0.4 * gap)[:, None] * (0.9 + 0.1 * np.sin(ph * math.pi))[:, None]
    rgb = PT.variation(rgb, ctx.P, 0.1, 60.0, 46)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5)


def parts():
    staff_p = Part("staff", staff(), "fixed", vox=0.0012, tris=480, paint=paint_staff, texel=0.8, uv_angle=70, cull_eps=0.005)
    staff_p.uv_bands = (2, 5)
    return [
        staff_p,
        Part("fittings", fittings(), "fixed", vox=0.0008, tris=220, paint=paint_fittings, texel=1.0),
        Part("chain", chain(), "fixed", vox=0.0005, tris=200, paint=lambda c: PP.worked_metal(c, TIN, TIN_HI, TIN_LO, band=0.3, seed=47), texel=1.0),
        Part("frame", lamp_frame(), "fixed", vox=0.0006, tris=420, paint=paint_frame, texel=1.4),
        Part("glass", glass(), "fixed", vox=0.0008, tris=260, paint=paint_glass, texel=1.6),
        Part("wrap", wrap(), "secondary", vox=0.0007, tris=260, paint=paint_wrap, texel=1.1),
    ]
