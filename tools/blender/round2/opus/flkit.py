# FIRSTLIGHT design round (opus, part B): shared Blender helpers.
# Kit pieces are built with bmesh into mesh datablocks carrying two corner colour layers:
#   Col = linear base colour, PBR = (metallic, roughness, emission strength 0..1, 1).
# One opaque material (M_Kit) reads both, so a whole building is one opaque material + one
# shared hologram material (M_Holo) (+ M_Portal on the gate). Placements are linked duplicates
# (instances) of the kit meshes; the triangle count sums every placed instance.
import bpy, bmesh, math, random, os, sys, time
from mathutils import Vector, Matrix, Euler, Quaternion

T0 = time.time()
def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)

def args():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {}
    i = 0
    while i < len(a):
        if a[i].startswith("--"):
            k = a[i][2:]
            if i + 1 < len(a) and not a[i + 1].startswith("--"):
                out[k] = a[i + 1]; i += 2
            else:
                out[k] = True; i += 1
        else:
            i += 1
    return out

# ------------------------------------------------------------------ colour
def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def C(h, a=1.0):
    """sRGB hex (int or '#rrggbb') or linear tuple -> linear RGBA."""
    if isinstance(h, tuple) or isinstance(h, list):
        return tuple(h) if len(h) == 4 else (h[0], h[1], h[2], a)
    if isinstance(h, str):
        h = int(h.lstrip('#'), 16)
    return (_lin(((h >> 16) & 255) / 255), _lin(((h >> 8) & 255) / 255), _lin((h & 255) / 255), a)

def mixc(a, b, t):
    a, b = C(a), C(b)
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(4))

def jit(c, amt=0.06, rng=random):
    c = C(c)
    k = 1 + rng.uniform(-amt, amt)
    return (c[0] * k * (1 + rng.uniform(-amt, amt) * 0.4), c[1] * k, c[2] * k * (1 + rng.uniform(-amt, amt) * 0.4), 1)

#               metallic roughness emission
PBR = {
    'paint':   (0.0, 0.70, 0.0),
    'plaster': (0.0, 0.92, 0.0),
    'wood':    (0.0, 0.80, 0.0),
    'stone':   (0.0, 0.88, 0.0),
    'cloth':   (0.0, 0.95, 0.0),
    'leaf':    (0.0, 0.75, 0.0),
    'iron':    (0.85, 0.48, 0.0),
    'brass':   (1.0, 0.30, 0.0),
    'chrome':  (1.0, 0.13, 0.0),
    'enamel':  (0.0, 0.32, 0.0),
    'glass':   (0.0, 0.05, 0.0),
    'glow':    (0.0, 0.50, 1.0),
}

