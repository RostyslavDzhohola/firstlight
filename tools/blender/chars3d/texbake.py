# FIRSTLIGHT sculpted characters: texture "baking" without a renderer. The game mesh's UV layout is
# rasterised in numpy; every texel is projected onto its part's signed-distance surface (the sculpt),
# which gives exact high-detail positions, normals, curvature and occlusion. Tangent-space normals use
# the per-triangle UV-gradient (cotangent) frame, which is what three.js builds in the shader when the
# mesh has no tangent attribute (OpenGL convention: green = +V in Blender's UVs; the client flips Y
# for glTF UVs with normalScale (1, -1)).
# Our own code: MIT.

import numpy as np

import sdf as S

F = np.float32


def mesh_tris(ob):
    """Triangles of a Blender mesh object: corner positions (T,3,3), corner normals (T,3,3), corner UVs
    (T,3,2), face part id (T,)."""
    me = ob.data
    nv = len(me.vertices)
    co = np.empty(nv * 3, F)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    nl = len(me.loops)
    vi = np.empty(nl, np.int32)
    me.loops.foreach_get("vertex_index", vi)
    uv = np.empty(nl * 2, F)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    cn = np.empty(nl * 3, F)
    me.corner_normals.foreach_get("vector", cn)
    cn = cn.reshape(-1, 3)
    npl = len(me.polygons)
    ls = np.empty(npl, np.int32)
    lt = np.empty(npl, np.int32)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    pid = np.zeros(npl, np.int32)
    if "part_id" in me.attributes:
        me.attributes["part_id"].data.foreach_get("value", pid)
    tri_l = []
    tri_p = []
    for k in range(3, int(lt.max()) + 1):
        sel = np.nonzero(lt == k)[0]
        for j in range(1, k - 1):
            tri_l.append(np.stack([ls[sel], ls[sel] + j, ls[sel] + j + 1], axis=1))
            tri_p.append(pid[sel])
    L = np.concatenate(tri_l)
    return co[vi[L]], cn[L], uv[L], np.concatenate(tri_p)


