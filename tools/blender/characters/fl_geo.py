# FIRSTLIGHT character builder: geometry helpers (run inside Blender 5.x, headless).
# Parts are plain vertex/face lists with per-face atlas tiles and per-corner UVs; they become Blender
# objects only when weighted and joined. Blender axes: X = character's left, -Y = forward, Z = up.
# Our own code: MIT. Generated art: CC BY 4.0 (LICENSE-ART).

import math
import bpy
from mathutils import Vector, Matrix

TAU = math.tau


def v3(x, y=None, z=None):
    if y is None:
        return Vector(x)
    return Vector((x, y, z))


def smoothstep(a, b, x):
    if a == b:
        return 1.0 if x >= b else 0.0
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


class Part:
    """A mesh fragment: verts, faces, per-face tile name, per-face corner UVs (or None = tile centre)."""

    def __init__(self, name, tile=None):
        self.name = name
        self.tile = tile
        self.verts = []
        self.faces = []
        self.ftile = []
        self.fuv = []
        self.weights = None  # set by the builder: ("rigid", bone) | ("body",) | ("fn", callable)
        self.smooth = True
        self.sharp_angle = None  # degrees; mark sharp edges above this angle
        self.flat_ok = False

    def v(self, co):
        self.verts.append(Vector(co))
        return len(self.verts) - 1

    def f(self, idx, tile=None, uvs=None):
        self.faces.append(tuple(idx))
        self.ftile.append(tile or self.tile)
        self.fuv.append(uvs)

    def extend(self, other):
        off = len(self.verts)
        self.verts += [Vector(p) for p in other.verts]
        for fi, f in enumerate(other.faces):
            self.faces.append(tuple(i + off for i in f))
            self.ftile.append(other.ftile[fi])
            self.fuv.append(other.fuv[fi])
        return self

    def transform(self, m):
        self.verts = [m @ p for p in self.verts]
        return self

    def tri_count(self):
        return sum(len(f) - 2 for f in self.faces)

    def keep_faces(self, pred):
        """Drop faces whose centre fails pred(centre); unused verts are dropped too."""
        nf, nt, nu = [], [], []
        for f, t, uv in zip(self.faces, self.ftile, self.fuv):
            c = sum((self.verts[i] for i in f), Vector()) / len(f)
            if pred(c):
                nf.append(f); nt.append(t); nu.append(uv)
        used = sorted({i for f in nf for i in f})
        remap = {o: k for k, o in enumerate(used)}
        self.verts = [self.verts[i] for i in used]
        self.faces = [tuple(remap[i] for i in f) for f in nf]
        self.ftile, self.fuv = nt, nu
        return self

    def retile(self, pred, tile):
        """Set the tile of faces whose centre passes pred(centre)."""
        for fi, f in enumerate(self.faces):
            c = sum((self.verts[i] for i in f), Vector()) / len(f)
            if pred(c):
                self.ftile[fi] = tile
        return self


def frame_from_dir(d, up=Vector((0, 0, 1))):
    """Orthonormal frame (x, y, z) with z along d."""
    z = Vector(d).normalized()
    ref = up if abs(z.dot(up)) < 0.95 else Vector((0, -1, 0))
    x = ref.cross(z).normalized()
    y = z.cross(x).normalized()
    return x, y, z


