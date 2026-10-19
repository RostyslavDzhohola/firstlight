# FIRSTLIGHT sculpted props: the Yew Longbow (docs/content.md §2.3, ranged, arrows; any starter can carry it).
#
# Brief: a self bow cut from one yew stave, as old longbows are: pale cream sapwood on the back, orange-
# brown heartwood on the belly, with small pin knots; a D-section limb tapering to horn nocks; a plain
# leather grip laced on the belly side; a linen string with a dark whipped serving where the arrow
# sits; one knotted tassel in the palette colour tied under the upper nock.
# Feel: a historical war bow (a public-domain form); a well-oiled garden-tool handle; a hand-tied
# fishing fly (the tassel).
# Tie-breakers: one long clean curve; the two-tone wood is the character; at 10 m it reads as a tall
# thin D with a bright string.
# Avoid (IP): leaf carvings or silver filigree on a recurve (the Tolkien films' elven bows); blue-and-
# gold ornamented tips (Zelda's bows); compound-bow pulleys (Marvel's Hawkeye); Merida's (Brave) or
# Katniss's (The Hunger Games) recurves; a Robin Hood green-and-feather look; any lettering. No glow.
# Orientation: today's bow (weapons.ts) runs its limbs along weapon +Y, which the aim and shoot clips
# turn sideways (the bow lies flat, the string through the fist). This one runs along +Z like a staff,
# so it stands upright in aim/shoot with its back (-X) towards the target and the string at +X.
# Weapon space (hold.py): origin = the grip, +Z = the upper limb, +X = towards the archer when aiming.
# Our own code: MIT. The model and textures are CC BY 4.0.

import math

import numpy as np

import paint as PT
import ppaint as PP
import sdf as S
import shapes as SH
from part import Part

F = np.float32
SCAN = ((-0.05, -0.06, -0.8), (0.18, 0.06, 0.82))
VIEW = {"up": "z", "side": "x"}

Z_UP, Z_LO = 0.745, -0.725  # nock tips; the grip sits a little above the middle, as on old bows
BEND = 0.118  # how far the braced tips sit towards the archer


def xc(z):
    """Limb centreline: stiff through the grip, bending towards the archer (+X) out to the tips."""
    L = np.where(z >= 0, Z_UP, -Z_LO)
    u = np.clip((np.abs(z) - 0.06) / (L - 0.06), 0, 1)
    return (BEND * u ** 1.8).astype(F)


def width(z):
    L = np.where(z >= 0, Z_UP, -Z_LO)
    u = np.clip(np.abs(z) / L, 0, 1)
    return (0.031 - 0.019 * u ** 1.3).astype(F)


def thick(z):
    L = np.where(z >= 0, Z_UP, -Z_LO)
    u = np.clip(np.abs(z) / L, 0, 1)
    return (0.034 - 0.022 * u ** 1.1).astype(F)


def limb_field(grow=0.0):
    """D-section stave: an ellipse in the XY plane around the centreline, its back (-X) cut flat."""
    def f(P):
        z = np.clip(P[:, 2], Z_LO + 0.03, Z_UP - 0.03)
        a, b = thick(z) * 0.5 + grow, width(z) * 0.5 + grow
        dx, dy = P[:, 0] - xc(z), P[:, 1]
        e = (np.sqrt((dx / a) ** 2 + (dy / b) ** 2) - 1) * np.minimum(a, b)
        back = -(dx + 0.62 * a)
        d = np.maximum(e, back)
        dz = np.maximum(P[:, 2] - (Z_UP - 0.03), (Z_LO + 0.03) - P[:, 2])
        return np.maximum(d, dz) / 1.15
    return f


def limbs():
    return S.bounded(limb_field(), (-0.03, -0.02, Z_LO), (0.15, 0.02, Z_UP), 0.01)


def paint_limbs(ctx):
    P = ctx.P
    z = P[:, 2]
    a = thick(np.clip(z, Z_LO, Z_UP)) * 0.5
    rel = (P[:, 0] - xc(np.clip(z, Z_LO, Z_UP))) / a  # -0.62 = the back, +1 = the belly
    edge = -0.2 + 0.12 * S.fbm(P * F((1, 1, 0.05)), 60.0, 3, 21)
    sap = S.smoothstep(edge + 0.05, edge - 0.05, rel)
    heart = PP.wood(P, (0, 0, 1), "#c46a33", "#8a3f1d", seed=13, knots=0.06)
    sapw = PP.wood(P, (0, 0, 1), "#f0e2bd", "#d9c08a", seed=14)
    rgb = PT.mix(heart, sapw, sap)
    return PP.shade(ctx, rgb, ao_amt=0.5, cav_amt=0.4, edge_amt=0.18)