# ------------------------------------------------------------------ kit piece builder
class Piece:
    """One reusable kit mesh, assembled from parts in a single bmesh."""
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.lc = self.bm.loops.layers.float_color.new("Col")
        self.lp = self.bm.loops.layers.float_color.new("PBR")

    # -- internals
    def _begin(self):
        return set(self.bm.faces)

    def _end(self, before, M, col, kind, glow, mat, recalc=True, smooth=True):
        new = [f for f in self.bm.faces if f not in before]
        vs = list({v for f in new for v in f.verts})
        if M is not None:
            bmesh.ops.transform(self.bm, matrix=M, verts=vs)
        if recalc:
            bmesh.ops.recalc_face_normals(self.bm, faces=new)
        self.paint(new, col, kind, glow, mat, smooth)
        return new

    def paint(self, faces, col, kind='paint', glow=None, mat=0, smooth=True):
        c = C(col)
        m, r, e = PBR[kind]
        if glow is not None:
            e = glow
        for f in faces:
            f.material_index = mat
            f.smooth = smooth
            for l in f.loops:
                l[self.lc] = c
                l[self.lp] = (m, r, e, 1.0)

    @staticmethod
    def M(loc=(0, 0, 0), rot=(0, 0, 0), scale=None):
        m = Matrix.Translation(Vector(loc)) @ Euler(rot, 'XYZ').to_matrix().to_4x4()
        if scale is not None:
            m = m @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        return m

    # -- primitives
    def box(self, size, loc=(0, 0, 0), rot=(0, 0, 0), col=0xffffff, kind='paint', bevel=0.0,
            taper=(1.0, 1.0), shear=(0.0, 0.0), glow=None, mat=0, seg=1):
        """Box of `size` centred at loc. taper scales the top face (x, y); shear offsets the top (x, y)."""
        b = self._begin()
        r = bmesh.ops.create_cube(self.bm, size=1.0)
        sx, sy, sz = size
        for v in r['verts']:
            top = v.co.z > 0
            x, y, z = v.co.x * sx, v.co.y * sy, v.co.z * sz
            if top:
                x = x * taper[0] + shear[0]
                y = y * taper[1] + shear[1]
            v.co = (x, y, z)
        if bevel > 0:
            new = [f for f in self.bm.faces if f not in b]
            edges = list({e for f in new for e in f.edges})
            bmesh.ops.bevel(self.bm, geom=edges, offset=bevel, offset_type='OFFSET', segments=seg,
                            profile=0.5, affect='EDGES', clamp_overlap=True)
        return self._end(b, self.M(loc, rot), col, kind, glow, mat)

    def cyl(self, r1, h, loc=(0, 0, 0), rot=(0, 0, 0), seg=12, r2=None, col=0xffffff, kind='paint',
            cap=True, glow=None, mat=0, base=False, smooth=True):
        """Cylinder/cone along local Z, centred (or with its base at loc if base=True)."""
        b = self._begin()
        bmesh.ops.create_cone(self.bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r1,
                              radius2=r1 if r2 is None else r2, depth=h)
        M = self.M(loc, rot) @ Matrix.Translation((0, 0, h / 2 if base else 0))
        return self._end(b, M, col, kind, glow, mat, smooth=smooth)

    def sphere(self, r, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), u=8, v=6, col=0xffffff, kind='paint',
               glow=None, mat=0, ico=0, noise=0.0, rng=None):
        b = self._begin()
        if ico:
            bmesh.ops.create_icosphere(self.bm, subdivisions=ico, radius=r)
        else:
            bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=v, radius=r)
        if noise > 0:
            rng = rng or random
            for f in [f for f in self.bm.faces if f not in b]:
                pass
            for vv in {vv for f in self.bm.faces if f not in b for vv in f.verts}:
                vv.co *= 1 + rng.uniform(-noise, noise)
        return self._end(b, self.M(loc, rot, scale), col, kind, glow, mat)

    def prism(self, pts, depth, loc=(0, 0, 0), rot=(0, 0, 0), plane='XZ', col=0xffffff, kind='paint',
              glow=None, mat=0, caps=True, bevel=0.0, smooth=True):
        """Extrude a 2D outline (u, v) by depth along the plane's normal (centred).
        plane 'XZ': u->X, v->Z, depth along Y.  'XY': u->X, v->Y, depth along Z (base at 0 if depth>0).  'YZ': u->Y, v->Z, depth along X."""
        b = self._begin()
        bm = self.bm
        if plane == 'XZ':
            mk = lambda u, v, w: (u, w, v)
            d0, d1 = -depth / 2, depth / 2
        elif plane == 'XY':
            mk = lambda u, v, w: (u, v, w)
            d0, d1 = 0.0, depth
        else:
            mk = lambda u, v, w: (w, u, v)
            d0, d1 = -depth / 2, depth / 2
        A = [bm.verts.new(mk(u, v, d0)) for u, v in pts]
        B = [bm.verts.new(mk(u, v, d1)) for u, v in pts]
        n = len(pts)
        if caps:
            bm.faces.new(A)
            bm.faces.new(list(reversed(B)))
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((A[i], A[j], B[j], B[i]))
        if bevel > 0:
            new = [f for f in bm.faces if f not in b]
            edges = list({e for f in new for e in f.edges})
            bmesh.ops.bevel(bm, geom=edges, offset=bevel, offset_type='OFFSET', segments=1,
                            profile=0.5, affect='EDGES', clamp_overlap=True)
        return self._end(b, self.M(loc, rot), col, kind, glow, mat, smooth=smooth)

    def lathe(self, prof, seg=12, loc=(0, 0, 0), rot=(0, 0, 0), col=0xffffff, kind='paint', glow=None,
              mat=0, cap0=True, cap1=True, a0=0.0, a1=2 * math.pi, scale=(1, 1, 1)):
        """Surface of revolution of profile [(r, z), ...] around local Z."""
        b = self._begin()
        bm = self.bm
        full = abs(a1 - a0 - 2 * math.pi) < 1e-6
        ns = seg if full else seg + 1
        rings = []
        for (r, z) in prof:
            ring = []
            for k in range(ns):
                a = a0 + (a1 - a0) * k / seg
                ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
            rings.append(ring)
        for i in range(len(prof) - 1):
            for k in range(seg):
                k2 = (k + 1) % ns
                q = (rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k])
                if len(set(q)) == 4:
                    bm.faces.new(q)
        if full:
            if cap0 and prof[0][0] > 1e-5:
                bm.faces.new(list(reversed(rings[0])))
            if cap1 and prof[-1][0] > 1e-5:
                bm.faces.new(rings[-1])
        bmesh.ops.remove_doubles(bm, verts=[v for r in rings for v in r], dist=1e-5)
        return self._end(b, self.M(loc, rot, scale), col, kind, glow, mat)

    def torus(self, R, r, seg=16, rseg=6, loc=(0, 0, 0), rot=(0, 0, 0), col=0xffffff, kind='paint',
              glow=None, mat=0, a0=0.0, a1=2 * math.pi, scale=(1, 1, 1)):
        """Torus in the local XY plane (around Z); partial when a1-a0 < 2pi."""
        b = self._begin()
        bm = self.bm
        full = abs(a1 - a0 - 2 * math.pi) < 1e-6
        ns = seg if full else seg + 1
        grid = []
        for k in range(ns):
            a = a0 + (a1 - a0) * k / seg
            c, s = math.cos(a), math.sin(a)
            ring = []
            for j in range(rseg):
                t = 2 * math.pi * j / rseg
                rr = R + r * math.cos(t)
                ring.append(bm.verts.new((rr * c, rr * s, r * math.sin(t))))
            grid.append(ring)
        for k in range(seg):
            k2 = (k + 1) % ns
            for j in range(rseg):
                j2 = (j + 1) % rseg
                bm.faces.new((grid[k][j], grid[k2][j], grid[k2][j2], grid[k][j2]))
        if not full:
            bm.faces.new(list(reversed(grid[0])))
            bm.faces.new(grid[-1])
        return self._end(b, self.M(loc, rot, scale), col, kind, glow, mat)

    def quad(self, pts3, col=0xffffff, kind='paint', glow=None, mat=0):
        b = self._begin()
        self.bm.faces.new([self.bm.verts.new(p) for p in pts3])
        return self._end(b, None, col, kind, glow, mat, recalc=False)

    def tube(self, p0, p1, r, seg=6, col=0xffffff, kind='iron', glow=None, mat=0, cap=True, r2=None):
        """Cylinder from point p0 to p1."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        b = self._begin()
        bmesh.ops.create_cone(self.bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r,
                              radius2=r if r2 is None else r2, depth=d.length)
        M = Matrix.Translation((p0 + p1) / 2) @ q.to_matrix().to_4x4()
        return self._end(b, M, col, kind, glow, mat)

    def mesh(self, sharp_deg=50):
        me = bpy.data.meshes.new(self.name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        try:
            me.set_sharp_from_angle(angle=math.radians(sharp_deg))
        except Exception as ex:
            log("set_sharp_from_angle failed", ex)
        me.color_attributes.active_color_name = "Col"
        return me

def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)

# ------------------------------------------------------------------ building assembly
class Building:
    """Places kit meshes as linked-duplicate objects; tracks instances and triangles."""
    def __init__(self, name, mats, origin=Matrix.Identity(4)):
        self.name = name
        self.coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(self.coll)
        self.mats = mats
        self.objs = []
        self.origin = origin

    def put(self, me, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), tint=None, name=None, count=True):
        if len(me.materials) == 0:
            for m in self.mats:
                me.materials.append(m)
        ob = bpy.data.objects.new(name or me.name, me)
        local = Matrix.Translation(Vector(loc)) @ Euler(rot, 'XYZ').to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1))
        ob.matrix_world = self.origin @ local
        if tint is not None:
            ob.color = C(tint)
        self.coll.objects.link(ob)
        ob["counted"] = bool(count)
        wn = ob.modifiers.new("WN", 'WEIGHTED_NORMAL')
        wn.keep_sharp = True
        wn.weight = 50
        self.objs.append(ob)
        return ob

    def stats(self):
        per = {}
        total = 0
        for ob in self.objs:
            if not ob["counted"]:
                continue
            t = tris(ob.data)
            total += t
            e = per.setdefault(ob.data.name, [0, 0])
            e[0] = t
            e[1] += 1
        return total, per

    def report(self, path=None):
        total, per = self.stats()
        lines = [f"{self.name}: {total} triangles placed, {len(per)} unique kit meshes, "
                 f"{sum(v[1] for v in per.values())} instances"]
        uniq = 0
        for k, (t, n) in sorted(per.items(), key=lambda kv: -kv[1][0] * kv[1][1]):
            lines.append(f"  {k:24s} {t:5d} tris x {n:3d} = {t * n:6d}")
            uniq += t
        lines.append(f"  unique kit triangles: {uniq}")
        txt = "\n".join(lines)
        log(txt)
        if path:
            with open(path, "w") as fh:
                fh.write(txt + "\n")
        return total

# ------------------------------------------------------------------ materials
def _nodes(m):
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    return nt, nt.nodes, nt.links

def mat_kit(name="M_Kit", grit=1.0, emis_scale=7.0):
    """Opaque kit material: vertex colour x object tint x painterly noise; PBR attribute drives
    metallic/roughness/emission. AO darkening stands in for the game's GTAO / baked vertex AO."""
    m = bpy.data.materials.new(name)
    nt, N, L = _nodes(m)
    out = N.new("ShaderNodeOutputMaterial")
    bs = N.new("ShaderNodeBsdfPrincipled")
    col = N.new("ShaderNodeVertexColor"); col.layer_name = "Col"
    pbr = N.new("ShaderNodeAttribute"); pbr.attribute_name = "PBR"; pbr.attribute_type = 'GEOMETRY'
    sep = N.new("ShaderNodeSeparateColor"); L.new(pbr.outputs["Color"], sep.inputs[0])
    obi = N.new("ShaderNodeObjectInfo")
    tint = N.new("ShaderNodeMix"); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'
    tint.inputs[0].default_value = 1.0
    L.new(col.outputs["Color"], tint.inputs[6]); L.new(obi.outputs["Color"], tint.inputs[7])
    # painterly variation: large soft blotches + finer brush grain, world space
    tc = N.new("ShaderNodeTexCoord")
    geo = N.new("ShaderNodeNewGeometry")
    n1 = N.new("ShaderNodeTexNoise"); n1.inputs["Scale"].default_value = 0.6; n1.inputs["Detail"].default_value = 3
    n2 = N.new("ShaderNodeTexNoise"); n2.inputs["Scale"].default_value = 5.0; n2.inputs["Detail"].default_value = 2
    n2.inputs["Roughness"].default_value = 0.6
    L.new(geo.outputs["Position"], n1.inputs["Vector"]); L.new(geo.outputs["Position"], n2.inputs["Vector"])
    mr1 = N.new("ShaderNodeMapRange"); mr1.inputs[1].default_value = 0.3; mr1.inputs[2].default_value = 0.7
    mr1.inputs[3].default_value = 1 - 0.10 * grit; mr1.inputs[4].default_value = 1 + 0.07 * grit
    L.new(n1.outputs["Fac"], mr1.inputs[0])
    mr2 = N.new("ShaderNodeMapRange"); mr2.inputs[1].default_value = 0.35; mr2.inputs[2].default_value = 0.65
    mr2.inputs[3].default_value = 1 - 0.06 * grit; mr2.inputs[4].default_value = 1 + 0.04 * grit
    L.new(n2.outputs["Fac"], mr2.inputs[0])
    mul = N.new("ShaderNodeMath"); mul.operation = 'MULTIPLY'
    L.new(mr1.outputs[0], mul.inputs[0]); L.new(mr2.outputs[0], mul.inputs[1])
    # grime near the ground (world Z, building frame ~ ground at 0)
    sepz = N.new("ShaderNodeSeparateXYZ"); L.new(geo.outputs["Position"], sepz.inputs[0])
    gr = N.new("ShaderNodeMapRange"); gr.inputs[1].default_value = -0.2; gr.inputs[2].default_value = 0.9
    gr.inputs[3].default_value = 1 - 0.22 * grit; gr.inputs[4].default_value = 1.0
    L.new(sepz.outputs["Z"], gr.inputs[0])
    mul2 = N.new("ShaderNodeMath"); mul2.operation = 'MULTIPLY'
    L.new(mul.outputs[0], mul2.inputs[0]); L.new(gr.outputs[0], mul2.inputs[1])
    # AO (contact shadows in crevices)
    ao = N.new("ShaderNodeAmbientOcclusion"); ao.inputs["Distance"].default_value = 0.6; ao.samples = 8
    aom = N.new("ShaderNodeMapRange"); aom.inputs[3].default_value = 0.72; aom.inputs[4].default_value = 1.0
    L.new(ao.outputs["AO"], aom.inputs[0])
    mul3 = N.new("ShaderNodeMath"); mul3.operation = 'MULTIPLY'
    L.new(mul2.outputs[0], mul3.inputs[0]); L.new(aom.outputs[0], mul3.inputs[1])
    # metals skip the painterly darkening partially
    fin = N.new("ShaderNodeMix"); fin.data_type = 'RGBA'; fin.blend_type = 'MULTIPLY'
    L.new(mul3.outputs[0], fin.inputs[0])
    L.new(tint.outputs[2], fin.inputs[6])
    L.new(tint.outputs[2], fin.inputs[7])
    # Mix(factor=f, A=c, B=c, multiply) = c*(1-f) + c*c*f : not what we want -> use scale instead
    sc = N.new("ShaderNodeVectorMath"); sc.operation = 'SCALE'
    L.new(tint.outputs[2], sc.inputs[0]); L.new(mul3.outputs[0], sc.inputs["Scale"])
    L.new(sc.outputs[0], bs.inputs["Base Color"])
    L.new(sep.outputs[0], bs.inputs["Metallic"])
    L.new(sep.outputs[1], bs.inputs["Roughness"])
    L.new(tint.outputs[2], bs.inputs["Emission Color"])
    em = N.new("ShaderNodeMath"); em.operation = 'MULTIPLY'; em.inputs[1].default_value = emis_scale
    L.new(sep.outputs[2], em.inputs[0]); L.new(em.outputs[0], bs.inputs["Emission Strength"])
    try:
        bs.inputs["Specular IOR Level"].default_value = 0.4
    except KeyError:
        pass
    L.new(bs.outputs[0], out.inputs[0])
    nt.nodes.remove(fin)
    return m

