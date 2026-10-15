# FIRSTLIGHT sculpted characters: signed-distance "sculpting" in numpy.
#
# Every shape is a function P (N,3 float32) -> distances (N,). Shapes combine with smooth unions, so
# limbs, faces and folds blend like clay. Meshing evaluates the field on a narrow band of a voxel grid
# and extracts the surface with OpenVDB (bundled with Blender 5.x).
# Blender axes: X = the character's left, -Y = forward, Z = up. Units: metres.
# Our own code: MIT.

import math
import numpy as np

F = np.float32


def vec(x):
    return np.asarray(x, dtype=F)


def norm(v):
    v = vec(v)
    n = float(np.linalg.norm(v))
    return v / (n if n > 1e-12 else 1.0)


def frame(fwd, up=(0, 0, 1)):
    """3x3 matrix whose columns are a right-handed frame with Y along `fwd` (bone convention)."""
    y = norm(fwd)
    up = norm(up)
    if abs(float(np.dot(y, up))) > 0.98:
        up = vec((1, 0, 0)) if abs(y[0]) < 0.9 else vec((0, 1, 0))
    x = norm(np.cross(y, up))
    z = np.cross(x, y)
    return np.stack([x, y, z], axis=1).astype(F)


def rot(axis, deg):
    a = norm(axis)
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    x, y, z = a
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]], dtype=F)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def length(P):
    return np.sqrt(np.einsum("ij,ij->i", P, P))


# ---------------------------------------------------------------------------------------------
# primitives (exact or conservative bounds)


def sphere(c, r):
    c = vec(c)
    return lambda P: length(P - c) - r


def ellipsoid(c, r, R=None):
    """Axis radii r=(rx,ry,rz) in a local frame R (columns = local axes); IQ's bound, made
    conservative so narrow-band culling stays safe."""
    c, r = vec(c), vec(r)
    rmin = float(r.min())

    def f(P):
        q = P - c
        if R is not None:
            q = q @ R
        k0 = length(q / r)
        k1 = length(q / (r * r))
        d = k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)
        return np.maximum(d, (k0 - 1.0) * rmin)
    return f


def capsule(a, b, r):
    a, b = vec(a), vec(b)
    ba = b - a
    L2 = float(np.dot(ba, ba))

    def f(P):
        pa = P - a
        h = np.clip(pa @ ba / L2, 0.0, 1.0)
        return length(pa - h[:, None] * ba) - r
    return f


def round_cone(a, b, r1, r2):
    """Cone with spherical caps between a (radius r1) and b (radius r2) (IQ)."""
    a, b = vec(a), vec(b)
    ba = b - a
    l2 = float(np.dot(ba, ba))
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2

    def f(P):
        pa = P - a
        y = pa @ ba
        z = y - l2
        xv = pa * l2 - y[:, None] * ba
        x2 = np.einsum("ij,ij->i", xv, xv)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        out = (np.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
        m1 = np.sign(z) * a2 * z2 > k
        m2 = np.sign(y) * a2 * y2 < k
        out = np.where(m1, np.sqrt(x2 + z2) * il2 - r2, out)
        out = np.where(m2, np.sqrt(x2 + y2) * il2 - r1, out)
        return out
    return f


def box(c, half, R=None, rad=0.0):
    c, half = vec(c), vec(half)

    def f(P):
        q = P - c
        if R is not None:
            q = q @ R
        q = np.abs(q) - (half - rad)
        out = length(np.maximum(q, 0.0)) + np.minimum(q.max(axis=1), 0.0)
        return out - rad
    return f


def torus(c, R_, r, Rm=None):
    """Ring around the local Z axis."""
    c = vec(c)

    def f(P):
        q = P - c
        if Rm is not None:
            q = q @ Rm
        d = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2) - R_
        return np.sqrt(d * d + q[:, 2] ** 2) - r
    return f


def cyl(c, r, h, R=None, rad=0.0):
    """Capped cylinder along local Z, half height h, optional edge rounding."""
    c = vec(c)

    def f(P):
        q = P - c
        if R is not None:
            q = q @ R
        dx = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2) - (r - rad)
        dz = np.abs(q[:, 2]) - (h - rad)
        return np.minimum(np.maximum(dx, dz), 0.0) + np.sqrt(np.maximum(dx, 0) ** 2 + np.maximum(dz, 0) ** 2) - rad
    return f


