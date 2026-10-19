# FIRSTLIGHT sculpted props: paint helpers for wood, worked metal, wraps and glowing glass, on top of
# chars3d/paint.py. Same contract: arrays of surface samples (weapon space), sRGB colours in [0, 1].
# Metal is painted, not shaded: the client's avatar material is a toon ramp with no metalness, so the
# highlights that make metal read (bright edges, a soft studio band) go into the albedo.
# Our own code: MIT. The painted textures are CC BY 4.0.

import numpy as np

import paint as PT
import sdf as S

F = np.float32


def axis_coords(P, a, b, ref=(0, 1, 0)):
    """Position along the segment a->b (metres from a), distance from its line, and the angle around
    it (radians, 0 towards `ref`)."""
    a, b = S.vec(a), S.vec(b)
    d = S.norm(b - a)
    Q = P - a
    s = Q @ d
    R = Q - s[:, None] * d
    r = S.length(R)
    u = S.norm(np.asarray(ref, F) - float(np.dot(ref, d)) * d)
    v = np.cross(d, u)
    th = np.arctan2(R @ v, R @ u)
    return s, r, th


def streaks(P, axis, freq=90.0, stretch=14.0, seed=0):
    """Long grain streaks in [-1, 1] along `axis`: noise squashed across the grain."""
    ax = S.norm(axis)
    along = (P @ ax)[:, None] * ax[None, :]
    Q = (P - along) * F(freq) + along * F(freq / stretch)
    return S.fbm(Q, 1.0, 3, seed)


def wood(P, axis, light, dark, seed=0, knots=0.0):
    """Wood: grain streaks between two tones, a few fine dark lines, optional knots."""
    g = streaks(P, axis, 70.0, 16.0, seed)
    lines = np.abs(np.sin(streaks(P, axis, 30.0, 25.0, seed + 7) * 9.0))
    t = np.clip(0.5 + 0.55 * g, 0, 1)
    rgb = PT.mix(PT.hexc(light), PT.hexc(dark), t)
    rgb = rgb * (1 - 0.18 * (lines < 0.18))[:, None]
    if knots:
        f1, _, cid = S.voronoi(P, 9.0, seed + 3)
        k = (cid < knots) * (1 - S.smoothstep(0.004, 0.012, f1))
        rgb = PT.mix(rgb, PT.hexc(dark) * 0.7, k)
    return np.clip(rgb, 0, 1)


def worked_metal(ctx, base, hi, lo=None, dents=0.0, band_dir=(0.3, 0.75, 0.6), band=0.35, seed=0):
    """Forged metal: the base tone, darker in occlusion, bright worn edges (convex cavity), a soft
    painted studio band where the normal faces band_dir, optional hammer dents (Voronoi cells)."""
    n = ctx.n
    rgb = PT.fill(n, PT.hexc(base))
    lo_c = PT.hexc(lo) if lo else PT.hexc(base) * 0.45
    ao = np.clip(ctx.ao, 0, 1)
    rgb = PT.mix(lo_c[None, :].repeat(n, 0), rgb, 0.35 + 0.65 * ao)
    if dents:
        f1, f2, _ = S.voronoi(ctx.P, dents, seed)
        rim = S.smoothstep(0.0, 0.25 / dents, f2 - f1)
        rgb = rgb * (0.86 + 0.14 * rim)[:, None]
    face = np.clip(ctx.N @ S.norm(band_dir), 0, 1)
    rgb = PT.mix(rgb, PT.hexc(hi), band * S.smoothstep(0.55, 0.95, face))
    edge = np.clip(ctx.cav, 0, 1)
    rgb = PT.mix(rgb, PT.hexc(hi), S.smoothstep(0.08, 0.5, edge) * 0.8)
    cav = np.clip(-ctx.cav, 0, 1)
    rgb = rgb * (1 - 0.35 * cav)[:, None]
    return np.clip(PT.variation(rgb, ctx.P, 0.05, 40.0, seed), 0, 1)


def helix(s, th, pitch, width=0.82):
    """A wrap wound along an axis: (band coordinate in [0, 1) across one turn, mask of the gap lines)."""
    ph = (s / pitch + th / (2 * np.pi)) % 1.0
    gap = 1 - S.smoothstep(0.0, 0.06, ph) * (1 - S.smoothstep(width, width + 0.06, ph))
    return ph, gap


def shade(ctx, rgb, ao_amt=0.5, cav_amt=0.4, edge_amt=0.15):
    """chars3d's painterly AO / cavity / edge pass, without its character-height top light."""
    return PT.shade(rgb, ctx.P, ctx.N, ctx.ao, ctx.cav, ao_amt=ao_amt, top_light=0.0, cav_amt=cav_amt,
                    edge_amt=edge_amt)