def mat_holo(name="M_Holo", strength=2.6, scan=40.0):
    """Diegetic hologram: additive emission from vertex colour with scanlines and a fresnel edge."""
    m = bpy.data.materials.new(name)
    nt, N, L = _nodes(m)
    out = N.new("ShaderNodeOutputMaterial")
    col = N.new("ShaderNodeVertexColor"); col.layer_name = "Col"
    obi = N.new("ShaderNodeObjectInfo")
    tint = N.new("ShaderNodeMix"); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'; tint.inputs[0].default_value = 1
    L.new(col.outputs["Color"], tint.inputs[6]); L.new(obi.outputs["Color"], tint.inputs[7])
    geo = N.new("ShaderNodeNewGeometry")
    sz = N.new("ShaderNodeSeparateXYZ"); L.new(geo.outputs["Position"], sz.inputs[0])
    wave = N.new("ShaderNodeMath"); wave.operation = 'MULTIPLY'; wave.inputs[1].default_value = scan
    L.new(sz.outputs["Z"], wave.inputs[0])
    sn = N.new("ShaderNodeMath"); sn.operation = 'SINE'; L.new(wave.outputs[0], sn.inputs[0])
    mr = N.new("ShaderNodeMapRange"); mr.inputs[1].default_value = -1; mr.inputs[2].default_value = 1
    mr.inputs[3].default_value = 0.55; mr.inputs[4].default_value = 1.0
    L.new(sn.outputs[0], mr.inputs[0])
    lw = N.new("ShaderNodeLayerWeight"); lw.inputs[0].default_value = 0.35
    fr = N.new("ShaderNodeMapRange"); fr.inputs[3].default_value = 0.8; fr.inputs[4].default_value = 1.8
    L.new(lw.outputs["Facing"], fr.inputs[0])
    m1 = N.new("ShaderNodeMath"); m1.operation = 'MULTIPLY'; L.new(mr.outputs[0], m1.inputs[0]); L.new(fr.outputs[0], m1.inputs[1])
    m2 = N.new("ShaderNodeMath"); m2.operation = 'MULTIPLY'; m2.inputs[1].default_value = strength; L.new(m1.outputs[0], m2.inputs[0])
    em = N.new("ShaderNodeEmission"); L.new(tint.outputs[2], em.inputs[0]); L.new(m2.outputs[0], em.inputs[1])
    tr = N.new("ShaderNodeBsdfTransparent")
    add = N.new("ShaderNodeAddShader"); L.new(em.outputs[0], add.inputs[0]); L.new(tr.outputs[0], add.inputs[1])
    L.new(add.outputs[0], out.inputs[0])
    try:
        m.surface_render_method = 'BLENDED'
    except Exception:
        pass
    return m