def rasterise(P3, N3, UV3, PID, size):
    """Per texel (rows bottom-up like Blender pixels): part id (0 = empty), low-poly position, normal,
    and the triangle's UV-gradient tangent frame."""
    H = W = size
    pid = np.zeros((H, W), np.int32)
    pos = np.zeros((H, W, 3), F)
    nrm = np.zeros((H, W, 3), F)
    tan = np.zeros((H, W, 3), F)
    bit = np.zeros((H, W, 3), F)
    # per-triangle gradients of u and v on the triangle plane
    e1 = P3[:, 1] - P3[:, 0]
    e2 = P3[:, 2] - P3[:, 0]
    fn = np.cross(e1, e2)
    A2 = np.linalg.norm(fn, axis=1)
    fn = fn / np.maximum(A2, 1e-12)[:, None]
    g1 = np.cross(fn, P3[:, 0] - P3[:, 2]) / np.maximum(A2, 1e-12)[:, None]  # grad of barycentric 1
    g2 = np.cross(fn, P3[:, 1] - P3[:, 0]) / np.maximum(A2, 1e-12)[:, None]  # grad of barycentric 2
    du1 = UV3[:, 1, 0] - UV3[:, 0, 0]
    du2 = UV3[:, 2, 0] - UV3[:, 0, 0]
    dv1 = UV3[:, 1, 1] - UV3[:, 0, 1]
    dv2 = UV3[:, 2, 1] - UV3[:, 0, 1]
    gu = g1 * du1[:, None] + g2 * du2[:, None]
    gv = g1 * dv1[:, None] + g2 * dv2[:, None]
    px = UV3 * F(size) - 0.5  # texel centres at integer coords
    for t in range(len(P3)):
        a, b, c = px[t]
        x0 = int(max(0, np.floor(min(a[0], b[0], c[0])) - 1))
        x1 = int(min(W - 1, np.ceil(max(a[0], b[0], c[0])) + 1))
        y0 = int(max(0, np.floor(min(a[1], b[1], c[1])) - 1))
        y1 = int(min(H - 1, np.ceil(max(a[1], b[1], c[1])) + 1))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1, dtype=F), np.arange(y0, y1 + 1, dtype=F))
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        w0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
        w1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
        w2 = 1 - w0 - w1
        eps = -1e-4
        m = (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
        if not m.any():
            continue
        yy = ys[m].astype(np.int32)
        xx = xs[m].astype(np.int32)
        W0, W1, W2 = w0[m][:, None], w1[m][:, None], w2[m][:, None]
        pid[yy, xx] = PID[t]
        pos[yy, xx] = W0 * P3[t, 0] + W1 * P3[t, 1] + W2 * P3[t, 2]
        nrm[yy, xx] = W0 * N3[t, 0] + W1 * N3[t, 1] + W2 * N3[t, 2]
        tan[yy, xx] = gu[t]
        bit[yy, xx] = gv[t]
    n = np.linalg.norm(nrm, axis=2, keepdims=True)
    nrm = nrm / np.maximum(n, 1e-9)
    return pid, pos, nrm, tan, bit


def project(field, P, iters=3, h=6e-4):
    """Snap points to the zero set of field; returns positions and unit normals."""
    Q = P.copy()
    for _ in range(iters):
        d = field(Q)
        g = S.gradient(field, Q, h)
        Q = Q - d[:, None] * g
    N = S.gradient(field, Q, h)
    return Q, N


def curvature(field, P, h=0.003):
    """Laplacian of the field (mean curvature x 2 on the surface): > 0 convex, < 0 concave."""
    d0 = field(P)
    acc = np.zeros(len(P), F) - 6 * d0
    for ax in range(3):
        e = np.zeros(3, F)
        e[ax] = h
        acc += field(P + e) + field(P - e)
    return acc / F(h * h)


def sdf_ao(field, P, N, dists=(0.006, 0.016, 0.032, 0.06, 0.1), strength=1.0):
    occ = np.zeros(len(P), F)
    w = 1.0
    tot = 0.0
    for h in dists:
        d = field(P + N * F(h))
        occ += F(w) * np.clip((h - d) / h, 0, 1)
        tot += w
        w *= 0.75
    return np.clip(1 - strength * occ / F(tot), 0, 1)


def tangent_normals(Nhi, Nlo, T, B):
    """Encode high normals in the cotangent frame [T B Nlo] (T, B made perpendicular to Nlo)."""
    T = T - (np.einsum("ij,ij->i", T, Nlo))[:, None] * Nlo
    B = B - (np.einsum("ij,ij->i", B, Nlo))[:, None] * Nlo
    s = 1.0 / np.sqrt(np.maximum(np.maximum(np.einsum("ij,ij->i", T, T), np.einsum("ij,ij->i", B, B)), 1e-18))
    T = T * s[:, None]
    B = B * s[:, None]
    # UV-degenerate triangles give a singular frame: fall back to any orthonormal frame there
    bad = np.abs(np.einsum("ij,ij->i", np.cross(T, B), Nlo)) < 1e-4
    if bad.any():
        ref = np.where(np.abs(Nlo[bad, 2:3]) < 0.9, np.array([[0, 0, 1]], F), np.array([[1, 0, 0]], F))
        t = np.cross(ref, Nlo[bad])
        t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-9)
        T[bad] = t
        B[bad] = np.cross(Nlo[bad], t)
    M = np.stack([T, B, Nlo], axis=2)  # columns
    n = np.linalg.solve(M.astype(np.float64), Nhi.astype(np.float64)[:, :, None])[:, :, 0]
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    n[:, 2] = np.maximum(n[:, 2], 0.05)
    n = n / np.linalg.norm(n, axis=1, keepdims=True)
    return (n * 0.5 + 0.5).astype(F)


def dilate(img, mask, iters=8):
    """Grow covered texels into empty ones (for mip/filter bleeding)."""
    img = img.copy()
    m = mask.copy()
    for _ in range(iters):
        acc = np.zeros_like(img)
        cnt = np.zeros(m.shape, dtype=F)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            sh = np.roll(np.roll(img, dy, 0), dx, 1)
            sm = np.roll(np.roll(m, dy, 0), dx, 1)
            acc += sh * sm[..., None]
            cnt += sm
        grow = (~m) & (cnt > 0)
        img[grow] = acc[grow] / cnt[grow][:, None]
        m = m | grow
    return img, m
