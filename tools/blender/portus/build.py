# Portus village (FIRSTLIGHT hub planet): reproducible headless Blender build.
#
#   blender -b --disable-autoexec --factory-startup --python build.py -- --village <kit glTF dir> --nature <kit glTF dir> [options]
#
# Normally run by tools/blender/portus/build.sh, which verifies the kit archives' SHA-256 and extracts
# them into a fresh temporary folder first. Kit paths can also come from the environment
# (PORTUS_VILLAGE_GLTF, PORTUS_NATURE_GLTF).
#
# Options (all optional):
#   --out DIR            output folder (default: folder of this script)
#   --renders a,b,...    renders to make; default: aerial,plaza_eye,gate_eye,street_eye,castle_eye,hall_eye,prefab_sheet
#                        ("none" = no renders). Extra views: street_east, market_eye, plan_aerial, lineup, insp_*
#   --plan               build prefabs + layout, validate, write scratch/plan.json and stop
#   --no-export          skip writing prefabs/*.glb
#   --scale PCT          render resolution percentage (default 100 -> 1600x900)
#   --samples N          EEVEE samples (default 64)
#   --sun-az DEG --sun-el DEG   sun azimuth (CCW from east) / elevation (default -12 / 24: low morning sun)
#
# Builds every prefab from the CC0 kits (Quaternius Medieval Village MegaKit + Stylized Nature MegaKit),
# validates the layout (overlaps, plaza, portal clearances and approaches, street widths, fixed features),
# exports Y-up GLBs (one mesh, one primitive per material, pivot at ground centre, shared textures in
# prefabs/textures), writes layout.json (Portus plaza tangent frame, geodesic east/north), town_extra.json
# (streets, paved areas, fixed features, per-prefab footprints for the game's colliders) and budget.txt,
# and renders the village on the curved ground (radius-150 sphere centred at (0, 0, -150), Blender Z up).
# Kit files are treated as data: only glTF and PNG files are read. tools/blender/portus/pack.py turns the
# output into the game's packed asset (apps/client/public/assets-dev/portus).
import bpy, bmesh, sys, os, math, json, random, re, time
from mathutils import Vector, Matrix, Quaternion, geometry

T0 = time.time()
ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def opt(name, default=None):
    if name in ARGV:
        i = ARGV.index(name)
        return ARGV[i + 1] if i + 1 < len(ARGV) and not ARGV[i + 1].startswith("--") else True
    return default

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(opt("--out", HERE))
RENDERS = [r for r in str(opt("--renders", "aerial,plaza_eye,gate_eye,street_eye,castle_eye,hall_eye,prefab_sheet")).split(",") if r and r != "none"]
EXPORT = not opt("--no-export", False)
SCALE = int(opt("--scale", 100))
SAMPLES = int(opt("--samples", 64))

VIL = str(opt("--village", os.environ.get("PORTUS_VILLAGE_GLTF", "")))
NAT = str(opt("--nature", os.environ.get("PORTUS_NATURE_GLTF", "")))
if not (os.path.isdir(VIL) and os.path.isdir(NAT)):
    raise SystemExit("build.py: pass --village <Medieval Village MegaKit glTF dir> --nature <Stylized Nature MegaKit glTF dir>")
R = 150.0                       # planet radius (m)
H = 3.12                        # kit storey height
os.makedirs(OUT, exist_ok=True)
SC = None
rng = random.Random(7)

def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)

# --------------------------------------------------------------------------------------------
# Materials: the kit's own materials, deduplicated by name, plus two small custom ones
# (M_Cloth: banners/awnings from a generated colour palette, M_Glow: flames and lantern glass).
# --------------------------------------------------------------------------------------------
MATS = {}

def canon(m):
    base = re.sub(r"\.\d+$", "", m.name)
    if base in MATS and MATS[base] is not m:
        return MATS[base]
    MATS[base] = m
    m.name = base
    return m

def bsdf(m):
    return next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

def tune_glass(m):
    """Kit glass is 9 % opaque: interiors would show. Make it dark, glossy, opaque leaded glass."""
    b = bsdf(m)
    for l in list(b.inputs["Base Color"].links): m.node_tree.links.remove(l)
    for l in list(b.inputs["Alpha"].links): m.node_tree.links.remove(l)
    b.inputs["Base Color"].default_value = (0.05, 0.075, 0.10, 1)
    b.inputs["Alpha"].default_value = 1.0
    b.inputs["Roughness"].default_value = 0.08
    b.inputs["Metallic"].default_value = 0.0
    try:
        m.surface_render_method = "DITHERED"
    except Exception:
        pass
    m.blend_method = "OPAQUE" if hasattr(m, "blend_method") else None

PALETTE = {  # M_Cloth palette columns (sRGB-ish linear values)
    "red": (0.50, 0.05, 0.04), "cream": (0.78, 0.68, 0.48), "blue": (0.06, 0.15, 0.48),
    "gold": (0.85, 0.55, 0.08), "green": (0.10, 0.34, 0.10), "teal": (0.03, 0.36, 0.40),
    "purple": (0.28, 0.08, 0.38), "orange": (0.80, 0.30, 0.06), "linen": (0.42, 0.33, 0.21),
    "dark": (0.10, 0.07, 0.05), "white": (0.92, 0.90, 0.84), "wine": (0.30, 0.03, 0.08),
}
PAL_KEYS = list(PALETTE)

def write_png(path, w, h, rows):
    """Minimal RGB PNG writer (rows: list of bytes, each w*3 long)."""
    import zlib, struct
    raw = b"".join(b"\x00" + r for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)

def to_srgb(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

def make_custom_materials(tex_dir):
    # palette texture: 16 columns of solid colours with a slight weave noise (sRGB PNG)
    W, Hh = 256, 32
    r2 = random.Random(3)
    rows = []
    for y in range(Hh):
        row = bytearray()
        for x in range(W):
            col = x * 16 // W
            c = PALETTE[PAL_KEYS[col]] if col < len(PAL_KEYS) else (0.5, 0.5, 0.5)
            weave = 1.0 + 0.06 * (((x + y) % 2) - 0.5) + r2.uniform(-0.03, 0.03)
            row += bytes(int(max(0, min(1, to_srgb(min(1.0, ch * weave)))) * 255 + 0.5) for ch in c)
        rows.append(bytes(row))
    os.makedirs(tex_dir, exist_ok=True)
    path = os.path.join(tex_dir, "T_Cloth_Palette.png")
    write_png(path, W, Hh, rows)
    img2 = bpy.data.images.load(path)
    img2.name = "T_Cloth_Palette"

    m = bpy.data.materials.new("M_Cloth")
    m.use_nodes = True
    b = bsdf(m)
    t = m.node_tree.nodes.new("ShaderNodeTexImage"); t.image = img2; t.interpolation = "Closest"
    m.node_tree.links.new(t.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.85
    m.use_backface_culling = False
    MATS["M_Cloth"] = m

    g = bpy.data.materials.new("M_Glow")
    g.use_nodes = True
    b = bsdf(g)
    b.inputs["Base Color"].default_value = (1.0, 0.30, 0.03, 1)
    b.inputs["Emission Color"].default_value = (1.0, 0.24, 0.02, 1)
    b.inputs["Emission Strength"].default_value = 1.6
    MATS["M_Glow"] = g

def pal_uv(color, v=0.5):
    """UV of a solid palette colour."""
    i = PAL_KEYS.index(color)
    return ((i + 0.5) / 16.0, v)

# --------------------------------------------------------------------------------------------
# Kit import: each module is imported once and kept as world-baked mesh data.
# --------------------------------------------------------------------------------------------
_MOD = {}

def kit(name, src=None):
    key = name
    if key in _MOD:
        return _MOD[key]
    folder = src or (NAT if os.path.exists(f"{NAT}/{name}.gltf") and not os.path.exists(f"{VIL}/{name}.gltf") else VIL)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=f"{folder}/{name}.gltf")
    new = [o for o in bpy.data.objects if o not in before]
    out = []
    for o in new:
        if o.type == "MESH":
            me = o.data.copy()
            me.transform(o.matrix_world)
            for i, m in enumerate(me.materials):
                if m is not None:
                    me.materials[i] = canon(m)
            # keep one UV layer called UVMap
            while len(me.uv_layers) > 1:
                me.uv_layers.remove(me.uv_layers[-1])
            if me.uv_layers:
                me.uv_layers[0].name = "UVMap"
            me.name = "K_" + name
            out.append(me)
    for o in new:
        bpy.data.objects.remove(o)
    if not out:
        raise RuntimeError("kit module without mesh: " + name)
    _MOD[key] = out
    return out

def preload_materials():
    """Import the modules that carry every kit material we use, then add the custom ones."""
    for m in ("Roof_Tower_RoundTiles", "Wall_UnevenBrick_Straight", "Window_Wide_Flat1", "Door_4_Flat", "Floor_Brick", "Prop_Vine1"):
        kit(m)
    tune_glass(MATS["MI_WindowGlass"])
    make_custom_materials(os.path.join(OUT, "prefabs", "textures"))

def kit_bounds(name):
    mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
    for me in kit(name):
        for v in me.vertices:
            mn = Vector(map(min, mn, v.co)); mx = Vector(map(max, mx, v.co))
    return mn, mx

# --------------------------------------------------------------------------------------------
# Custom geometry (fortifications, paving, stalls, props) using the kit's materials.
# UV convention of the kit: tiling textures (UnevenBrick, Brick, Plaster, RoundTiles) = 1 UV per 2 m;
# RockTrim trim sheet = 1 UV per 4 m along u; bands in v: 0.70-1.0 fieldstone, 0.42-0.68 smooth slab,
# 0.0-0.40 dressed ashlar. WoodTrim: 0.70-1.0 light planks, 0.40-0.70 dark planks, 0.21-0.39 beam ends.
# --------------------------------------------------------------------------------------------
BAND = {"field": (0.70, 0.98), "slab": (0.43, 0.67), "ashlar": (0.02, 0.39),
        "plank": (0.71, 0.99), "dark": (0.41, 0.69), "ends": (0.22, 0.38), "metal": (0.06, 0.18)}

class MB:
    """Accumulates flat-shaded polygons with per-corner UVs and a material per face."""
    def __init__(self):
        self.V, self.F, self.UV, self.M, self.S = [], [], [], [], []

    def face(self, pts, mat, uvs, smooth=False):
        b = len(self.V)
        self.V.extend(Vector(p) for p in pts)
        self.F.append(tuple(range(b, b + len(pts))))
        self.UV.append([tuple(u) for u in uvs])
        self.M.append(mat)
        self.S.append(smooth)

    def extend(self, other, M=Matrix.Identity(4)):
        for f, uv, m, s in zip(other.F, other.UV, other.M, other.S):
            self.face([M @ other.V[i] for i in f], m, uv, s)

    def mesh(self, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in self.V], [], self.F)
        mats = []
        for m in self.M:
            if m not in mats:
                mats.append(m)
        for m in mats:
            me.materials.append(MATS[m])
        uvl = me.uv_layers.new(name="UVMap")
        idx = {m: i for i, m in enumerate(mats)}
        for i, p in enumerate(me.polygons):
            p.material_index = idx[self.M[i]]
            p.use_smooth = self.S[i]
            for j, li in enumerate(p.loop_indices):
                uvl.data[li].uv = self.UV[i][j]
        me.validate()
        return me

def _axes(n):
    n = Vector(n).normalized()
    if abs(n.z) > 0.7:
        return Vector((1, 0, 0)), Vector((0, 1 if n.z > 0 else -1, 0))
    t = Vector((-n.y, n.x, 0)).normalized()
    return t, Vector((0, 0, 1))

def uv_planar(pts, n, tile=2.0, uo=0.0, vo=0.0):
    t, b = _axes(n)
    return [(Vector(p).dot(t) / tile + uo, Vector(p).dot(b) / tile + vo) for p in pts]

def uv_band(pts, n, band, tileu=4.0, uo=0.0, z0=None, z1=None):
    """Map a face onto a horizontal band of a trim sheet: u along the face, v across its height."""
    t, b = _axes(n)
    vs = [Vector(p).dot(b) for p in pts]
    lo = min(vs) if z0 is None else z0
    hi = max(vs) if z1 is None else z1
    span = max(hi - lo, 1e-6)
    v0, v1 = BAND[band]
    return [(Vector(p).dot(t) / tileu + uo, v0 + (vv - lo) / span * (v1 - v0)) for p, vv in zip(pts, vs)]

def normal_of(pts):
    p = [Vector(x) for x in pts]
    n = Vector((0, 0, 0))
    for i in range(len(p)):
        a, b = p[i], p[(i + 1) % len(p)]
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    return n.normalized() if n.length > 1e-9 else Vector((0, 0, 1))

def quad(mb, pts, mat, mode="planar", tile=2.0, band=None, uo=0.0, vo=0.0, tileu=4.0, z0=None, z1=None, uvs=None):
    n = normal_of(pts)
    if uvs is None:
        if mode == "band":
            uvs = uv_band(pts, n, band, tileu=tileu, uo=uo, z0=z0, z1=z1)
        elif mode == "pal":
            uvs = [pal_uv(band)] * len(pts)
        else:
            uvs = uv_planar(pts, n, tile, uo, vo)
    mb.face(pts, mat, uvs)

def box(mb, x0, y0, z0, x1, y1, z1, mat, skip=(), mode="planar", band=None, top=None, tileu=4.0, pal=None):
    """Axis-aligned box. skip: subset of {'-x','+x','-y','+y','-z','+z'}. top=(mat, mode, band) for +z."""
    P = lambda x, y, z: (x, y, z)
    faces = {
        "-y": [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)],
        "+y": [P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1)],
        "-x": [P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1)],
        "+x": [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)],
        "+z": [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)],
        "-z": [P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0), P(x0, y0, z0)],
    }
    for k, pts in faces.items():
        if k in skip:
            continue
        if pal:
            quad(mb, pts, mat, mode="pal", band=pal)
        elif k == "+z" and top:
            quad(mb, pts, top[0], mode=top[1], band=top[2] if len(top) > 2 else None, tileu=tileu)
        else:
            quad(mb, pts, mat, mode=mode, band=band, tileu=tileu)

def oriented_box(mb, M, sx, sy, sz, mat, mode="planar", band=None, pal=None, skip=()):
    """Box of size sx, sy, sz centred on x/y, bottom at z=0, transformed by M (UVs from local coords)."""
    tmp = MB()
    box(tmp, -sx / 2, -sy / 2, 0, sx / 2, sy / 2, sz, mat, mode=mode, band=band, pal=pal, skip=skip)
    mb.extend(tmp, M)

def prism(mb, poly, z0, z1, mat, mode="planar", band=None, cap_top=True, cap_bot=False, top=None, tile=2.0, smooth=False, tileu=4.0):
    """Vertical extrusion of a CCW 2D polygon (side UVs run along the perimeter)."""
    n = len(poly)
    run = 0.0
    for i in range(n):
        a, b = Vector((*poly[i], 0)), Vector((*poly[(i + 1) % n], 0))
        L = (b - a).length
        pts = [(a.x, a.y, z0), (b.x, b.y, z0), (b.x, b.y, z1), (a.x, a.y, z1)]
        if mode == "band":
            v0, v1 = BAND[band]
            uvs = [(run / tileu, v0), ((run + L) / tileu, v0), ((run + L) / tileu, v1), (run / tileu, v1)]
        elif mode == "pal":
            uvs = [pal_uv(band)] * 4
        else:
            uvs = [(run / tile, z0 / tile), ((run + L) / tile, z0 / tile), ((run + L) / tile, z1 / tile), (run / tile, z1 / tile)]
        mb.face(pts, mat, uvs, smooth)
        run += L
    if cap_top:
        pts = [(x, y, z1) for x, y in poly]
        tm = top or (mat, "planar")
        if tm[1] == "pal":
            mb.face(pts, tm[0], [pal_uv(tm[2])] * len(pts))
        elif tm[1] == "band":
            quad(mb, pts, tm[0], mode="band", band=tm[2])
        else:
            mb.face(pts, tm[0], uv_planar(pts, (0, 0, 1)))
    if cap_bot:
        pts = [(x, y, z0) for x, y in reversed(poly)]
        mb.face(pts, mat, uv_planar(pts, (0, 0, -1)))

def circle(r, n, a0=0.0):
    return [(r * math.cos(a0 + 2 * math.pi * i / n), r * math.sin(a0 + 2 * math.pi * i / n)) for i in range(n)]

def frustum(mb, r0, r1, z0, z1, n, mat, mode="planar", band=None, tile=2.0, cap=False, smooth=False, a0=None):
    """Tapered polygonal ring (battered plinths, cones when r1=0)."""
    a0 = math.pi / n if a0 is None else a0
    c0, c1 = circle(r0, n, a0), circle(r1, n, a0)
    run = 0.0
    for i in range(n):
        j = (i + 1) % n
        L0 = (Vector(c0[j]) - Vector(c0[i])).length
        L1 = (Vector(c1[j]) - Vector(c1[i])).length
        pts = [(*c0[i], z0), (*c0[j], z0), (*c1[j], z1), (*c1[i], z1)]
        slant = math.hypot(z1 - z0, r1 - r0)
        if mode == "band":
            v0, v1 = BAND[band]
            uvs = [(run / 4, v0), ((run + L0) / 4, v0), ((run + (L0 + L1) / 2) / 4, v1), (run / 4, v1)]
        elif mode == "pal":
            uvs = [pal_uv(band)] * 4
        else:
            mid = run + L0 / 2
            uvs = [((mid - L0 / 2) / tile, 0), ((mid + L0 / 2) / tile, 0), ((mid + L1 / 2) / tile, slant / tile), ((mid - L1 / 2) / tile, slant / tile)]
        if r1 < 1e-4:
            mb.face(pts[:3], mat, uvs[:3], smooth)
        else:
            mb.face(pts, mat, uvs, smooth)
        run += L0
    if cap and r1 > 1e-4:
        pts = [(*p, z1) for p in c1]
        mb.face(pts, mat, [pal_uv(band)] * len(pts) if mode == "pal" else uv_planar(pts, (0, 0, 1)))

def wall_face(mb, origin, uax, vax, outline, holes, mat, tile=2.0, uo=0.0, vo=0.0):
    """Planar wall face with holes. outline/holes are 2D (u, v) polylines in the face frame."""
    origin, uax, vax = Vector(origin), Vector(uax), Vector(vax)
    loops = [outline] + holes
    tris = geometry.tessellate_polygon([[(p[0], p[1], 0) for p in l] for l in loops])
    flat = [p for l in loops for p in l]
    n = uax.cross(vax)
    for t in tris:
        a, b, c = (flat[i] for i in t)
        pts = [origin + uax * p[0] + vax * p[1] for p in (a, b, c)]
        if normal_of(pts).dot(n) < 0:
            a, c = c, a
            pts = [pts[2], pts[1], pts[0]]
        mb.face(pts, mat, [(p[0] / tile + uo, p[1] / tile + vo) for p in (a, b, c)])

def arch_shape(cx, z0, w, spring, segs=8):
    """Round-headed opening: rectangle w wide from z0 up to `spring`, semicircle on top (CCW)."""
    r = w / 2
    pts = [(cx - r, z0), (cx + r, z0), (cx + r, spring)]
    for i in range(1, segs):
        a = math.pi * i / segs
        pts.append((cx + r * math.cos(a), spring + r * math.sin(a)))
    pts.append((cx - r, spring))
    return pts

def rect_shape(cx, z0, w, h):
    return [(cx - w / 2, z0), (cx + w / 2, z0), (cx + w / 2, z0 + h), (cx - w / 2, z0 + h)]

def reveal(mb, origin, uax, vax, shape, depth, mat, back_mat=None, tile=2.0, through=False):
    """Jambs of a hole cut `depth` metres into a face (+ a dark back panel unless `through`)."""
    origin, uax, vax = Vector(origin), Vector(uax), Vector(vax)
    inward = -uax.cross(vax).normalized()
    P = lambda p, d: origin + uax * p[0] + vax * p[1] + inward * d
    run = 0.0
    n = len(shape)
    for i in range(n):
        a, b = shape[i], shape[(i + 1) % n]
        L = math.dist(a, b)
        pts = [P(b, 0), P(a, 0), P(a, depth), P(b, depth)]
        mb.face(pts, mat, [((run + L) / tile, 0), (run / tile, 0), (run / tile, depth / tile), ((run + L) / tile, depth / tile)])
        run += L
    if not through and back_mat:
        pts = [P(p, depth) for p in shape]
        uvs = [(p[0] / tile, p[1] / tile) for p in shape]
        if back_mat == "M_Cloth":
            uvs = [pal_uv("dark")] * len(pts)
        mb.face(pts, back_mat, uvs)

def bend(me, radius=R):
    """Wrap a mesh around the planet along its local X axis (for long pieces that follow the surface)."""
    for v in me.vertices:
        x, y, z = v.co
        a = x / radius
        v.co = ((radius + z) * math.sin(a), y, (radius + z) * math.cos(a) - radius)

# --------------------------------------------------------------------------------------------
# Prefab assembly
# --------------------------------------------------------------------------------------------
PREFABS = {}          # name -> object (joined, at origin, hidden from render)
PREFAB_INFO = {}      # name -> dict(tris, mats, size, lod)
COLL_PREFABS = None

def init_scene():
    global SC, COLL_PREFABS
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SC = bpy.context.scene
    COLL_PREFABS = bpy.data.collections.new("prefabs")
    SC.collection.children.link(COLL_PREFABS)

def T(x=0, y=0, z=0):
    return Matrix.Translation((x, y, z))

def Rz(deg):
    return Matrix.Rotation(math.radians(deg), 4, "Z")

def Rx(deg):
    return Matrix.Rotation(math.radians(deg), 4, "X")

def Ry(deg):
    return Matrix.Rotation(math.radians(deg), 4, "Y")

def S(sx, sy=None, sz=None):
    sy = sx if sy is None else sy
    sz = sx if sz is None else sz
    return Matrix.Diagonal((sx, sy, sz, 1))