def mat_simple(name, color, rough=0.8, emit=0.0):
    m = bpy.data.materials.new(name)
    nt, N, L = _nodes(m)
    out = N.new("ShaderNodeOutputMaterial")
    bs = N.new("ShaderNodeBsdfPrincipled")
    bs.inputs["Base Color"].default_value = C(color)
    bs.inputs["Roughness"].default_value = rough
    if emit:
        bs.inputs["Emission Color"].default_value = C(color)
        bs.inputs["Emission Strength"].default_value = emit
    L.new(bs.outputs[0], out.inputs[0])
    return m

def fog_wrap(m, fog_col, density, start):
    """Mix the material output toward a fog colour by camera distance (aerial perspective)."""
    nt = m.node_tree; N = nt.nodes; L = nt.links
    out = next(n for n in N if n.type == 'OUTPUT_MATERIAL')
    src = out.inputs[0].links[0].from_socket
    cam = N.new("ShaderNodeCameraData")
    sub = N.new("ShaderNodeMath"); sub.operation = 'SUBTRACT'; sub.inputs[1].default_value = start
    L.new(cam.outputs["View Distance"], sub.inputs[0])
    mx = N.new("ShaderNodeMath"); mx.operation = 'MAXIMUM'; mx.inputs[1].default_value = 0
    L.new(sub.outputs[0], mx.inputs[0])
    mul = N.new("ShaderNodeMath"); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = -density
    L.new(mx.outputs[0], mul.inputs[0])
    ex = N.new("ShaderNodeMath"); ex.operation = 'EXPONENT'; L.new(mul.outputs[0], ex.inputs[0])
    inv = N.new("ShaderNodeMath"); inv.operation = 'SUBTRACT'; inv.inputs[0].default_value = 1
    L.new(ex.outputs[0], inv.inputs[1])
    em = N.new("ShaderNodeEmission"); em.inputs[0].default_value = C(fog_col); em.inputs[1].default_value = 1.0
    ms = N.new("ShaderNodeMixShader")
    L.new(inv.outputs[0], ms.inputs[0]); L.new(src, ms.inputs[1]); L.new(em.outputs[0], ms.inputs[2])
    L.new(ms.outputs[0], out.inputs[0])