def plane(p, n):
    p, n = vec(p), norm(n)
    return lambda P: (P - p) @ n


def bounded(f, lo, hi, margin=0.04):
    """Evaluate f only inside the box [lo, hi] grown by `margin`; outside, return the distance to the
    grown box plus `margin`, still a lower bound of the true distance. The added margin matters: a
    value near zero at the box faces would make smooth unions (which dip by up to k/4) cross zero
    there and grow box-shaped sheets. Big speed-up for small parts."""
    lo = vec(lo) - margin
    hi = vec(hi) + margin

    def g(P):
        out = np.maximum(np.maximum(lo - P, P - hi), 0.0)
        dbox = np.sqrt(np.einsum("ij,ij->i", out, out))
        inside = dbox <= 0.0
        res = (dbox + margin).astype(F)
        if inside.any():
            res[inside] = f(P[inside])
        return res
    return g


def tube(pts, radii, k=0.0, flat=None, up=(0, 0, 1)):
    f = _tube(pts, radii, k, flat, up)
    P = np.asarray(pts, dtype=F)
    r = float(max(radii))
    return bounded(f, P.min(axis=0) - r, P.max(axis=0) + r)


def _tube(pts, radii, k=0.0, flat=None, up=(0, 0, 1)):
    """A smooth tube through points with per-point radii (chained round cones). flat=(ratio) squashes
    the cross-section along the curve's local 'up' side axis (hair clumps, scarves)."""
    pts = [vec(p) for p in pts]
    segs = [round_cone(pts[i], pts[i + 1], radii[i], radii[i + 1]) for i in range(len(pts) - 1)]
    if flat is None:
        if k > 0:
            return smin_all(segs, k)
        return union(*segs)
    # flattened: evaluate in a per-segment squashed space (conservative by dividing by the scale)
    ups = []
    for i in range(len(pts) - 1):
        d = norm(pts[i + 1] - pts[i])
        u = norm(up)
        side = norm(np.cross(d, u))
        nrm = norm(np.cross(side, d))
        ups.append(nrm)
    s = 1.0 / flat

    def f(P):
        best = None
        for i in range(len(pts) - 1):
            nrm = ups[i]
            mid = (pts[i] + pts[i + 1]) * 0.5
            q = P - mid
            along = q @ nrm
            Q = P + ((s - 1.0) * along)[:, None] * nrm[None, :]
            d = segs[i](Q) / s
            best = d if best is None else (smin(best, d, k) if k > 0 else np.minimum(best, d))
        return best
    return f


# ---------------------------------------------------------------------------------------------
# operators


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


def union(*fs):
    def f(P):
        d = fs[0](P)
        for g in fs[1:]:
            d = np.minimum(d, g(P))
        return d
    return f


def smin_all(fs, k):
    def f(P):
        d = fs[0](P)
        for g in fs[1:]:
            d = smin(d, g(P), k)
        return d
    return f


def sunion(f, g, k):
    return lambda P: smin(f(P), g(P), k)


def ssub(f, g, k=0.0):
    """f minus g."""
    return lambda P: smax(f(P), -g(P), k) if k > 0 else np.maximum(f(P), -g(P))


def sinter(f, g, k=0.0):
    return lambda P: smax(f(P), g(P), k) if k > 0 else np.maximum(f(P), g(P))


def shell(f, t):
    """Hollow shell of thickness t centred on f's surface."""
    return lambda P: np.abs(f(P)) - t * 0.5


def offset(f, d):
    return lambda P: f(P) - d


def displace(f, fn, lip=1.0):
    """f + fn(P); fn returns metres (positive pushes inwards). lip = 1 + max |grad fn| keeps the
    field conservative."""
    return lambda P: (f(P) + fn(P)) / lip


def mirror_x(f):
    def g(P):
        Q = P.copy()
        Q[:, 0] = np.abs(Q[:, 0])
        return f(Q)
    return g