def strip_interior(me, boxes):
    """Delete faces that can never be seen: inside a closed building volume and facing inward/down.
    Glass and cloth are kept. Boxes are (x0, y0, x1, y1, z0, z1) in prefab space."""
    bm = bmesh.new()
    bm.from_mesh(me)
    keep_mats = {i for i, m in enumerate(me.materials) if m and m.name in ("MI_WindowGlass", "M_Cloth", "M_Glow")}
    kill = []
    for f in bm.faces:
        if f.material_index in keep_mats:
            continue
        c = f.calc_center_median()
        n = f.normal
        for (x0, y0, x1, y1, z0, z1) in boxes:
            if x0 < c.x < x1 and y0 < c.y < y1 and z0 < c.z < z1:
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                to_c = Vector((cx - c.x, cy - c.y, 0))
                if to_c.length > 1e-6:
                    to_c.normalize()
                # inward-facing (toward the box axis) or downward-facing (ceilings, roof undersides)
                if n.dot(to_c) > 0.35 or n.z < -0.4:
                    kill.append(f)
                break
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(me)
    bm.free()

def footprints(me, trunk=False):
    """2D boxes: ground (z 0.05..2.2: what you bump into), full (everything above 0.25 m)."""
    g = [v.co for v in me.vertices if 0.05 <= v.co.z <= (1.2 if trunk else 2.0)]
    f = [v.co for v in me.vertices if v.co.z >= 0.25]
    if trunk:   # trees: only the trunk counts as ground footprint
        g = [c for c in g if abs(c.x) < 0.8 and abs(c.y) < 0.8] or [Vector((0, 0, 0))]
    g = g or f
    bb = lambda pts: ([min(p.x for p in pts), min(p.y for p in pts)], [max(p.x for p in pts), max(p.y for p in pts)])
    gmn, gmx = bb(g)
    fmn, fmx = bb(f or g)
    return dict(gmin=gmn, gmax=gmx, fmin=fmn, fmax=fmx, ghull=hull2d(g), fhull=hull2d(f or g))

def hull2d(pts):
    """Convex hull (monotone chain) of the XY projection, CCW."""
    P = sorted({(round(p.x, 3), round(p.y, 3)) for p in pts})
    if len(P) < 3:
        return P
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in P:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(P):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]

class Prefab:
    def __init__(self, name, lod=""):
        self.name, self.lod = name, lod
        self.parts = []          # (mesh, matrix)
        self.mb = MB()

    def k(self, module, x=0, y=0, z=0, rot=0, s=(1, 1, 1), M=None):
        """Place a kit module (rot in degrees about Z, s = per-axis scale)."""
        if M is None:
            M = T(x, y, z) @ Rz(rot) @ Matrix.Diagonal((*s, 1))
        for me in kit(module):
            self.parts.append((me, M))

    def finish(self, bend_x=False, interior=None, keep_colors=False):
        """interior: list of (x0, y0, x1, y1, z0, z1) boxes whose hidden inward faces are removed.
        keep_colors: keep the "Col" corner colours (round-2 vertex-colour pieces, COLOR_0)."""
        objs = []
        if self.mb.F:
            me = self.mb.mesh(self.name + "_custom")
            objs.append(bpy.data.objects.new(self.name + "_c", me))
        for me, M in self.parts:
            m2 = me.copy()
            m2.transform(M)
            if M.determinant() < 0:
                m2.flip_normals()
            objs.append(bpy.data.objects.new(self.name + "_p", m2))
        for o in objs:
            COLL_PREFABS.objects.link(o)
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.name = self.name
        obj.data.name = self.name
        # drop unused / duplicate material slots: one primitive per material
        me = obj.data
        used = sorted({p.material_index for p in me.polygons})
        mats = [me.materials[i] for i in used]
        remap = {}
        uniq = []
        for i in used:
            m = me.materials[i]
            if m not in uniq:
                uniq.append(m)
            remap[i] = uniq.index(m)
        mi = [remap[p.material_index] for p in me.polygons]
        me.materials.clear()
        for m in uniq:
            me.materials.append(m)
        for p, i in zip(me.polygons, mi):
            p.material_index = i
        for a in list(me.color_attributes):
            if not (keep_colors and a.name == "Col"):
                me.color_attributes.remove(a)
        if keep_colors:
            me.color_attributes.active_color_name = "Col"
        if interior:
            strip_interior(me, interior)
        if bend_x:
            bend(me)
        me.update()
        obj.hide_render = True
        obj.hide_set(True)
        tris = sum(len(p.vertices) - 2 for p in me.polygons)
        mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
        for v in me.vertices:
            mn = Vector(map(min, mn, v.co)); mx = Vector(map(max, mx, v.co))
        PREFABS[self.name] = obj
        PREFAB_INFO[self.name] = dict(tris=tris, mats=[m.name for m in me.materials], min=list(mn), max=list(mx), lod=self.lod, **footprints(me))
        log(f"prefab {self.name:22s} tris {tris:6d}  size {mx.x - mn.x:5.1f} x {mx.y - mn.y:5.1f} x {mx.z - mn.z:5.1f}  mats {len(me.materials)}")
        return obj

def lighten_tree(me, bark_ratio=0.3, leaf_keep=0.7, seed=1):
    """Lighter tree: weld + decimate the bark, drop a share of the (single-quad) leaf cards."""
    bm = bmesh.new()
    bm.from_mesh(me)
    r2 = random.Random(seed)
    leaf_idx = {i for i, m in enumerate(me.materials) if m and ("Leaves" in m.name or "Flowers" in m.name)}
    bark_idx = {i for i, m in enumerate(me.materials) if m and "Bark" in m.name}
    # leaf cards: faces come in 2-triangle quads that share an edge; group by connectivity
    bm.faces.ensure_lookup_table()
    seen, kill = set(), []
    for f in bm.faces:
        if f.index in seen or f.material_index not in leaf_idx:
            continue
        stack, island = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop(); island.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen and h.material_index in leaf_idx:
                        seen.add(h.index); stack.append(h)
        if r2.random() > leaf_keep:
            kill.extend(island)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(me)
    bm.free()
    if bark_idx and bark_ratio < 1.0:
        # split the bark into its own mesh, weld its seams and collapse-decimate it alone, then merge back
        bark = me.copy()
        bm = bmesh.new(); bm.from_mesh(bark)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index not in bark_idx], context="FACES")
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.002)
        bm.to_mesh(bark); bm.free()
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in bark_idx], context="FACES")
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new("tmp_bark", bark)
        ol = bpy.data.objects.new("tmp_leaf", me)
        for o in (ob, ol):
            bpy.context.scene.collection.objects.link(o)
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.ratio = bark_ratio
        mod.use_collapse_triangulate = True
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = ob
        ob.select_set(True)
        bpy.ops.object.modifier_apply(modifier="dec")
        ol.select_set(True)
        bpy.context.view_layer.objects.active = ol
        bpy.ops.object.join()
        bpy.context.scene.collection.objects.unlink(ol)
        bpy.data.objects.remove(ol)

def nature_prefab(name, module, lod="", s=1.0, light=None):
    """Nature kit pieces keep their vertex colours (leaf tint). light=(bark_ratio, leaf_keep) thins them."""
    meshes = kit(module, NAT)
    objs = []
    for me in meshes:
        m2 = me.copy()
        if s != 1.0:
            m2.transform(S(s))
        if light:
            lighten_tree(m2, *light)
        objs.append(bpy.data.objects.new(name + "_p", m2))
    for o in objs:
        COLL_PREFABS.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name; obj.data.name = name
    obj.hide_render = True; obj.hide_set(True)
    me = obj.data
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
    for v in me.vertices:
        mn = Vector(map(min, mn, v.co)); mx = Vector(map(max, mx, v.co))
    PREFABS[name] = obj
    PREFAB_INFO[name] = dict(tris=tris, mats=[m.name for m in me.materials], min=list(mn), max=list(mx), lod=lod, **footprints(me, trunk=True))
    log(f"prefab {name:22s} tris {tris:6d}  size {mx.x - mn.x:5.1f} x {mx.y - mn.y:5.1f} x {mx.z - mn.z:5.1f}  mats {len(me.materials)}")
    return obj

# --------------------------------------------------------------------------------------------
# Sphere mapping (Portus plaza tangent frame at the north pole -> planet surface)
#   (east, north) are geodesic (arc-length) coordinates: azimuthal equidistant projection.
#   up = (sin t cos a, sin t sin a, cos t) with t = hypot(e, n) / R, a = atan2(n, e)
#   position = (0, 0, -R) + R * up                         (Blender, Z up)
#   rotation = minimal rotation taking +Z to `up`, then `yaw` about the local up (CCW from above).
# --------------------------------------------------------------------------------------------
def surf_up(e, n):
    r = math.hypot(e, n)
    if r < 1e-9:
        return Vector((0, 0, 1))
    t, a = r / R, math.atan2(n, e)
    return Vector((math.sin(t) * math.cos(a), math.sin(t) * math.sin(a), math.cos(t)))

def surf_point(e, n, h=0.0):
    up = surf_up(e, n)
    return Vector((0, 0, -R)) + up * (R + h)

def surf_quat(e, n, yaw):
    up = surf_up(e, n)
    q = Vector((0, 0, 1)).rotation_difference(up)
    return q @ Quaternion((0, 0, 1), math.radians(yaw))

def surf_matrix(e, n, yaw=0.0, scale=1.0, h=0.0):
    return Matrix.LocRotScale(surf_point(e, n, h), surf_quat(e, n, yaw), Vector((scale,) * 3))

def from_up(up):
    """Inverse map: unit up vector -> (east, north)."""
    t = math.acos(max(-1.0, min(1.0, up.z)))
    a = math.atan2(up.y, up.x)
    return R * t * math.cos(a), R * t * math.sin(a)

def yaw_for_dir(e, n, d):
    """Yaw at (e, n) so that the prefab's local +X points along world tangent direction d."""
    q = surf_quat(e, n, 0)
    x = q @ Vector((1, 0, 0)); y = q @ Vector((0, 1, 0))
    return math.degrees(math.atan2(d.dot(y), d.dot(x)))

def geodesic_run(p1, p2, seg, inset1=0.0, inset2=0.0):
    """Instances of a bent segment prefab (length `seg`) filling the great-circle arc p1 -> p2.
    inset: metres kept free at each end (inside towers). Returns [(e, n, yaw)]."""
    u1, u2 = surf_up(*p1), surf_up(*p2)
    ang = u1.angle(u2)
    L = ang * R - inset1 - inset2
    k = max(1, int(math.ceil(L / seg - 0.15)))
    total = k * seg
    start = inset1 + (L - total) / 2          # centre the run between the towers
    out = []
    axis = u1.cross(u2).normalized()
    for i in range(k):
        s = start + seg * (i + 0.5)
        q = Quaternion(axis, s / R)
        up = q @ u1
        e, n = from_up(up)
        d = axis.cross(up).normalized()        # tangent direction of travel
        out.append((e, n, yaw_for_dir(e, n, d)))
    return out

def polar(r, deg):
    return (r * math.cos(math.radians(deg)), r * math.sin(math.radians(deg)))

def yaw_facing(e, n, te, tn):
    """Yaw so that the prefab front (-Y at yaw 0) faces the point (te, tn) (tangent-plane approx.)."""
    dx, dy = te - e, tn - n
    return math.degrees(math.atan2(dy, dx)) + 90.0


# ============================================================================================
# PREFABS
# ============================================================================================
WALLS = {
    "stone": {"S": "Wall_UnevenBrick_Straight", "W": "Wall_UnevenBrick_Window_Wide_Flat", "w": "Wall_UnevenBrick_Window_Wide_Flat",
              "c": "Wall_UnevenBrick_Window_Wide_Flat", "R": "Wall_UnevenBrick_Window_Wide_Round", "T": "Wall_UnevenBrick_Window_Thin_Round",
              "t": "Wall_UnevenBrick_Window_Thin_Round", "D": "Wall_UnevenBrick_Door_Flat", "A": "Wall_UnevenBrick_Door_Round",
              "B": "Wall_UnevenBrick_Door_Flat", "X": "Wall_UnevenBrick_Straight", "G": "Wall_UnevenBrick_Straight",
              "Q": "Wall_UnevenBrick_Door_Round"},
    "plaster": {"S": "Wall_Plaster_Straight", "W": "Wall_Plaster_Window_Wide_Flat", "w": "Wall_Plaster_Window_Wide_Flat",
                "c": "Wall_Plaster_Window_Wide_Flat", "F": "Wall_Plaster_Window_Wide_Flat2", "R": "Wall_Plaster_Window_Wide_Round",
                "T": "Wall_Plaster_Window_Thin_Round", "t": "Wall_Plaster_Window_Thin_Round", "D": "Wall_Plaster_Door_Flat",
                "A": "Wall_Plaster_Door_Round", "B": "Wall_Plaster_Door_Flat", "X": "Wall_Plaster_Straight_L", "G": "Wall_Plaster_Straight_Base",
                "Q": "Wall_Plaster_Door_Round"},
}
INSERTS = {  # letter -> list of (module, dx) placed in the same frame as the wall module
    "W": [("Window_Wide_Flat1", 0)], "F": [("Window_Wide_Flat1", 0)], "R": [("Window_Wide_Round1", 0)],
    "T": [("Window_Thin_Round1", 0)], "t": [("Window_Thin_Round1", 0), ("WindowShutters_Thin_Round_Open", 0)],
    "w": [("Window_Wide_Flat1", 0), ("WindowShutters_Wide_Flat_Open", 0)],
    "c": [("Window_Wide_Flat1", 0), ("WindowShutters_Wide_Flat_Closed", 0)],
    "D": [("Door_1_Flat", -0.53)], "B": [("Door_1_Flat", -0.53)], "A": [("Door_1_Round", -0.52)],
    "Q": [("Door_4_Round", -0.52)],
}

def side_frames(w, d):
    """For each side: function i -> (x, y, rot) of the i-th 2 m module, left to right seen from outside."""
    return {
        "front": lambda i: (-w / 2 + 1 + 2 * i, -d / 2, 0),
        "right": lambda i: (w / 2, -d / 2 + 1 + 2 * i, 90),
        "back": lambda i: (w / 2 - 1 - 2 * i, d / 2, 180),
        "left": lambda i: (-w / 2, d / 2 - 1 - 2 * i, -90),
    }

def storey(p, w, d, z, style, sides, corners="Corner_Exterior_Wood", ox=0.0, oy=0.0):
    fr = side_frames(w, d)
    for side, spec in sides.items():
        for i, ch in enumerate(spec):
            x, y, rot = fr[side](i)
            x += ox; y += oy
            p.k(WALLS[style][ch], x, y, z, rot)
            for mod, dx in INSERTS.get(ch, []):
                a = math.radians(rot)
                p.k(mod, x + dx * math.cos(a), y + dx * math.sin(a), z, rot)
    if corners:
        for cx, cy in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
            p.k(corners, cx + ox, cy + oy, z)

def plinth(p, w, d, h=0.18, ox=0.0, oy=0.0, pad=0.2, depth=0.9):
    """Stone socle under a building: hides the curvature of the ground under the corners."""
    x0, x1 = ox - w / 2 - pad, ox + w / 2 + pad
    y0, y1 = oy - d / 2 - pad, oy + d / 2 + pad
    box(p.mb, x0, y0, -depth, x1, y1, h, "MI_RockTrim", mode="band", band="ashlar", skip=("-z",),
        top=("MI_RockTrim", "band", "slab"))

def gable_roof(p, w, d, z, ridge="y", gables=True, ox=0.0, oy=0.0, gable_mod=None):
    if ridge == "y":
        p.k(f"Roof_RoundTiles_{w}x{d}", ox, oy, z)
        if gables:
            g = gable_mod or f"Roof_Front_Brick{w}"
            p.k(g, ox, oy - d / 2, z, 0)
            p.k(g, ox, oy + d / 2, z, 180)
    else:
        p.k(f"Roof_RoundTiles_{d}x{w}", ox, oy, z, 90)
        if gables:
            g = gable_mod or f"Roof_Front_Brick{d}"
            p.k(g, ox + w / 2, oy, z, 90)
            p.k(g, ox - w / 2, oy, z, -90)

def roof_height(w):
    return {4: 3.73, 6: 4.89, 8: 6.0}[w]

def awning(mb, x0, x1, y_wall, z_top, depth=1.3, drop=0.5, colors=("red", "cream"), stripes=None):
    """Striped cloth awning sloping out from a wall (front faces -Y) with a scalloped valance."""
    n = stripes or max(2, int(round((x1 - x0) / 0.36)))
    for i in range(n):
        a = x0 + (x1 - x0) * i / n
        b = x0 + (x1 - x0) * (i + 1) / n
        col = colors[i % len(colors)]
        pts = [(a, y_wall - depth, z_top - drop), (b, y_wall - depth, z_top - drop), (b, y_wall, z_top), (a, y_wall, z_top)]
        mb.face(pts, "M_Cloth", [pal_uv(col)] * 4)
        mb.face(list(reversed(pts)), "M_Cloth", [pal_uv(col)] * 4)
        # valance flap
        v = [(a, y_wall - depth, z_top - drop - 0.22), (b, y_wall - depth, z_top - drop - 0.22), (b, y_wall - depth, z_top - drop), (a, y_wall - depth, z_top - drop)]
        mb.face(v, "M_Cloth", [pal_uv(col)] * 4)
        mb.face(list(reversed(v)), "M_Cloth", [pal_uv(col)] * 4)
    # two thin poles / brackets
    for x in (x0 + 0.05, x1 - 0.05):
        oriented_box(mb, T(x, y_wall - depth / 2, z_top - drop / 2 - 0.05) @ Rx(-math.degrees(math.atan2(drop, depth))), 0.06, depth * 1.1, 0.06, "MI_WoodTrim", mode="band", band="dark")

def hanging_sign(mb, x, y_wall, z, color="gold", side=1):
    """Iron bracket + painted board sticking out of a wall (front -Y), perpendicular to the wall."""
    oriented_box(mb, T(x, y_wall - 0.55, z), 0.05, 1.1, 0.05, "MI_MetalOrnaments", mode="planar")
    oriented_box(mb, T(x, y_wall - 0.6, z - 0.68), 0.06, 0.8, 0.62, "MI_WoodTrim", mode="band", band="dark")
    oriented_box(mb, T(x + 0.035, y_wall - 0.6, z - 0.61), 0.01, 0.62, 0.48, "M_Cloth", pal=color)
    oriented_box(mb, T(x - 0.035, y_wall - 0.6, z - 0.61), 0.01, 0.62, 0.48, "M_Cloth", pal=color)
    # painted emblem (a dark roundel with a light centre) on both faces
    for sx in (1, -1):
        xx = x + sx * 0.042
        ring = [(xx, y_wall - 0.6 + math.cos(a) * 0.17, z - 0.37 + math.sin(a) * 0.17) for a in [2 * math.pi * k / 8 for k in range(8)]]
        mb.face(ring if sx > 0 else list(reversed(ring)), "M_Cloth", [pal_uv("dark")] * 8)
        dot = [(xx + sx * 0.002, y_wall - 0.6 + math.cos(a) * 0.08, z - 0.37 + math.sin(a) * 0.08) for a in [2 * math.pi * k / 6 for k in range(6)]]
        mb.face(dot if sx > 0 else list(reversed(dot)), "M_Cloth", [pal_uv("white" if color != "white" else "red")] * 6)

def balcony(p, x, y_wall, z):
    """1 m deep balcony on the -Y face at storey floor z, centred on x (2 m wide)."""
    p.k("Floor_WoodDark_Half3", x, y_wall, z + 0.02, 180)
    p.k("Balcony_Cross_Straight", x, y_wall, z + 0.02)
    p.k("HoleCover_Straight", x, y_wall + 0.0, z + 0.02, 180)
    for sx in (-0.85, 0.85):
        p.k("Prop_Support", x + sx, y_wall, z - 2.92 + 0.02, 0, (1, 0.55, 1))

def house(name, w, d, floors, ridge="y", chimney=None, extras=None, lod="", gables=True, roof_mod=None):
    p = Prefab(name, lod)
    plinth(p, w, d)
    for i, (style, sides) in enumerate(floors):
        storey(p, w, d, i * H, style, sides)
    top = len(floors) * H
    if roof_mod:
        roof_mod(p, top)
    else:
        gable_roof(p, w, d, top, ridge, gables)
    if chimney:
        cx, cy, cz = chimney
        p.k("Prop_Chimney2", cx, cy, top + cz)
    if extras:
        extras(p, top)
    m = 0.16
    across = w if ridge == "y" else d
    return p.finish(interior=[(-w / 2 + m, -d / 2 + m, w / 2 - m, d / 2 - m, 0.05, top + roof_height(across) - 0.9)])

# Round 2 (the owner's pick, 2026-10-15): the market houses are the Opus design A (half-timbered,
# teal shop front, string lights; tools/blender/round2), built to each house plot so the layout and
# the colliders stay: plot = the old house's collider (pack.py HAND), centred 0.108 m toward the
# front; the house's footprint (counter and step included) fits inside it. Variant = roof and plaster tints (0 coral, 1 slate, 2 moss, 3 plum). LOD1 drops the small
# parts (goods, flower boxes, lights, sign, lantern, finial, hoist): a "<name>__L1" prefab.
ROUND2 = os.path.abspath(os.path.join(HERE, "..", "round2"))
OPUS_HOUSES = {"house_a": (2.417, 2.308, 0), "house_b": (2.417, 3.308, 1), "house_c": (3.417, 2.308, 2), "house_d": (3.417, 3.308, 3)}

def build_round2_houses():
    if ROUND2 not in sys.path:
        sys.path.insert(0, ROUND2)
    import pieces
    for name, (hx, hz, variant) in OPUS_HOUSES.items():
        for lod1, pname in ((False, name), (True, name + "__L1")):
            old = PREFABS.pop(pname, None)
            if old is not None:
                bpy.data.objects.remove(old)
            # The counter, crates and door step stand up to 0.63 m in front of the ground-floor wall,
            # the plinth 0.15 m behind and beside it: all of it inside the old collider.
            me = pieces.house(2 * hx - 0.4, 2 * hz - 0.78, variant, pname + "_r2", lod1=lod1)
            me.transform(T(0, -0.108 + 0.24, 0))
            p = Prefab(pname, lod="round 2 Opus house A; LOD1 without the small parts")
            p.parts.append((me, Matrix.Identity(4)))
            p.finish(keep_colors=True)

def build_round2_gates():
    """The portal courts become the Opus gate A ("Waygate", floating arch, destination globe),
    tinted to their world; the portal itself (membrane, trigger) is the game's (Portals.ts)."""
    if ROUND2 not in sys.path:
        sys.path.insert(0, ROUND2)
    import pieces
    for world in PORTAL_COLORS:
        name = "portal_court_" + world
        me = pieces.gate_a(world, name + "_r2")
        p = Prefab(name, lod="round 2 Opus gate A")
        p.parts.append((me, Matrix.Identity(4)))
        p.finish(keep_colors=True)