# ------------------------------------------------------------------ looks (apps/client/src/render/looks.ts)
LOOKS = {
    'portus': dict(zenith=0x4a7fe0, mid=0x93c0f2, horizon=0xffdcc0, ground=0xe9c3a6, glow=0xffc28a,
                   sun=0xfff1d6, sun_int=3.2, sun_elev=0.85, hemi_sky=0x9fb8ff, hemi_ground=0x6a5644, R=150.0),
    'meridian': dict(zenith=0x2a62c8, mid=0x86b2ec, horizon=0xffd2b0, ground=0xd8a88a, glow=0xffe0c0,
                     sun=0xffffff, sun_int=4.0, sun_elev=0.95, hemi_sky=0xa8c8ff, hemi_ground=0x6a2a18, R=1000.0),
    'arcadia': dict(zenith=0x2f7ff0, mid=0x6fb8f2, horizon=0xc4f4ec, ground=0xa8d8cc, glow=0xffd27a,
                    sun=0xffe2a8, sun_int=3.4, sun_elev=0.55, hemi_sky=0x9fe8ff, hemi_ground=0x3f5a2a, R=500.0),
}

def world_sky(look, sun_az_deg, sun_scale=1.0, sky_light=1.0, sun_elev=None):
    """Gradient art sky from looks.ts + sun glow; returns the sun light object."""
    L_ = LOOKS[look]
    w = bpy.data.worlds.new("Sky")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree; N = nt.nodes; L = nt.links
    for n in list(N):
        N.remove(n)
    out = N.new("ShaderNodeOutputWorld")
    tc = N.new("ShaderNodeTexCoord")
    nrm = N.new("ShaderNodeVectorMath"); nrm.operation = 'NORMALIZE'; L.new(tc.outputs["Generated"], nrm.inputs[0])
    sep = N.new("ShaderNodeSeparateXYZ"); L.new(nrm.outputs[0], sep.inputs[0])
    mr = N.new("ShaderNodeMapRange"); mr.inputs[1].default_value = -1; mr.inputs[2].default_value = 1
    L.new(sep.outputs["Z"], mr.inputs[0])
    ramp = N.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.interpolation = 'EASE'
    stops = [(0.0, mixc(L_['ground'], L_['hemi_ground'], 0.5)), (0.49, L_['ground']), (0.503, L_['horizon']),
             (0.56, L_['mid']), (0.80, mixc(L_['mid'], L_['zenith'], 0.6)), (1.0, L_['zenith'])]
    cr.elements[0].position = stops[0][0]; cr.elements[0].color = C(stops[0][1])
    cr.elements[1].position = stops[-1][0]; cr.elements[1].color = C(stops[-1][1])
    for p, c in stops[1:-1]:
        e = cr.elements.new(p); e.color = C(c)
    L.new(mr.outputs[0], ramp.inputs[0])
    elev = L_['sun_elev'] if sun_elev is None else sun_elev
    az = math.radians(sun_az_deg)
    sd = Vector((math.cos(elev) * math.cos(az), math.cos(elev) * math.sin(az), math.sin(elev)))
    dot = N.new("ShaderNodeVectorMath"); dot.operation = 'DOT_PRODUCT'; dot.inputs[1].default_value = sd
    L.new(nrm.outputs[0], dot.inputs[0])
    mx = N.new("ShaderNodeMath"); mx.operation = 'MAXIMUM'; mx.inputs[1].default_value = 0; L.new(dot.outputs["Value"], mx.inputs[0])
    pw = N.new("ShaderNodeMath"); pw.operation = 'POWER'; pw.inputs[1].default_value = 12; L.new(mx.outputs[0], pw.inputs[0])
    gl = N.new("ShaderNodeMix"); gl.data_type = 'RGBA'; gl.blend_type = 'ADD'
    gm = N.new("ShaderNodeMath"); gm.operation = 'MULTIPLY'; gm.inputs[1].default_value = 0.5; L.new(pw.outputs[0], gm.inputs[0])
    L.new(gm.outputs[0], gl.inputs[0]); L.new(ramp.outputs[0], gl.inputs[6]); gl.inputs[7].default_value = C(L_['glow'])
    bg = N.new("ShaderNodeBackground"); L.new(gl.outputs[2], bg.inputs[0]); bg.inputs[1].default_value = 1.0
    bg2 = N.new("ShaderNodeBackground"); L.new(gl.outputs[2], bg2.inputs[0]); bg2.inputs[1].default_value = sky_light
    lp = N.new("ShaderNodeLightPath")
    ms = N.new("ShaderNodeMixShader"); L.new(lp.outputs["Is Camera Ray"], ms.inputs[0])
    L.new(bg2.outputs[0], ms.inputs[1]); L.new(bg.outputs[0], ms.inputs[2])
    L.new(ms.outputs[0], out.inputs[0])
    # sun
    ld = bpy.data.lights.new("Sun", 'SUN')
    ld.energy = L_['sun_int'] * sun_scale
    ld.color = C(L_['sun'])[:3]
    ld.angle = math.radians(2.0)
    so = bpy.data.objects.new("Sun", ld)
    bpy.context.scene.collection.objects.link(so)
    so.rotation_euler = Vector((0, 0, 1)).rotation_difference(sd).to_euler()
    return so