def transformed(f, M, c=(0, 0, 0)):
    """Evaluate f in a rotated frame about point c (M maps world dirs to local dirs: q = M @ (p - c))."""
    c = vec(c)
    M = vec(M)

    def g(P):
        return f((P - c) @ M.T + c)
    return g


# ---------------------------------------------------------------------------------------------
# noise (value noise, hashed lattice; deterministic)


def _hash3(ix, iy, iz, seed):
    h = (ix.astype(np.uint32) * np.uint32(0x8DA6B343)) ^ (iy.astype(np.uint32) * np.uint32(0xD8163841)) ^ \
        (iz.astype(np.uint32) * np.uint32(0xCB1AB31F)) ^ np.uint32(seed * 0x9E3779B1 & 0xFFFFFFFF)
    h ^= h >> np.uint32(15)
    h *= np.uint32(0x2C1B3C6D)
    h ^= h >> np.uint32(12)
    h *= np.uint32(0x297A2D39)
    h ^= h >> np.uint32(15)
    return (h & np.uint32(0xFFFFFF)).astype(F) / F(0xFFFFFF)


def vnoise(P, freq=1.0, seed=0):
    """Value noise in [-1, 1]."""
    Q = P * F(freq) + F(1000.0)
    i = np.floor(Q)
    fr = Q - i
    i = i.astype(np.int64)
    u = fr * fr * (3 - 2 * fr)
    out = np.zeros(len(P), dtype=F)
    for dx in (0, 1):
        wx = u[:, 0] if dx else 1 - u[:, 0]
        for dy in (0, 1):
            wy = u[:, 1] if dy else 1 - u[:, 1]
            for dz in (0, 1):
                wz = u[:, 2] if dz else 1 - u[:, 2]
                out += wx * wy * wz * _hash3(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out * 2 - 1


def fbm(P, freq=1.0, octaves=4, seed=0, gain=0.5, lac=2.03):
    out = np.zeros(len(P), dtype=F)
    a, f, tot = 1.0, freq, 0.0
    for o in range(octaves):
        out += F(a) * vnoise(P, f, seed + o * 17)
        tot += a
        a *= gain
        f *= lac
    return out / F(tot)


def voronoi(P, freq, seed=0, jitter=0.85):
    """(f1, f2, cell id) of 3D Voronoi cells (for stone plates, scales)."""
    Q = P * F(freq)
    i = np.floor(Q).astype(np.int64)
    fr = Q - i
    f1 = np.full(len(P), 9.0, dtype=F)
    f2 = np.full(len(P), 9.0, dtype=F)
    cid = np.zeros(len(P), dtype=F)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cx, cy, cz = i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz
                ox = _hash3(cx, cy, cz, seed) * jitter + (1 - jitter) * 0.5
                oy = _hash3(cx, cy, cz, seed + 1) * jitter + (1 - jitter) * 0.5
                oz = _hash3(cx, cy, cz, seed + 2) * jitter + (1 - jitter) * 0.5
                d = np.sqrt((dx + ox - fr[:, 0]) ** 2 + (dy + oy - fr[:, 1]) ** 2 + (dz + oz - fr[:, 2]) ** 2)
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                cid = np.where(closer, _hash3(cx, cy, cz, seed + 3), cid)
                f1 = np.minimum(f1, d)
    return f1 / F(freq), f2 / F(freq), cid


# ---------------------------------------------------------------------------------------------
# meshing


SAFETY = 1.6


def evaluate_grid(f, bmin, bmax, vox, block=16, bw_vox=3.0, chunk=3_000_000, safety=None):
    """Narrow-band evaluation on a dense grid. Returns (array, origin, voxel). Blocks whose centre is
    far from the surface are filled with +-band without evaluating every voxel."""
    bmin, bmax = vec(bmin), vec(bmax)
    nb = np.maximum(np.ceil((bmax - bmin) / (vox * block)).astype(int), 1)
    dims = nb * block + 1
    bw = F(vox * bw_vox)
    centres = bmin + (np.indices(nb).reshape(3, -1).T.astype(F) + 0.5) * F(block * vox)
    dc = f(centres.astype(F))
    hd = block * vox * math.sqrt(3) * 0.5
    # a block is skipped only when its centre is far from the surface; fields whose slope exceeds 1
    # (displacements, angular cuts) need the extra safety, or a skipped block leaves a box-shaped
    # artefact where the true surface crossed it
    safety = SAFETY if safety is None else safety
    active = np.abs(dc) < hd * safety + 2 * vox
    arr = np.empty(tuple(dims), dtype=F)
    core = arr[:-1, :-1, :-1].reshape(nb[0], block, nb[1], block, nb[2], block)
    fill = np.where(dc > 0, bw, -bw).reshape(tuple(nb)).astype(F)
    core[...] = fill[:, None, :, None, :, None]
    ids = np.nonzero(active)[0]
    bi, bj, bk = np.unravel_index(ids, tuple(nb))
    loc = np.indices((block, block, block)).reshape(3, -1).T.astype(F)
    per = block ** 3
    step = max(1, chunk // per)
    for s in range(0, len(ids), step):
        sl = slice(s, s + step)
        org = np.stack([bi[sl], bj[sl], bk[sl]], axis=1).astype(F) * block
        pts = (org[:, None, :] + loc[None, :, :]).reshape(-1, 3) * F(vox) + bmin
        d = np.clip(f(pts), -bw, bw).reshape(-1, block, block, block)
        core[bi[sl], :, bj[sl], :, bk[sl], :] = d
    # the +1 border planes: copy the neighbours (they lie outside the box anyway)
    arr[-1, :, :] = bw
    arr[:, -1, :] = bw
    arr[:, :, -1] = bw
    arr[0, :, :] = bw
    arr[:, 0, :] = bw
    arr[:, :, 0] = bw
    return arr, bmin, vox, float(active.mean())


def mesh_field(f, bmin, bmax, vox, adaptivity=0.0):
    """Surface of f inside the box -> (verts (N,3), faces list of quads/tris as (M,4)/(K,3) arrays)."""
    import openvdb as vdb
    arr, org, vox, frac = evaluate_grid(f, bmin, bmax, vox)
    g = vdb.FloatGrid(float(vox * 3.0))
    g.copyFromArray(arr, (0, 0, 0), 0.0)
    if adaptivity > 0:
        pts, tris, quads = g.convertToPolygons(0.0, adaptivity)
    else:
        pts, quads = g.convertToQuads(0.0)
        tris = np.zeros((0, 3), dtype=np.uint32)
    pts = pts.astype(F) * F(vox) + org
    return pts, np.asarray(tris, dtype=np.int64), np.asarray(quads, dtype=np.int64), frac


def gradient(f, P, h=1e-3):
    """Central-difference normal of f at P."""
    ex = vec((h, 0, 0))
    ey = vec((0, h, 0))
    ez = vec((0, 0, h))
    g = np.stack([f(P + ex) - f(P - ex), f(P + ey) - f(P - ey), f(P + ez) - f(P - ez)], axis=1)
    return g / np.maximum(length(g), 1e-12)[:, None]


# ---------------------------------------------------------------------------------------------
# meshes as fields (lofted heads and bodies are modelled as meshes, then sampled as distances)


class MeshField:
    """Signed distance to a closed mesh, via an OpenVDB level set sampled into a dense array and read
    back with trilinear interpolation. Outside the band the value saturates at +-band."""

    def __init__(self, verts, tris=None, quads=None, vox=0.001, band=0.06, pad=0.07):
        import openvdb as vdb
        verts = np.asarray(verts, dtype=np.float64)
        self.lo = verts.min(axis=0) - pad
        hi = verts.max(axis=0) + pad
        self.vox = vox
        xf = vdb.createLinearTransform(vox)
        pts = (verts - self.lo) / vox  # index space -> world handled ourselves
        tris = np.zeros((0, 3), dtype=np.uint32) if tris is None else np.asarray(tris, dtype=np.uint32)
        quads = np.zeros((0, 4), dtype=np.uint32) if quads is None else np.asarray(quads, dtype=np.uint32)
        hw = band / vox
        g = vdb.FloatGrid.createLevelSetFromPolygons(pts * vox, tris, quads, xf, hw)
        dims = np.ceil((hi - self.lo) / vox).astype(int) + 1
        arr = np.full(tuple(dims), float(band), dtype=np.float32)
        g.copyToArray(arr, (0, 0, 0))
        self.arr = np.clip(arr, -band, band)
        self.dims = dims
        self.band = band

    def __call__(self, P):
        q = (P - self.lo.astype(F)) / F(self.vox)
        hi = self.dims - 1.001
        inside = np.all((q >= 0) & (q <= hi), axis=1)
        q = np.clip(q, 0, hi)
        i = np.floor(q).astype(np.int64)
        t = (q - i).astype(F)
        a = self.arr
        x0, y0, z0 = i[:, 0], i[:, 1], i[:, 2]
        x1, y1, z1 = x0 + 1, y0 + 1, z0 + 1
        tx, ty, tz = t[:, 0], t[:, 1], t[:, 2]
        c00 = a[x0, y0, z0] * (1 - tx) + a[x1, y0, z0] * tx
        c10 = a[x0, y1, z0] * (1 - tx) + a[x1, y1, z0] * tx
        c01 = a[x0, y0, z1] * (1 - tx) + a[x1, y0, z1] * tx
        c11 = a[x0, y1, z1] * (1 - tx) + a[x1, y1, z1] * tx
        c0 = c00 * (1 - ty) + c10 * ty
        c1 = c01 * (1 - ty) + c11 * ty
        d = c0 * (1 - tz) + c1 * tz
        # outside the sampled box: distance to the box plus the band (keeps narrow-band culling useful)
        lo = self.lo.astype(F)
        hi_w = lo + F(self.vox) * (self.dims - 1).astype(F)
        out = np.maximum(np.maximum(lo - P, P - hi_w), 0.0)
        far = np.sqrt(np.einsum("ij,ij->i", out, out)) + F(self.band)
        return np.where(inside, d, far).astype(F)


def loft(profiles, nz=140, nt=180, expo=2.0, z_range=None):
    """Closed lofted surface from per-height profiles (callables of z): 'yf' front (min y), 'yb' back
    (max y), 'w' half width, optional 'ym' (y of the widest point), 'xc' centre x, 'ex' exponent.
    z_range=(z_bottom, z_top): both ends close at a pole. Returns (verts, tris, quads)."""
    zb, zt = z_range
    # cosine spacing: denser rings near the poles where the curvature is high
    s = (1 - np.cos(np.linspace(0, math.pi, nz + 2)[1:-1])) * 0.5
    zs = zb + (zt - zb) * s
    yf, yb, w = profiles["yf"](zs), profiles["yb"](zs), profiles["w"](zs)
    ym = profiles["ym"](zs) if "ym" in profiles else (yf + yb) * 0.5
    xc = profiles["xc"](zs) if "xc" in profiles else np.zeros_like(zs)
    ex = profiles["ex"](zs) if "ex" in profiles else np.full_like(zs, expo)
    t = np.linspace(0, 2 * math.pi, nt, endpoint=False)
    ct, st = np.cos(t), np.sin(t)
    V = []
    for k in range(nz):
        e = 2.0 / ex[k]
        x = xc[k] + w[k] * np.sign(ct) * np.abs(ct) ** e
        dy = np.where(st < 0, ym[k] - yf[k], yb[k] - ym[k])
        y = ym[k] + dy * np.sign(st) * np.abs(st) ** e
        V.append(np.stack([x, y, np.full(nt, zs[k])], axis=1))
    V = np.concatenate(V)
    bot = np.array([[xc[0], (yf[0] + yb[0]) * 0.5, zb]])
    top = np.array([[xc[-1], (yf[-1] + yb[-1]) * 0.5, zt]])
    nb_, nt_ = len(V), len(V) + 1
    V = np.concatenate([V, bot, top])
    quads = []
    for k in range(nz - 1):
        for j in range(nt):
            a = k * nt + j
            b = k * nt + (j + 1) % nt
            quads.append((a, b, b + nt, a + nt))
    tris = []
    for j in range(nt):
        tris.append((nb_, (j + 1) % nt, j))
        tris.append((nt_, (nz - 1) * nt + j, (nz - 1) * nt + (j + 1) % nt))
    return V.astype(np.float32), np.array(tris, dtype=np.int64), np.array(quads, dtype=np.int64)