def build_houses():
    # A: compact 4x4 corner house, stone below, timber above, side chimney + ivy.
    house("house_a", 4, 4, [
        ("stone", {"front": "DW", "right": "WS", "back": "SS", "left": "SW"}),
        ("plaster", {"front": "wF", "right": "XW", "back": "SX", "left": "WX"}),
    ], chimney=(1.1, 1.0, 0.4), lod="roof+gables ~50 % of tris. LOD1: swap the kit tile roof for a 2-slope shell (~40 tris), keep gables; collapse-decimation opens holes",
        extras=lambda p, top: (p.k("Prop_Vine5", -2.1, -0.3, 2.9, -90),))

    # B: tall narrow 4x6 town house, gable to the street, three storeys.
    def b_extra(p, top):
        hanging_sign(p.mb, 1.75, -3.1, 3.1, "teal")
    house("house_b", 4, 6, [
        ("stone", {"front": "AW", "right": "WSS", "back": "SS", "left": "SSW"}),
        ("plaster", {"front": "ww", "right": "SWX", "back": "SX", "left": "XWS"}),
        ("plaster", {"front": "TT", "right": "SXS", "back": "SS", "left": "SXS"}),
    ], chimney=(-1.0, 1.6, 1.2), extras=b_extra, lod="LOD1: swap the kit tile roof for a 2-slope shell (~40 tris), keep gables; collapse-decimation opens holes; drop window/shutter inserts")

    # C: 6x4 shop house, eaves to the street, balcony + striped awnings.
    def c_extra(p, top):
        awning(p.mb, -2.95, -1.05, -2.09, 2.95, colors=("red", "cream"))
        awning(p.mb, 1.05, 2.95, -2.09, 2.95, colors=("red", "cream"))
        balcony(p, 0, -2.0, H)
        hanging_sign(p.mb, -3.0, -2.1, 3.1, "gold")
    house("house_c", 6, 4, [
        ("stone", {"front": "WDW", "right": "WS", "back": "SSS", "left": "SW"}),
        ("plaster", {"front": "FBF", "right": "XS", "back": "XWX", "left": "SX"}),
    ], ridge="x", chimney=(1.6, 0.9, 0.6), extras=c_extra, lod="LOD1: swap the kit tile roof for a 2-slope shell (~40 tris), keep gables; collapse-decimation opens holes")

    # D: 6x6 burgher house with balcony and big gable.
    def d_extra(p, top):
        balcony(p, -2, -3.0, H)
        p.k("Prop_Vine6", 3.15, 1.0, 3.0, 90)
    house("house_d", 6, 6, [
        ("stone", {"front": "WAW", "right": "WSS", "back": "SSS", "left": "SSW"}),
        ("plaster", {"front": "BFw", "right": "XFX", "back": "SXS", "left": "XFX"}),
    ], chimney=(1.8, 1.5, 1.4), extras=d_extra, lod="LOD1: swap the kit tile roof for a 2-slope shell (~40 tris), keep gables; collapse-decimation opens holes")

    # Cottage: single storey stone, for the back lanes.
    house("cottage", 4, 4, [
        ("stone", {"front": "DW", "right": "WS", "back": "SS", "left": "SW"}),
    ], chimney=(-1.1, 1.1, 0.3), lod="LOD1: swap the kit tile roof for a 2-slope shell (~40 tris), keep gables; collapse-decimation opens holes",
        extras=lambda p, top: (p.k("Prop_Vine2", 2.1, 0.6, 2.9, 90),))

# --------------------------------------------------------------------------------------------
# Fortifications (custom geometry, kit materials)
# --------------------------------------------------------------------------------------------
WALL_T = 2.4        # curtain wall thickness
WALK_Z = 6.2        # wall-walk height
BREAST_Z = 7.2      # top of the breastwork
MERLON_Z = 8.3      # top of the merlons

def merlon_row(mb, x0, x1, y0, y1, z0, z1, pitch=2.0, width=1.15, phase=0.0, cap=True):
    """Merlons along X between x0..x1 (centres at phase + k*pitch), between y0..y1."""
    k0 = math.ceil((x0 - phase) / pitch - 1e-6)
    x = phase + k0 * pitch
    while x <= x1 + 1e-6:
        a, b = max(x0, x - width / 2), min(x1, x + width / 2)
        if b - a > 0.3:
            box(mb, a, y0, z0, b, y1, z1, "MI_UnevenBrick", skip=("-z",), top=("MI_RockTrim", "band", "slab"))
        x += pitch

def wall_section(mb, x0, x1, inner_lip=True):
    """Curtain wall cross-section extruded along X (front/outside = -Y)."""
    t = WALL_T / 2
    # battered ashlar foot
    quad(mb, [(x0, -t - 0.55, -1.4), (x1, -t - 0.55, -1.4), (x1, -t, 1.3), (x0, -t, 1.3)], "MI_RockTrim", mode="band", band="ashlar", z0=-1.4, z1=1.3)
    # outer face
    quad(mb, [(x0, -t, 1.3), (x1, -t, 1.3), (x1, -t, BREAST_Z), (x0, -t, BREAST_Z)], "MI_UnevenBrick")
    # string course under the parapet
    box(mb, x0, -t - 0.14, WALK_Z - 0.28, x1, -t + 0.01, WALK_Z, "MI_RockTrim", mode="band", band="slab", skip=("-x", "+x", "+y"))
    # breastwork top + inner face of the parapet
    quad(mb, [(x0, -t, BREAST_Z), (x1, -t, BREAST_Z), (x1, -t + 0.6, BREAST_Z), (x0, -t + 0.6, BREAST_Z)], "MI_RockTrim", mode="band", band="slab")
    quad(mb, [(x1, -t + 0.6, WALK_Z), (x0, -t + 0.6, WALK_Z), (x0, -t + 0.6, BREAST_Z), (x1, -t + 0.6, BREAST_Z)], "MI_UnevenBrick")
    merlon_row(mb, x0, x1, -t, -t + 0.6, BREAST_Z, MERLON_Z, phase=1.0)
    # wall walk
    quad(mb, [(x0, -t + 0.6, WALK_Z), (x1, -t + 0.6, WALK_Z), (x1, t - 0.35, WALK_Z), (x0, t - 0.35, WALK_Z)], "MI_RockTrim", mode="band", band="slab")
    # inner lip + inner face
    lip = WALK_Z + (0.75 if inner_lip else 0.0)
    if inner_lip:
        quad(mb, [(x1, t - 0.35, WALK_Z), (x0, t - 0.35, WALK_Z), (x0, t - 0.35, lip), (x1, t - 0.35, lip)], "MI_UnevenBrick")
        quad(mb, [(x0, t - 0.35, lip), (x1, t - 0.35, lip), (x1, t, lip), (x0, t, lip)], "MI_RockTrim", mode="band", band="slab")
    quad(mb, [(x1, t, -1.4), (x0, t, -1.4), (x0, t, lip), (x1, t, lip)], "MI_UnevenBrick")
    quad(mb, [(x1, t + 0.25, -1.4), (x0, t + 0.25, -1.4), (x0, t, 0.6), (x1, t, 0.6)], "MI_RockTrim", mode="band", band="ashlar", z0=-1.4, z1=0.6)

def build_wall_seg():
    t = WALL_T / 2
    for name, ivy in (("wall_seg", False), ("wall_seg_ivy", True)):
        p = Prefab(name, lod="custom, already minimal" if not ivy else "custom + 2 kit ivy patches")
        wall_section(p.mb, -2.0, 2.0)
        # inner pilaster every 4 m (breaks the long inner face)
        box(p.mb, -0.45, t - 0.02, -1.0, 0.45, t + 0.45, WALK_Z - 0.6, "MI_UnevenBrick", skip=("-z", "-y"), top=("MI_RockTrim", "band", "slab"))
        if ivy:
            p.k("Prop_Vine6", 0.6, -t - 0.02, 6.4, 180, (0.9, 0.9, 1.6))
            p.k("Prop_Vine1", -1.1, t + 0.02, 5.9, 0, (1.0, 1.0, 1.4))
        p.finish(bend_x=True)

def build_wall_extras():
    """Stair up to the wall-walk (built against the inner face) and a lean-to shed."""
    p = Prefab("wall_stair", lod="custom, minimal")
    mb = p.mb
    n = 18
    rise, run, w = WALK_Z / n, 0.42, 1.4
    L = n * run
    for i in range(n):
        x0 = -L / 2 + i * run
        box(mb, x0, -w, -0.6, x0 + run + 0.01, 0.0, (i + 1) * rise, "MI_RockTrim", mode="band", band="ashlar", skip=("+y", "-z", "+x" if i < n - 1 else "") , top=("MI_RockTrim", "band", "slab"))
    # landing against the wall and a parapet-less side wall under the flight
    box(mb, L / 2, -w, -0.6, L / 2 + 1.4, 0.0, WALK_Z, "MI_UnevenBrick", skip=("+y", "-z"), top=("MI_RockTrim", "band", "slab"))
    p.finish()
    p = Prefab("lean_to", lod="kit wooden roof pieces + crates")
    mb = p.mb
    for x in (-2.0, 0.0, 2.0):
        box(mb, x - 0.08, -2.25, 0.0, x + 0.08, -2.09, 2.35, "MI_WoodTrim", mode="band", band="dark")
    p.k("Roof_Wooden_2x1_L", -1.0, 0.05, 2.25, 0, (1, 1.45, 1))
    p.k("Roof_Wooden_2x1_R", 1.0, 0.05, 2.25, 0, (1, 1.45, 1))
    p.k("Prop_Crate", -1.2, -0.9, 0, 10, (0.8, 0.8, 0.8))
    barrel(mb, T(0.4, -0.7, 0)); barrel(mb, T(1.2, -1.2, 0), h=0.8, r=0.3)
    for i, c in enumerate(("linen", "linen")):
        oriented_box(mb, T(1.4 - i * 0.5, -0.45, 0) @ Rz(15 * i), 0.5, 0.4, 0.45, "M_Cloth", pal=c)
    p.finish()

def round_tower_body(mb, r, top, slits=(), roofed=False, n=20, parapet=True):
    """Round tower: battered foot, shaft, string course, corbelled crenellated parapet."""
    frustum(mb, r + 0.6, r, -1.4, 1.6, n, "MI_RockTrim", mode="band", band="ashlar")
    prism(mb, circle(r, n, math.pi / n), 1.6, top, "MI_UnevenBrick", cap_top=False)
    frustum(mb, r + 0.2, r + 0.2, top - 0.3, top, n, "MI_RockTrim", mode="band", band="slab")
    frustum(mb, r, r + 0.2, top - 0.6, top - 0.3, n, "MI_RockTrim", mode="band", band="slab")
    if not parapet:
        quad(mb, [(*p, top) for p in circle(r + 0.2, n, math.pi / n)], "MI_RockTrim", mode="band", band="slab")
        return top
    # parapet ring (outer face, top, inner face) and floor
    po, pi = r + 0.2, r - 0.4
    prism(mb, circle(po, n, math.pi / n), top, top + 1.0, "MI_UnevenBrick", cap_top=False)
    ring_top = []
    co, ci = circle(po, n, math.pi / n), circle(pi, n, math.pi / n)
    for i in range(n):
        j = (i + 1) % n
        quad(mb, [(*co[i], top + 1.0), (*co[j], top + 1.0), (*ci[j], top + 1.0), (*ci[i], top + 1.0)], "MI_RockTrim", mode="band", band="slab")
        quad(mb, [(*ci[j], top + 1.0), (*ci[i], top + 1.0), (*ci[i], top), (*ci[j], top)], "MI_UnevenBrick")
    quad(mb, [(*p, top + 0.02) for p in circle(pi, n, math.pi / n)], "MI_RockTrim", mode="band", band="slab")
    if not roofed:
        # merlons on every other facet
        for i in range(0, n, 2):
            j = (i + 1) % n
            a0, a1 = co[i], co[j]
            b0, b1 = ci[i], ci[j]
            z0, z1 = top + 1.0, top + 2.0
            quad(mb, [(*a0, z0), (*a1, z0), (*a1, z1), (*a0, z1)], "MI_UnevenBrick")
            quad(mb, [(*b1, z0), (*b0, z0), (*b0, z1), (*b1, z1)], "MI_UnevenBrick")
            quad(mb, [(*b0, z0), (*a0, z0), (*a0, z1), (*b0, z1)], "MI_UnevenBrick")
            quad(mb, [(*a1, z0), (*b1, z0), (*b1, z1), (*a1, z1)], "MI_UnevenBrick")
            quad(mb, [(*a0, z1), (*a1, z1), (*b1, z1), (*b0, z1)], "MI_RockTrim", mode="band", band="slab")
    # arrow slits: dark recesses on the shaft
    for ang, z in slits:
        a = math.radians(ang)
        c = Vector((math.cos(a) * r, math.sin(a) * r, 0))
        uax = Vector((-math.sin(a), math.cos(a), 0))
        origin = c + Vector((0, 0, 0)) + (-uax * 0) + Vector((math.cos(a), math.sin(a), 0)) * 0.03
        shape = rect_shape(0, z, 0.22, 1.3)
        # recess drawn as jambs + dark back (face sits slightly proud of the facet)
        reveal(mb, origin, uax, Vector((0, 0, 1)), shape, 0.25, "MI_UnevenBrick", back_mat="MI_WindowGlass")
        oriented_box(mb, Matrix.Translation(origin + Vector((0, 0, z - 0.12))) @ Matrix.Rotation(a - math.pi / 2, 4, "Z"), 0.6, 0.12, 0.12, "MI_RockTrim", mode="band", band="slab")
    return top + 1.0

def cone_roof(mb, r, z0, h, n=20, overhang=0.5):
    """Conical tiled roof with a wooden eave ring and an iron finial."""
    rr = r + overhang
    co = circle(rr, n, math.pi / n)
    slant = math.hypot(rr, h)
    circ = 2 * math.pi * rr
    for i in range(n):
        j = (i + 1) % n
        u0, u1 = i / n * circ / 2.0, (i + 1) / n * circ / 2.0
        um = (u0 + u1) / 2
        mb.face([(*co[i], z0), (*co[j], z0), (0, 0, z0 + h)], "MI_RoundTiles",
                [(u0, 0), (u1, 0), (um, slant / 2.0)])
    frustum(mb, rr + 0.05, rr + 0.05, z0 - 0.25, z0, n, "MI_WoodTrim", mode="band", band="dark")
    quad(mb, [(*p, z0 - 0.25) for p in reversed(circle(rr + 0.05, n, math.pi / n))], "MI_WoodTrim", mode="band", band="dark")
    # finial
    frustum(mb, 0.12, 0.02, z0 + h - 0.2, z0 + h + 1.6, 6, "MI_MetalOrnaments")
    frustum(mb, 0.22, 0.22, z0 + h + 0.3, z0 + h + 0.42, 6, "MI_MetalOrnaments")

def build_towers():
    p = Prefab("tower_round", lod="custom, minimal")
    round_tower_body(p.mb, 3.3, 9.6, slits=[(-90, 3.0), (-45, 6.2), (-135, 6.2), (180, 3.4), (0, 3.4)])
    p.finish()
    p = Prefab("tower_round_roof", lod="custom, minimal")
    top = round_tower_body(p.mb, 3.3, 11.0, slits=[(-90, 3.0), (-45, 7.0), (-135, 7.0), (0, 4.0), (180, 4.0)], roofed=True)
    cone_roof(p.mb, 3.5, top - 0.05, 5.6)
    p.finish()

def torch(mb, M):
    """Wall torch: iron bracket + flame (front faces -Y, mounted on a wall at y=0)."""
    oriented_box(mb, M @ T(0, -0.18, -0.1), 0.06, 0.36, 0.06, "MI_MetalOrnaments")
    tmp = MB()
    frustum(tmp, 0.07, 0.12, 0, 0.35, 6, "MI_MetalOrnaments")
    frustum(tmp, 0.10, 0.0, 0.33, 0.85, 6, "M_Glow")
    mb.extend(tmp, M @ T(0, -0.36, -0.15))

def banner(mb, M, w, h, colors=("red", "gold"), tails=True):
    """Hanging cloth banner (front -Y) from a horizontal pole at the origin, with a forked tail."""
    oriented_box(mb, M @ T(0, -0.08, -0.03), w + 0.35, 0.07, 0.07, "MI_WoodTrim", mode="band", band="dark")
    main, trim = colors[0], colors[1]
    y = -0.12
    pts = [(-w / 2, y, -h), (w / 2, y, -h), (w / 2, y, 0), (-w / 2, y, 0)]
    tmp = MB()
    tmp.face(pts, "M_Cloth", [pal_uv(main)] * 4)
    tmp.face(list(reversed(pts)), "M_Cloth", [pal_uv(main)] * 4)
    if tails:
        tri = [(-w / 2, y, -h), (0, y, -h - w * 0.45), (w / 2, y, -h)]
        tmp.face([(-w / 2, y, -h), (0, y, -h + w * 0.25), (0, y, -h - 0.0)], "M_Cloth", [pal_uv(main)] * 3)
        tmp.face([(-w / 2, y, -h), (-w / 4, y, -h - w * 0.5), (0, y, -h + 0.0)], "M_Cloth", [pal_uv(main)] * 3)
        tmp.face([(0, y, -h), (w / 4, y, -h - w * 0.5), (w / 2, y, -h)], "M_Cloth", [pal_uv(main)] * 3)
        for f in list(tmp.F[-3:]):
            pass
    # trim stripe + emblem (diamond) on the front
    y2 = y - 0.01
    s = [(-w / 2 + 0.08, y2, -h * 0.20), (w / 2 - 0.08, y2, -h * 0.20), (w / 2 - 0.08, y2, -h * 0.14), (-w / 2 + 0.08, y2, -h * 0.14)]
    tmp.face(s, "M_Cloth", [pal_uv(trim)] * 4)
    cz = -h * 0.5
    d = w * 0.28
    tmp.face([(0, y2, cz - d * 1.3), (d, y2, cz), (0, y2, cz + d * 1.3), (-d, y2, cz)], "M_Cloth", [pal_uv(trim)] * 4)
    # back faces for the tails/trim are not needed (thin flags read from the front; banner body is two-sided)
    mb.extend(tmp, M)

def gate_block(mb, w, d, h, aw, spring, y_front=None, face_mat="MI_UnevenBrick"):
    """Stone block with a through-passage along Y (arched both ends). Front at y=-d/2."""
    x0, x1, y0, y1 = -w / 2, w / 2, -d / 2, d / 2
    shape = arch_shape(0, -0.6, aw, spring, segs=10)
    outline = [(x0, -1.4), (x1, -1.4), (x1, h), (x0, h)]
    # front face (normal -Y): u along +X
    wall_face(mb, (0, y0, 0), (1, 0, 0), (0, 0, 1), outline, [shape], face_mat)
    # back face (normal +Y): u along -X
    shape_b = [(-p[0], p[1]) for p in reversed(shape)]
    wall_face(mb, (0, y1, 0), (-1, 0, 0), (0, 0, 1), [(x0, -1.4), (x1, -1.4), (x1, h), (x0, h)], [shape_b], face_mat)
    # side faces + top
    quad(mb, [(x0, y1, -1.4), (x0, y0, -1.4), (x0, y0, h), (x0, y1, h)], face_mat)
    quad(mb, [(x1, y0, -1.4), (x1, y1, -1.4), (x1, y1, h), (x1, y0, h)], face_mat)
    # passage vault (through)
    reveal(mb, (0, y0, 0), (1, 0, 0), (0, 0, 1), shape, d, face_mat, through=True)
    # voussoir ring on the front and back
    for sign, yy in ((-1, y0), (1, y1)):
        r0, r1 = aw / 2, aw / 2 + 0.55
        segs = 10
        for i in range(segs):
            a0, a1 = math.pi * i / segs, math.pi * (i + 1) / segs
            p0 = (math.cos(a0) * r0, spring + math.sin(a0) * r0)
            p1 = (math.cos(a1) * r0, spring + math.sin(a1) * r0)
            q0 = (math.cos(a0) * r1, spring + math.sin(a0) * r1)
            q1 = (math.cos(a1) * r1, spring + math.sin(a1) * r1)
            yo = yy + sign * 0.12
            pts = [(q0[0], yo, q0[1]), (q1[0], yo, q1[1]), (p1[0], yo, p1[1]), (p0[0], yo, p0[1])]
            if sign > 0:
                pts = list(reversed(pts))
            L = 0.55
            quad(mb, pts, "MI_RockTrim", uvs=[(i * 0.12, 0.02), ((i + 1) * 0.12, 0.02), ((i + 1) * 0.12, 0.38), (i * 0.12, 0.38)])
            # outer edge of the ring
            e = [(q0[0], yy, q0[1]), (q1[0], yy, q1[1]), (q1[0], yo, q1[1]), (q0[0], yo, q0[1])]
            if sign < 0:
                e = list(reversed(e))
            quad(mb, e, "MI_RockTrim", mode="band", band="slab")
        # imposts
        for sx in (-1, 1):
            box(mb, sx * (aw / 2) - 0.35 + (0.35 if sx > 0 else 0), min(yy, yy + sign * 0.14), spring - 0.3, sx * (aw / 2) + (0.35 if sx > 0 else 0), max(yy, yy + sign * 0.14), spring, "MI_RockTrim", mode="band", band="slab")

def portcullis(mb, M, w, h, bars=7):
    for i in range(bars):
        x = -w / 2 + w * (i + 0.5) / bars
        oriented_box(mb, M @ T(x, 0, -0.25), 0.09, 0.09, h + 0.25, "MI_MetalOrnaments")
        tmp = MB(); frustum(tmp, 0.06, 0.0, 0, 0.25, 4, "MI_MetalOrnaments"); mb.extend(tmp, M @ T(x, 0, -0.25) @ Rx(180))
    for j in range(4):
        z = h * (j + 0.6) / 4.6
        oriented_box(mb, M @ T(0, 0, z), w, 0.1, 0.1, "MI_MetalOrnaments")