# ------------------------------------------------------------------ planet ground
def planet_ground(R, mat, subdiv=7):
    me = bpy.data.meshes.new("Ground")
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=R)
    # rotate so a vertex is not exactly at the pole (avoids a visible pole pinch under the building)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("Ground", me)
    ob.location = (0, 0, -R)
    ob.rotation_euler = (0.013, 0.021, 0.3)
    me.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    return ob

def on_planet(R, x, y, yaw=0.0, lift=0.0):
    """Frame of a point standing on the sphere (centre (0,0,-R)) above tangent position (x, y)."""
    d = Vector((x, y, R)).normalized()
    p = d * (R + lift) - Vector((0, 0, R))
    q = Vector((0, 0, 1)).rotation_difference(d) @ Quaternion((0, 0, 1), yaw)
    return Matrix.Translation(p) @ q.to_matrix().to_4x4()

# ------------------------------------------------------------------ ground shaders (context only)
def mat_cobbles(name="M_Cobble", scale=2.2, c1=0xb9a58c, c2=0xa18b74, c3=0xcbb9a0, grout=0x6e5f50, fog=None):
    m = bpy.data.materials.new(name)
    nt, N, L = _nodes(m)
    out = N.new("ShaderNodeOutputMaterial")
    bs = N.new("ShaderNodeBsdfPrincipled"); bs.inputs["Roughness"].default_value = 0.85
    geo = N.new("ShaderNodeNewGeometry")
    # slight warp so the stones are irregular
    wn = N.new("ShaderNodeTexNoise"); wn.inputs["Scale"].default_value = 1.3
    L.new(geo.outputs["Position"], wn.inputs["Vector"])
    wm = N.new("ShaderNodeVectorMath"); wm.operation = 'MULTIPLY_ADD'
    wm.inputs[1].default_value = (0.25, 0.25, 0.25)
    L.new(wn.outputs["Color"], wm.inputs[0]); L.new(geo.outputs["Position"], wm.inputs[2])
    sc = N.new("ShaderNodeVectorMath"); sc.operation = 'MULTIPLY'; sc.inputs[1].default_value = (scale, scale * 1.35, scale)
    L.new(wm.outputs[0], sc.inputs[0])
    v1 = N.new("ShaderNodeTexVoronoi"); v1.feature = 'DISTANCE_TO_EDGE'; v1.inputs["Randomness"].default_value = 0.85
    L.new(sc.outputs[0], v1.inputs["Vector"])
    v2 = N.new("ShaderNodeTexVoronoi"); v2.feature = 'F1'; v2.inputs["Randomness"].default_value = 0.85
    L.new(sc.outputs[0], v2.inputs["Vector"])
    ramp = N.new("ShaderNodeValToRGB"); cr = ramp.color_ramp
    cr.elements[0].position = 0.0; cr.elements[0].color = C(c2)
    cr.elements[1].position = 1.0; cr.elements[1].color = C(c3)
    e = cr.elements.new(0.5); e.color = C(c1)
    sepc = N.new("ShaderNodeSeparateColor"); L.new(v2.outputs["Color"], sepc.inputs[0])
    L.new(sepc.outputs[0], ramp.inputs[0])
    gmask = N.new("ShaderNodeMapRange"); gmask.inputs[1].default_value = 0.02; gmask.inputs[2].default_value = 0.09
    L.new(v1.outputs["Distance"], gmask.inputs[0])
    mix = N.new("ShaderNodeMix"); mix.data_type = 'RGBA'
    L.new(gmask.outputs[0], mix.inputs[0]); mix.inputs[6].default_value = C(grout); L.new(ramp.outputs[0], mix.inputs[7])
    # soft painterly large variation
    n3 = N.new("ShaderNodeTexNoise"); n3.inputs["Scale"].default_value = 0.08; L.new(geo.outputs["Position"], n3.inputs["Vector"])
    m3 = N.new("ShaderNodeMapRange"); m3.inputs[3].default_value = 0.85; m3.inputs[4].default_value = 1.1
    L.new(n3.outputs["Fac"], m3.inputs[0])
    vs = N.new("ShaderNodeVectorMath"); vs.operation = 'SCALE'
    L.new(mix.outputs[2], vs.inputs[0]); L.new(m3.outputs[0], vs.inputs["Scale"])
    L.new(vs.outputs[0], bs.inputs["Base Color"])
    bump = N.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.35; bump.inputs["Distance"].default_value = 0.05
    L.new(gmask.outputs[0], bump.inputs["Height"])
    L.new(bump.outputs[0], bs.inputs["Normal"])
    L.new(bs.outputs[0], out.inputs[0])
    if fog:
        fog_wrap(m, *fog)
    return m

