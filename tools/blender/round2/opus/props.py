# Context dressing for the renders (not part of any building budget).
import math, random
import flkit as K

def portus_props():
    P = {}
    p = K.Piece("X_barrel")
    p.lathe([(0.0, 0.0), (0.27, 0.0), (0.32, 0.25), (0.33, 0.45), (0.32, 0.65), (0.27, 0.9), (0.0, 0.9)], seg=10, col=0x8A5A36, kind='wood')
    for z in (0.15, 0.75):
        p.cyl(0.31 if z < 0.5 else 0.30, 0.05, (0, 0, z), seg=10, col=0x3A3436, kind='iron')
    P['barrel'] = p.mesh()
    p = K.Piece("X_crate")
    p.box((0.6, 0.6, 0.6), (0, 0, 0.3), col=0xA87A48, kind='wood', bevel=0.02)
    for s in (-1, 1):
        p.box((0.62, 0.62, 0.06), (0, 0, 0.3 + s * 0.24), col=0x7E5434, kind='wood')
    P['crate'] = p.mesh()
    p = K.Piece("X_lamppost")
    p.cyl(0.18, 0.3, (0, 0, 0), seg=8, col=0x3A3436, kind='iron', base=True)
    p.cyl(0.06, 3.4, (0, 0, 0.3), seg=8, r2=0.045, col=0x3A3436, kind='iron', base=True)
    p.cyl(0.16, 0.06, (0, 0, 3.7), seg=6, col=0x3A3436, kind='iron', base=True)
    p.cyl(0.13, 0.42, (0, 0, 3.76), seg=6, r2=0.16, col=0xFFC46B, kind='glow', glow=0.7, base=True)
    p.cyl(0.22, 0.22, (0, 0, 4.18), seg=6, r2=0.02, col=0x3A3436, kind='iron', base=True)
    P['lamppost'] = p.mesh()
    rng = random.Random(4)
    p = K.Piece("X_tree")
    p.cyl(0.16, 2.2, (0, 0, 0), seg=7, r2=0.10, col=0x6B4A33, kind='wood', base=True)
    for (x, y, z, r, c) in [(0, 0, 2.9, 1.25, 0x5E9A45), (0.6, 0.2, 2.4, 0.85, 0x6FAE4F), (-0.55, -0.3, 2.5, 0.9, 0x548E3E), (0.1, -0.2, 3.6, 0.8, 0x7DBB57)]:
        p.sphere(r, (x, y, z), ico=2, noise=0.08, rng=rng, col=c, kind='leaf')
    P['tree'] = p.mesh()
    p = K.Piece("X_planter")
    p.box((0.7, 0.7, 0.45), (0, 0, 0.225), col=0xC9B79C, kind='stone', bevel=0.03, taper=(1.1, 1.1))
    p.sphere(0.42, (0, 0, 0.7), ico=1, noise=0.1, rng=rng, col=0x5E9A45, kind='leaf')
    for k in range(3):
        a = k * 2.1
        p.sphere(0.1, (0.25 * math.cos(a), 0.25 * math.sin(a), 0.95), u=5, v=3, col=[0xE2475B, 0xF4C542, 0xF6EEDF][k], kind='leaf')
    P['planter'] = p.mesh()
    return P

def figure(col_body=0x3F5F9A, col_acc=0xE9E4D8):
    """Neutral scale figure (1.75 m), a stand-in, not a character design."""
    p = K.Piece("X_figure")
    p.lathe([(0.0, 0.0), (0.12, 0.0), (0.13, 0.08), (0.11, 0.85)], seg=8, loc=(-0.1, 0, 0), col=0x3A3A44, kind='cloth')
    p.lathe([(0.0, 0.0), (0.12, 0.0), (0.13, 0.08), (0.11, 0.85)], seg=8, loc=(0.1, 0, 0), col=0x3A3A44, kind='cloth')
    p.lathe([(0.0, 0.8), (0.24, 0.82), (0.27, 1.05), (0.25, 1.35), (0.16, 1.48), (0.0, 1.5)], seg=10, col=col_body, kind='cloth')
    p.sphere(0.13, (0, 0, 1.62), u=10, v=7, col=0xE8C4A0, kind='paint')
    p.tube((-0.27, 0, 1.38), (-0.33, 0.02, 0.9), 0.06, seg=6, col=col_body, kind='cloth')
    p.tube((0.27, 0, 1.38), (0.33, 0.02, 0.9), 0.06, seg=6, col=col_body, kind='cloth')
    p.box((0.5, 0.3, 0.1), (0, 0.05, 0.95), col=col_acc, kind='paint')
    return p.mesh()
