# FIRSTLIGHT sculpted props: shape helpers shared by the item recipes (on top of chars3d/sdf.py).
# Our own code: MIT.

import numpy as np

import sdf as S

F = np.float32


def spline(pts, n=24, radii=None):
    """Catmull-Rom through pts (and per-point radii), resampled to n points: chained round cones through
    a handful of points bend at visible corners."""
    P = np.asarray(pts, F)
    Q = np.concatenate([P[:1] * 2 - P[1:2], P, P[-1:] * 2 - P[-2:-1]])
    t = np.linspace(0, len(P) - 1, n)
    i = np.minimum(t.astype(int), len(P) - 2)
    u = (t - i)[:, None]
    p0, p1, p2, p3 = Q[i], Q[i + 1], Q[i + 2], Q[i + 3]
    out = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u ** 2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)
    if radii is None:
        return out
    r = np.interp(t, np.arange(len(P)), np.asarray(radii, F))
    return out, r


def smooth_tube(pts, radii, n=24, k=0.0):
    P, r = spline(pts, n, radii)
    return S.tube(list(P), list(r), k=k)


def poly2d(pts):
    """Signed distance to a closed 2D polygon (exact; negative inside), for (N,2) samples."""
    V = np.asarray(pts, F)

    def f(Q):
        d = np.full(len(Q), np.inf, F)
        sgn = np.ones(len(Q), F)
        j = len(V) - 1
        for i in range(len(V)):
            e = V[j] - V[i]
            w = Q - V[i]
            b = w - e[None, :] * np.clip((w @ e) / float(e @ e), 0, 1)[:, None]
            d = np.minimum(d, np.einsum("ij,ij->i", b, b))
            c1 = Q[:, 1] >= V[i][1]
            c2 = Q[:, 1] < V[j][1]
            c3 = e[0] * w[:, 1] > e[1] * w[:, 0]
            flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
            sgn = np.where(flip, -sgn, sgn)
            j = i
        return sgn * np.sqrt(d)
    return f