# ------------------------------------------------------------------ render
def setup_render(w=1600, h=900, samples=64, engine='CYCLES', exposure=0.0, look='AgX - Punchy'):
    sc = bpy.context.scene
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    sc.render.engine = engine
    if engine == 'CYCLES':
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            prefs.compute_device_type = 'METAL'
            prefs.get_devices()
            n = 0
            for d in prefs.devices:
                d.use = d.type != 'CPU'
                n += d.use
            sc.cycles.device = 'GPU' if n else 'CPU'
            log("cycles device", sc.cycles.device, [d.name for d in prefs.devices if d.use])
        except Exception as ex:
            log("GPU setup failed", ex)
        sc.cycles.samples = samples
        sc.cycles.use_adaptive_sampling = True
        sc.cycles.adaptive_threshold = 0.03
        sc.cycles.use_denoising = True
        try:
            sc.cycles.denoiser = 'OPENIMAGEDENOISE'
        except Exception:
            pass
        sc.cycles.max_bounces = 6
        sc.cycles.diffuse_bounces = 3
        sc.cycles.glossy_bounces = 3
        sc.cycles.transparent_max_bounces = 12
        sc.cycles.transmission_bounces = 4
        sc.cycles.caustics_reflective = False
        sc.cycles.caustics_refractive = False
        sc.cycles.blur_glossy = 1.0
    sc.view_settings.view_transform = 'AgX'
    for lk in (look, look.replace('AgX - ', ''), 'None'):
        try:
            sc.view_settings.look = lk
            break
        except Exception:
            continue
    sc.view_settings.exposure = exposure
    sc.render.image_settings.file_format = 'PNG'
    sc.render.film_transparent = False