GRIP = (-0.055, 0.072)


def grip():
    inner = limb_field(0.0028)

    def f(P):
        z0, z1 = GRIP
        cap = np.maximum(z0 - P[:, 2], P[:, 2] - z1)
        return np.maximum(inner(P), cap - 0.002)
    return S.bounded(f, (-0.03, -0.025, GRIP[0]), (0.04, 0.025, GRIP[1]), 0.01)


def paint_grip(ctx):
    P = ctx.P
    rgb = PT.fill(ctx.n, PT.hexc("#6a4430"))
    rgb = PT.variation(rgb, P, 0.12, 80.0, 31)
    # lacing on the belly (+X) side: a seam with cross-stitches
    belly = S.smoothstep(0.6, 0.9, ctx.N[:, 0])
    stitch = (np.abs(((P[:, 2] - GRIP[0]) / 0.008) % 1.0 - 0.5) < 0.2) * (np.abs(P[:, 1]) < 0.006)
    rgb = PT.mix(rgb, PT.hexc("#2c1d14"), belly * (np.abs(P[:, 1]) < 0.0012))
    rgb = PT.mix(rgb, PT.hexc("#d8c8a4"), belly * stitch * 0.85)
    return PP.shade(ctx, rgb, ao_amt=0.6, cav_amt=0.5, edge_amt=0.15)


def nock_axis(z0, z1):
    return (float(xc(np.float32(z0))), 0.0, z0), (float(xc(np.float32(z1))) + 0.004, 0.0, z1)


def nocks():
    fs = []
    for z0, z1 in ((Z_UP - 0.055, Z_UP + 0.012), (Z_LO + 0.055, Z_LO - 0.012)):
        a, b = nock_axis(z0, z1)
        horn = S.round_cone(a, b, 0.0085, 0.0042)
        # the string groove: a ring cut a third of the way down from the tip
        g = np.array(a, F) + (np.array(b, F) - np.array(a, F)) * 0.62
        groove = S.torus(tuple(g), 0.0074, 0.0019)
        fs.append(S.ssub(horn, groove, 0.0015))
    return S.union(*fs)


def paint_nocks(ctx):
    P = ctx.P
    to_tip = np.where(P[:, 2] > 0, (Z_UP + 0.012) - P[:, 2], P[:, 2] - (Z_LO - 0.012))
    tip = S.smoothstep(0.03, 0.006, to_tip)
    bands = 0.5 + 0.5 * np.sin(np.abs(P[:, 2]) * 600 + 3 * S.fbm(P, 50.0, 2, 41))
    rgb = PT.mix(PT.fill(ctx.n, PT.hexc("#e9dcc4")), PT.hexc("#c8b391"), bands * 0.4)
    rgb = PT.mix(rgb, PT.hexc("#3a3330"), tip * 0.85)
    return PP.shade(ctx, rgb, ao_amt=0.5, cav_amt=0.5, edge_amt=0.2)


def grooves():
    out = []
    for z0, z1 in ((Z_UP - 0.055, Z_UP + 0.012), (Z_LO + 0.055, Z_LO - 0.012)):
        a, b = nock_axis(z0, z1)
        out.append(np.array(a, F) + (np.array(b, F) - np.array(a, F)) * 0.62)
    return out


def string_ends():
    """Where the string leaves the nock grooves (their belly side)."""
    return [g + np.array((0.0062, 0, 0), F) for g in grooves()]


def string():
    top, bot = string_ends()
    # the loop that hooks each end into its groove: without it the string stops beside the nock
    loops = [S.torus(tuple(g), 0.0062, 0.0017) for g in grooves()]
    return S.union(S.capsule(top, bot, 0.0016), *loops)


SERVE = (-0.05, 0.11)


def serving():
    top, bot = string_ends()
    d = top - bot
    a = bot + d * ((SERVE[0] - bot[2]) / d[2])
    b = bot + d * ((SERVE[1] - bot[2]) / d[2])
    ring = bot + d * ((0.035 - bot[2]) / d[2])
    return S.union(S.capsule(a, b, 0.0024), S.sphere(ring, 0.0036))


