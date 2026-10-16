# Portus market house: two-storey jettied market house with a shop front, built from a small kit.
# Front faces -Y, ground at z = 0, origin at the footprint centre. Run through render_piece.py.
# Round 2 (the owner's pick, design A): configure(w, d) sizes it to a town plot (FIRSTLIGHT's four
# house footprints); everything along the width and depth follows W and D.
import math, random
from mathutils import Matrix, Vector
import flkit as K
from flkit import C

rng = random.Random(11)

PAL = dict(
    stone=0xCDBB9E, stone2=0xB59F84, plaster_lo=0xE9D3AE, plaster_hi=0xF6EEDF, timber=0x6A4330,
    teal=0x2D6B68, teal2=0x4E9A92, cream=0xF7EBD3, coral=0xE0604A, door=0x7C3F2B, iron=0x2E2B2F,
    brass=0xD9A441, warm=0xFFC46B, holo=0x6FD3FF, glass=0x1E2A35, interior=0x3B2A20, roof=0xF2E9DF,
    leaf=0x4D8A3A, red=0xE2475B, yellow=0xF4C542, violet=0x9A5CC6, white=0xFFFFFF,
)
W, D = 7.0, 6.0
Z0, Z1, ZJ, Z2 = 0.30, 3.30, 3.55, 6.35          # plinth top, ground-storey top, jetty floor top, upper top
YF, YJ, YG = -3.0, -3.45, -3.65                   # ground front, upper (jettied) front, gable front
PITCH = math.radians(52)
RIDGE = Z2 + (W / 2) * math.tan(PITCH)


def configure(w=7.0, d=6.0):
    """Size the house to a w x d plot (the walls; the plinth adds 0.15 m all round)."""
    global W, D, YF, YJ, YG, RIDGE
    W, D = w, d
    YF = -D / 2
    YJ, YG = YF - 0.45, YF - 0.65
    RIDGE = Z2 + (W / 2) * math.tan(PITCH)


def shop_span():
    """Shop front x0..x1 and the door's centre (the 7 m house: -3.0..1.0, door at 2.25)."""
    dx = W / 2 - 1.25
    return -W / 2 + 0.5, dx - 1.25, dx


def bays():
    """Front post positions (outer, inner) along x: the 7 m house has posts at 3.42 and 1.15."""
    return W / 2 - 0.08, W * 0.164