def camera(name, loc, target, lens=35, shift_x=0.0, shift_y=0.0, ortho=None):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.sensor_width = 36
    cd.shift_x = shift_x
    cd.shift_y = shift_y
    cd.clip_start = 0.1
    cd.clip_end = 5000
    if ortho:
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
    co = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(co)
    co.location = loc
    d = Vector(target) - Vector(loc)
    co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return co

def level_camera(name, loc, target, lens=24, shift_y=0.0, shift_x=0.0):
    """Camera with no pitch (vertical lines stay vertical); frame moved with lens shift."""
    cd = bpy.data.cameras.new(name)
    cd.lens = lens; cd.sensor_width = 36; cd.shift_y = shift_y; cd.shift_x = shift_x
    cd.clip_start = 0.1; cd.clip_end = 5000
    co = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(co)
    co.location = loc
    d = Vector(target) - Vector(loc)
    d.z = 0
    co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return co

def render(cam, path):
    sc = bpy.context.scene
    sc.camera = cam
    sc.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    log(f"rendered {os.path.basename(path)} in {time.time() - t:.1f}s")

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def export_glb(B, path):
    """Export the counted objects of a building as one GLB (pieces as separate nodes, instances kept)."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.object.select_all(action='DESELECT')
        for ob in B.objs:
            if ob["counted"]:
                ob.select_set(True)
        kw = dict(filepath=path, use_selection=True, export_format='GLB', export_apply=True)
        try:
            bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
        except TypeError:
            bpy.ops.export_scene.gltf(**kw)
        log("exported", path, os.path.getsize(path), "bytes")
    except Exception as ex:
        log("GLB export failed:", ex)
    finally:
        bpy.ops.object.select_all(action='DESELECT')

def kit_sheet(P, mats, path, tints=None, look='portus', max_row=24.0, title=None, skip=()):
    """Line every unique kit mesh up at true scale: small pieces in a front row, large ones in a back
    row far enough behind to stay visible; upright labels (name + triangles) in front of each."""
    tints = tints or {}
    world_sky(look, sun_az_deg=-60, sky_light=1.1, sun_elev=0.9)
    floor_m = mat_simple("M_Floor", 0xE8E2D6, rough=0.9)
    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(floor_m)
    lab_m = mat_simple("M_Label", 0x2E2A2C, rough=0.6)
    items = []
    for key, me in P.items():
        if key in skip:
            continue
        xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
        items.append((key, me, min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))
    big = [it for it in items if max(it[3] - it[2], it[7] - it[6]) >= 2.2]
    small = [it for it in items if it not in big]
    big.sort(key=lambda it: it[7] - it[6]); small.sort(key=lambda it: it[7] - it[6])
    el = math.radians(14)
    hs = max([it[7] - it[6] for it in small] + [0.5])
    gap = hs * math.cos(el) / math.sin(el) + 3.0
    rows = [(small, 0.0, 0.30), (big, gap + max([it[5] - it[4] for it in small] + [1]) / 2 + max([it[5] - it[4] for it in big] + [1]) / 2, 0.42)]
    widths = []
    for row, y, ls in rows:
        bws = [max(it[3] - it[2], len(it[1].name) * ls * 0.62) + 0.8 for it in row]
        w = sum(bws); widths.append(w)
        x = -w / 2
        for it, bw in zip(row, bws):
            key, me, x0, x1, y0, y1, z0, z1 = it
            if len(me.materials) == 0:
                for m in mats:
                    me.materials.append(m)
            ob = bpy.data.objects.new("k_" + key, me)
            cx = x + bw / 2
            ob.location = (cx - (x0 + x1) / 2, y - (y0 + y1) / 2, -z0)
            if key in tints:
                ob.color = C(tints[key])
            bpy.context.scene.collection.objects.link(ob)
            cu = bpy.data.curves.new("lab_" + key, 'FONT')
            cu.body = f"{me.name}  {tris(me)}"
            cu.size = ls
            cu.align_x = 'CENTER'
            cu.extrude = 0.01
            to = bpy.data.objects.new("lab_" + key, cu)
            to.location = (cx, y - (y1 - y0) / 2 - 0.6, 0.06)
            to.rotation_euler = (math.radians(76), 0, 0)
            to.data.materials.append(lab_m)
            bpy.context.scene.collection.objects.link(to)
            x += bw
    yb = rows[1][1]
    hb = max([it[7] - it[6] for it in big] + [1])
    top = yb * math.sin(el) + hb * math.cos(el)
    bottom = -1.2 * math.sin(el) - 0.2
    span_x = max(widths)
    scale_o = max(span_x * 1.04, (top - bottom + 1.0) * 16 / 9)
    d = Vector((0, -math.cos(el), math.sin(el)))
    up = Vector((0, math.sin(el), math.cos(el)))
    mid_v = (top + bottom) / 2
    tgt = Vector((0, 0, 0)) + up * mid_v
    cam = camera("cam_kit", tgt + d * 200, tgt, lens=50, ortho=scale_o)
    cam.data.clip_end = 1000
    render(cam, path)