def build_gatehouse():
    p = Prefab("gatehouse", lod="LOD1: drop the timber storey inserts, 2-slope roof shell; stone body already minimal")
    mb = p.mb
    W, D, Hs = 7.6, 5.6, 9.2
    gate_block(mb, W, D, Hs, 3.8, 3.4)
    # crenellated walk around the timber storey
    quad(mb, [(-W / 2, -D / 2, Hs), (W / 2, -D / 2, Hs), (W / 2, D / 2, Hs), (-W / 2, D / 2, Hs)], "MI_RockTrim", mode="band", band="slab")
    box(mb, -W / 2 - 0.15, -D / 2 - 0.15, Hs - 0.3, W / 2 + 0.15, -D / 2 + 0.01, Hs, "MI_RockTrim", mode="band", band="slab", skip=("+y",))
    # hoarding corbels (beam ends) under the timber storey on the front
    # timber gate room on top (kit walls), 6 x 4
    storey(p, 6, 4, Hs, "plaster", {"front": "wFw", "right": "SX", "back": "FSF", "left": "XS"}, oy=-0.2)
    gable_roof(p, 6, 4, Hs + H, ridge="x", oy=-0.2)
    for x in (-2.6, -1.3, 0.0, 1.3, 2.6):
        oriented_box(mb, T(x, -2.45, Hs - 0.32), 0.22, 0.6, 0.3, "MI_WoodTrim", mode="band", band="ends")
    # flanking round towers
    for sx in (-1, 1):
        tmp = MB()
        round_tower_body(tmp, 2.9, 11.2, slits=[(-90, 3.2), (-90 - sx * 50, 7.2), (sx * 0 + (0 if sx > 0 else 180), 5.0)], roofed=True)
        cone_roof(tmp, 3.1, 12.15, 5.4)
        mb.extend(tmp, T(sx * 5.3, -0.9, 0))
    # portcullis (half raised) in the front arch, doors open inside
    portcullis(mb, T(0, -D / 2 + 0.45, 3.3), 3.6, 2.6)
    for sx in (-1, 1):
        oriented_box(mb, T(sx * 1.55, 0.9, 0.0) @ Rz(sx * 8), 0.12, 1.9, 3.3, "MI_WoodTrim", mode="band", band="dark")
    # banners and torches on the front
    banner(mb, T(-2.75, -D / 2, 8.6), 1.1, 3.4, ("red", "gold"))
    banner(mb, T(2.75, -D / 2, 8.6), 1.1, 3.4, ("red", "gold"))
    torch(mb, T(-2.6, -D / 2, 3.2))
    torch(mb, T(2.6, -D / 2, 3.2))
    torch(mb, T(-2.6, D / 2, 3.2) @ Rz(180))
    torch(mb, T(2.6, D / 2, 3.2) @ Rz(180))
    banner(mb, T(-2.75, D / 2, 8.6) @ Rz(180), 1.0, 2.8, ("red", "gold"))
    banner(mb, T(2.75, D / 2, 8.6) @ Rz(180), 1.0, 2.8, ("red", "gold"))
    return p.finish(interior=[(-3 + 0.16, -2.2 + 0.16, 3 - 0.16, 1.8 - 0.16, Hs + 0.05, Hs + H + 2.8)])


def recess_window(mb, origin, uax, z0, w, h, depth=0.3, arched=True, sill=True, mat="MI_UnevenBrick"):
    """Dark glazed window recess on a plain wall face (origin on the face, uax along it, normal = uax x Z)."""
    origin, uax = Vector(origin), Vector(uax)
    vax = Vector((0, 0, 1))
    shape = arch_shape(0, z0, w, z0 + h - w / 2, segs=6) if arched else rect_shape(0, z0, w, h)
    nrm = uax.cross(vax).normalized()
    o2 = origin + nrm * 0.02
    # stone surround: a slightly proud frame (4 quads) around the opening
    reveal(mb, o2, uax, vax, shape, depth + 0.02, mat, back_mat="MI_WindowGlass")
    if sill:
        M = Matrix((uax, -nrm, vax)).transposed().to_4x4()
        M.translation = origin + nrm * 0.08 + Vector((0, 0, z0 - 0.14))
        oriented_box(mb, M, w + 0.3, 0.22, 0.14, "MI_RockTrim", mode="band", band="slab")

def face_frame(side, hw, hd):
    """Origin/axes for a box face: returns (origin_fn(u, z) -> point on face, uax)."""
    if side == "front":
        return (lambda u: Vector((u, -hd, 0))), Vector((1, 0, 0))
    if side == "back":
        return (lambda u: Vector((-u, hd, 0))), Vector((-1, 0, 0))
    if side == "right":
        return (lambda u: Vector((hw, u, 0))), Vector((0, 1, 0))
    return (lambda u: Vector((-hw, -u, 0))), Vector((0, -1, 0))

def walls_with_openings(mb, hw, hd, z0, z1, openings, mat="MI_UnevenBrick", through=None):
    """Four walls of a box (half sizes hw, hd) from z0..z1; openings: side -> list of (u, zb, w, h, kind)
    kind in {'arch','rect','door','slit'}; recesses are dark-glazed (doors get a plank leaf)."""
    for side in ("front", "right", "back", "left"):
        fn, uax = face_frame(side, hw, hd)
        half = hw if side in ("front", "back") else hd
        holes = []
        ops = openings.get(side, [])
        for (u, zb, w, h, kind) in ops:
            holes.append(arch_shape(u, zb, w, zb + h - w / 2, 6) if kind in ("arch", "door") else rect_shape(u, zb, w, h))
        origin = fn(0)
        wall_face(mb, origin, uax, (0, 0, 1), [(-half, z0), (half, z0), (half, z1), (-half, z1)], holes, mat)
        nrm = uax.cross(Vector((0, 0, 1)))
        for (u, zb, w, h, kind), hole in zip(ops, holes):
            if kind == "door":
                reveal(mb, origin, uax, (0, 0, 1), hole, 0.45, mat, back_mat="MI_WoodTrim")
                # door leaf planks: use the dark plank band
                pts = [origin + uax * p[0] + Vector((0, 0, p[1])) - nrm * 0.45 + nrm * 0.01 for p in hole]
                mb.F.pop(); mb.V[-len(hole):] = []; mb.UV.pop(); mb.M.pop(); mb.S.pop()
                mb.face(pts, "MI_WoodTrim", [((p[0] - u) / 4 + 0.5, 0.41 + (p[1] - zb) / h * 0.28) for p in hole])
                # iron bands
                for zz in (zb + 0.5, zb + h * 0.62):
                    M = Matrix((uax, -nrm, Vector((0, 0, 1)))).transposed().to_4x4()
                    M.translation = origin + uax * u + Vector((0, 0, zz)) - nrm * 0.43
                    oriented_box(mb, M, w * 0.92, 0.04, 0.08, "MI_MetalOrnaments")
            else:
                reveal(mb, origin, uax, (0, 0, 1), hole, 0.3 if kind != "slit" else 0.35, mat, back_mat="MI_WindowGlass")
            if kind in ("arch", "rect"):
                M = Matrix((uax, -nrm, Vector((0, 0, 1)))).transposed().to_4x4()
                M.translation = origin + uax * u + nrm * 0.1 + Vector((0, 0, zb - 0.14))
                oriented_box(mb, M, w + 0.3, 0.24, 0.14, "MI_RockTrim", mode="band", band="slab")

def square_band(mb, hw, hd, z0, z1, out=0.12, band="slab"):
    """Protruding string course around a box."""
    box(mb, -hw - out, -hd - out, z0, hw + out, hd + out, z1, "MI_RockTrim", mode="band", band=band, skip=())

def crenel_box_top(mb, hw, hd, z, depth=0.6, pitch=1.8, width=1.0, h_breast=1.0, h_merlon=1.0, floor=True):
    """Parapet with merlons around the top of a box (outer faces flush with hw/hd)."""
    zb = z + h_breast
    # outer faces of the breastwork
    for side in ("front", "right", "back", "left"):
        fn, uax = face_frame(side, hw, hd)
        half = hw if side in ("front", "back") else hd
        o = fn(0)
        quad(mb, [o + uax * -half + Vector((0, 0, z)), o + uax * half + Vector((0, 0, z)), o + uax * half + Vector((0, 0, zb)), o + uax * -half + Vector((0, 0, zb))], "MI_UnevenBrick")
        nrm = uax.cross(Vector((0, 0, 1)))
        inner = o - nrm * depth
        hi = half - depth
        quad(mb, [inner + uax * hi + Vector((0, 0, z)), inner + uax * -hi + Vector((0, 0, z)), inner + uax * -hi + Vector((0, 0, zb)), inner + uax * hi + Vector((0, 0, zb))], "MI_UnevenBrick")
        quad(mb, [o + uax * -half + Vector((0, 0, zb)), o + uax * half + Vector((0, 0, zb)), inner + uax * hi + Vector((0, 0, zb)), inner + uax * -hi + Vector((0, 0, zb))], "MI_RockTrim", mode="band", band="slab")
        # merlons
        n = max(2, int(round((2 * half) / pitch)))
        for i in range(n + 1):
            if i % 2:
                continue
            c = -half + (2 * half) * i / n
            a, b = max(-half, c - width / 2), min(half, c + width / 2)
            M = Matrix((uax, -nrm, Vector((0, 0, 1)))).transposed().to_4x4()
            M.translation = o + uax * ((a + b) / 2) - nrm * (depth / 2) + Vector((0, 0, zb))
            oriented_box(mb, M, b - a, depth, h_merlon, "MI_UnevenBrick", skip=("-z",))
    if floor:
        quad(mb, [(-hw + depth, -hd + depth, z + 0.02), (hw - depth, -hd + depth, z + 0.02), (hw - depth, hd - depth, z + 0.02), (-hw + depth, hd - depth, z + 0.02)], "MI_RockTrim", mode="band", band="slab")