def kit():
    P = {}
    # ---- plinth
    p = K.Piece("H_plinth")
    p.box((W + 0.3, D + 0.3, Z0), (0, 0, Z0 / 2), col=PAL['stone2'], kind='stone', bevel=0.05)
    p.box((1.5, 0.5, 0.18), (shop_span()[2] - 0.05, YF - 0.38, 0.09), col=PAL['stone'], kind='stone', bevel=0.04)   # door step
    P['plinth'] = p.mesh()
    # ---- unit slabs (scaled per instance; base colour near white, tinted per instance)
    p = K.Piece("H_slab"); p.box((1, 1, 1), (0, 0, 0), col=PAL['white'], kind='plaster'); P['slab'] = p.mesh()
    # ---- timber beam: chamfered 0.18 x 0.16 section, unit length along X
    s, t, c = 0.09, 0.08, 0.028
    sec = [(-s + c, -t), (s, -t), (s, t), (-s + c, t), (-s, t - c), (-s, -t + c)]
    p = K.Piece("H_beam"); p.prism(sec, 1.0, plane='YZ', col=PAL['timber'], kind='wood'); P['beam'] = p.mesh(sharp_deg=50)
    # ---- painted beam (teal shopfront members)
    p = K.Piece("H_beam_teal"); p.prism(sec, 1.0, plane='YZ', col=PAL['teal'], kind='paint'); P['beam_teal'] = p.mesh()
    # ---- quoin block (sandstone), unit block 0.52 x 0.34 x 0.31
    qa, qb, qc = 0.26, 0.17, 0.035
    p = K.Piece("H_quoin")
    p.prism([(-qa + qc, -qb), (qa - qc, -qb), (qa, -qb + qc), (qa, qb - qc), (qa - qc, qb), (-qa + qc, qb), (-qa, qb - qc), (-qa, -qb + qc)],
            0.30, plane='XY', loc=(0, 0, -0.15), col=PAL['stone'], kind='stone')
    P['quoin'] = p.mesh()
    # ---- jetty bracket: curved brace in the YZ plane, wall at y=0, projecting to -Y, top at z=0
    arc = [(-0.45 + 0.45 * math.cos(math.radians(a)), -0.62 + 0.45 * math.sin(math.radians(a))) for a in (90, 67.5, 45, 22.5, 0)]
    pts = [(0.0, 0.0), (-0.47, 0.0), (-0.47, -0.10)] + arc
    p = K.Piece("H_bracket"); p.prism(pts, 0.15, plane='YZ', col=PAL['timber'], kind='wood'); P['bracket'] = p.mesh()
    # ---- upper window: opening 1.0 x 1.25, frame, glass, cross, sill, head, open shutters
    p = K.Piece("H_window")
    w, h, fd = 1.0, 1.25, 0.10
    p.box((w + 0.2, 0.12, 0.10), (0, -0.06, -h / 2 - 0.05), col=PAL['cream'], kind='paint')           # frame bottom
    p.box((w + 0.2, 0.12, 0.10), (0, -0.06, h / 2 + 0.05), col=PAL['cream'], kind='paint')            # frame top
    p.box((0.10, 0.12, h), (-w / 2 - 0.05, -0.06, 0), col=PAL['cream'], kind='paint')
    p.box((0.10, 0.12, h), (w / 2 + 0.05, -0.06, 0), col=PAL['cream'], kind='paint')
    p.box((w, 0.02, h), (0, -0.012, 0), col=PAL['glass'], kind='glass')
    p.box((0.05, 0.05, h), (0, -0.045, 0), col=PAL['cream'], kind='paint')
    p.box((w, 0.05, 0.05), (0, -0.045, 0.12), col=PAL['cream'], kind='paint')
    p.box((w + 0.42, 0.26, 0.08), (0, -0.13, -h / 2 - 0.12), col=PAL['timber'], kind='wood')  # sill
    p.box((w + 0.34, 0.16, 0.14), (0, -0.09, h / 2 + 0.16), col=PAL['teal2'], kind='paint', taper=(0.86, 1.0))  # head
    for sx in (-1, 1):
        p.box((0.42, 0.05, h + 0.02), (sx * (w / 2 + 0.33), -0.035, 0), col=PAL['teal'], kind='paint')
    P['window'] = p.mesh()
    # ---- small ground-floor side window
    p = K.Piece("H_window_s")
    p.box((0.86, 0.10, 0.9), (0, -0.04, 0), col=PAL['cream'], kind='paint')
    p.box((0.66, 0.02, 0.70), (0, -0.095, 0), col=PAL['glass'], kind='glass')
    p.box((0.05, 0.04, 0.70), (0, -0.11, 0), col=PAL['cream'], kind='paint')
    p.box((1.0, 0.24, 0.08), (0, -0.10, -0.5), col=PAL['stone'], kind='stone')
    P['window_s'] = p.mesh()
    # ---- flower box
    p = K.Piece("H_flowerbox")
    p.box((1.15, 0.26, 0.22), (0, 0, 0), col=PAL['timber'], kind='wood', taper=(1.06, 1.1))
    for i, (x, col) in enumerate([(-0.4, PAL['red']), (-0.12, PAL['leaf']), (0.15, PAL['yellow']), (0.42, PAL['leaf'])]):
        p.sphere(0.17 if col == PAL['leaf'] else 0.14, (x, -0.02, 0.17), scale=(1.2, 0.9, 0.8), u=5, v=3, col=col, kind='leaf')
    p.sphere(0.09, (-0.28, -0.11, 0.24), u=4, v=3, col=PAL['violet'], kind='leaf')
    P['flowerbox'] = p.mesh()
    # ---- arched door with stone surround (front plane y = 0, door recessed)
    p = K.Piece("H_door")
    dw, dh = 1.1, 1.95                     # rect part height, arch radius = dw/2
    r = dw / 2
    arch = [(r * math.cos(math.pi * k / 8), dh + r * math.sin(math.pi * k / 8)) for k in range(9)]
    door = [(-r, 0.0), (r, 0.0)] + arch[0:9]
    p.prism([(r, 0.0)] + arch[0:9] + [(-r, 0.0)], 0.08, loc=(0, 0.20, 0), col=PAL['door'], kind='wood')
    for z in (0.45, 1.55):
        p.box((dw * 0.92, 0.03, 0.08), (0, 0.15, z), col=PAL['iron'], kind='iron')
    p.torus(0.08, 0.015, seg=6, rseg=3, loc=(0.3, 0.14, 1.05), rot=(math.pi / 2, 0, 0), col=PAL['brass'], kind='brass')
    p.sphere(0.12, (0, 0.15, dh + 0.18), scale=(1, 0.3, 1), u=6, v=3, col=PAL['warm'], kind='glow', glow=0.25)
    # voussoirs
    for k in range(7):
        a0, a1 = math.pi * k / 7, math.pi * (k + 1) / 7
        ro, ri = r + 0.30, r
        sec = [(ri * math.cos(a0), dh + ri * math.sin(a0)), (ro * math.cos(a0), dh + ro * math.sin(a0)),
               (ro * math.cos(a1), dh + ro * math.sin(a1)), (ri * math.cos(a1), dh + ri * math.sin(a1))]
        p.prism(sec, 0.36 if k != 3 else 0.42, loc=(0, 0.02 if k != 3 else -0.01, 0), col=K.jit(PAL['stone'], 0.07, rng), kind='stone')
    for i in range(4):          # jamb blocks
        for sx in (-1, 1):
            wide = (i % 2 == 0)
            p.box((0.30 if wide else 0.22, 0.34, 0.46), (sx * (r + (0.15 if wide else 0.11)), 0.02, 0.24 + i * 0.48),
                  col=K.jit(PAL['stone'], 0.06, rng), kind='stone')
    P['door'] = p.mesh()
    # ---- wall above door, cut to the arch (front at y=0, depth 0.30)
    p = K.Piece("H_overdoor")
    ro = r + 0.30
    arc = [(ro * math.cos(math.pi * k / 8), dh + ro * math.sin(math.pi * k / 8)) for k in range(9)]
    poly = [(ro, dh), (ro, Z1 - Z0), (-ro, Z1 - Z0), (-ro, dh)] + [arc[k] for k in range(7, 0, -1)]
    p.prism(poly, 0.30, loc=(0, 0.15, 0), col=PAL['white'], kind='plaster')
    P['overdoor'] = p.mesh()
    # ---- wall lantern
    p = K.Piece("H_lantern")
    p.box((0.06, 0.40, 0.06), (0, -0.2, 0.30), col=PAL['iron'], kind='iron')
    p.cyl(0.13, 0.05, (0, -0.38, 0.22), seg=6, col=PAL['iron'], kind='iron')
    p.cyl(0.11, 0.30, (0, -0.38, 0.05), seg=6, col=PAL['warm'], kind='glow', glow=0.55)
    p.cyl(0.15, 0.16, (0, -0.38, -0.16), seg=6, r2=0.02, col=PAL['iron'], kind='iron')
    p.cyl(0.16, 0.14, (0, -0.38, 0.28), seg=6, r2=0.03, col=PAL['iron'], kind='iron')
    P['lantern'] = p.mesh()
    # ---- shop front: counter, posts, lintel, interior recess with shelves and goods (local: front at y=0, x from 0 to 4.0)
    p = K.Piece("H_shopfront")
    x0, x1, _dx = shop_span()
    SW = x1 - x0
    p.box((SW, 0.40, 0.72), (SW / 2, 0.05, 0.36), col=PAL['teal'], kind='paint')                      # counter body
    npan = max(2, int(round(SW)))
    for i in range(npan):
        p.box((SW / npan - 0.14, 0.05, 0.46), ((i + 0.5) * SW / npan, -0.17, 0.36), col=PAL['teal2'], kind='paint')  # panels
    p.box((SW + 0.3, 0.62, 0.07), (SW / 2, -0.04, 0.76), col=PAL['timber'], kind='wood')   # counter top
    p.box((SW + 0.36, 0.30, 0.34), (SW / 2, 0.02, Z1 - Z0 - 0.30), col=PAL['teal'], kind='paint')      # lintel / fascia
    p.box((SW + 0.44, 0.36, 0.08), (SW / 2, 0.0, Z1 - Z0 - 0.10), col=PAL['teal2'], kind='paint')      # cornice
    p.box((SW - 0.3, 0.04, 0.22), (SW / 2, -0.15, Z1 - Z0 - 0.32), col=PAL['cream'], kind='paint')     # name board
    for x in (0.0, SW / 2, SW):
        p.box((0.20, 0.26, Z1 - Z0 - 0.45), (x, 0.03, (Z1 - Z0 - 0.45) / 2), col=PAL['teal'], kind='paint')
        p.box((0.28, 0.32, 0.16), (x, 0.03, 0.08), col=PAL['teal2'], kind='paint')
    # interior recess (back wall at y=0.7)
    p.box((SW, 0.10, Z1 - Z0 - 0.4), (SW / 2, 0.75, (Z1 - Z0) / 2), col=PAL['interior'], kind='wood')
    p.box((SW, 0.80, 0.06), (SW / 2, 0.35, Z1 - Z0 - 0.47), col=PAL['interior'], kind='wood')         # ceiling
    p.box((0.06, 0.80, Z1 - Z0 - 0.4), (0.06, 0.35, (Z1 - Z0) / 2), col=PAL['interior'], kind='wood')
    p.box((0.06, 0.80, Z1 - Z0 - 0.4), (SW - 0.06, 0.35, (Z1 - Z0) / 2), col=PAL['interior'], kind='wood')
    for z in (1.45, 2.05):
        p.box((SW - 0.2, 0.30, 0.05), (SW / 2, 0.58, z), col=PAL['timber'], kind='wood')
    # goods on shelves: jars and bottles
    jar = [(0.0, 0.0), (0.08, 0.0), (0.10, 0.06), (0.09, 0.20), (0.05, 0.24), (0.05, 0.28), (0.0, 0.28)]
    cols = [PAL['coral'], PAL['yellow'], PAL['teal2'], PAL['violet'], PAL['leaf'], PAL['brass']]
    ngoods = max(2, int((SW - 0.3) / 0.62))
    for row, z in enumerate((1.475, 2.075)):
        for i in range(ngoods):
            x = 0.45 + i * (SW - 0.9) / max(1, ngoods - 1) + rng.uniform(-0.06, 0.06)
            sc = rng.uniform(0.85, 1.3)
            hh = 0.24 * sc * rng.uniform(0.9, 1.4)
            p.cyl(0.09 * sc, hh, (x, 0.58, z), seg=6, r2=0.06 * sc, col=cols[(i + row * 2) % len(cols)],
                  kind='glass' if i % 3 == 0 else 'paint', base=True)
            if i % 2 == 0:
                p.cyl(0.07 * sc, 0.05, (x, 0.58, z + hh), seg=5, col=PAL['timber'], kind='wood', base=True)
    # produce crates on the counter
    crates = [(0.55, PAL['coral']), (1.35, PAL['yellow']), (2.65, PAL['leaf']), (3.45, PAL['red'])]
    crates = [(x * SW / 4.0, c) for x, c in crates]
    if SW < 3.0:
        crates = [crates[0], crates[3]]
    for i, (x, col) in enumerate(crates):
        p.box((0.62, 0.42, 0.18), (x, -0.05, 0.89), col=PAL['timber'], kind='wood', taper=(1.05, 1.05))
        p.box((0.54, 0.34, 0.08), (x, -0.05, 0.99), col=col, kind='leaf', taper=(0.85, 0.8))
    # interior warm light (a lamp hanging inside)
    p.cyl(0.10, 0.18, (SW / 2, 0.45, Z1 - Z0 - 0.75), seg=6, r2=0.05, col=PAL['warm'], kind='glow', glow=0.5)
    P['shopfront'] = p.mesh()
    # ---- striped awning (local: wall at y=0, top edge at z=0, x 0..SW)
    p = K.Piece("H_awning")
    proj, drop = 1.25, 0.55
    ang = math.atan2(drop, proj)
    L_ = math.hypot(proj, drop)
    n = max(4, 2 * int(round(SW)))
    sw = (SW + 0.3) / n
    for i in range(n):
        x = -0.15 + sw * (i + 0.5)
        col = PAL['coral'] if i % 2 == 0 else PAL['cream']
        p.box((sw + 0.002, L_, 0.04), (x, -proj / 2, -drop / 2), rot=(ang, 0, 0), col=col, kind='cloth')
        sc = [(sw / 2 * math.cos(math.pi + math.pi * k / 4), -0.05 + 0.20 * math.sin(math.pi + math.pi * k / 4)) for k in range(5)]
        sc = [(-sw / 2, 0.0)] + sc[1:4] + [(sw / 2, 0.0)]
        p.prism(sc, 0.03, loc=(x, -proj - 0.01, -drop + 0.0), col=col, kind='cloth')
    for x in (0.0, SW):
        p.tube((x, -0.02, -0.75), (x, -proj + 0.03, -drop + 0.02), 0.025, seg=5, col=PAL['iron'], kind='iron')
    P['awning'] = p.mesh()
    # ---- roof shingle row: profile across the slope (u: down-slope, nose at u=0), unit length along Y
    p = K.Piece("H_roofrow")
    prof = [(-0.98, 0.0), (0.0, 0.0), (0.04, 0.05), (0.02, 0.13), (-0.06, 0.16), (-0.98, 0.05)]
    p.prism(prof, 1.0, plane='XZ', col=PAL['roof'], kind='stone')
    P['roofrow'] = p.mesh(sharp_deg=55)
    # ---- ridge cap + finial
    p = K.Piece("H_ridge")
    p.cyl(0.17, 1.0, (0, 0, 0), rot=(math.pi / 2, 0, 0), seg=8, col=PAL['roof'], kind='stone')
    P['ridge'] = p.mesh()
    p = K.Piece("H_finial")
    p.lathe([(0.0, 0.0), (0.14, 0.0), (0.10, 0.25), (0.05, 0.32), (0.05, 0.45), (0.12, 0.52), (0.0, 0.66)], seg=6,
            col=PAL['teal2'], kind='paint')
    p.cyl(0.018, 1.1, (0, 0, 0.66), seg=4, col=PAL['brass'], kind='brass', base=True)
    p.prism([(0.0, 0.0), (0.55, 0.0), (0.62, 0.12), (0.55, 0.24), (0.0, 0.24)], 0.02, loc=(0.02, 0, 1.40), col=PAL['brass'], kind='brass')
    p.sphere(0.06, (0, 0, 1.78), u=6, v=4, col=PAL['brass'], kind='brass')
    P['finial'] = p.mesh()
    # ---- gable infill: triangle prism, front at y=0 (local), base at z=0, half width W/2
    p = K.Piece("H_gable")
    gh = (W / 2) * math.tan(PITCH)
    p.prism([(-W / 2, 0.0), (W / 2, 0.0), (0.0, gh)], 0.25, loc=(0, 0.125, 0), col=PAL['white'], kind='plaster')
    P['gable'] = p.mesh()
    # ---- loft door with hoist (local front y=0, bottom z=0)
    p = K.Piece("H_loft")
    p.box((1.25, 0.12, 1.55), (0, -0.02, 0.78), col=PAL['cream'], kind='paint')
    for sx in (-1, 1):
        p.box((0.50, 0.06, 1.40), (sx * 0.27, -0.09, 0.76), col=PAL['teal'], kind='paint')
        p.box((0.36, 0.03, 0.06), (sx * 0.27, -0.125, 1.15), col=PAL['iron'], kind='iron')
        p.box((0.36, 0.03, 0.06), (sx * 0.27, -0.125, 0.35), col=PAL['iron'], kind='iron')
    p.box((1.6, 0.30, 0.08), (0, -0.12, -0.04), col=PAL['timber'], kind='wood')
    # hoist beam + hood + pulley + rope + crate
    hz = 2.25
    p.box((0.22, 1.70, 0.24), (0, -0.70, hz), col=PAL['timber'], kind='wood')
    for sx in (-1, 1):
        p.box((0.62, 1.95, 0.05), (sx * 0.27, -0.80, hz + 0.37), rot=(0, sx * math.radians(38), 0), col=PAL['teal2'], kind='paint')
    p.cyl(0.13, 0.06, (0, -1.38, hz - 0.22), rot=(0, math.pi / 2, 0), seg=7, col=PAL['brass'], kind='brass')
    p.box((0.03, 0.03, 1.15), (0.0, -1.38, hz - 0.85), col=0x8A6A43, kind='cloth')
    p.box((0.46, 0.42, 0.40), (0.0, -1.38, hz - 1.60), rot=(0, 0, 0.25), col=0xA0703E, kind='wood')
    P['loft'] = p.mesh()
    # ---- chimney (base at z=0)
    p = K.Piece("H_chimney")
    p.box((0.80, 0.80, 2.6), (0, 0, 1.3), col=PAL['stone'], kind='stone', taper=(0.92, 0.92))
    p.box((1.02, 1.02, 0.16), (0, 0, 2.38), col=PAL['stone2'], kind='stone', bevel=0.03)
    p.box((0.90, 0.90, 0.12), (0, 0, 2.62), col=PAL['stone2'], kind='stone')
    p.lathe([(0.0, 2.6), (0.20, 2.6), (0.17, 3.0), (0.21, 3.08), (0.15, 3.08), (0.0, 3.0)], seg=8, col=0xC0603F, kind='stone')
    P['chimney'] = p.mesh()
    # ---- shop sign: iron bracket (projecting -Y from the wall), brass ring, hologram glyph
    p = K.Piece("H_sign_frame")
    p.box((0.07, 1.45, 0.07), (0, -0.72, 0), col=PAL['iron'], kind='iron')
    p.tube((0, -0.02, -0.55), (0, -0.70, -0.02), 0.03, seg=4, col=PAL['iron'], kind='iron')
    p.torus(0.16, 0.022, seg=6, rseg=3, a0=0.0, a1=math.pi * 1.5, loc=(0, -0.35, -0.22), rot=(0, math.pi / 2, 0), col=PAL['iron'], kind='iron')
    for y in (-1.02, -1.42):
        p.box((0.02, 0.02, 0.22), (0, y, -0.12), col=PAL['iron'], kind='iron')
    p.torus(0.42, 0.045, seg=12, rseg=3, loc=(0, -1.22, -0.66), rot=(0, math.pi / 2, 0), col=PAL['brass'], kind='brass')
    p.sphere(0.06, (0, -1.22, -1.12), u=6, v=4, col=PAL['brass'], kind='brass')
    P['sign_frame'] = p.mesh()
    p = K.Piece("H_sign_holo")
    # flask glyph (both faces visible), in the YZ plane
    flask = [(0.06, 0.30), (0.06, 0.12), (0.22, -0.02), (0.26, -0.16), (0.20, -0.28), (0.0, -0.33),
             (-0.20, -0.28), (-0.26, -0.16), (-0.22, -0.02), (-0.06, 0.12), (-0.06, 0.30)]
    p.prism(flask, 0.03, plane='YZ', loc=(0, -1.22, -0.66), col=PAL['holo'], kind='glow', mat=1)
    p.prism([(0.10, 0.30), (0.10, 0.36), (-0.10, 0.36), (-0.10, 0.30)], 0.03, plane='YZ', loc=(0, -1.22, -0.66), col=PAL['holo'], kind='glow', mat=1)
    disc = [(0.38 * math.cos(2 * math.pi * k / 16), 0.38 * math.sin(2 * math.pi * k / 16)) for k in range(16)]
    p.prism(disc, 0.004, plane='YZ', loc=(0, -1.22, -0.66), col=mixc_(PAL['holo'], 0.12), kind='glow', mat=1)
    P['sign_holo'] = p.mesh()
    # ---- string-light bulb
    p = K.Piece("H_bulb")
    p.sphere(0.065, (0, 0, -0.06), u=4, v=2, col=PAL['warm'], kind='glow', glow=1.0)
    P['bulb'] = p.mesh()
    p = K.Piece("H_wire"); p.cyl(0.008, 1.0, (0, 0, 0), rot=(0, math.pi / 2, 0), seg=3, col=PAL['iron'], kind='iron', cap=False); P['wire'] = p.mesh()
    return P