def loft(name, rings, n, tile=None, cap0=False, cap1=False, closed=True, uv_rect=None, arc=(0.0, 1.0),
         flip=False):
    """Loft through rings. Each ring: dict(c, x, y, rx, ry, [shape: f(theta)->scale], [off: f(theta)->Vector]).
    The ring point at parameter theta: c + x*rx*cos*s + y*ry*sin*s. With closed=False the ring spans
    `arc` (fractions of a turn) and is left open (garment openings). uv_rect=(u0,v0,u1,v1) maps the
    (around, along) parameters into an atlas rectangle for pattern tiles."""
    p = Part(name, tile)
    cols = n if closed else n + 1
    grid = []
    for ri, r in enumerate(rings):
        row = []
        for k in range(cols):
            a = k / n
            ra = r.get("arc", arc)
            th = TAU * (ra[0] + (ra[1] - ra[0]) * a) if not closed else TAU * a
            s = r["shape"](th) if "shape" in r else 1.0
            pt = r["c"] + r["x"] * (r["rx"] * math.cos(th) * s) + r["y"] * (r["ry"] * math.sin(th) * s)
            if "off" in r:
                pt = pt + r["off"](th)
            row.append(p.v(pt))
        grid.append(row)
    nr = len(rings)

    def uv(k, ri):
        if not uv_rect:
            return None
        u0, v0, u1, v1 = uv_rect
        return (u0 + (u1 - u0) * (k / n), v0 + (v1 - v0) * (ri / max(1, nr - 1)))

    for ri in range(nr - 1):
        for k in range(n):
            k1 = (k + 1) % cols if closed else k + 1
            a, b, c, d = grid[ri][k], grid[ri][k1], grid[ri + 1][k1], grid[ri + 1][k]
            uvs = None
            if uv_rect:
                kk1 = k + 1
                uvs = [uv(k, ri), uv(kk1, ri), uv(kk1, ri + 1), uv(k, ri + 1)]
            if flip:
                p.f((a, d, c, b), uvs=[uvs[0], uvs[3], uvs[2], uvs[1]] if uvs else None)
            else:
                p.f((a, b, c, d), uvs=uvs)
    # orient outwards: compare the first side quad's normal with the ring's radial direction
    if p.faces:
        votes = 0.0
        for fi in range(0, len(p.faces), max(1, len(p.faces) // 7)):
            a, b, c, d = (p.verts[i] for i in p.faces[fi])
            nrm = (b - a).cross(d - a)
            ri = fi // n
            votes += nrm.dot(a - rings[min(ri, nr - 1)]["c"])
        if votes < 0:
            p.faces = [tuple(reversed(f)) for f in p.faces]
            p.fuv = [list(reversed(u)) if u else None for u in p.fuv]
        flip = votes < 0
    if cap0:
        c0 = p.v(rings[0]["c"] + rings[0].get("cap_off", Vector()))
        for k in range(n if closed else n):
            k1 = (k + 1) % cols if closed else k + 1
            p.f((grid[0][k1], grid[0][k], c0) if not flip else (grid[0][k], grid[0][k1], c0))
    if cap1:
        c1 = p.v(rings[-1]["c"] + rings[-1].get("cap_off", Vector()))
        for k in range(n):
            k1 = (k + 1) % cols if closed else k + 1
            p.f((grid[-1][k], grid[-1][k1], c1) if not flip else (grid[-1][k1], grid[-1][k], c1))
    p.grid = grid
    return p


def ring(c, x, y, rx, ry, **kw):
    d = dict(c=Vector(c), x=Vector(x), y=Vector(y), rx=rx, ry=ry)
    d.update(kw)
    return d


def tube(name, pts, radii, n=8, tile=None, cap0=True, cap1=True, up=Vector((0, 0, 1)), ry_scale=1.0,
         uv_rect=None):
    """Tube through a polyline with per-point radius (parallel-transport-ish frames)."""
    rings = []
    pts = [Vector(q) for q in pts]
    prev_x = None
    for i, q in enumerate(pts):
        if i == 0:
            d = pts[1] - pts[0]
        elif i == len(pts) - 1:
            d = pts[-1] - pts[-2]
        else:
            d = (pts[i + 1] - pts[i - 1])
        x, y, z = frame_from_dir(d, up)
        if prev_x is not None:
            # keep the frame continuous
            x = (prev_x - z * prev_x.dot(z)).normalized()
            y = z.cross(x).normalized()
        prev_x = x
        r = radii[i]
        rings.append(ring(q, x, y, r, r * ry_scale))
    return loft(name, rings, n, tile, cap0=cap0, cap1=cap1, uv_rect=uv_rect)


def superellipsoid(name, c, r, e1=0.5, e2=0.5, nu=16, nv=10, tile=None, frame=None, deform=None,
                   vrange=(0.0, 1.0), uv_rect=None):
    """Rounded box/blob. r=(rx, ry, rz); e1 (vertical) and e2 (horizontal) exponents: 1 = ellipsoid,
    small = boxy. vrange trims the latitudes (0 = bottom pole, 1 = top pole)."""
    c = Vector(c)
    fx, fy, fz = frame or (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))

    def sgnpow(v, e):
        return math.copysign(abs(v) ** e, v)

    p = Part(name, tile)
    rows = []
    v0, v1 = vrange
    for j in range(nv + 1):
        t = v0 + (v1 - v0) * j / nv
        phi = -math.pi / 2 + math.pi * t
        cp, sp = math.cos(phi), math.sin(phi)
        row = []
        for i in range(nu):
            th = TAU * i / nu
            ct, st = math.cos(th), math.sin(th)
            lx = r[0] * sgnpow(cp, e1) * sgnpow(ct, e2)
            ly = r[1] * sgnpow(cp, e1) * sgnpow(st, e2)
            lz = r[2] * sgnpow(sp, e1)
            q = Vector((lx, ly, lz))
            if deform:
                q = deform(q, th, t)
            row.append(p.v(c + fx * q.x + fy * q.y + fz * q.z))
        rows.append(row)
    for j in range(nv):
        for i in range(nu):
            i1 = (i + 1) % nu
            uvs = None
            if uv_rect:
                u0, w0, u1, w1 = uv_rect
                uvs = [(u0 + (u1 - u0) * i / nu, w0 + (w1 - w0) * j / nv),
                       (u0 + (u1 - u0) * (i + 1) / nu, w0 + (w1 - w0) * j / nv),
                       (u0 + (u1 - u0) * (i + 1) / nu, w0 + (w1 - w0) * (j + 1) / nv),
                       (u0 + (u1 - u0) * i / nu, w0 + (w1 - w0) * (j + 1) / nv)]
            a, b, cc, d = rows[j][i], rows[j][i1], rows[j + 1][i1], rows[j + 1][i]
            if j == 0 and v0 <= 0.0:
                p.f((a, cc, d), uvs=[uvs[0], uvs[2], uvs[3]] if uvs else None)
            elif j == nv - 1 and v1 >= 1.0:
                p.f((a, b, d), uvs=[uvs[0], uvs[1], uvs[3]] if uvs else None)
            else:
                p.f((a, b, cc, d), uvs=uvs)
    p.rows = rows
    return p


def disc(name, c, normal, r, n=16, tile=None, uv_rect=None, inner=None):
    """Flat disc (or ring if inner radius given) facing `normal`."""
    x, y, z = frame_from_dir(normal)
    p = Part(name, tile)
    outer = [p.v(Vector(c) + (x * math.cos(TAU * i / n) + y * math.sin(TAU * i / n)) * r) for i in range(n)]

    def uvat(q):
        if not uv_rect:
            return None
        u0, v0, u1, v1 = uv_rect
        lx = (q - Vector(c)).dot(x) / r * 0.5 + 0.5
        ly = (q - Vector(c)).dot(y) / r * 0.5 + 0.5
        return (u0 + (u1 - u0) * lx, v0 + (v1 - v0) * ly)

    if inner is None:
        cc = p.v(Vector(c))
        for i in range(n):
            i1 = (i + 1) % n
            idx = (outer[i], outer[i1], cc)
            p.f(idx, uvs=[uvat(p.verts[k]) for k in idx] if uv_rect else None)
    else:
        inn = [p.v(Vector(c) + (x * math.cos(TAU * i / n) + y * math.sin(TAU * i / n)) * inner) for i in range(n)]
        for i in range(n):
            i1 = (i + 1) % n
            idx = (outer[i], outer[i1], inn[i1], inn[i])
            p.f(idx, uvs=[uvat(p.verts[k]) for k in idx] if uv_rect else None)
    return p


def box(name, c, size, tile=None, frame=None):
    fx, fy, fz = frame or (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    p = Part(name, tile)
    idx = {}
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                idx[(sx, sy, sz)] = p.v(Vector(c) + fx * sx * hx + fy * sy * hy + fz * sz * hz)
    F = [((-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)), ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)),
         ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)), ((-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)),
         ((-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)), ((1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1))]
    for f in F:
        p.f([idx[k] for k in f])
    p.smooth = False
    return p


