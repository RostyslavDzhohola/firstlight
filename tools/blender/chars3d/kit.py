# FIRSTLIGHT sculpted characters: shared garment and accessory builders (robes, sleeves, boots, belts,
# straps, hair clumps), all as signed-distance fields over the shared T-pose skeleton.
# Our own code: MIT.

import math

import numpy as np

import anat as A
import sdf as S
from sdf import vec

F = np.float32


# ---------------------------------------------------------------------------------------------
# surface helpers


def project(field, p, off=0.0, iters=6):
    """Move point(s) p onto the surface of field, then off metres out along the normal."""
    P = np.atleast_2d(np.asarray(p, dtype=F))
    for _ in range(iters):
        d = field(P)
        g = S.gradient(field, P, 1e-3)
        P = P - (d - off)[:, None] * g
    return P if np.ndim(p) > 1 else P[0]


def ray_hit(field, origin, direction, off=0.0, tmax=0.5):
    """First point along origin + t * dir where field == off (bisection on a coarse march)."""
    o = vec(origin)
    d = S.norm(direction)
    ts = np.linspace(0, tmax, 200, dtype=F)
    P = o[None, :] + ts[:, None] * d[None, :]
    v = field(P) - off
    k = np.nonzero(v > 0)[0]
    if len(k) == 0:
        return o + d * tmax
    i = k[0]
    if i == 0:
        return o
    a, b = ts[i - 1], ts[i]
    for _ in range(30):
        m = 0.5 * (a + b)
        if field((o + d * m)[None, :])[0] - off > 0:
            b = m
        else:
            a = m
    return o + d * (0.5 * (a + b))


# ---------------------------------------------------------------------------------------------
# hair