def build_keep():
    p = Prefab("keep", lod="landmark: keep full detail (seen from everywhere); LOD1 = custom pyramid roof")
    mb = p.mb
    hw = 5.0
    top = 23.0
    # battered foot
    frustum(mb, (hw + 0.7) * math.sqrt(2), hw * math.sqrt(2), -1.4, 2.2, 4, "MI_RockTrim", mode="band", band="ashlar", a0=math.pi / 4)
    ops = {}
    for side in ("front", "right", "back", "left"):
        lst = [(-2.4, 4.2, 0.28, 1.4, "slit"), (2.4, 4.2, 0.28, 1.4, "slit"),
               (-2.2, 8.4, 1.0, 2.1, "arch"), (2.2, 8.4, 1.0, 2.1, "arch"),
               (-1.0, 13.9, 0.9, 2.2, "arch"), (1.0, 13.9, 0.9, 2.2, "arch"),
               (0.0, 18.6, 1.1, 2.4, "arch")]
        if side == "front":
            lst = [(0, 2.2, 2.0, 3.4, "door")] + lst
        ops[side] = lst
    walls_with_openings(mb, hw, hw, 2.2, top, ops)
    square_band(mb, hw, hw, 7.0, 7.3)
    square_band(mb, hw, hw, 12.6, 12.9)
    square_band(mb, hw, hw, 17.6, 17.9)
    # clasping corner buttresses in dressed stone
    for sx in (-1, 1):
        for sy in (-1, 1):
            xa, xb = (hw - 0.7, hw + 0.3) if sx > 0 else (-hw - 0.3, -hw + 0.7)
            ya, yb = (hw - 0.7, hw + 0.3) if sy > 0 else (-hw - 0.3, -hw + 0.7)
            box(mb, xa, ya, -1.0, xb, yb, 20.0, "MI_Brick", skip=("-z",), top=("MI_RockTrim", "band", "slab"))
    # corbels + projecting crenellated parapet
    for side in ("front", "right", "back", "left"):
        fn, uax = face_frame(side, hw, hw)
        nrm = uax.cross(Vector((0, 0, 1)))
        for i in range(9):
            u = -4.0 + i
            M = Matrix((uax, -nrm, Vector((0, 0, 1)))).transposed().to_4x4()
            M.translation = fn(0) + uax * u - nrm * 0.0 + Vector((0, 0, top - 0.55))
            oriented_box(mb, M, 0.36, 0.7, 0.55, "MI_RockTrim", mode="band", band="ashlar")
    box(mb, -hw - 0.35, -hw - 0.35, top - 0.05, hw + 0.35, hw + 0.35, top + 0.25, "MI_RockTrim", mode="band", band="slab", skip=("+z",))
    crenel_box_top(mb, hw + 0.35, hw + 0.35, top + 0.25, depth=0.55, pitch=1.4, width=0.8)
    # corner bartizans
    for sx in (-1, 1):
        for sy in (-1, 1):
            tmp = MB()
            frustum(tmp, 0.25, 1.25, top - 2.4, top + 0.25, 12, "MI_RockTrim", mode="band", band="ashlar")
            prism(tmp, circle(1.25, 12, math.pi / 12), top + 0.25, top + 2.4, "MI_UnevenBrick", cap_top=False)
            for k in range(0, 12, 3):
                a = 2 * math.pi * (k + 0.5) / 12
                o = Vector((math.cos(a) * 1.27, math.sin(a) * 1.27, 0))
                reveal(tmp, o, Vector((-math.sin(a), math.cos(a), 0)), (0, 0, 1), rect_shape(0, top + 1.0, 0.2, 0.8), 0.2, "MI_UnevenBrick", back_mat="MI_WindowGlass")
            cone_roof(tmp, 1.25, top + 2.4, 2.8, n=12, overhang=0.3)
            mb.extend(tmp, T(sx * (hw + 0.35), sy * (hw + 0.35), 0))
    # upper tower with the kit's tower roof
    uw = 3.2
    walls_with_openings(mb, uw, uw, top, top + 5.6, {s: [(-1.1, top + 2.0, 0.8, 1.8, "arch"), (1.1, top + 2.0, 0.8, 1.8, "arch")] for s in ("front", "right", "back", "left")})
    square_band(mb, uw, uw, top + 5.3, top + 5.6, out=0.1)
    p.k("Roof_Tower_RoundTiles", 0, 0, top + 5.6, 0, (1.2, 1.25, 1.35))
    # long banners on the front face + flag on the spire
    banner(mb, T(-2.6, -hw - 0.36, top - 0.7), 1.3, 5.6, ("red", "gold"))
    banner(mb, T(2.6, -hw - 0.36, top - 0.7), 1.3, 5.6, ("red", "gold"))
    zf = top + 5.6 + 6.79 * 1.35
    oriented_box(mb, T(0, 0, zf - 1.0), 0.07, 0.07, 3.2, "MI_MetalOrnaments")
    flag = [(0.04, 0, zf + 1.1), (2.4, 0, zf + 1.45), (2.2, 0, zf + 1.9), (0.04, 0, zf + 2.1)]
    mb.face(flag, "M_Cloth", [pal_uv("red")] * 4); mb.face(list(reversed(flag)), "M_Cloth", [pal_uv("red")] * 4)
    # entrance stair landing
    box(mb, -2.2, -hw - 2.6, -0.6, 2.2, -hw, 0.45, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    box(mb, -2.2, -hw - 3.3, -0.6, 2.2, -hw - 2.6, 0.22, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    torch(mb, T(-1.6, -hw - 0.02, 4.4))
    torch(mb, T(1.6, -hw - 0.02, 4.4))
    return p.finish()

def build_castle_gate():
    p = Prefab("castle_gate", lod="custom, minimal")
    mb = p.mb
    W, D, Hs = 7.0, 4.4, 8.4
    gate_block(mb, W, D, Hs, 3.4, 3.2)
    crenel_box_top(mb, W / 2, D / 2, Hs, depth=0.5, pitch=1.4, width=0.8)
    box(mb, -W / 2 - 0.15, -D / 2 - 0.15, Hs - 0.3, W / 2 + 0.15, D / 2 + 0.15, Hs, "MI_RockTrim", mode="band", band="slab")
    portcullis(mb, T(0, -D / 2 + 0.4, 3.0), 3.2, 2.4)
    banner(mb, T(0, -D / 2 - 0.15, Hs - 0.5), 1.2, 2.2, ("red", "gold"), tails=False)
    torch(mb, T(-2.4, -D / 2, 3.0)); torch(mb, T(2.4, -D / 2, 3.0))
    return p.finish()

PORTAL_COLORS = {"arcadia": ("green", "gold"), "hollowmere": ("teal", "white"), "meridian": ("gold", "red")}

def brazier(mb, M, h=1.0):
    tmp = MB()
    frustum(tmp, 0.08, 0.08, 0, h - 0.3, 6, "MI_MetalOrnaments")
    frustum(tmp, 0.12, 0.42, h - 0.3, h, 8, "MI_MetalOrnaments", cap=True)
    frustum(tmp, 0.32, 0.0, h, h + 0.7, 7, "M_Glow")
    frustum(tmp, 0.18, 0.0, h, h + 1.05, 5, "M_Glow", a0=0.3)
    mb.extend(tmp, M)

def build_portal_court(name, colors):
    """Freestanding stone arch behind the portal ring + a curved exedra seat + braziers.
    Portal ring at the origin (ring plane = XZ); the court opens toward -Y (the plaza centre)."""
    p = Prefab("portal_court_" + name, lod="custom, minimal")
    mb = p.mb
    ya, depth = 4.7, 1.2
    hw, top = 4.3, 9.4
    shape = arch_shape(0, -0.6, 6.0, 5.6, segs=12)
    for (yy, uax) in ((ya, (1, 0, 0)), (ya + depth, (-1, 0, 0))):
        sh = shape if uax[0] > 0 else [(-q[0], q[1]) for q in reversed(shape)]
        wall_face(mb, (0, yy, 0), uax, (0, 0, 1), [(-hw, -1.0), (hw, -1.0), (hw, top), (-hw, top)], [sh], "MI_Brick")
    quad(mb, [(-hw, ya + depth, -1), (-hw, ya, -1), (-hw, ya, top), (-hw, ya + depth, top)], "MI_Brick")
    quad(mb, [(hw, ya, -1), (hw, ya + depth, -1), (hw, ya + depth, top), (hw, ya, top)], "MI_Brick")
    reveal(mb, (0, ya, 0), (1, 0, 0), (0, 0, 1), shape, depth, "MI_Brick", through=True)
    # voussoirs and cornice
    for i in range(12):
        a0, a1 = math.pi * i / 12, math.pi * (i + 1) / 12
        r0, r1 = 3.0, 3.6
        q = lambda a, r: (math.cos(a) * r, 5.6 + math.sin(a) * r)
        A, B, C, D = q(a0, r1), q(a1, r1), q(a1, r0), q(a0, r0)
        y = ya - 0.1
        quad(mb, [(A[0], y, A[1]), (B[0], y, B[1]), (C[0], y, C[1]), (D[0], y, D[1])], "MI_RockTrim", uvs=[(i * 0.1, 0.02), ((i + 1) * 0.1, 0.02), ((i + 1) * 0.1, 0.38), (i * 0.1, 0.38)])
        quad(mb, [(A[0], ya, A[1]), (B[0], ya, B[1]), (B[0], y, B[1]), (A[0], y, A[1])][::-1], "MI_RockTrim", mode="band", band="slab")
    box(mb, -hw - 0.25, ya - 0.25, top, hw + 0.25, ya + depth + 0.25, top + 0.4, "MI_RockTrim", mode="band", band="slab")
    box(mb, -hw - 0.15, ya - 0.15, 4.95, hw + 0.15, ya + depth + 0.15, 5.25, "MI_RockTrim", mode="band", band="slab")
    # stepped crest with a keystone pediment
    box(mb, -2.2, ya + 0.1, top + 0.4, 2.2, ya + depth - 0.1, top + 1.1, "MI_Brick", top=("MI_RockTrim", "band", "slab"))
    box(mb, -0.9, ya + 0.2, top + 1.1, 0.9, ya + depth - 0.2, top + 1.8, "MI_Brick", top=("MI_RockTrim", "band", "slab"))
    for x in (-hw + 0.3, hw - 0.3):
        tmp = MB(); frustum(tmp, 0.32, 0.05, 0, 1.4, 4, "MI_RockTrim", mode="band", band="slab"); mb.extend(tmp, T(x, ya + depth / 2, top + 0.4))
    # banners on the piers (destination colours)
    for x in (-hw + 0.65, hw - 0.65):
        banner(mb, T(x, ya - 0.02, 8.6), 1.0, 3.8, colors)
    # exedra: curved stone bench wall behind the portal
    n = 14
    r_in, r_out = 6.1, 6.6
    a_from, a_to = math.radians(-8), math.radians(188)
    for i in range(n):
        a0 = a_from + (a_to - a_from) * i / n
        a1 = a_from + (a_to - a_from) * (i + 1) / n
        pi0 = (math.cos(a0) * r_in, math.sin(a0) * r_in); pi1 = (math.cos(a1) * r_in, math.sin(a1) * r_in)
        po0 = (math.cos(a0) * r_out, math.sin(a0) * r_out); po1 = (math.cos(a1) * r_out, math.sin(a1) * r_out)
        zt = 0.95
        quad(mb, [(*pi1, -0.5), (*pi0, -0.5), (*pi0, zt), (*pi1, zt)], "MI_Brick")
        quad(mb, [(*po0, -0.5), (*po1, -0.5), (*po1, zt), (*po0, zt)], "MI_Brick")
        quad(mb, [(*pi0, zt), (*pi1, zt), (*po1, zt), (*po0, zt)], "MI_RockTrim", mode="band", band="slab")
        # seat ledge on the inside
        si0 = (math.cos(a0) * (r_in - 0.45), math.sin(a0) * (r_in - 0.45)); si1 = (math.cos(a1) * (r_in - 0.45), math.sin(a1) * (r_in - 0.45))
        quad(mb, [(*si0, 0.48), (*si1, 0.48), (*pi1, 0.48), (*pi0, 0.48)], "MI_WoodTrim", mode="band", band="plank")
        quad(mb, [(*si1, -0.3), (*si0, -0.3), (*si0, 0.48), (*si1, 0.48)], "MI_Brick")
    # pillars with braziers at the mouth of the court
    for a in (a_from, a_to):
        c = Vector((math.cos(a) * 6.35, math.sin(a) * 6.35, 0))
        box(mb, c.x - 0.45, c.y - 0.45, -0.5, c.x + 0.45, c.y + 0.45, 3.6, "MI_Brick", top=("MI_RockTrim", "band", "slab"))
        box(mb, c.x - 0.55, c.y - 0.55, -0.5, c.x + 0.55, c.y + 0.55, 0.5, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
        box(mb, c.x - 0.55, c.y - 0.55, 3.6, c.x + 0.55, c.y + 0.55, 3.85, "MI_RockTrim", mode="band", band="slab")
        brazier(mb, T(c.x, c.y, 3.85), h=0.5)
    return p.finish()

def build_market_hall():
    p = Prefab("market_hall", lod="LOD1: swap the kit tile roof for a 2-slope shell (~40 tris), keep gables; collapse-decimation opens holes; bell turret already custom")
    mb = p.mb
    w, d = 8, 10
    plinth(p, w, d)
    storey(p, w, d, 0, "stone", {"front": "RAAR", "right": "WSWSW", "back": "SDSS", "left": "WSWSW"})
    storey(p, w, d, H, "plaster", {"front": "FwwF", "right": "XFXFX", "back": "SFFS", "left": "XFXFX"})
    gable_roof(p, w, d, 2 * H)
    # bell turret on the ridge
    zr = 2 * H + 6.0 - 0.5
    box(mb, -0.9, -0.9, zr - 1.4, 0.9, 0.9, zr + 1.6, "MI_WoodTrim", mode="band", band="dark", skip=("-z",))
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(mb, sx * 0.9 - 0.12, sy * 0.9 - 0.12, zr - 1.0, sx * 0.9 + 0.12, sy * 0.9 + 0.12, zr + 1.7, "MI_WoodTrim", mode="band", band="plank")
    for side in ("front", "right", "back", "left"):
        fn, uax = face_frame(side, 0.9, 0.9)
        reveal(mb, fn(0), uax, (0, 0, 1), arch_shape(0, zr + 0.1, 0.9, zr + 0.9, 6), 0.3, "MI_WoodTrim", back_mat="MI_WindowGlass")
    tmp = MB()
    frustum(tmp, 1.55, 0.0, 0, 3.4, 4, "MI_RoundTiles", a0=math.pi / 4)
    frustum(tmp, 1.6, 1.6, -0.18, 0.0, 4, "MI_WoodTrim", mode="band", band="dark", a0=math.pi / 4)
    frustum(tmp, 0.1, 0.02, 3.2, 4.8, 6, "MI_MetalOrnaments")
    mb.extend(tmp, T(0, 0, zr + 1.7))
    # clock on the front gable
    cz = 2 * H + 2.1
    tmp = MB()
    frustum(tmp, 0.78, 0.78, 0, 0.12, 16, "MI_WoodTrim", mode="band", band="dark", cap=True)
    frustum(tmp, 0.62, 0.62, 0.12, 0.14, 16, "M_Cloth", mode="pal", band="cream", cap=False)
    mb.extend(tmp, T(0, -d / 2 - 0.42, cz) @ Rx(90))
    disc = [(math.cos(a) * 0.64, -d / 2 - 0.58, cz + math.sin(a) * 0.64) for a in [2 * math.pi * i / 16 for i in range(16)]]
    mb.face(list(reversed(disc)), "M_Cloth", [pal_uv("cream")] * 16)
    oriented_box(mb, T(0, -d / 2 - 0.6, cz) @ Ry(-35), 0.06, 0.03, 0.5, "MI_MetalOrnaments")
    oriented_box(mb, T(0, -d / 2 - 0.6, cz) @ Ry(100), 0.06, 0.03, 0.36, "MI_MetalOrnaments")
    # long market awning across the ground floor front + town banner
    awning(mb, -3.9, 3.9, -d / 2 - 0.09, 3.0, depth=1.7, drop=0.55, colors=("gold", "cream"))
    banner(mb, T(-2.95, -d / 2 - 0.1, 2 * H - 0.25), 0.8, 2.3, ("red", "gold"))
    banner(mb, T(2.95, -d / 2 - 0.1, 2 * H - 0.25), 0.8, 2.3, ("red", "gold"))
    p.k("Prop_Vine6", 4.15, 3.0, 3.1, 90)
    return p.finish(interior=[(-w / 2 + 0.16, -d / 2 + 0.16, w / 2 - 0.16, d / 2 - 0.16, 0.05, 2 * H + 5.0)])

def build_hall_of_firsts():
    """Monumental stone hall (custom walls under the kit's 6x10 roof)."""
    p = Prefab("hall_of_firsts", lod="LOD1: swap the kit tile roof for a 2-slope shell (~40 tris), keep gables; collapse-decimation opens holes")
    mb = p.mb
    hw, hd, top = 3.1, 5.0, 2 * H
    box(mb, -hw - 0.35, -hd - 0.35, -1.2, hw + 0.35, hd + 0.35, 0.5, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    side_ops = [(-3.0, 1.2, 0.9, 3.6, "arch"), (0.0, 1.2, 0.9, 3.6, "arch"), (3.0, 1.2, 0.9, 3.6, "arch")]
    ops = {"front": [(0, 0.5, 1.9, 3.3, "door"), (-2.0, 1.8, 0.7, 2.6, "arch"), (2.0, 1.8, 0.7, 2.6, "arch")],
           "back": [(0, 1.6, 0.9, 3.0, "arch")], "right": side_ops, "left": side_ops}
    walls_with_openings(mb, hw, hd, 0.5, top, ops)
    square_band(mb, hw, hd, top - 0.3, top, out=0.12)
    # side buttresses
    for sx in (-1, 1):
        for y in (-4.4, -1.5, 1.5, 4.4):
            box(mb, sx * hw - (0.0 if sx > 0 else 0.55), y - 0.3, -0.5, sx * hw + (0.55 if sx > 0 else 0.0), y + 0.3, top - 1.0, "MI_Brick", skip=("-z",), top=("MI_RockTrim", "band", "slab"))
    # stone gables under the roof
    for sgn in (-1, 1):
        y = sgn * hd
        tri = [(-hw, top), (hw, top), (hw, top + 0.45), (0, top + 4.45), (-hw, top + 0.45)]
        uax = (1, 0, 0) if sgn < 0 else (-1, 0, 0)
        trs = tri if sgn < 0 else [(-q[0], q[1]) for q in tri]
        hole = [] if sgn > 0 else [[(math.cos(a) * 0.75, top + 1.9 + math.sin(a) * 0.75) for a in [2 * math.pi * i / 12 for i in range(12)]]]
        wall_face(mb, (0, y, 0), uax, (0, 0, 1), trs, hole, "MI_UnevenBrick")
        if hole:
            reveal(mb, (0, y, 0), (1, 0, 0), (0, 0, 1), hole[0], 0.3, "MI_UnevenBrick", back_mat="MI_WindowGlass")
            tmp = MB(); frustum(tmp, 0.95, 0.95, 0, 0.14, 12, "MI_RockTrim", mode="band", band="slab"); frustum(tmp, 0.95, 0.75, 0.14, 0.14, 12, "MI_RockTrim", mode="band", band="slab")
            mb.extend(tmp, T(0, y - 0.14, top + 1.9) @ Rx(90))
    p.k("Roof_RoundTiles_6x10", 0, 0, top)
    # grand door frame + steps + banners + braziers
    segs = 9
    r0, r1, zc = 0.95, 1.45, 0.5 + 3.3 - 0.95
    for i in range(segs):
        a0, a1 = math.pi * i / segs, math.pi * (i + 1) / segs
        q = lambda a, r: (math.cos(a) * r, zc + math.sin(a) * r)
        A, B, C, D = q(a0, r1), q(a1, r1), q(a1, r0), q(a0, r0)
        y = -hd - 0.16
        quad(mb, [(A[0], y, A[1]), (B[0], y, B[1]), (C[0], y, C[1]), (D[0], y, D[1])], "MI_RockTrim", uvs=[(i * 0.13, 0.02), ((i + 1) * 0.13, 0.02), ((i + 1) * 0.13, 0.38), (i * 0.13, 0.38)])
        quad(mb, [(A[0], -hd, A[1]), (B[0], -hd, B[1]), (B[0], y, B[1]), (A[0], y, A[1])][::-1], "MI_RockTrim", mode="band", band="slab")
    for sx in (-1, 1):
        box(mb, sx * 1.2 - 0.25, -hd - 0.16, 0.5, sx * 1.2 + 0.25, -hd, zc, "MI_RockTrim", mode="band", band="ashlar")
    box(mb, -2.0, -hd - 1.4, -0.6, 2.0, -hd, 0.32, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    banner(mb, T(-2.05, -hd - 0.36, top - 0.4), 0.9, 3.0, ("blue", "gold"))
    banner(mb, T(2.05, -hd - 0.36, top - 0.4), 0.9, 3.0, ("blue", "gold"))
    for x in (-2.6, 2.6):
        brazier(mb, T(x, -hd - 1.3, 0.0), h=1.1)
    return p.finish()

# --------------------------------------------------------------------------------------------
# Market and street props
# --------------------------------------------------------------------------------------------
def barrel(mb, M, h=0.95, r=0.34):
    tmp = MB()
    n = 10
    frustum(tmp, r * 0.86, r, 0, h / 2, n, "MI_WoodTrim", mode="band", band="dark", tile=1.0)
    frustum(tmp, r, r * 0.86, h / 2, h, n, "MI_WoodTrim", mode="band", band="dark", tile=1.0)
    quad(tmp, [(*q, h) for q in circle(r * 0.86, n, math.pi / n)], "MI_WoodTrim", mode="band", band="ends")
    for z in (0.12, h - 0.16):
        rr = r * (0.86 + 0.14 * min(z, h - z) / (h / 2)) + 0.012
        frustum(tmp, rr, rr, z, z + 0.05, n, "MI_MetalOrnaments")
    mb.extend(tmp, M)

def crate(p, x, y, z=0, rot=0, s=1.0):
    p.k("Prop_Crate", x, y, z, rot, (s, s, s))

def goods(mb, M, colors):
    """A row of small produce boxes (cloth-coloured fill) on a counter."""
    for i, c in enumerate(colors):
        oriented_box(mb, M @ T(-0.75 + i * 0.5, 0, 0), 0.42, 0.42, 0.14, "MI_WoodTrim", mode="band", band="plank")
        oriented_box(mb, M @ T(-0.75 + i * 0.5, 0, 0.14), 0.36, 0.36, 0.06, "M_Cloth", pal=c)

def build_stalls():
    for name, cols, gcols in (("stall_a", ("red", "cream"), ("orange", "green", "red", "gold")),
                              ("stall_b", ("blue", "cream"), ("purple", "linen", "teal", "gold")),
                              ("stall_c", ("green", "gold"), ("red", "orange", "green", "linen"))):
        p = Prefab(name, lod="custom, minimal")
        mb = p.mb
        W, D = 2.8, 1.8
        for sx in (-1, 1):
            box(mb, sx * W / 2 - 0.06, -D / 2 - 0.06, -0.3, sx * W / 2 + 0.06, -D / 2 + 0.06, 2.3, "MI_WoodTrim", mode="band", band="plank")
            box(mb, sx * W / 2 - 0.06, D / 2 - 0.06, -0.3, sx * W / 2 + 0.06, D / 2 + 0.06, 2.75, "MI_WoodTrim", mode="band", band="plank")
        box(mb, -W / 2 + 0.05, -D / 2 + 0.05, 0, W / 2 - 0.05, -D / 2 + 0.85, 0.92, "MI_WoodTrim", mode="band", band="dark", top=("MI_WoodTrim", "band", "plank"))
        goods(mb, T(0, -D / 2 + 0.45, 0.92), gcols)
        # canopy
        n = 8
        for i in range(n):
            a = -W / 2 - 0.15 + (W + 0.3) * i / n
            b = -W / 2 - 0.15 + (W + 0.3) * (i + 1) / n
            c = cols[i % 2]
            pts = [(a, -D / 2 - 0.45, 2.15), (b, -D / 2 - 0.45, 2.15), (b, D / 2 + 0.1, 2.85), (a, D / 2 + 0.1, 2.85)]
            mb.face(pts, "M_Cloth", [pal_uv(c)] * 4); mb.face(list(reversed(pts)), "M_Cloth", [pal_uv(c)] * 4)
            v = [(a, -D / 2 - 0.45, 1.88), (b, -D / 2 - 0.45, 1.88), (b, -D / 2 - 0.45, 2.15), (a, -D / 2 - 0.45, 2.15)]
            mb.face(v, "M_Cloth", [pal_uv(c)] * 4); mb.face(list(reversed(v)), "M_Cloth", [pal_uv(c)] * 4)
        barrel(mb, T(W / 2 + 0.45, 0.2, 0))
        p.k("Prop_Crate", -W / 2 - 0.5, 0.3, 0, 12, (0.62, 0.62, 0.62))
        p.k("Prop_Crate", -W / 2 - 0.45, 0.25, 0.66, 40, (0.45, 0.45, 0.45))
        p.finish()

def build_props():
    # crates and barrels cluster
    p = Prefab("crates", lod="Prop_Crate 230 tris each; ok")
    crate(p, 0, 0, 0, 5); crate(p, 0.35, 0.05, 1.06, 20, 0.8)
    barrel(p.mb, T(-0.95, 0.15, 0)); barrel(p.mb, T(1.05, -0.55, 0), h=0.8, r=0.3)
    p.finish()
    p = Prefab("barrels", lod="custom, minimal")
    for (x, y) in ((0, 0), (0.72, 0.1), (0.35, 0.62)):
        barrel(p.mb, T(x, y, 0))
    barrel(p.mb, T(0.36, 0.25, 0.96), h=0.85, r=0.3)
    p.finish()
    p = Prefab("wagon", lod="kit wagon (1672 tris): LOD1 = drop at > 40 m")
    p.k("Prop_Wagon", 0, -1.1, 0)
    for i, c in enumerate(("linen", "linen", "cream")):
        oriented_box(p.mb, T(-0.3 + i * 0.32, -0.5 + (i % 2) * 0.5, 0.75) @ Rz(10 * i), 0.5, 0.75, 0.38, "M_Cloth", pal=c)
    p.finish()
    # well
    p = Prefab("well", lod="custom, minimal")
    mb = p.mb
    n = 14
    co, ci = circle(1.05, n), circle(0.75, n)
    prism(mb, co, -0.3, 0.85, "MI_UnevenBrick", cap_top=False)
    prism(mb, list(reversed(ci)), 0.0, 0.85, "MI_UnevenBrick", cap_top=False)
    for i in range(n):
        j = (i + 1) % n
        quad(mb, [(*co[i], 0.85), (*co[j], 0.85), (*ci[j], 0.85), (*ci[i], 0.85)], "MI_RockTrim", mode="band", band="slab")
    quad(mb, [(*q, 0.35) for q in ci], "MI_WindowGlass")
    for sx in (-1, 1):
        box(mb, sx * 0.95 - 0.09, -0.09, 0.85, sx * 0.95 + 0.09, 0.09, 2.6, "MI_WoodTrim", mode="band", band="plank")
    box(mb, -1.1, -0.06, 2.0, 1.1, 0.06, 2.12, "MI_WoodTrim", mode="band", band="plank")
    for sy in (-1, 1):
        pts = [(-1.35, sy * 1.0, 2.25), (1.35, sy * 1.0, 2.25), (1.35, 0, 3.05), (-1.35, 0, 3.05)]
        if sy > 0:
            pts = list(reversed(pts))
        quad(mb, pts, "MI_WoodTrim", mode="band", band="plank", tileu=2.0)
        quad(mb, list(reversed(pts)), "MI_WoodTrim", mode="band", band="dark", tileu=2.0)
    for sx in (-1.35, 1.35):
        tri = [(sx, -1.0, 2.25), (sx, 1.0, 2.25), (sx, 0, 3.05)]
        mb.face(tri if sx > 0 else list(reversed(tri)), "MI_WoodTrim", uv_band(tri, Vector((1, 0, 0)), "dark"))
    barrel(mb, T(0.3, 0.0, 1.35), h=0.32, r=0.16)
    p.finish()
    # lamp post
    p = Prefab("lamp_post", lod="custom, minimal")
    mb = p.mb
    box(mb, -0.2, -0.2, -0.3, 0.2, 0.2, 0.35, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    box(mb, -0.08, -0.08, 0.35, 0.08, 0.08, 3.3, "MI_WoodTrim", mode="band", band="dark")
    box(mb, -0.05, -0.75, 3.1, 0.05, 0.05, 3.2, "MI_MetalOrnaments")
    lm = T(0, -0.7, 2.45)
    oriented_box(mb, lm, 0.34, 0.34, 0.06, "MI_MetalOrnaments")
    oriented_box(mb, lm @ T(0, 0, 0.06), 0.26, 0.26, 0.42, "M_Glow")
    tmp = MB(); frustum(tmp, 0.3, 0.02, 0, 0.3, 4, "MI_MetalOrnaments", a0=math.pi / 4); mb.extend(tmp, lm @ T(0, 0, 0.48))
    oriented_box(mb, lm @ T(0, 0, 0.48), 0.03, 0.03, 0.2, "MI_MetalOrnaments")
    p.finish()
    # bench
    p = Prefab("bench", lod="custom, minimal")
    box(p.mb, -0.9, -0.22, 0.42, 0.9, 0.22, 0.5, "MI_WoodTrim", mode="band", band="plank")
    for x in (-0.7, 0.7):
        box(p.mb, x - 0.06, -0.18, 0, x + 0.06, 0.18, 0.42, "MI_WoodTrim", mode="band", band="dark")
    box(p.mb, -0.9, 0.16, 0.5, 0.9, 0.24, 0.95, "MI_WoodTrim", mode="band", band="plank")
    p.finish()
    # banner pole
    p = Prefab("banner_pole", lod="custom, minimal")
    box(p.mb, -0.25, -0.25, -0.3, 0.25, 0.25, 0.4, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    box(p.mb, -0.06, -0.06, 0.4, 0.06, 0.06, 6.0, "MI_WoodTrim", mode="band", band="dark")
    tmp = MB(); frustum(tmp, 0.1, 0.0, 0, 0.35, 6, "MI_MetalOrnaments"); p.mb.extend(tmp, T(0, 0, 6.0))
    banner(p.mb, T(0, 0.1, 5.6) @ Rz(0), 0.8, 2.6, ("red", "gold"))
    p.finish()
    # fence piece
    p = Prefab("fence", lod="kit fence, minimal")
    p.k("Prop_WoodenFence_Single", 0, 0, 0)
    p.finish()
    # weapon rack + archery target for the training yard
    p = Prefab("weapon_rack", lod="custom, minimal")
    mb = p.mb
    for x in (-1.0, 1.0):
        box(mb, x - 0.07, -0.07, 0, x + 0.07, 0.07, 1.7, "MI_WoodTrim", mode="band", band="dark")
    box(mb, -1.1, -0.06, 1.45, 1.1, 0.06, 1.57, "MI_WoodTrim", mode="band", band="plank")
    box(mb, -1.1, -0.2, 0.25, 1.1, 0.2, 0.33, "MI_WoodTrim", mode="band", band="plank")
    for i in range(6):
        x = -0.8 + i * 0.32
        oriented_box(mb, T(x, 0.05, 0.25) @ Ry(4 - i * 1.5), 0.05, 0.05, 2.2, "MI_WoodTrim", mode="band", band="dark")
        tmp = MB(); frustum(tmp, 0.06, 0.0, 0, 0.3, 4, "MI_MetalOrnaments"); mb.extend(tmp, T(x, 0.05, 2.45) @ Ry(4 - i * 1.5))
    for i, c in enumerate(("red", "blue")):
        tmp = MB(); frustum(tmp, 0.45, 0.45, 0, 0.06, 10, "MI_WoodTrim", mode="band", band="dark", cap=True)
        mb.extend(tmp, T(-0.55 + i * 1.1, -0.12, 0.85) @ Rx(90))
        disc = [(-0.55 + i * 1.1 + math.cos(a) * 0.36, -0.19, 0.85 + math.sin(a) * 0.36) for a in [2 * math.pi * k / 10 for k in range(10)]]
        mb.face(list(reversed(disc)), "M_Cloth", [pal_uv(c)] * 10)
    p.finish()
    p = Prefab("target", lod="custom, minimal")
    mb = p.mb
    for a in (0, 120, 240):
        oriented_box(mb, Rz(a) @ T(0, 0.45, 0) @ Rx(-14), 0.08, 0.08, 1.9, "MI_WoodTrim", mode="band", band="dark")
    tmp = MB(); frustum(tmp, 0.65, 0.65, 0, 0.22, 14, "M_Cloth", mode="pal", band="linen", cap=True); mb.extend(tmp, T(0, -0.05, 1.35) @ Rx(80))
    for r, c in ((0.5, "white"), (0.32, "red"), (0.14, "gold")):
        disc = [(math.cos(a) * r, -0.08 - (0.5 - r) * 0.02 - 0.18, 1.35 + math.sin(a) * r * 0.98) for a in [2 * math.pi * k / 14 for k in range(14)]]
        mb.face(list(reversed(disc)), "M_Cloth", [pal_uv(c)] * 14)
    p.finish()
    # signpost
    p = Prefab("signpost", lod="custom, minimal")
    mb = p.mb
    box(mb, -0.08, -0.08, -0.3, 0.08, 0.08, 2.7, "MI_WoodTrim", mode="band", band="dark")
    for i, (a, z) in enumerate(((20, 2.3), (150, 1.95), (-70, 1.6))):
        M = T(0, 0, z) @ Rz(a)
        oriented_box(mb, M @ T(0.6, 0, -0.14), 1.1, 0.05, 0.26, "MI_WoodTrim", mode="band", band="plank")
        tri = [(1.15, -0.03, -0.27), (1.4, -0.03, -0.14), (1.15, -0.03, -0.01)]
        tmp = MB(); tmp.face(tri, "MI_WoodTrim", [(0, 0.75), (0.05, 0.8), (0, 0.85)]); tmp.face([(x, 0.03, z2) for (x, _, z2) in reversed(tri)], "MI_WoodTrim", [(0, 0.75), (0.05, 0.8), (0, 0.85)])
        mb.extend(tmp, M)
    p.finish()
    # vegetable plot: fence on three sides + crop rows (kit ivy patches)
    p = Prefab("garden_plot", lod="kit fence + ivy patches, minimal")
    for i in range(3):
        p.k("Prop_WoodenFence_Single", -2.05 + 2.05 * i, 2.1, 0, 0)
        p.k("Prop_WoodenFence_Extension1" if i % 2 else "Prop_WoodenFence_Single", -2.05 + 2.05 * i, -2.1, 0, 0)
    for j in range(2):
        p.k("Prop_WoodenFence_Single", 3.1, -1.05 + 2.1 * j, 0, 90)
    for j in range(3):
        p.k("Prop_Vine9", 0.0, -1.2 + 1.2 * j, -0.25, 0, (1.2, 0.55, 0.7))
    barrel(p.mb, T(-2.6, 1.4, 0), h=0.8, r=0.3)
    p.finish()
    # woodpile under a lean-to
    p = Prefab("woodpile", lod="custom, minimal")
    mb = p.mb
    for row in range(3):
        for i in range(5 - row):
            tmp = MB()
            frustum(tmp, 0.16, 0.16, -1.0, 1.0, 7, "MI_WoodTrim", mode="band", band="dark", cap=True)
            quad(tmp, [(*q, -1.0) for q in reversed(circle(0.16, 7, math.pi / 7))], "MI_WoodTrim", mode="band", band="ends")
            mb.extend(tmp, T(-0.66 + i * 0.33 + row * 0.165, 0, 0.17 + row * 0.29) @ Ry(90))
    for x in (-1.2, 1.2):
        box(mb, x - 0.06, 0.4, 0, x + 0.06, 0.52, 2.0, "MI_WoodTrim", mode="band", band="dark")
        box(mb, x - 0.06, -0.62, 0, x + 0.06, -0.5, 1.6, "MI_WoodTrim", mode="band", band="dark")
    pts = [(-1.4, -0.85, 1.55), (1.4, -0.85, 1.55), (1.4, 0.7, 2.1), (-1.4, 0.7, 2.1)]
    quad(mb, pts, "MI_WoodTrim", mode="band", band="plank", tileu=2.0); quad(mb, list(reversed(pts)), "MI_WoodTrim", mode="band", band="dark", tileu=2.0)
    p.finish()
    # stone planter with a flowering bush
    p = Prefab("planter", lod="custom, minimal")
    box(p.mb, -0.9, -0.9, -0.3, 0.9, 0.9, 0.6, "MI_Brick", top=("MI_RockTrim", "band", "slab"))
    box(p.mb, -0.75, -0.75, 0.6, 0.75, 0.75, 0.62, "MI_WoodTrim", mode="band", band="dark", skip=("-z",))
    p.finish()
    # ring bench around a plaza tree
    p = Prefab("ring_bench", lod="custom, minimal")
    n = 12
    co, ci = circle(2.0, n), circle(1.45, n)
    prism(p.mb, co, -0.3, 0.45, "MI_Brick", cap_top=False)
    prism(p.mb, list(reversed(ci)), 0.0, 0.45, "MI_Brick", cap_top=False)
    for i in range(n):
        j = (i + 1) % n
        quad(p.mb, [(*co[i], 0.45), (*co[j], 0.45), (*ci[j], 0.45), (*ci[i], 0.45)], "MI_WoodTrim", mode="band", band="plank")
    p.finish()
    # festive bunting (span L, anchors at z = 0 at both ends; pivot at the middle of the span)
    for L in (8, 12):
        p = Prefab(f"bunting_{L}", lod="custom, minimal")
        mb = p.mb
        n = int(L / 0.55)
        sag = 0.06 * L
        zf = lambda x: 4.6 - sag * (1 - (2 * x / L) ** 2)
        cols = ("red", "gold", "blue", "cream", "green", "orange")
        for i in range(n + 1):
            x0 = -L / 2 + L * i / (n + 1)
            x1 = -L / 2 + L * (i + 1) / (n + 1)
            oriented_box(mb, T((x0 + x1) / 2, 0, (zf(x0) + zf(x1)) / 2 - 0.012) @ Ry(-math.degrees(math.atan2(zf(x1) - zf(x0), x1 - x0))), x1 - x0 + 0.02, 0.02, 0.025, "MI_WoodTrim", mode="band", band="dark", skip=("-z", "+z"))
            if 0 < i:
                xm = x0
                c = cols[i % len(cols)]
                tri = [(xm - 0.16, 0, zf(xm)), (xm + 0.16, 0, zf(xm)), (xm, 0, zf(xm) - 0.42)]
                mb.face(tri, "M_Cloth", [pal_uv(c)] * 3)
                mb.face(list(reversed(tri)), "M_Cloth", [pal_uv(c)] * 3)
        p.finish()
    # low garden wall, 4 m, with a slab coping
    p = Prefab("garden_wall", lod="custom, minimal")
    box(p.mb, -2.0, -0.25, -0.5, 2.0, 0.25, 1.05, "MI_UnevenBrick", skip=("-z",), top=("MI_RockTrim", "band", "slab"))
    box(p.mb, -2.05, -0.32, 1.05, 2.05, 0.32, 1.2, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    p.finish()
    # brazier on a stone base (gates, plaza)
    p = Prefab("brazier", lod="custom, minimal")
    box(p.mb, -0.35, -0.35, -0.3, 0.35, 0.35, 0.3, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    brazier(p.mb, T(0, 0, 0.3), h=1.0)
    p.finish()

def build_nature():
    nature_prefab("tree_oak", "CommonTree_3", lod="bark decimated to 25 %, 70 % of leaf cards; impostor beyond 60 m", light=(0.25, 0.7))
    nature_prefab("tree_oak_small", "CommonTree_5", lod="bark decimated to 25 %, 70 % of leaf cards; impostor beyond 60 m", light=(0.25, 0.7))
    nature_prefab("tree_pine", "Pine_5", lod="bark decimated to 50 %, 75 % of needle cards; impostor beyond 60 m", light=(0.5, 0.75))
    nature_prefab("tree_pine_tall", "Pine_4", lod="bark decimated to 20 %, 75 % of needle cards; impostor beyond 60 m", light=(0.2, 0.75))
    nature_prefab("bush", "Bush_Common_Flowers", lod="65 % of leaf/flower cards", light=(1.0, 0.65))

# ============================================================================================
# RENDER SETUP
# ============================================================================================
def setup_render(res=(1600, 900)):
    SC.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE_NEXT"
    SC.render.resolution_x, SC.render.resolution_y = res
    SC.render.resolution_percentage = SCALE
    ee = SC.eevee
    for k, v in (("taa_render_samples", SAMPLES), ("use_shadows", True), ("use_raytracing", True),
                 ("shadow_ray_count", 2), ("shadow_step_count", 8), ("use_gtao", True), ("gtao_distance", 1.5),
                 ("fast_gi_method", "GLOBAL_ILLUMINATION"), ("use_fast_gi", True), ("shadow_resolution_scale", 1.0)):
        try:
            setattr(ee, k, v)
        except Exception:
            pass
    try:
        ee.ray_tracing_options.resolution_scale = "1"
        ee.ray_tracing_options.use_denoise = True
    except Exception:
        pass
    SC.view_settings.view_transform = "AgX"
    for look in ("AgX - Punchy", "Punchy", "AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            SC.view_settings.look = look
            break
        except Exception:
            pass
    SC.view_settings.exposure = 0.0
    SC.render.film_transparent = False
    SC.render.image_settings.file_format = "PNG"

def setup_world(strength=1.0):
    """Stylised sky: vivid blue gradient on the view direction + soft noise clouds (render only)."""
    w = bpy.data.worlds.new("sky")
    SC.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    cr = ramp.color_ramp
    cr.elements[0].position = 0.0; cr.elements[0].color = (0.30, 0.52, 0.90, 1)
    cr.elements[1].position = 1.0; cr.elements[1].color = (0.05, 0.18, 0.62, 1)
    e = cr.elements.new(0.06); e.color = (0.56, 0.72, 0.92, 1)
    e = cr.elements.new(0.35); e.color = (0.16, 0.38, 0.82, 1)
    # clouds
    mapn = nt.nodes.new("ShaderNodeMapping"); mapn.inputs["Scale"].default_value = (1.6, 1.6, 4.0)
    nt.links.new(tc.outputs["Generated"], mapn.inputs["Vector"])
    noise = nt.nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 4.0; noise.inputs["Roughness"].default_value = 0.55
    nt.links.new(mapn.outputs["Vector"], noise.inputs["Vector"])
    cm = nt.nodes.new("ShaderNodeValToRGB")
    cm.color_ramp.elements[0].position = 0.56; cm.color_ramp.elements[0].color = (0, 0, 0, 1)
    cm.color_ramp.elements[1].position = 0.72; cm.color_ramp.elements[1].color = (1, 1, 1, 1)
    nt.links.new(noise.outputs["Fac"], cm.inputs["Fac"])
    band = nt.nodes.new("ShaderNodeMapRange")
    band.inputs["From Min"].default_value = 0.02; band.inputs["From Max"].default_value = 0.22
    nt.links.new(sep.outputs["Z"], band.inputs["Value"])
    mulc = nt.nodes.new("ShaderNodeMath"); mulc.operation = "MULTIPLY"
    nt.links.new(cm.outputs["Color"], mulc.inputs[0]); nt.links.new(band.outputs["Result"], mulc.inputs[1])
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"
    nt.links.new(mulc.outputs["Value"], mix.inputs["Factor"])
    nt.links.new(ramp.outputs["Color"], mix.inputs["A"])
    mix.inputs["B"].default_value = (0.95, 0.95, 0.97, 1)
    nt.links.new(mix.outputs["Result"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs[0], out.inputs["Surface"])

def add_sun(az=215.0, el=38.0, energy=4.6, color=(1.0, 0.86, 0.68)):
    l = bpy.data.lights.new("sun", "SUN")
    l.energy = energy
    l.color = color
    l.angle = math.radians(1.2)
    o = bpy.data.objects.new("sun", l)
    SC.collection.objects.link(o)
    # direction the light travels: from azimuth `az` (deg, CCW from east) and elevation `el`
    src = Vector((math.cos(math.radians(el)) * math.cos(math.radians(az)), math.cos(math.radians(el)) * math.sin(math.radians(az)), math.sin(math.radians(el))))
    o.rotation_euler = (-src).to_track_quat("-Z", "Y").to_euler()
    return o

def add_camera(name, lens=24.0):
    c = bpy.data.cameras.new(name)
    c.lens = lens
    c.clip_start = 0.1
    c.clip_end = 3000
    o = bpy.data.objects.new(name, c)
    SC.collection.objects.link(o)
    return o

def look_at(o, eye, target, roll_up=Vector((0, 0, 1))):
    eye, target = Vector(eye), Vector(target)
    d = (target - eye).normalized()
    up = Vector(roll_up).normalized()
    right = d.cross(up).normalized()
    true_up = right.cross(d).normalized()
    M = Matrix((right, true_up, -d)).transposed()
    o.matrix_world = Matrix.Translation(eye) @ M.to_4x4()

def render_to(cam, path):
    SC.camera = cam
    SC.render.filepath = path
    bpy.ops.render.render(write_still=True)
    log("rendered", path)

def lineup_sheet(names, path, res=(2400, 900), gap=2.5):
    """Orthographic prefab sheet (like v0-prefabs.png) on a flat ground."""
    x = 0.0
    insts = []
    hmax = 1.0
    for n in names:
        info = PREFAB_INFO[n]
        inst = bpy.data.objects.new(n + "_sheet", PREFABS[n].data)
        SC.collection.objects.link(inst)
        inst.location = (x - info["min"][0], 0, 0)
        insts.append(inst)
        x += info["max"][0] - info["min"][0] + gap
        hmax = max(hmax, info["max"][2])
    bpy.ops.mesh.primitive_plane_add(size=1, location=(x / 2, 0, -0.005))
    pl = bpy.context.active_object
    pl.scale = (x + 400, 600, 1)
    gm = bpy.data.materials.new("sheet_ground"); gm.use_nodes = True
    bsdf(gm).inputs["Base Color"].default_value = (0.20, 0.30, 0.10, 1)
    pl.data.materials.append(gm)
    cam = add_camera("cam_sheet", 50)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = max(x, hmax * res[0] / res[1]) * 1.03
    look_at(cam, (x / 2 - gap / 2, -200, hmax * 0.45 + 200 * math.tan(math.radians(14))), (x / 2 - gap / 2, 0, hmax * 0.45))
    old = (SC.render.resolution_x, SC.render.resolution_y)
    SC.render.resolution_x, SC.render.resolution_y = res
    render_to(cam, path)
    SC.render.resolution_x, SC.render.resolution_y = old
    for i in insts:
        bpy.data.objects.remove(i)
    bpy.data.objects.remove(pl)

def lineup_render(names, path, cols=None, gap=3.0):
    """Flat-ground lineup of prefabs (for checking modules)."""
    x = 0.0
    insts = []
    for n in names:
        o = PREFABS[n]
        info = PREFAB_INFO[n]
        w = info["max"][0] - info["min"][0]
        inst = bpy.data.objects.new(n + "_lu", o.data)
        SC.collection.objects.link(inst)
        inst.location = (x - info["min"][0], 0, 0)
        insts.append(inst)
        x += w + gap
    bpy.ops.mesh.primitive_plane_add(size=1, location=(x / 2, 0, -0.01))
    pl = bpy.context.active_object
    pl.scale = (x + 200, 400, 1)
    gm = bpy.data.materials.new("lineup_ground"); gm.use_nodes = True
    bsdf(gm).inputs["Base Color"].default_value = (0.25, 0.32, 0.18, 1)
    pl.data.materials.append(gm)
    cam = add_camera("cam_lineup", 50)
    hmax = max(PREFAB_INFO[n]["max"][2] for n in names)
    dist = max(x * 0.9, hmax * 2.6)
    look_at(cam, (x / 2, -dist, hmax * 0.9 + dist * 0.22), (x / 2, 0, hmax * 0.35))
    render_to(cam, path)
    for i in insts:
        bpy.data.objects.remove(i)
    bpy.data.objects.remove(pl)
    return cam


# ============================================================================================
# LAYOUT (Portus plaza tangent frame: east = +x, north = +y, metres, geodesic coordinates;
# yaw 0 = prefab front faces south, positive yaw = counter-clockwise seen from above)
# ============================================================================================
# The game's fixed features in this frame (game frame: east = -X, north = +Z at the +Y pole; see
# packages/shared/src/content/portusTown.ts). Portals sit 17 m out on the tangent plane
# (planet/portals.ts: atan(17 / 150) * 150 = 16.928 m of arc), Juno, the Hall wall and the dummies
# are geodesic offsets (content/world.ts, content/onboarding.ts).
PORTAL_ARC = math.atan(17.0 / 150.0) * 150.0
PORTALS = {"arcadia": (round(PORTAL_ARC * math.cos(math.radians(30)), 4), round(PORTAL_ARC * 0.5, 4)),
           "hollowmere": (round(-PORTAL_ARC * math.cos(math.radians(30)), 4), round(PORTAL_ARC * 0.5, 4)),
           "meridian": (0.0, round(-PORTAL_ARC, 4))}
JUNO = (0.0, 11.0)
PLAQUE = (-20.8, -12.0)
DUMMIES = [(8.9, -7.2), (10.0, -5.0), (11.1, -2.8)]
PLAZA_R = 22.0
LAYOUT = []
STREETS = []      # dict(name, pts, width, mat)
AREAS = []        # dict(name, poly, mat)

def put(prefab, e, n, yaw=0.0, scale=1.0, tag=""):
    LAYOUT.append(dict(prefab=prefab, east=round(e, 3), north=round(n, 3), yaw=round(((yaw + 180) % 360) - 180, 2), scale=scale, tag=tag))

def face_c(e, n):
    """Yaw so the front faces the plaza centre."""
    return yaw_facing(e, n, 0, 0)

def face_out(e, n):
    return yaw_facing(e, n, 2 * e, 2 * n)

def ring(prefab, theta, r_front=24.5, dyaw=0.0, dr=0.0, tag=""):
    """Building on the plaza ring: front (ground footprint) at r_front, facing the centre."""
    front = -PREFAB_INFO[prefab]["gmin"][1]
    r = r_front + front + dr
    e, n = polar(r, theta)
    put(prefab, e, n, theta - 90 + dyaw, tag=tag)

def street(name, pts, width, mat="MI_Brick"):
    STREETS.append(dict(name=name, pts=pts, width=width, mat=mat))

# town wall: tower positions, counter-clockwise (outside = local -Y of the wall segments)
CASTLE = {"SW": (-15.0, 40.6), "SE": (15.0, 40.6), "NE": (15.0, 62.5), "NW": (-15.0, 62.5)}
GATE_E, GATE_W = (46.0, 0.0), (-46.0, 0.0)
CASTLE_GATE = (0.0, 40.6)
TOWN_RING = [  # (key, (e, n), kind)
    ("cSW", CASTLE["SW"], "castle_tower"),
    ("T10", (-31.0, 31.0), "tower"), ("T9", (-42.0, 16.0), "tower_roof"), ("GW", GATE_W, "gate"),
    ("T8", (-42.0, -16.0), "tower"), ("T7", (-30.5, -32.0), "tower_roof"), ("T6", (-12.0, -43.5), "tower"),
    ("T5", (9.5, -44.0), "tower"), ("T4", (29.0, -33.5), "tower_roof"), ("T3", (42.0, -16.5), "tower"),
    ("GE", GATE_E, "gate"), ("T2", (42.0, 16.0), "tower_roof"), ("T1", (31.0, 31.0), "tower"),
    ("cSE", CASTLE["SE"], "castle_tower"),
]
INSET = {"tower": 2.4, "tower_roof": 2.4, "castle_tower": 2.7, "gate": 7.4, "castle_gate": 3.4}

_WALL_COUNT = [0]

def wall_between(a, b, ka, kb):
    for e, n, yaw in geodesic_run(a, b, 4.0, INSET[ka], INSET[kb]):
        _WALL_COUNT[0] += 1
        put("wall_seg_ivy" if _WALL_COUNT[0] % 5 == 2 else "wall_seg", e, n, yaw, tag="wall")

def against_wall(prefab, a, b, t, offset=0.0, tag="prop"):
    """Place a prefab against the inner face of the wall run a -> b at fraction t (its -Y faces into town)."""
    runs = geodesic_run(a, b, 0.5)
    e, n, yaw = runs[min(len(runs) - 1, int(t * len(runs)))]
    # inner face is at local +Y of the wall (half thickness + pilaster)
    a_ = math.radians(yaw)
    ny = (-math.sin(a_), math.cos(a_))
    d = WALL_T / 2 + 0.02 + offset
    put(prefab, e + ny[0] * d, n + ny[1] * d, yaw + 180.0, tag=tag)

def prop(prefab, e, n, yaw=0.0, scale=1.0):
    put(prefab, e, n, yaw, scale, tag="prop")

def tree(prefab, e, n, yaw=None, scale=1.0):
    put(prefab, e, n, rng.uniform(0, 360) if yaw is None else yaw, scale, tag="tree")

def gwall(a, b):
    """Garden walls along a -> b in 4 m pieces (on the tangent plane; short runs only)."""
    L = math.dist(a, b)
    k = max(1, round(L / 4.0))
    yaw = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
    for i in range(k):
        t = (i + 0.5) / k
        put("garden_wall", a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, yaw, scale=round(L / k / 4.0, 3), tag="prop")

def fence(a, b):
    L = math.dist(a, b)
    k = max(1, round(L / 2.05))
    yaw = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
    for i in range(k):
        t = (i + 0.5) / k
        put("fence", a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, yaw, tag="prop")

def make_layout():
    LAYOUT.clear(); STREETS.clear(); AREAS.clear()
    rng.seed(11)
    # ---------------- fortifications ----------------
    pts = TOWN_RING
    for i in range(len(pts) - 1):
        (ka, a, ta), (kb, b, tb) = pts[i], pts[i + 1]
        wall_between(a, b, ta, tb)
    for key, (e, n), kind in pts:
        if kind == "tower":
            put("tower_round", e, n, face_out(e, n), tag="tower")
        elif kind == "tower_roof":
            put("tower_round_roof", e, n, face_out(e, n), tag="tower")
        elif kind == "gate":
            put("gatehouse", e, n, face_out(e, n), tag="gate")
    sw, se, ne, nw = CASTLE["SW"], CASTLE["SE"], CASTLE["NE"], CASTLE["NW"]
    wall_between(sw, CASTLE_GATE, "castle_tower", "castle_gate")
    wall_between(CASTLE_GATE, se, "castle_gate", "castle_tower")
    wall_between(se, ne, "castle_tower", "castle_tower")
    wall_between(ne, nw, "castle_tower", "castle_tower")
    wall_between(nw, sw, "castle_tower", "castle_tower")
    for k in ("SW", "SE", "NE", "NW"):
        e, n = CASTLE[k]
        put("tower_round_roof", e, n, yaw_facing(e, n, e * 2, n + (5 if n > 50 else -5)), scale=1.18, tag="castle_tower")
    put("castle_gate", CASTLE_GATE[0], CASTLE_GATE[1], 0, tag="gate")
    # stairs up to the wall-walk and lean-to sheds against the inner face
    R_ = {k: p for k, p, _ in TOWN_RING}
    against_wall("wall_stair", R_["T5"], R_["T4"], 0.55, tag="attached")
    against_wall("wall_stair", R_["T9"], R_["T10"], 0.5, tag="attached")
    against_wall("wall_stair", R_["T2"], R_["T1"], 0.45, tag="attached")
    against_wall("lean_to", R_["T6"], R_["T5"], 0.5, offset=0.45, tag="attached")
    against_wall("lean_to", R_["T3"], R_["GE"], 0.4, offset=0.45, tag="attached")
    put("keep", 0.0, 52.6, 0, tag="keep")

    # ---------------- civic ----------------
    ring("market_hall", 69.0, r_front=24.4, tag="building")
    e, n = polar(24.0 + 1.25 + 6.45, 210)
    put("hall_of_firsts", e, n, 120, tag="building")
    for name, (e, n) in PORTALS.items():
        put("portal_court_" + name, e, n, face_c(e, n), tag="portal_court")

    # ---------------- streets ----------------
    street("east", [(19.5, 0.3), (28.0, 0.5), (36.0, 0.4), (41.5, 0.1), (46.0, 0.0), (52.0, -0.8), (60.0, -3.2), (70.0, -7.0), (84.0, -13.0)], 6.0)
    street("west", [(-19.5, 0.3), (-28.0, 0.4), (-36.0, 0.2), (-41.5, 0.0), (-46.0, 0.0), (-52.0, 1.0), (-60.0, 3.5), (-70.0, 7.5), (-84.0, 13.5)], 6.0)
    street("castle", [(0.0, 19.5), (0.0, 30.0), (0.0, 41.0)], 6.0)
    street("south", [(-9.6, -20.0), (-10.4, -26.5), (-10.6, -30.6)], 4.0)
    AREAS.append(dict(name="ward", poly=[(-13.6, 41.9), (13.6, 41.9), (13.6, 61.2), (-13.6, 61.2)], mat="MI_UnevenBrick"))

    # ---------------- houses ----------------
    # north ring: castle street on the axis spawn -> Juno -> castle gate -> keep
    ring("house_a", 47.0, r_front=25.4, dyaw=-4, tag="building")
    ring("house_b", 31.0, r_front=26.4, tag="building")
    ring("house_b", 104.5, r_front=24.6, dyaw=2, tag="building")
    ring("house_d", 121.5, r_front=24.8, tag="building")
    ring("house_c", 141.0, r_front=26.0, dyaw=4, tag="building")
    put("cottage", -6.4, 34.6, -90.0, tag="building")
    # east street
    put("house_c", 26.2, 6.1, 1.5, tag="building")
    put("house_b", 33.4, 7.2, -2.0, tag="building")
    put("house_d", 26.9, -6.2, 178.5, tag="building")
    put("house_a", 34.6, -5.2, 182.0, tag="building")
    # west street
    put("house_a", -25.6, 5.9, -2.5, tag="building")
    put("house_d", -33.3, 6.8, 1.5, tag="building")
    put("house_c", -26.6, -5.1, 180.0, tag="building")
    # south-east / south
    ring("house_a", 316.0, r_front=24.8, dyaw=-3, tag="building")
    put("cottage", -9.6, -35.6, 172.0, tag="building")

    # ---------------- gardens, walls, trees ----------------
    # behind the meridian arch: a walled garden with an old oak framed by the arch
    tree("tree_oak", 0.4, -29.5, 30)
    gwall((-6.0, -26.5), (-2.4, -25.2)); gwall((2.4, -25.2), (6.0, -26.5))
    tree("bush", 5.6, -28.8); tree("bush", -5.3, -29.6)
    # south quarter: cottages, vegetable plots, woodpile, well
    put("cottage", 13.2, -33.6, face_c(13.2, -33.6) + 8, tag="building")
    prop("garden_plot", -2.8, -36.8, 4.0); prop("garden_plot", 22.6, -27.4, 52.0); prop("garden_plot", -18.6, -31.0, -32.0)
    prop("woodpile", 8.4, -37.6, 20.0); prop("well", 5.8, -33.2, 20)
    tree("tree_oak_small", -21.8, -24.6); tree("tree_pine", 27.8, -21.2)
    # north-east garden behind the market hall
    tree("tree_oak", 24.5, 27.5); tree("tree_pine", 31.5, 21.5)
    # north-west garden
    tree("tree_oak_small", -25.5, 25.5); tree("tree_pine", -31.0, 20.5)
    gwall((-11.0, 37.0), (-17.0, 33.0)); prop("woodpile", -13.6, 33.2, 56.0)
    # near the gates (inside)
    tree("tree_oak_small", 38.0, 8.5)
    tree("tree_pine", -38.5, 8.5); prop("crates", -37.5, -7.0, 10)
    # castle ward
    tree("tree_oak_small", 9.5, 56.5); prop("well", -9.5, 55.0, 0); prop("crates", 9.0, 44.5, 10); prop("barrels", -10.5, 45.0, 0)
    prop("banner_pole", -5.5, 44.5, 0); prop("banner_pole", 5.5, 44.5, 0)
    # plaza shade tree with a ring bench, planters
    tree("tree_oak", -10.6, -9.6, 200); prop("ring_bench", -10.6, -9.6, 0)
    for th in (200, 244, 296):
        e, n = polar(20.2, th)
        prop("planter", e, n, th); tree("bush", e, n, th + 40, 0.8)

    # ---------------- market around Juno ----------------
    prop("stall_a", -6.4, 14.0, -26.0); prop("stall_b", 6.4, 14.0, 26.0)
    prop("stall_c", -8.6, 19.0, -20.0); prop("stall_a", 9.0, 19.6, 24.0)
    prop("crates", -2.9, 12.6, 15.0); prop("barrels", 2.6, 12.5, 0.0)
    prop("wagon", 18.5, 33.0, -40.0)
    # ---------------- plaza furniture ----------------
    for th, r in ((62, 21.0), (118, 21.0), (228, 21.0), (248, 21.0), (292, 21.0), (312, 21.0)):
        e, n = polar(r, th)
        prop("lamp_post", e, n, th + 90)
    for th in (226, 314):
        e, n = polar(19.8, th)
        prop("bench", e, n, th - 90 + 180)
    for e, n in ((21.2, 4.7), (21.2, -3.9), (-21.2, 4.7), (-21.2, -3.9)):
        prop("banner_pole", e, n, 90 if e > 0 else -90)
    # bunting across the street mouths (between the banner poles) and along the market
    for sgn in (1, -1):
        e0 = 21.2 * sgn
        put("bunting_8", e0, 0.4, 90.0, scale=1.075, tag="deco")
    prop("banner_pole", -3.9, 22.4, 0); prop("banner_pole", 3.9, 22.4, 0)
    put("bunting_8", 0.0, 22.4, 0.0, scale=0.975, tag="deco")
    # street life: barrels / crates by the doors, lamps along the streets
    prop("barrels", -35.0, -1.7, 10); prop("barrels", -28.9, 2.4, 170); prop("lamp_post", -36.6, 2.9, 0)
    prop("barrels", 34.0, -1.5, 190); prop("lamp_post", 36.6, 3.0, 0)
    # ---------------- training yard ----------------
    fence((9.0, -0.8), (13.2, -0.8)); fence((13.6, -1.2), (13.6, -9.4)); fence((13.2, -9.8), (8.2, -9.8))
    prop("weapon_rack", 12.9, -4.4, -90); prop("target", 12.2, -8.6, -60); prop("barrels", 12.6, 0.3, 0)
    # ---------------- gates and countryside ----------------
    for (g, sgn) in ((GATE_E, 1), (GATE_W, -1)):
        prop("brazier", g[0] + sgn * 4.6, 4.2, 0); prop("brazier", g[0] + sgn * 4.6, -4.2, 0)
    prop("signpost", 58.0, 2.8, 15); prop("signpost", -58.0, 6.6, 195)
    prop("crates", 55.5, -6.0, 70); prop("barrels", -55.0, -4.0, 20)
    fence((60.0, 8.0), (72.0, 4.0)); fence((72.0, 4.0), (76.0, 14.0))
    for (e, n, k) in ((58.5, 18.5, "tree_pine_tall"), (63, 12, "tree_oak"), (53, -15, "tree_pine"),
                      (-54, 14, "tree_pine_tall"), (-53, -14, "tree_oak"), (-61, -10, "tree_pine"),
                      (8, -58, "tree_pine_tall"), (34, 51, "tree_pine"), (-33, 53, "tree_pine")):
        tree(k, e, n)

    put("paving", 0.0, 0.0, 0.0, tag="paving")

def layout_fixtures():
    """Render-only stand-ins for the game's fixed features (not part of layout.json)."""
    out = []
    for name, (e, n) in PORTALS.items():
        out.append(("fx_portal_" + name, e, n, face_c(e, n)))
    out.append(("fx_juno", JUNO[0], JUNO[1], 0.0))
    out.append(("fx_plaque", PLAQUE[0], PLAQUE[1], 120.0))
    for (e, n) in DUMMIES:
        out.append(("fx_dummy", e, n, 90.0))
    return out

# ============================================================================================
# PAVING: one terrain-decal prefab placed once at (0, 0), vertices already on the planet surface
# ============================================================================================
def sp(e, n, h):
    return tuple(surf_point(e, n, h))

def disc_bands(mb, cx, cy, bands, h, nseg, rot=0.0):
    """Concentric paving bands around (cx, cy): bands = [(r0, r1, mat, kind)], kind 'field' or 'ring'."""
    for (r0, r1, mat, kind) in bands:
        steps = max(1, int(math.ceil((r1 - r0) / 2.2)))
        for k in range(steps):
            ra = r0 + (r1 - r0) * k / steps
            rb = r0 + (r1 - r0) * (k + 1) / steps
            for i in range(nseg):
                a0 = rot + 2 * math.pi * i / nseg
                a1 = rot + 2 * math.pi * (i + 1) / nseg
                q = [(cx + ra * math.cos(a0), cy + ra * math.sin(a0)), (cx + ra * math.cos(a1), cy + ra * math.sin(a1)),
                     (cx + rb * math.cos(a1), cy + rb * math.sin(a1)), (cx + rb * math.cos(a0), cy + rb * math.sin(a0))]
                if kind == "ring":
                    v0, v1 = BAND["slab"] if mat == "MI_RockTrim" else (0.0, (r1 - r0) / 2.0)
                    arc0, arc1 = a0 * (ra + rb) / 2, a1 * (ra + rb) / 2
                    fa = (ra - r0) / (r1 - r0); fb = (rb - r0) / (r1 - r0)
                    tu = 4.0 if mat == "MI_RockTrim" else 2.0
                    uv = [(arc0 / tu, v0 + fa * (v1 - v0)), (arc1 / tu, v0 + fa * (v1 - v0)), (arc1 / tu, v0 + fb * (v1 - v0)), (arc0 / tu, v0 + fb * (v1 - v0))]
                else:
                    uv = [(x / 2.0, y / 2.0) for x, y in q]
                if ra < 1e-6:
                    mb.face([sp(*q[0], h), sp(*q[2], h), sp(*q[3], h)], mat, [uv[0], uv[2], uv[3]])
                else:
                    mb.face([sp(*c, h) for c in q], mat, uv)

def strip(mb, pts, width, h, mat, curb=True, skip_fn=None):
    """Street strip along a polyline (sampled every <= 2 m), with raised slab curbs."""
    samp = []
    for a, b in zip(pts, pts[1:]):
        L = math.dist(a, b)
        k = max(1, int(math.ceil(L / 2.0)))
        for i in range(k):
            t = i / k
            samp.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    samp.append(pts[-1])
    norms = []
    for i, p in enumerate(samp):
        a = samp[max(0, i - 1)]; b = samp[min(len(samp) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1
        norms.append((-dy / L, dx / L))
    hw = width / 2
    for i in range(len(samp) - 1):
        p0, p1 = samp[i], samp[i + 1]
        n0, n1 = norms[i], norms[i + 1]
        L0 = (p0[0] - n0[0] * hw, p0[1] - n0[1] * hw); R0 = (p0[0] + n0[0] * hw, p0[1] + n0[1] * hw)
        L1 = (p1[0] - n1[0] * hw, p1[1] - n1[1] * hw); R1 = (p1[0] + n1[0] * hw, p1[1] + n1[1] * hw)
        q = [L0, L1, R1, R0]
        q = q if (L1[0] - L0[0]) * (R0[1] - L0[1]) - (L1[1] - L0[1]) * (R0[0] - L0[0]) < 0 else list(reversed(q))
        mb.face([sp(*c, h) for c in q], mat, [(x / 2.0, y / 2.0) for x, y in q])
        if curb:
            for side in (-1, 1):
                mid = ((p0[0] + p1[0]) / 2 + side * n0[0] * hw, (p0[1] + p1[1]) / 2 + side * n0[1] * hw)
                if skip_fn and skip_fn(mid):
                    continue
                o0 = (p0[0] + side * n0[0] * hw, p0[1] + side * n0[1] * hw); o1 = (p1[0] + side * n1[0] * hw, p1[1] + side * n1[1] * hw)
                i0 = (p0[0] + side * n0[0] * (hw - 0.35), p0[1] + side * n0[1] * (hw - 0.35)); i1 = (p1[0] + side * n1[0] * (hw - 0.35), p1[1] + side * n1[1] * (hw - 0.35))
                seg = math.dist(p0, p1)
                u0 = i * 2.0 / 4.0
                top = [i0, i1, o1, o0] if side > 0 else [o0, o1, i1, i0]
                vv = BAND["slab"]
                mb.face([sp(*c, h + 0.08) for c in top], "MI_RockTrim", [(u0, vv[0]), (u0 + seg / 4, vv[0]), (u0 + seg / 4, vv[1]), (u0, vv[1])] if side > 0 else [(u0, vv[1]), (u0 + seg / 4, vv[1]), (u0 + seg / 4, vv[0]), (u0, vv[0])])
                for (c0, c1) in ((i0, i1),):
                    f = [sp(*c0, h - 0.05), sp(*c1, h - 0.05), sp(*c1, h + 0.08), sp(*c0, h + 0.08)]
                    nrm = Vector(normal_of(f))
                    centre = Vector(sp((c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, 0))
                    mid3 = Vector(sp(*mid, 0))
                    if nrm.dot(centre - mid3) < 0:
                        f = list(reversed(f))
                    mb.face(f, "MI_RockTrim", [(u0, 0.43), (u0 + seg / 4, 0.43), (u0 + seg / 4, 0.47), (u0, 0.47)])

def area_fill(mb, poly, h, mat, step=2.0):
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    nx, ny = max(1, int(math.ceil((x1 - x0) / step))), max(1, int(math.ceil((y1 - y0) / step)))
    for i in range(nx):
        for j in range(ny):
            a, b = x0 + (x1 - x0) * i / nx, x0 + (x1 - x0) * (i + 1) / nx
            c, d = y0 + (y1 - y0) * j / ny, y0 + (y1 - y0) * (j + 1) / ny
            if point_in_poly(((a + b) / 2, (c + d) / 2), poly):
                q = [(a, c), (b, c), (b, d), (a, d)]
                mb.face([sp(*p, h) for p in q], mat, [(x / 2.0, y / 2.0) for x, y in q])

def build_paving():
    p = Prefab("paving", lod="terrain decal: placed once at (0, 0); vertices lie on the planet surface")
    mb = p.mb
    # plaza: medallion, rings and fields
    disc_bands(mb, 0, 0, [(0.0, 2.2, "MI_Brick", "field"), (2.2, 2.7, "MI_RockTrim", "ring"), (2.7, 8.6, "MI_UnevenBrick", "field"),
                          (8.6, 9.3, "MI_RockTrim", "ring"), (9.3, 21.4, "MI_UnevenBrick", "field"), (21.4, 22.3, "MI_Brick", "ring"),
                          (22.3, 23.0, "MI_RockTrim", "ring")], 0.06, 80)
    # compass star inlay at the spawn point: eight slab rays pointing at the gates, portals and the keep
    for k in range(8):
        a = math.radians(90 + 45 * k)
        L = 2.15 if k % 2 == 0 else 1.45
        tip = (L * math.cos(a), L * math.sin(a))
        lft = (0.42 * math.cos(a + 0.6), 0.42 * math.sin(a + 0.6))
        rgt = (0.42 * math.cos(a - 0.6), 0.42 * math.sin(a - 0.6))
        vv = BAND["slab"]
        mb.face([sp(0, 0, 0.068), sp(*rgt, 0.068), sp(*tip, 0.068)], "MI_RockTrim", [(0, vv[0]), (0.1, vv[0]), (0.05, vv[1])])
        mb.face([sp(0, 0, 0.068), sp(*tip, 0.068), sp(*lft, 0.068)], "MI_RockTrim", [(0, vv[0]), (0.05, vv[1]), (0.1, vv[0])])
    # dressed-stone paths from the spawn ring toward the gates, the castle and the portals
    for th in (0, 90, 180, 30, 150, 270):
        a = math.radians(th)
        r1 = 21.4 if th % 90 == 0 else 11.5
        strip(mb, [(2.6 * math.cos(a), 2.6 * math.sin(a)), (r1 * math.cos(a), r1 * math.sin(a))], 2.2, 0.066, "MI_Brick", curb=False)
    # portal court floors
    for name, (e, n) in PORTALS.items():
        disc_bands(mb, e, n, [(0.0, 5.4, "MI_Brick", "field"), (5.4, 6.0, "MI_RockTrim", "ring")], 0.075, 48)
    # streets
    def skip(m):
        if math.hypot(*m) < 23.2:
            return True
        for g in (GATE_E, GATE_W, CASTLE_GATE):
            if math.dist(m, g) < 4.2:
                return True
        return False
    for st in STREETS:
        strip(mb, st["pts"], st["width"], 0.045, st["mat"], curb=True, skip_fn=skip)
    for a in AREAS:
        area_fill(mb, a["poly"], 0.05, a["mat"])
    return p.finish()

# ============================================================================================
# VALIDATION (tangent-plane approximation is fine at these distances)
# ============================================================================================
FOOT_POLY = {}   # prefab -> local convex polygon overriding the box footprint

def set_foot_polys():
    arc = [(6.7 * math.cos(math.radians(a)), 6.7 * math.sin(math.radians(a))) for a in range(-12, 193, 15)]
    for k in PORTAL_COLORS:
        FOOT_POLY["portal_court_" + k] = arc
    for name, r in (("tower_round", 3.95), ("tower_round_roof", 3.95)):
        FOOT_POLY[name] = [(r * math.cos(2 * math.pi * i / 12), r * math.sin(2 * math.pi * i / 12)) for i in range(12)]

def fp_poly(item, kind="g"):
    info = PREFAB_INFO[item["prefab"]]
    mn, mx = info[kind + "min"], info[kind + "max"]
    s = item.get("scale", 1.0)
    a = math.radians(item["yaw"])
    c, si = math.cos(a), math.sin(a)
    out = []
    local = FOOT_POLY.get(item["prefab"]) or info.get(kind + "hull") or ((mn[0], mn[1]), (mx[0], mn[1]), (mx[0], mx[1]), (mn[0], mx[1]))
    for x, y in local:
        x, y = x * s, y * s
        out.append((item["east"] + x * c - y * si, item["north"] + x * si + y * c))
    return out

def _proj(poly, ax):
    d = [p[0] * ax[0] + p[1] * ax[1] for p in poly]
    return min(d), max(d)

def poly_overlap(a, b, margin=0.0):
    for poly in (a, b):
        for i in range(len(poly)):
            p, q = poly[i], poly[(i + 1) % len(poly)]
            ax = (-(q[1] - p[1]), q[0] - p[0])
            L = math.hypot(*ax) or 1.0
            ax = (ax[0] / L, ax[1] / L)
            a0, a1 = _proj(a, ax); b0, b1 = _proj(b, ax)
            if a1 + margin <= b0 or b1 + margin <= a0:
                return False
    return True

def seg_dist(p, a, b):
    ax, ay = b[0] - a[0], b[1] - a[1]
    L2 = ax * ax + ay * ay or 1e-9
    t = max(0, min(1, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / L2))
    return math.hypot(p[0] - a[0] - t * ax, p[1] - a[1] - t * ay)

def point_in_poly(p, poly):
    inside = False
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]):
            inside = not inside
    return inside

def poly_seg_dist(poly, a, b):
    if point_in_poly(a, poly) or point_in_poly(b, poly):
        return 0.0
    d = min(seg_dist(p, a, b) for p in poly)
    for i in range(len(poly)):
        d = min(d, seg_dist(a, poly[i], poly[(i + 1) % len(poly)]), seg_dist(b, poly[i], poly[(i + 1) % len(poly)]))
        # segment crossing
        p, q = poly[i], poly[(i + 1) % len(poly)]
        def ccw(A, B, C):
            return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0])
        if ccw(a, p, q) != ccw(b, p, q) and ccw(a, b, p) != ccw(a, b, q):
            return 0.0
    return d

SOLID = {"building", "keep", "gate", "tower", "castle_tower", "wall", "portal_court"}
FORT = {"gate", "tower", "castle_tower", "wall"}

def validate():
    set_foot_polys()
    problems = []
    items = LAYOUT
    solids = [it for it in items if it["tag"] in SOLID]
    # 1. overlaps between solid things (roofs included), fortification joints excepted
    for i in range(len(solids)):
        for j in range(i + 1, len(solids)):
            a, b = solids[i], solids[j]
            if a["tag"] in FORT and b["tag"] in FORT:
                continue
            if a["tag"] == "keep" and b["tag"] in FORT or b["tag"] == "keep" and a["tag"] in FORT:
                pass
            if poly_overlap(fp_poly(a, "f"), fp_poly(b, "f"), margin=0.05):
                problems.append(f"overlap: {a['prefab']}@({a['east']:.1f},{a['north']:.1f}) x {b['prefab']}@({b['east']:.1f},{b['north']:.1f})")
    # 2. plaza must stay clear of buildings (ground footprint)
    for it in items:
        if it["tag"] in SOLID and it["tag"] != "portal_court":
            poly = fp_poly(it, "g")
            if min(math.hypot(*p) for p in poly) < PLAZA_R or point_in_poly((0, 0), poly):
                d = min(math.hypot(*p) for p in poly)
                problems.append(f"in plaza: {it['prefab']}@({it['east']:.1f},{it['north']:.1f}) d={d:.2f}")
    # 3. portals: 4 m clear around, 5 m wide approach from the centre
    for name, pp in PORTALS.items():
        for it in items:
            if it["prefab"] in ("paving", "portal_court_" + name):
                continue
            poly = fp_poly(it, "g")
            d = min(min(math.hypot(p[0] - pp[0], p[1] - pp[1]) for p in poly), 1e9 if not point_in_poly(pp, poly) else 0)
            if d < 4.0 + 2.2 * 0:
                problems.append(f"portal {name} not clear: {it['prefab']} d={d:.2f}")
            if poly_seg_dist(poly, (0, 0), pp) < 2.5:
                problems.append(f"portal {name} approach blocked by {it['prefab']}@({it['east']:.1f},{it['north']:.1f})")
    # 4. streets >= their width, free of solid ground footprints (gates/walls are passages)
    for st in STREETS:
        pts = st["pts"]
        for it in items:
            if it["tag"] not in SOLID or it["tag"] in ("gate", "wall"):
                continue
            poly = fp_poly(it, "g")
            for a, b in zip(pts, pts[1:]):
                if math.hypot(*a) < 22.5 and math.hypot(*b) < 22.5:
                    continue
                if math.hypot(*a) < 22.5:     # clip the part inside the open plaza
                    t = 0.0
                    while t < 1 and math.hypot(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) < 22.5:
                        t += 0.02
                    a = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                if poly_seg_dist(poly, a, b) < st["width"] / 2 - 0.05:
                    problems.append(f"street {st['name']} blocked by {it['prefab']}@({it['east']:.1f},{it['north']:.1f})")
                    break
    # 4b. props and tree trunks must not stand inside buildings
    for it in items:
        if it["tag"] not in ("prop", "tree", "stall"):
            continue
        pg = fp_poly(it, "g")
        for b in solids:
            if b["tag"] == "wall" and it["tag"] == "tree":
                pass
            if poly_overlap(pg, fp_poly(b, "g"), margin=0.05):
                problems.append(f"prop {it['prefab']}@({it['east']:.1f},{it['north']:.1f}) inside {b['prefab']}@({b['east']:.1f},{b['north']:.1f})")
    # 5. fixed features
    for (fx, r) in ((JUNO, 2.2), (PLAQUE, 2.5)) + tuple((d, 1.0) for d in DUMMIES):
        for it in items:
            if it["prefab"] == "paving":
                continue
            poly = fp_poly(it, "g")
            if point_in_poly(fx, poly) or min(math.hypot(p[0] - fx[0], p[1] - fx[1]) for p in poly) < r and it["tag"] not in ("prop",):
                problems.append(f"fixed feature {fx} crowded by {it['prefab']}")
    for p_ in problems:
        log("CHECK", p_)
    log(f"validation: {len(problems)} problem(s)")
    return problems

def budget_report():
    from collections import Counter
    cnt = Counter(it["prefab"] for it in LAYOUT)
    rows = sorted(((PREFAB_INFO[k]["tris"] * c, k, c) for k, c in cnt.items()), reverse=True)
    total = sum(r[0] for r in rows)
    mats = sorted({m for k in cnt for m in PREFAB_INFO[k]["mats"]})
    lines = [f"TOTAL {total} tris in {sum(cnt.values())} instances of {len(cnt)} prefabs; {len(mats)} materials"]
    for t, k, c in rows:
        lines.append(f"  {k:26s} {PREFAB_INFO[k]['tris']:7d} x {c:3d} = {t:7d}")
    lines.append("materials: " + ", ".join(mats))
    return total, rows, mats, lines

def write_plan(path):
    data = dict(items=[dict(it, g=fp_poly(it, "g"), f=fp_poly(it, "f")) for it in LAYOUT],
                streets=STREETS, areas=AREAS, portals=PORTALS, juno=JUNO, plaque=PLAQUE, dummies=DUMMIES,
                fixtures=[dict(name=f[0], east=f[1], north=f[2], yaw=f[3]) for f in layout_fixtures()])
    with open(path, "w") as f:
        json.dump(data, f)

# ============================================================================================
# WORLD SCENE (render only): curved ground, instances, stand-ins for the game's fixed features
# ============================================================================================
def build_ground():
    """Spherical grass cap (render only; the game has its own planet mesh)."""
    rings = [0.0]
    r = 0.0
    while r < 235.6:
        r += 1.5 if r < 90 else 4.0
        rings.append(min(r, 235.6))
    nseg = 180
    verts, faces = [], []
    for k, rr in enumerate(rings):
        if k == 0:
            verts.append(tuple(surf_point(0, 0, 0)))
            continue
        for i in range(nseg):
            a = 2 * math.pi * i / nseg
            verts.append(tuple(surf_point(rr * math.cos(a), rr * math.sin(a), 0)))
    for i in range(nseg):
        faces.append((0, 1 + i, 1 + (i + 1) % nseg))
    for k in range(1, len(rings) - 1):
        b0 = 1 + (k - 1) * nseg
        b1 = 1 + k * nseg
        for i in range(nseg):
            j = (i + 1) % nseg
            faces.append((b0 + i, b1 + i, b1 + j, b0 + j))
    me = bpy.data.meshes.new("ground")
    me.from_pydata(verts, [], faces)
    for p in me.polygons:
        p.use_smooth = True
    o = bpy.data.objects.new("ground", me)
    SC.collection.objects.link(o)
    m = bpy.data.materials.new("render_grass")
    m.use_nodes = True
    nt = m.node_tree
    b = bsdf(m)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n1 = nt.nodes.new("ShaderNodeTexNoise"); n1.inputs["Scale"].default_value = 0.035; n1.inputs["Detail"].default_value = 3.0
    n2 = nt.nodes.new("ShaderNodeTexNoise"); n2.inputs["Scale"].default_value = 1.4; n2.inputs["Detail"].default_value = 6.0
    nt.links.new(tc.outputs["Object"], n1.inputs["Vector"]); nt.links.new(tc.outputs["Object"], n2.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.elements[0].position = 0.30; cr.elements[0].color = (0.085, 0.20, 0.03, 1)
    cr.elements[1].position = 0.72; cr.elements[1].color = (0.30, 0.44, 0.08, 1)
    nt.links.new(n1.outputs["Fac"], ramp.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 0.55
    nt.links.new(ramp.outputs["Color"], mix.inputs["A"])
    r2 = nt.nodes.new("ShaderNodeValToRGB")
    r2.color_ramp.elements[0].position = 0.35; r2.color_ramp.elements[0].color = (0.62, 0.66, 0.55, 1)
    r2.color_ramp.elements[1].position = 0.65; r2.color_ramp.elements[1].color = (1.0, 1.0, 0.92, 1)
    nt.links.new(n2.outputs["Fac"], r2.inputs["Fac"])
    nt.links.new(r2.outputs["Color"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.95
    try:
        b.inputs["Specular IOR Level"].default_value = 0.2
    except Exception:
        pass
    me.materials.append(m)
    return o

def fixture_meshes():
    """Stand-ins for the game's own objects (portal rings, Juno's stall, plaque wall, dummies)."""
    out = {}
    for name, (c1, c2) in PORTAL_COLORS.items():
        mb = MB()
        n = 28
        for i in range(n):
            a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
            for (ri, ro, mat, y0, y1) in ((1.95, 2.45, "MI_RockTrim", -0.2, 0.2),):
                P = lambda a, r, y: (math.cos(a) * r, y, 2.45 + math.sin(a) * r)
                for (pa, pb) in (((ro, y0), (ro, y1)), ((ri, y1), (ri, y0))):
                    quad(mb, [P(a0, pa[0], pa[1]), P(a1, pa[0], pa[1]), P(a1, pb[0], pb[1]), P(a0, pb[0], pb[1])], mat, mode="band", band="slab")
                quad(mb, [P(a0, ri, y0), P(a1, ri, y0), P(a1, ro, y0), P(a0, ro, y0)], mat, mode="band", band="ashlar")
                quad(mb, [P(a1, ri, y1), P(a0, ri, y1), P(a0, ro, y1), P(a1, ro, y1)], mat, mode="band", band="ashlar")
            Pg = lambda a, r: (math.cos(a) * r, 0, 2.45 + math.sin(a) * r)
            mb.face([Pg(a0, 1.95), Pg(a1, 1.95), (0, 0, 2.45)], "fx_portal_" + name, [(0, 0)] * 3)
            mb.face([(0, 0, 2.45), Pg(a1, 1.95), Pg(a0, 1.95)], "fx_portal_" + name, [(0, 0)] * 3)
        box(mb, -1.0, -0.6, -0.3, 1.0, 0.6, 0.25, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
        m = bpy.data.materials.new("fx_portal_" + name); m.use_nodes = True
        b = bsdf(m)
        col = PALETTE[c1]
        b.inputs["Base Color"].default_value = (*col, 1)
        b.inputs["Emission Color"].default_value = (*col, 1)
        b.inputs["Emission Strength"].default_value = 2.2
        b.inputs["Alpha"].default_value = 0.62
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
        MATS["fx_portal_" + name] = m
        out["fx_portal_" + name] = mb.mesh("fx_portal_" + name)
    # Juno's stall: a richer stall in purple and gold
    mb = MB()
    W, D = 3.2, 2.0
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(mb, sx * W / 2 - 0.08, sy * D / 2 - 0.08, -0.3, sx * W / 2 + 0.08, sy * D / 2 + 0.08, 2.6 if sy < 0 else 3.0, "MI_WoodTrim", mode="band", band="plank")
    box(mb, -W / 2, -D / 2, 0, W / 2, -D / 2 + 0.9, 1.0, "MI_WoodTrim", mode="band", band="dark", top=("MI_WoodTrim", "band", "plank"))
    goods(mb, T(-0.3, -D / 2 + 0.45, 1.0), ("purple", "gold", "teal", "red"))
    for i in range(10):
        a = -W / 2 - 0.2 + (W + 0.4) * i / 10; b2 = -W / 2 - 0.2 + (W + 0.4) * (i + 1) / 10
        c = ("purple", "gold")[i % 2]
        pts = [(a, -D / 2 - 0.5, 2.45), (b2, -D / 2 - 0.5, 2.45), (b2, D / 2 + 0.2, 3.15), (a, D / 2 + 0.2, 3.15)]
        mb.face(pts, "M_Cloth", [pal_uv(c)] * 4); mb.face(list(reversed(pts)), "M_Cloth", [pal_uv(c)] * 4)
        v = [(a, -D / 2 - 0.5, 2.15), (b2, -D / 2 - 0.5, 2.15), (b2, -D / 2 - 0.5, 2.45), (a, -D / 2 - 0.5, 2.45)]
        mb.face(v, "M_Cloth", [pal_uv(c)] * 4); mb.face(list(reversed(v)), "M_Cloth", [pal_uv(c)] * 4)
    oriented_box(mb, T(0, -D / 2 - 0.55, 2.75), 1.4, 0.06, 0.45, "MI_WoodTrim", mode="band", band="plank")
    out["fx_juno"] = mb.mesh("fx_juno")
    # plaque wall
    mb = MB()
    box(mb, -2.2, -0.35, -0.3, 2.2, 0.35, 2.4, "MI_Brick", top=("MI_RockTrim", "band", "slab"))
    box(mb, -2.4, -0.45, -0.3, 2.4, 0.45, 0.35, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    for i in range(3):
        oriented_box(mb, T(-1.3 + i * 1.3, -0.4, 0.8), 1.0, 0.06, 1.2, "MI_MetalOrnaments")
    out["fx_plaque"] = mb.mesh("fx_plaque")
    # training dummy
    mb = MB()
    box(mb, -0.07, -0.07, -0.3, 0.07, 0.07, 1.9, "MI_WoodTrim", mode="band", band="dark")
    oriented_box(mb, T(0, 0, 1.35), 1.2, 0.08, 0.08, "MI_WoodTrim", mode="band", band="dark")
    tmp = MB(); frustum(tmp, 0.26, 0.3, 0.9, 1.6, 8, "M_Cloth", mode="pal", band="linen", cap=True); mb.extend(tmp)
    tmp = MB(); frustum(tmp, 0.17, 0.17, 1.62, 1.95, 8, "M_Cloth", mode="pal", band="linen", cap=True); mb.extend(tmp)
    out["fx_dummy"] = mb.mesh("fx_dummy")
    return out

def instance_village():
    coll = bpy.data.collections.new("village")
    SC.collection.children.link(coll)
    for i, it in enumerate(LAYOUT):
        o = bpy.data.objects.new(f"{it['prefab']}.{i:03d}", PREFABS[it["prefab"]].data)
        o.matrix_world = surf_matrix(it["east"], it["north"], it["yaw"], it.get("scale", 1.0))
        coll.objects.link(o)
    fx = fixture_meshes()
    for name, e, n, yaw in layout_fixtures():
        o = bpy.data.objects.new(name, fx[name])
        o.matrix_world = surf_matrix(e, n, yaw)
        coll.objects.link(o)
    log(f"instanced {len(LAYOUT)} prefabs")

def eye_camera(name, e, n, h, target=None, yaw_dir=None, pitch=0.0, lens=22.0):
    """Camera at eye height on the planet. Either look at a world target (e, n, h) or along a local heading."""
    cam = add_camera(name, lens)
    eye = surf_point(e, n, h)
    up = surf_up(e, n)
    if target is not None:
        tgt = surf_point(*target)
    else:
        q = surf_quat(e, n, 0)
        d = q @ Vector((math.cos(math.radians(yaw_dir)), math.sin(math.radians(yaw_dir)), 0))
        d = (d + up * math.tan(math.radians(pitch))).normalized()
        tgt = eye + d * 10
    look_at(cam, eye, tgt, roll_up=up)
    return cam

CAMS = {
    # name: callable -> camera
    "plaza_eye": lambda: eye_camera("plaza_eye", 0.0, -6.0, 1.7, yaw_dir=90, pitch=4.0, lens=20.0),
    "gate_eye": lambda: eye_camera("gate_eye", 71.0, -6.5, 1.7, target=(46.0, 0.0, 6.0), lens=24.0),
    "street_eye": lambda: eye_camera("street_eye", -19.0, 0.9, 1.7, target=(-46.0, 0.2, 4.2), lens=22.0),
    "street_east": lambda: eye_camera("street_east", 23.8, -1.0, 1.7, target=(46.0, 0.6, 4.0), lens=22.0),
    "castle_eye": lambda: eye_camera("castle_eye", 1.0, 21.0, 1.7, target=(0.0, 46.0, 10.0), lens=20.0),
    "market_eye": lambda: eye_camera("market_eye", 8.0, 3.0, 1.7, target=(-2.0, 22.0, 4.0), lens=22.0),
    "hall_eye": lambda: eye_camera("hall_eye", -8.0, -3.0, 1.7, target=(-22.0, -13.0, 4.0), lens=22.0),
    "insp_stair": lambda: eye_camera("insp_stair", 17.0, -30.0, 1.7, target=(20.0, -38.5, 3.0), lens=24.0),
    "insp_leanto": lambda: eye_camera("insp_leanto", -1.0, -33.0, 1.7, target=(-1.0, -42.0, 1.5), lens=24.0),
    "insp_yard": lambda: eye_camera("insp_yard", 4.0, -1.0, 1.7, target=(11.0, -5.0, 1.0), lens=24.0),
    "insp_wall": lambda: eye_camera("insp_wall", 22.0, -30.0, 1.7, target=(36.0, -26.0, 4.0), lens=24.0),
    "insp_wall_out": lambda: eye_camera("insp_wall_out", 34.0, -48.0, 1.7, target=(20.0, -40.0, 4.0), lens=24.0),
    "insp_gate_in": lambda: eye_camera("insp_gate_in", 36.0, 3.0, 1.7, target=(46.0, 0.0, 5.0), lens=24.0),
    "insp_ward": lambda: eye_camera("insp_ward", -11.0, 44.0, 1.7, target=(0.0, 52.0, 6.0), lens=22.0),
    "insp_south": lambda: eye_camera("insp_south", -14.0, -20.0, 1.7, target=(5.0, -34.0, 2.0), lens=22.0),
}

def aerial_camera(name="aerial", eye=(-31.0, -97.0, 70.0), target=(1.0, 6.0, -6.0), lens=29.0):
    cam = add_camera(name, lens)
    look_at(cam, Vector(eye), Vector(target))
    return cam

def do_renders():
    setup_render((1600, 900))
    setup_world()
    add_sun(az=float(opt("--sun-az", -12.0)), el=float(opt("--sun-el", 24.0)))
    if "prefab_sheet" in RENDERS:
        lineup_sheet(["cottage", "house_a", "house_c", "house_b", "house_d", "market_hall", "hall_of_firsts", "portal_court_arcadia",
                      "tower_round", "tower_round_roof", "gatehouse", "castle_gate", "keep"], os.path.join(OUT, "prefabs_buildings.png"))
        lineup_sheet(["stall_a", "stall_b", "stall_c", "crates", "barrels", "wagon", "well", "lamp_post", "bench", "banner_pole", "bunting_8",
                      "garden_wall", "garden_plot", "woodpile", "planter", "ring_bench", "fence", "weapon_rack", "target", "signpost",
                      "brazier"], os.path.join(OUT, "prefabs_props.png"), res=(2400, 700), gap=0.8)
        lineup_sheet(["lean_to", "wall_stair", "wall_seg", "wall_seg_ivy", "bush", "tree_oak_small", "tree_oak", "tree_pine",
                      "tree_pine_tall"], os.path.join(OUT, "prefabs_walls_nature.png"), res=(2400, 700), gap=1.5)
    if "lineup" in RENDERS:
        sd = os.path.join(OUT, "scratch")
        lineup_render(["house_a", "house_b", "house_c", "house_d", "cottage"], os.path.join(sd, "lineup_houses.png"))
        lineup_render(["gatehouse", "tower_round", "tower_round_roof", "castle_gate"], os.path.join(sd, "lineup_fort.png"))
        lineup_render(["keep", "portal_court_arcadia", "market_hall", "hall_of_firsts"], os.path.join(sd, "lineup_civic.png"))
        lineup_render(["stall_a", "stall_b", "crates", "barrels", "wagon", "well", "lamp_post", "bench", "banner_pole", "garden_wall", "weapon_rack", "target", "signpost", "brazier"], os.path.join(sd, "lineup_props.png"), gap=1.0)
        lineup_render(["tree_oak", "tree_oak_small", "tree_pine", "tree_pine_tall", "bush"], os.path.join(sd, "lineup_nature.png"), gap=1.5)
    build_ground()
    instance_village()
    for r in RENDERS:
        if r == "aerial":
            cam = aerial_camera()
        elif r == "plan_aerial":
            cam = add_camera("plan", 50); cam.data.type = "ORTHO"; cam.data.ortho_scale = 150
            look_at(cam, Vector((0, 8, 300)), Vector((0, 8, 0)), roll_up=Vector((0, 1, 0)))
        elif r in CAMS:
            cam = CAMS[r]()
        else:
            continue
        render_to(cam, os.path.join(OUT, (opt("--prefix", "") or "") + r + ".png"))

# ============================================================================================
# EXPORT: prefabs/*.glb (Y-up, one mesh, one primitive per material, pivot at ground centre).
# Textures are written once to prefabs/textures/ and referenced by relative URI from every GLB,
# so all prefabs share the kit's texture files (and material names) instead of embedding copies.
# ============================================================================================
def pack_glb(gltf_path, glb_path):
    import struct, shutil
    with open(gltf_path) as f:
        doc = json.load(f)
    folder = os.path.dirname(gltf_path)
    binary = b""
    if doc.get("buffers"):
        with open(os.path.join(folder, doc["buffers"][0]["uri"]), "rb") as f:
            binary = f.read()
        doc["buffers"][0].pop("uri", None)
        doc["buffers"][0]["byteLength"] = len(binary)
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    with open(glb_path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        if binary:
            f.write(struct.pack("<II", len(binary), 0x004E4942)); f.write(binary)

def export_prefabs():
    import shutil
    pdir = os.path.join(OUT, "prefabs")
    tmp = os.path.join(OUT, "scratch", "gltf_tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    os.makedirs(os.path.join(pdir, "textures"), exist_ok=True)
    for f in os.listdir(pdir):
        if f.endswith(".glb"):
            os.remove(os.path.join(pdir, f))
    used = set()
    placed = {it["prefab"] for it in LAYOUT}
    for name, obj in PREFABS.items():
        # A placed prefab, or an explicit LOD1 ("<name>__L1") of one.
        if name not in placed and not (name.endswith("__L1") and name[:-4] in placed):
            continue
        obj.hide_set(False)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        gl = os.path.join(tmp, name + ".gltf")
        bpy.ops.export_scene.gltf(filepath=gl, export_format="GLTF_SEPARATE", export_texture_dir="textures",
                                  use_selection=True, export_yup=True, export_apply=False, export_animations=False,
                                  export_cameras=False, export_lights=False, export_extras=False, export_keep_originals=False)
        obj.hide_set(True)
        pack_glb(gl, os.path.join(pdir, name + ".glb"))
        with open(gl) as f:
            for im in json.load(f).get("images", []):
                used.add(im["uri"])
    for u in used:
        src = os.path.join(tmp, u)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(pdir, u))
    log(f"exported {len([f for f in os.listdir(pdir) if f.endswith('.glb')])} GLBs, {len(used)} shared textures")

def write_layout_json():
    out = [dict(prefab=it["prefab"], east=it["east"], north=it["north"], yaw=it["yaw"], scale=it.get("scale", 1.0)) for it in LAYOUT]
    with open(os.path.join(OUT, "layout.json"), "w") as f:
        json.dump(out, f, indent=1)

def write_town_extra():
    """Ground features and fixed points the game needs besides layout.json: streets and paved areas
    (grass/prop masks), the fixed features the layout was validated against, and every prefab's
    footprint/bounds (Blender prefab space: x right, y back, z up; front faces -y) for colliders."""
    info = {k: {kk: vv for kk, vv in v.items()} for k, v in PREFAB_INFO.items() if k in {it["prefab"] for it in LAYOUT}}
    out = dict(
        streets=[dict(name=s_["name"], pts=[list(p) for p in s_["pts"]], width=s_["width"]) for s_ in STREETS],
        areas=[dict(name=a["name"], poly=[list(p) for p in a["poly"]]) for a in AREAS],
        plaza=dict(paved=23.0, clear=PLAZA_R),
        portal_floor=6.0,
        portals={k: list(v) for k, v in PORTALS.items()},
        juno=list(JUNO), plaque=list(PLAQUE), dummies=[list(d) for d in DUMMIES],
        prefabs=info,
    )
    with open(os.path.join(OUT, "town_extra.json"), "w") as f:
        json.dump(out, f, indent=1)

def write_budget():
    total, rows, mats, _ = budget_report()
    L = ["Portus village: triangle and material budget (full detail, as rendered)", "",
         f"TOTAL TRIANGLES: {total}   (budget 200000)",
         f"INSTANCES: {sum(r[2] for r in rows)} of {len(rows)} prefabs",
         f"MATERIALS: {len(mats)}   (budget ~16)", "  " + ", ".join(mats), "",
         f"{'prefab':26s} {'tris':>7s} {'count':>6s} {'total':>8s}  LOD note"]
    for t, k, c in rows:
        L.append(f"{k:26s} {PREFAB_INFO[k]['tris']:7d} {c:6d} {t:8d}  {PREFAB_INFO[k]['lod']}")
    L += ["", "Not counted (render-only stand-ins for the game's own objects): portal rings, Juno's stall,",
          "Hall of Firsts plaque wall, training dummies, the planet ground sphere and the sky."]
    with open(os.path.join(OUT, "budget.txt"), "w") as f:
        f.write("\n".join(L) + "\n")

# ============================================================================================
# MAIN
# ============================================================================================
def build_all_prefabs():
    build_houses()
    build_round2_houses()          # replaces house_a..house_d (round 2)
    build_wall_seg(); build_wall_extras(); build_towers(); build_gatehouse(); build_keep(); build_castle_gate()
    build_round2_gates()           # the portal courts (round 2)
    build_market_hall(); build_hall_of_firsts(); build_stalls(); build_props(); build_nature()

def main():
    init_scene()
    preload_materials()
    build_all_prefabs()
    log("prefabs built")
    make_layout()
    build_paving()
    log("layout + paving")
    validate()
    for l in budget_report()[3]:
        log("BUDGET", l)
    os.makedirs(os.path.join(OUT, "scratch"), exist_ok=True)
    write_plan(os.path.join(OUT, "scratch", "plan.json"))
    if opt("--plan", False):
        return
    write_layout_json()
    write_town_extra()
    write_budget()
    if EXPORT:
        export_prefabs()
    if RENDERS:
        do_renders()

if __name__ == "__main__":
    main()