def mirror_x(part, name=None):
    q = Part(name or part.name + "_m", part.tile)
    q.verts = [Vector((-p.x, p.y, p.z)) for p in part.verts]
    for fi, f in enumerate(part.faces):
        q.faces.append(tuple(reversed(f)))
        q.ftile.append(part.ftile[fi])
        uv = part.fuv[fi]
        q.fuv.append(list(reversed(uv)) if uv else None)
    q.weights = part.weights
    q.smooth = part.smooth
    q.sharp_angle = part.sharp_angle
    return q


# ---------------------------------------------------------------------------------------------
# Blender object helpers


def part_to_object(part, atlas, coll=None):
    """Create a Blender mesh object from a Part: UVs from tiles, role colours, smooth shading."""
    me = bpy.data.meshes.new(part.name)
    me.from_pydata([tuple(p) for p in part.verts], [], [list(f) for f in part.faces])
    ob = bpy.data.objects.new(part.name, me)
    (coll or bpy.context.scene.collection).objects.link(ob)
    apply_tiles(ob, part.ftile, part.fuv, atlas)
    for poly in me.polygons:
        poly.use_smooth = part.smooth
    # weld coincident verts (pole rows, open-loft seams); loop UVs/colours survive the weld
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me)
    bm.free()
    if part.sharp_angle is not None:
        me.set_sharp_from_angle(angle=math.radians(part.sharp_angle))
    return ob


def apply_tiles(ob, ftile, fuv, atlas):
    """Per-face tile → UV (tile centre or tile-mapped explicit UVs) and role colour per corner."""
    me = ob.data
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    col = me.color_attributes.get("Role") or me.color_attributes.new("Role", "BYTE_COLOR", "CORNER")
    tile_attr = me.attributes.get("tile") or me.attributes.new("tile", "INT", "FACE")
    for poly in me.polygons:
        tname = ftile[poly.index]
        t = atlas.tile(tname)
        tile_attr.data[poly.index].value = t.index
        uvs = fuv[poly.index]
        for k, li in enumerate(poly.loop_indices):
            if uvs and uvs[k] is not None:
                u, v = uvs[k]
                uvl.data[li].uv = t.map(u, v)
            else:
                uvl.data[li].uv = t.centre()
            col.data[li].color = t.role_rgba()


def join(objs, name):
    objs = [o for o in objs if o is not None]
    base = objs[0]
    with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()
    base.name = name
    base.data.name = name
    return base


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)