class Hair:
    """Stylised hair: a cap hugging the skull above a hairline, plus clumps (tapered, flattened tubes
    that follow the skull and lift off at the tips)."""

    def __init__(self, head, cap=0.011, hairline=None, k=0.008):
        self.head = head
        self.cap_t = cap
        self.c = head.c
        self.centre = head.c + vec((0, 0.008, 0.045))
        self.clumps = []
        self.k = k
        self.hairline = hairline or (lambda th, ph: 0.0)

    def surf(self, az, el, off=0.0):
        """Point on the skull at azimuth az (deg, 0 = front, +90 = character's left) and elevation el
        (deg above the horizontal through the crown centre), offset off metres outward."""
        a, e = math.radians(az), math.radians(el)
        d = vec((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
        return ray_hit(self.head.field, self.centre, d, off)

    def clump(self, az, el, direction, length, width, thick=None, bend=(0, 0, 0), lift=0.004, tip_lift=0.02,
              taper=0.15, n=6, flat=0.45, curl=0.0):
        """direction: world vector (roughly tangent to the skull) the clump grows along."""
        root = self.surf(az, el, self.cap_t * 0.5)
        dvec = S.norm(direction)
        b = vec(bend)
        pts = []
        for i in range(n):
            s = i / (n - 1)
            p = root + dvec * (length * s) + b * (length * s * s)
            if curl:
                p = p + S.norm(np.cross(dvec, root - self.centre)) * curl * math.sin(s * math.pi) * length
            want = self.cap_t * 0.6 + lift + (tip_lift - lift) * s * s
            d = float(self.head.field(p[None, :])[0])
            if d < want:
                g = S.gradient(self.head.field, p[None, :])[0]
                p = p + g * (want - d)
            pts.append(p)
        w = [width * max(taper, (1 - (i / (n - 1)) ** 1.6)) for i in range(n)]
        w[-1] = width * 0.12
        up = S.norm(root - self.centre)
        self.clumps.append(S.tube(pts, w, k=0.004, flat=flat, up=tuple(up)))
        return pts

    def field(self):
        head = self.head.field
        cap_t = self.cap_t
        hl = self.hairline
        centre = self.centre
        clumps = list(self.clumps)
        k = self.k

        def f(P):
            q = P - centre
            az = np.degrees(np.arctan2(q[:, 0], -q[:, 1]))
            el = np.degrees(np.arctan2(q[:, 2], np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)))
            cap = head(P) - cap_t
            cap = S.smax(cap, -head(P) - 0.002, 0.004)  # a shell, not a solid (keeps the face clear)
            cut = (hl(az, el) - el) * F(0.0015)  # degrees -> metres-ish
            d = S.smax(cap, cut, 0.006)
            for c in clumps:
                d = S.smin(d, c(P), k)
            return d
        return f


# ---------------------------------------------------------------------------------------------
# garments


def ellipse_ring_dist(x, y, rx, ry):
    """Signed distance (approx.) from (x, y) to an ellipse with per-sample radii."""
    return A.ellipse2(x, y, rx, ry)


def skirt(z_top, z_hem, rx, ry, cy=0.02, thick=0.012, gap=None, folds=0, fold_amp=0.0, fold_phase=0.0,
          hem_wave=0.0, flare=1.3, seed=1):
    """Hollow skirt/robe tube between z_hem and z_top. rx/ry: (top, hem) radii; the radius grows with
    t^(1/flare) so it flares near the hem. gap: (top, hem) half-angle in degrees of a front opening.
    Folds: radial waves that deepen towards the hem."""
    def f(P):
        z = P[:, 2]
        t = np.clip((z_top - z) / (z_top - z_hem), 0, 1.15)
        tt = np.clip(t, 0, 1) ** (1.0 / flare)
        rxx = rx[0] + (rx[1] - rx[0]) * tt
        ryy = ry[0] + (ry[1] - ry[0]) * tt
        x, y = P[:, 0], P[:, 1] - cy
        th = np.arctan2(x, -y)  # 0 = front
        if folds:
            amp = fold_amp * (0.2 + 0.8 * np.clip(t, 0, 1) ** 1.3)
            wob = np.sin(th * folds + fold_phase + S.vnoise(P, 3.0, seed) * 1.2)
            sc = 1 + amp * wob / np.maximum(rxx, 0.05)
            x = x / sc
            y = y / sc
        d = np.abs(ellipse_ring_dist(x, y, rxx, ryy)) - thick * 0.5
        hem = z_hem + (hem_wave * np.sin(th * max(folds, 1) + fold_phase) if hem_wave else 0.0)
        d = S.smax(d, hem - z, 0.004)
        d = S.smax(d, z - z_top, 0.01)
        if gap is not None:
            g = np.radians(gap[0] + (gap[1] - gap[0]) * np.clip(t, 0, 1))
            r = np.sqrt(x * x + y * y)
            cut = (g - np.abs(th)) * r
            d = S.smax(d, cut, 0.004)
        return d * F(0.8)
    return f


def sleeve(sk, s, radii=(0.058, 0.052, 0.056, 0.075), ext=0.06, open_depth=0.07, thick=0.008, droop=0.02,
           folds=0.004, start=0.6):
    """Sleeve along the arm of side s (+1 left / -1 right): solid from the shoulder, hollow for the last
    open_depth metres so the hand comes out of it. radii at: shoulder, elbow, wrist, cuff end."""
    sd = "l" if s > 0 else "r"
    a = sk.head(f"upperarm_{sd}") * (1 - start) + sk.head(f"clavicle_{sd}") * start
    b = sk.tail(f"upperarm_{sd}")
    c = sk.tail(f"lowerarm_{sd}")
    ax = S.norm(c - b)
    e = c + ax * ext
    e = e + vec((0, 0, -droop))
    outer = S.smin_all([S.round_cone(a, b, radii[0], radii[1]), S.round_cone(b, c, radii[1], radii[2]),
                        S.round_cone(c, e, radii[2], radii[3])], 0.04)
    inner = S.round_cone(e - ax * open_depth, e + ax * 0.05, radii[2] - thick, radii[3] - thick)
    cap = S.plane(e, ax)

    def f(P):
        d = outer(P)
        d = S.smax(d, cap(P), 0.006)
        d = S.smax(d, -inner(P), 0.006)
        if folds:
            # compression rings near the elbow, a few diagonal twists on the upper arm
            along = (P - b) @ ax
            w = np.exp(-(along / 0.09) ** 2)
            d = d + folds * w * np.sin(along * 120 + S.vnoise(P, 25, 3) * 2)
            d = d + folds * 0.6 * np.sin((P @ S.norm(vec((0.3 * s, 0.6, 0.75)))) * 90) * (along < 0)
        return d * F(0.85)
    return f


def boot(sk, s, top=0.3, width=1.0, toe=0.135, heel=0.075, cuff=0.0, sole=0.012, round_toe=1.0, shaft_r=0.062):
    sd = "l" if s > 0 else "r"
    fx = float(sk.head(f"foot_{sd}")[0])
    foot = S.ellipsoid((fx, -0.04, 0.06), (0.058 * width, (toe + heel) * 0.5, 0.06))
    toe_b = S.ellipsoid((fx + 0.004 * s, -0.12, 0.045), (0.056 * width * round_toe, 0.07, 0.045))
    ankle = S.round_cone(vec((fx, 0.025, 0.07)), vec((fx, 0.03, top)), shaft_r * 1.05, shaft_r)
    flat = S.plane((0, 0, 0.0), (0, 0, -1))
    parts = [foot, toe_b, ankle]
    if cuff:
        parts.append(S.cyl((fx, 0.03, top - 0.01), shaft_r + cuff, 0.022, rad=0.008))

    def f(P):
        d = S.smin(parts[0](P), parts[1](P), 0.03)
        d = S.smin(d, parts[2](P), 0.035)
        for g in parts[3:]:
            d = S.smin(d, g(P), 0.01)
        d = S.smax(d, flat(P), 0.004)
        d = S.smax(d, P[:, 2] - top - 0.025, 0.01)
        return d
    return f


def band_on(field, pts, width, thick, off=0.0, closed=False, up=(0, 0, 1)):
    """A strap lying on a surface: path points are projected onto field (+ off) and swept as a
    flattened tube."""
    P = project(field, np.asarray(pts, dtype=F), off + thick * 0.5)
    if closed:
        P = np.concatenate([P, P[:1]])
    return S.tube(list(P), [width * 0.5] * len(P), k=0.0, flat=thick / width, up=up), P


def belt_ring(z, rx, ry, cy=0.02, h=0.045, t=0.012, k=0.004):
    """An elliptical belt band around the waist (height h, thickness t)."""
    def f(P):
        x, y = P[:, 0], P[:, 1] - cy
        d2 = np.abs(A.ellipse2(x, y, F(rx), F(ry))) - t * 0.5
        dz = np.abs(P[:, 2] - z) - h * 0.5
        return S.smax(d2, dz, k)
    return f