def paint_string(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -1), (0, 0, 1))
    twist = 0.5 + 0.5 * np.sin(th * 2 + s * 900)
    rgb = PT.mix(PT.fill(ctx.n, PT.hexc("#efe8d4")), PT.hexc("#bfb498"), twist * 0.5)
    return np.clip(rgb, 0, 1)


def paint_serving(ctx):
    s, _, th = PP.axis_coords(ctx.P, (0, 0, -1), (0, 0, 1))
    wraps = 0.5 + 0.5 * np.sin(s * 2600)
    rgb = PT.mix(PT.fill(ctx.n, PT.hexc("#3b302a")), PT.hexc("#5c4a3e"), wraps * 0.6)
    bead = S.smoothstep(0.0042, 0.0028, np.abs(ctx.P[:, 2] - 0.035))  # the brass nocking point
    rgb = PT.mix(rgb, PT.hexc("#c9953f"), bead)
    return np.clip(rgb, 0, 1)


TZ = Z_UP - 0.085  # the tassel's knot, on the side of the upper limb


def tassel():
    """A tie around the limb, a knot on its side, a wrapped neck and a full fringe hanging along the limb."""
    x0 = float(xc(np.float32(TZ)))
    w = float(width(np.float32(TZ))) * 0.5
    c = np.array((x0 + 0.002, w + 0.0055, 0), F)
    tie = S.transformed(S.torus((0, 0, 0), 1.0, 0.22), np.diag((1 / 0.0085, 1 / 0.0078, 1 / 0.0085)).astype(F))
    tie_f = lambda P: tie(P - np.array((x0, 0, TZ + 0.004), F)) * 0.0078  # noqa: E731  (an oval tie, hugging the limb)
    knot = S.sphere((c[0], c[1], TZ), 0.0062)
    neck = S.round_cone((c[0], c[1], TZ - 0.004), (c[0], c[1], TZ - 0.014), 0.0046, 0.0043)
    body = S.round_cone((c[0], c[1], TZ - 0.014), (c[0], c[1], TZ - 0.07), 0.0045, 0.0085)

    def fringe(P):
        _, _, th = PP.axis_coords(P, (c[0], c[1], TZ), (c[0], c[1], TZ - 0.1))
        depth = S.smoothstep(TZ - 0.016, TZ - 0.03, P[:, 2])
        return body(P) + 0.0011 * depth * (0.5 + 0.5 * np.cos(th * 9))
    fr = S.bounded(lambda P: fringe(P) / 1.3, (c[0] - 0.012, c[1] - 0.012, TZ - 0.08), (c[0] + 0.012, c[1] + 0.012, TZ - 0.01), 0.008)
    return S.smin_all([tie_f, knot, neck, fr], 0.0025)


def paint_tassel(ctx):
    P = ctx.P
    fib = PT.strands(P, (0, 0, 1), 1400.0, 0.25, 7)
    rgb = PT.fill(ctx.n, PT.hexc("#f2ece4")) * fib[:, None]
    tipfade = S.smoothstep(TZ - 0.055, TZ - 0.075, P[:, 2])
    neck = S.smoothstep(0.003, 0.0015, np.abs(P[:, 2] - (TZ - 0.009)))
    rgb = rgb * (1 - 0.3 * neck)[:, None]
    rgb = rgb * (1 - 0.18 * tipfade)[:, None]
    return PP.shade(ctx, rgb, ao_amt=0.55, cav_amt=0.4)


def parts():
    return [
        Part("limbs", limbs(), "fixed", vox=0.0009, tris=900, paint=paint_limbs, texel=0.9, uv_angle=70),
        Part("grip", grip(), "fixed", vox=0.0007, tris=220, paint=paint_grip, texel=1.3),
        Part("nocks", nocks(), "fixed", vox=0.0005, tris=200, paint=paint_nocks, texel=1.3),
        Part("string", string(), "fixed", vox=0.0005, tris=90, paint=paint_string, texel=0.5, occlude=False),
        Part("serving", serving(), "fixed", vox=0.0005, tris=80, paint=paint_serving, texel=0.8),
        Part("tassel", tassel(), "secondary", vox=0.0005, tris=240, paint=paint_tassel, texel=1.4),
    ]