def mixc_(h, k):
    c = C(h)
    return (c[0] * k, c[1] * k, c[2] * k, 1)

def place(B, P, variant=0):
    """Assemble one house into Building B (its origin matrix is the house frame)."""
    vr = random.Random(100 + variant)
    roof_t = [0xC65A3E, 0x5F7FA6, 0x6E8E4D, 0x8E5C9A][variant % 4]
    plaster_hi = [0xF6EEDF, 0xF4DCD4, 0xDDE9DE, 0xF3E6C6][variant % 4]
    plaster_lo = [0xE9D3AE, 0xE6C3B5, 0xC9DCCD, 0xE7CF9F][variant % 4]
    put = B.put
    put(P['plinth'])
    # ground storey shell: back + sides (plaster), solid core behind the shop recess
    hz = Z1 - Z0
    put(P['slab'], (0, D / 2 - 0.15, Z0 + hz / 2), scale=(W, 0.3, hz), tint=plaster_lo)
    for sx in (-1, 1):
        put(P['slab'], (sx * (W / 2 - 0.15), 0.0, Z0 + hz / 2), scale=(0.3, D, hz), tint=plaster_lo)
    # front right of the shop (x1 .. W/2) with the door at dx (the 7 m house: 1.0 .. 3.5, door at 2.25)
    sx0, sx1, dx = shop_span()
    ro = 0.55 + 0.30
    ri = 0.55 + 0.10
    put(P['slab'], ((sx1 + dx - ri) / 2, YF + 0.15, Z0 + hz / 2), scale=(dx - ri - sx1, 0.3, hz), tint=plaster_lo)
    put(P['slab'], ((dx + ri + W / 2) / 2, YF + 0.15, Z0 + hz / 2), scale=(W / 2 - dx - ri, 0.3, hz), tint=plaster_lo)
    put(P['overdoor'], (dx, YF, Z0), tint=plaster_lo)
    put(P['door'], (dx, YF, Z0))
    put(P['lantern'], (dx - 0.98, YF, Z0 + 2.15))
    # shop front x0 .. x1
    put(P['shopfront'], (sx0, YF, Z0))
    put(P['slab'], (sx0 - 0.25, YF + 0.15, Z0 + hz / 2), scale=(0.5, 0.3, hz), tint=plaster_lo)
    put(P['awning'], (sx0, YF - 0.17, Z0 + (Z1 - Z0) - 0.47))
    # quoins at the two front corners and the two back corners (front-facing courses alternate)
    for sx in (-1, 1):
        for i in range(9):
            z = Z0 + 0.17 + i * 0.334
            pq = 0.05
            if i % 2 == 0:
                put(P['quoin'], (sx * (W / 2 + pq - 0.26), YF - pq + 0.17, z), tint=K.jit(0xFFFFFF, 0.05, vr))
            else:
                put(P['quoin'], (sx * (W / 2 + pq - 0.17), YF - pq + 0.26, z), rot=(0, 0, math.pi / 2), tint=K.jit(0xFFFFFF, 0.05, vr))
    # side windows (ground storey)
    for sx in (-1, 1):
        put(P['window_s'], (sx * (W / 2), 0.6, Z0 + 1.7), rot=(0, 0, sx * math.pi / 2))
    # jetty: floor beam + brackets
    put(P['beam'], (0, YJ + 0.05, Z1 + 0.12), scale=(W + 0.3, 1.6, 1.6))
    for x in (-(W / 2 - 0.25), -W / 7, W / 7, W / 2 - 0.25):
        put(P['bracket'], (x, YF, Z1 + 0.04))
    # upper storey: plaster shell
    uz = Z2 - ZJ
    put(P['slab'], (0, YJ + 0.15, ZJ + uz / 2), scale=(W, 0.3, uz), tint=plaster_hi)
    put(P['slab'], (0, D / 2 - 0.15, ZJ + uz / 2), scale=(W, 0.3, uz), tint=plaster_hi)
    for sx in (-1, 1):
        put(P['slab'], (sx * (W / 2 - 0.15), (YJ + D / 2) / 2, ZJ + uz / 2), scale=(0.3, D / 2 - YJ, uz), tint=plaster_hi)
    put(P['slab'], (0, (YJ + D / 2) / 2, Z1 + 0.12), scale=(W - 0.1, D / 2 - YJ - 0.1, 0.24), tint=plaster_hi)
    # timber framing, front
    fy = YJ - 0.04
    po, pi_ = bays()
    for x in (-po, -pi_, pi_, po):
        put(P['beam'], (x, fy, (ZJ + Z2) / 2), rot=(0, math.pi / 2, 0), scale=(uz, 1, 1))
    for z in (ZJ + 0.06, ZJ + 0.98, Z2 - 0.05):
        put(P['beam'], (0, fy, z), scale=(W, 1, 1))
    # central bay: diamond of braces + rosette
    zb, zt = ZJ + 0.98, Z2 - 0.05
    zm, hh = (zb + zt) / 2, (zt - zb) / 2
    a = math.atan2(hh, pi_)
    for sx in (-1, 1):
        for sz in (-1, 1):
            put(P['beam'], (sx * pi_ / 2, fy + 0.01, zm + sz * hh / 2), rot=(0, sx * sz * a, 0), scale=(math.hypot(pi_, hh) + 0.05, 0.85, 0.85))
    # upper windows front, centred in the outer bays
    for x in (-(po + pi_) / 2, (po + pi_) / 2):
        put(P['window'], (x, YJ, ZJ + 1.75))
        put(P['flowerbox'], (x, YJ - 0.28, ZJ + 0.86))
    # timber framing, sides and back
    for sx in (-1, 1):
        xx = sx * (W / 2 + 0.04)
        for y in (YJ + 0.1, -0.1, D / 2 - 0.1):
            put(P['beam'], (xx, y, (ZJ + Z2) / 2), rot=(0, math.pi / 2, 0), scale=(uz, 1, 1))
        for z in (ZJ + 0.06, Z2 - 0.05):
            put(P['beam'], (xx, (YJ + D / 2) / 2, z), rot=(0, 0, math.pi / 2), scale=(D / 2 - YJ, 1, 1))
        span = D / 2 - 0.2
        a = math.atan2(uz - 0.25, span)
        put(P['beam'], (xx, (D / 2 - 0.2) / 2, (ZJ + Z2) / 2), rot=(0, -a, math.pi / 2), scale=(math.hypot(uz - 0.25, span), 1, 1))
        put(P['window'], (sx * W / 2, (YJ + 0.1 - 0.1) / 2, ZJ + 1.6), rot=(0, 0, sx * math.pi / 2))
    by = D / 2 + 0.04
    for x in (-pi_, pi_):
        put(P['beam'], (x, by, (ZJ + Z2) / 2), rot=(0, math.pi / 2, 0), scale=(uz, 1, 1))
    put(P['beam'], (0, by, ZJ + 0.98), scale=(W, 1, 1))
    put(P['window'], (0, D / 2, ZJ + 1.75), rot=(0, 0, math.pi))
    # gable (jettied again) + its framing
    put(P['beam'], (0, YG + 0.06, Z2 + 0.08), scale=(W + 0.4, 1.4, 1.4))
    put(P['gable'], (0, YG, Z2 + 0.18), tint=plaster_hi)
    put(P['gable'], (0, D / 2 - 0.25, Z2 + 0.0), tint=plaster_hi)
    gh = RIDGE - Z2
    for sx in (-1, 1):
        put(P['beam'], (sx * W * 0.18, YG - 0.04, Z2 + 0.18 + 0.85), rot=(0, math.pi / 2, 0), scale=(1.4, 1, 1))
    put(P['loft'], (0, YG, Z2 + 0.3))
    # roof
    Ls = (W / 2 + 0.45) / math.cos(PITCH)
    n = 9
    step = (Ls - 0.93) / (n - 1)
    y0, y1 = YG - 0.55, D / 2 + 0.45
    ylen, yc = y1 - y0, (y0 + y1) / 2
    off = 0.20  # roof surface above the wall-top line
    for sx in (-1, 1):
        ex, ez = W / 2 + 0.45, Z2 - 0.45 * math.tan(PITCH)
        nx, nz = math.sin(PITCH), math.cos(PITCH)
        ux, uz_ = -math.cos(PITCH), math.sin(PITCH)
        for i in range(n):
            s = i * step
            x = ex + ux * s + nx * off
            z = ez + uz_ * s + nz * off
            jt = K.jit(roof_t, 0.07, vr)
            if sx > 0:
                put(P['roofrow'], (x, yc, z), rot=(0, PITCH + vr.uniform(-0.012, 0.012), 0), scale=(1, ylen, 1), tint=jt)
            else:
                put(P['roofrow'], (-x, yc, z), rot=(0, PITCH + vr.uniform(-0.012, 0.012), math.pi), scale=(1, ylen, 1), tint=jt)
    put(P['ridge'], (0, yc, RIDGE + off / math.cos(PITCH) + 0.02), scale=(1, ylen + 0.1, 1), tint=K.jit(roof_t, 0.0, vr))
    put(P['finial'], (0, y0 + 0.15, RIDGE + off / math.cos(PITCH) + 0.12))
    # bargeboards (front) along the slopes
    bl = (W / 2 + 0.5) / math.cos(PITCH)
    for sx in (-1, 1):
        cx = sx * (W / 2 + 0.5) / 2
        cz = Z2 + (W / 2 - abs(cx)) * math.tan(PITCH) + 0.10 / math.cos(PITCH)
        put(P['beam_teal'], (cx, y0 + 0.02, cz), rot=(0, sx * PITCH, 0), scale=(bl + 0.1, 1.0, 1.45))
    # string lights along the bargeboards
    for sx in (-1, 1):
        for k in range(8):
            t = (k + 0.5) / 8
            x = sx * (W / 2 + 0.45) * (1 - t)
            z = Z2 - 0.45 * math.tan(PITCH) + (RIDGE - Z2 + 0.45 * math.tan(PITCH)) * t - 0.08
            put(P['bulb'], (x, y0 - 0.14, z - 0.10))
    # chimney on the right slope near the back
    cxp = W / 7
    put(P['chimney'], (cxp, min(1.6, D / 2 - 0.9), Z2 + (W / 2 - cxp) * math.tan(PITCH) + 0.325 - 0.8), rot=(0, 0, 0.04))
    # shop sign on the right front corner of the jetty
    put(P['sign_frame'], (W / 2 - 0.1, YJ - 0.1, Z1 + 0.05))
    put(P['sign_holo'], (W / 2 - 0.1, YJ - 0.1, Z1 + 0.05))
    return B
