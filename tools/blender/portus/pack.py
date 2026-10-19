# Portus town: pack the design build (build.py output) into the game's asset.
#
#   blender -b --disable-autoexec --factory-startup --python pack.py -- --design <build.py --out dir> --out <dir>
#
# Reads only our own build output (prefabs/*.glb, prefabs/textures/*.png, layout.json, town_extra.json)
# and writes:
#   portus_raw.glb      every prefab's geometry, one node per prefab and LOD with up to two primitives
#                       (material "town_opaque" / "town_cutout"); COLOR_0 = linear vertex tint (rgb) and
#                       the material slot (a, as slot/255). Scene extras carry the slot table.
#                       build.sh compresses it (meshopt) into portus.glb.
#   portus_color.webp   512 x 512·N strip: layer i = rows [512 i, 512 (i+1)) = base colour (sRGB rgb)
#                       and the cutout mask (a: 0 or 1; 1 on every opaque layer). The client decodes it
#                       through a canvas, which zeroes rgb where a = 0, so it samples the layer as
#                       premultiplied colour (rgb / a): no dark fringes in filtering or mipmaps.
#   portus_normal.webp  the same layers: tangent-space normal (rgb, OpenGL convention), opaque
#   town.json           prefabs (class, LOD mode, collider solids, triangle counts), layout, streets,
#                       paved areas: the input of gen_town.py (packages/shared/src/content/portusTown.ts)
#   pack_report.json    triangle and slot counts for the manifest
#
# LODs: buildings and the gatehouse swap each kit tile roof for its convex shell (sloped faces only, so
# the brick gables stay visible) and drop their vine patches; trees become two crossed cards with an impostor rendered here (Cycles,
# albedo only); props have no LOD1 (the client hides them beyond a distance); everything else is
# already minimal and keeps one LOD.
import bpy, bmesh, sys, os, json, math, struct, hashlib
import numpy as np
from mathutils import Vector, Matrix

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def opt(name, default=None):
    if name in ARGV:
        i = ARGV.index(name)
        return ARGV[i + 1]
    return default


# Set by configure() (the pad outposts' pack, tools/blender/pads/pack.py, imports this module and
# reuses its readers, LOD builders, texture packing and GLB writer).
DESIGN = OUT = PREFAB_DIR = TEX_DIR = None
# Layer size: 512 for the shipped strips; the HD art pack (tools/blender/artpacks) builds the same
# layers at 1024 (`--layer 1024`) from the same kit maps.
LAYER = int(opt("--layer", "512"))
# WebP's largest side is 16383 px: a strip taller than that is laid out in columns (save_strip).
WEBP_MAX = 16383


def configure(design, out):
    global DESIGN, OUT, PREFAB_DIR, TEX_DIR
    DESIGN = os.path.abspath(design)
    OUT = os.path.abspath(out)
    if not os.path.isdir(os.path.join(DESIGN, "prefabs")):
        raise SystemExit("pack.py: pass --design <build.py output dir> --out <dir>")
    os.makedirs(OUT, exist_ok=True)
    PREFAB_DIR = os.path.join(DESIGN, "prefabs")
    TEX_DIR = os.path.join(PREFAB_DIR, "textures")


def log(*a):
    print("[pack]", *a, flush=True)


# ------------------------------------------------------------------------------------------------
# Texture layers (shared by the colour and the normal/mask array) and material slots
# ------------------------------------------------------------------------------------------------
# layer key -> (base colour png, normal png or None, mode)
LAYERS = [
    ("brick", "T_Brick_BaseColor.png", "T_Brick_Normal.png", "tile"),
    ("plaster", "T_Plaster_BaseColor.png", "T_Plaster_Normal.png", "tile"),
    ("rocktrim", "T_RockTrim_BaseColor.png", "T_RockTrim_Normal.png", "tile"),
    ("roundtiles", "T_RoundTiles_BaseColor.png", "T_RoundTiles_Normal.png", "tile"),
    ("unevenbrick", "T_UnevenBrick_BaseColor.png", "T_UnevenBrick_Normal.png", "tile"),
    ("woodtrim", "T_WoodTrim_BaseColor.png", "T_WoodTrim_Normal.png", "tile"),
    ("metal", "T_MetalOrnaments_BaseColor.png", None, "tile"),
    ("cloth", "T_Cloth_Palette.png", None, "nearest"),
    ("bark", "Bark_NormalTree.png", "Bark_NormalTree_Normal.png", "tile"),
    ("white", None, None, "white"),
    ("vine", "T_VineLeaf_png.png", None, "cutout"),
    ("leaves", "Leaves_NormalTree_C.png", None, "cutout"),
    ("pine", "Leaf_Pine_C.png", None, "cutout"),
    ("flowers", "Flowers.png", None, "cutout"),
    ("impostor_broad", None, None, "impostor"),
    ("impostor_pine", None, None, "impostor"),
]
LAYER_INDEX = {k[0]: i for i, k in enumerate(LAYERS)}

# Material slots. Tints are linear multipliers of the texture; roughness/metalness replace the kit's
# roughness maps (the game lights with a sun and a hemisphere, no environment map, so metal stays low).
# emissive = colour * strength (kept under Portus' bloom threshold by day; the game multiplies it by
# the night glow boost); night = window glow at night (times the vertex tint's green: lit windows).
SLOTS = [
    # name,               layer,         tint,               rough, metal, normal, emissive (r,g,b,k),  night (r,g,b,k),     cutout
    ("MI_Brick",          "brick",       (1.0, 1.0, 1.0),    0.86, 0.0, 1.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_Plaster",        "plaster",     (1.0, 0.98, 0.95),  0.92, 0.0, 0.8, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_RockTrim",       "rocktrim",    (1.0, 1.0, 1.0),    0.86, 0.0, 1.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_RoundTiles",     "roundtiles",  (1.0, 1.0, 1.0),    0.72, 0.0, 1.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_UnevenBrick",    "unevenbrick", (1.0, 1.0, 1.0),    0.88, 0.0, 1.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_WoodTrim",       "woodtrim",    (1.0, 1.0, 1.0),    0.78, 0.0, 0.8, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_WoodTrim_Wear",  "woodtrim",    (0.93, 0.9, 0.86),  0.82, 0.0, 0.8, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_MetalOrnaments", "metal",       (0.85, 0.85, 0.85), 0.45, 0.35, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("M_Cloth",           "cloth",       (1.0, 1.0, 1.0),    0.9, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("Bark_NormalTree",   "bark",        (1.0, 1.0, 1.0),    0.9, 0.0, 1.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("MI_WindowGlass",    "white",       (0.05, 0.075, 0.1), 0.2, 0.0, 0.0, (0, 0, 0, 0), (1.0, 0.72, 0.38, 0.85), False),
    ("M_Glow",            "white",       (0.3, 0.09, 0.012), 0.6, 0.0, 0.0, (1.0, 0.36, 0.06, 0.85), (0, 0, 0, 0), False),
    ("MI_Vine",           "vine",        (0.13, 0.4, 0.04),  0.75, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), True),
    ("Leaves_NormalTree", "leaves",      (1.0, 1.0, 1.0),    0.8, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), True),
    ("Leaves_Pine",       "pine",        (1.0, 1.0, 1.0),    0.8, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), True),
    ("Flowers",           "flowers",     (1.0, 1.0, 1.0),    0.8, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), True),
    ("Impostor_Broad",    "impostor_broad", (0.92, 0.92, 0.92), 0.85, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), True),
    ("Impostor_Pine",     "impostor_pine",  (0.92, 0.92, 0.92), 0.85, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), True),
] + [
    # Round 2 vertex-colour pieces (tools/blender/round2): the colour is the vertex colour (white
    # layer), shading baked into it. Glass lights up at night like the kit's windows; glow uses its
    # own colour above the bloom threshold (townMaterial glow mode).
    ("OK_Matte",          "white",       (1.0, 1.0, 1.0),    0.85, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("OK_Gloss",          "white",       (1.0, 1.0, 1.0),    0.42, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("OK_Metal",          "white",       (1.0, 1.0, 1.0),    0.35, 0.1, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
    ("OK_Glass",          "white",       (1.0, 1.0, 1.0),    0.15, 0.0, 0.0, (0, 0, 0, 0), (1.0, 0.72, 0.38, 0.85), False),
    ("OK_Glow",           "white",       (1.0, 1.0, 1.0),    0.5, 0.0, 0.0, (0, 0, 0, 0), (0, 0, 0, 0), False),
]
# Slots that glow in their own (vertex) colour (manifest "glow").
GLOW_SLOTS = {"OK_Glow"}
SLOT_INDEX = {s[0]: i for i, s in enumerate(SLOTS)}
GLASS_SLOT = SLOT_INDEX["MI_WindowGlass"]

# Prefab classes: building (LOD1 roof shell), tree (LOD1 cards), prop (hidden beyond the tier's prop
# distance), static (one LOD, always drawn).
CLASS = {}
for n in ("house_a", "house_b", "house_c", "house_d", "cottage", "market_hall", "hall_of_firsts", "gatehouse"):
    CLASS[n] = "building"
for n in ("tree_oak", "tree_oak_small", "tree_pine", "tree_pine_tall"):
    CLASS[n] = "tree"
for n in ("stall_a", "stall_b", "stall_c", "crates", "barrels", "wagon", "well", "lamp_post", "bench", "banner_pole",
          "weapon_rack", "target", "signpost", "planter", "ring_bench", "bunting_8", "brazier", "bush", "woodpile"):
    CLASS[n] = "prop"
for n in ("wall_seg", "wall_seg_ivy", "tower_round", "tower_round_roof", "castle_gate", "keep", "wall_stair", "lean_to",
          "portal_court_arcadia", "portal_court_hollowmere", "portal_court_meridian", "paving", "fence", "garden_wall",
          "garden_plot"):
    CLASS[n] = "static"
IMPOSTOR_LAYER = {"tree_oak": ("impostor_broad", 0), "tree_oak_small": ("impostor_broad", 1),
                  "tree_pine": ("impostor_pine", 0), "tree_pine_tall": ("impostor_pine", 1)}


# ------------------------------------------------------------------------------------------------
# glTF reading (our own build output; plain accessors, no compression)
# ------------------------------------------------------------------------------------------------
COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    data = open(path, "rb").read()
    magic, _ver, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise SystemExit(f"not a GLB: {path}")
    off, doc, binc = 12, None, b""
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        if ctype == 0x4E4F534A:
            doc = json.loads(data[off:off + clen])
        elif ctype == 0x004E4942:
            binc = data[off:off + clen]
        off += clen
    return doc, binc


def accessor(doc, binc, i):
    a = doc["accessors"][i]
    bv = doc["bufferViews"][a["bufferView"]]
    dt = COMP[a["componentType"]]
    n = NCOMP[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride")
    item = np.dtype(dt).itemsize * n
    if stride and stride != item:
        raw = np.frombuffer(binc, dtype=np.uint8, count=stride * a["count"], offset=off).reshape(a["count"], stride)[:, :item]
        arr = np.ascontiguousarray(raw).view(dt).reshape(a["count"], n)
    else:
        arr = np.frombuffer(binc, dtype=dt, count=a["count"] * n, offset=off).reshape(a["count"], n)
    if a.get("normalized"):
        arr = arr.astype(np.float32) / float(np.iinfo(dt).max)
    return arr


def load_prefab(name):
    """Primitives of a prefab GLB in glTF space (x right, y up, z = front): list of dicts."""
    doc, binc = read_glb(os.path.join(PREFAB_DIR, name + ".glb"))
    node = doc["nodes"][doc["scenes"][doc.get("scene", 0)]["nodes"][0]]
    for k in ("matrix", "rotation", "scale", "translation"):
        v = node.get(k)
        if v and not (k == "scale" and v == [1, 1, 1]) and not (k == "translation" and v == [0, 0, 0]) and not (k == "rotation" and v == [0, 0, 0, 1]):
            raise SystemExit(f"{name}: unexpected node transform {k}={v}")
    out = []
    for p in doc["meshes"][node["mesh"]]["primitives"]:
        at = p["attributes"]
        pos = accessor(doc, binc, at["POSITION"]).astype(np.float64)
        nrm = accessor(doc, binc, at["NORMAL"]).astype(np.float64)
        uv = accessor(doc, binc, at["TEXCOORD_0"]).astype(np.float64)
        col = accessor(doc, binc, at["COLOR_0"]).astype(np.float64) if "COLOR_0" in at else None
        if col is not None and col.shape[1] == 3:
            col = np.concatenate([col, np.ones((len(col), 1))], axis=1)
        idx = accessor(doc, binc, p["indices"]).reshape(-1, 3).astype(np.int64)
        mat = doc["materials"][p["material"]]["name"]
        out.append(dict(mat=mat, pos=pos, nrm=nrm, uv=uv, col=col, idx=idx))
    return out


# ------------------------------------------------------------------------------------------------
# Geometry parts: (slot, pos, nrm, uv, rgb tint, idx) per prefab and LOD
# ------------------------------------------------------------------------------------------------
class Part:
    def __init__(self, slot, pos, nrm, uv, rgb, idx):
        self.slot, self.pos, self.nrm, self.uv, self.rgb, self.idx = slot, pos, nrm, uv, rgb, idx

    @property
    def cutout(self):
        return SLOTS[self.slot][8]

    def tris(self):
        return len(self.idx)


def parts_of(prims):
    out = []
    for p in prims:
        if p["mat"] not in SLOT_INDEX:
            raise SystemExit(f"unknown material {p['mat']}")
        rgb = p["col"][:, :3] if p["col"] is not None else np.ones((len(p["pos"]), 3))
        out.append(Part(SLOT_INDEX[p["mat"]], p["pos"], p["nrm"], p["uv"], rgb, p["idx"]))
    return out


def tris(parts):
    return int(sum(p.tris() for p in parts))


# ------------------------------------------------------------------------------------------------
# LOD1 roof shells: each big tile-roof component -> the sloped faces of its convex hull, with UVs
# from the component's own texture mapping (fitted per face frame), so tile rows keep their direction.
# ------------------------------------------------------------------------------------------------
def components(part):
    """Connected triangle sets of a part (vertices welded by position)."""
    key = np.round(part.pos * 1000).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    parent = list(range(int(inv.max()) + 1))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for t in part.idx:
        a, b, c = (find(int(inv[v])) for v in t)
        parent[b] = a
        parent[find(c)] = a
    groups = {}
    for ti, t in enumerate(part.idx):
        groups.setdefault(find(int(inv[t[0]])), []).append(ti)
    return list(groups.values())


def face_frame(n):
    up = np.array([0.0, 1.0, 0.0])
    along = np.cross(up, n)
    L = np.linalg.norm(along)
    if L < 1e-6:
        along, L = np.array([1.0, 0.0, 0.0]), 1.0
    along /= L
    upslope = np.cross(n, along)
    return along, upslope


def fit_uv_jacobian(part, tri_ids):
    """Median d(uv)/d(along, upslope) over the component's sloped triangles."""
    js, ws = [], []
    for ti in tri_ids:
        t = part.idx[ti]
        P = part.pos[t]
        U = part.uv[t]
        n = np.cross(P[1] - P[0], P[2] - P[0])
        area = np.linalg.norm(n) / 2
        if area < 1e-4:
            continue
        n /= area * 2
        if n[1] < 0.25:
            continue
        fr = face_frame(n)
        if fr is None:
            continue
        a, b = fr
        S = np.array([[np.dot(P[1] - P[0], a), np.dot(P[2] - P[0], a)], [np.dot(P[1] - P[0], b), np.dot(P[2] - P[0], b)]])
        D = np.array([U[1] - U[0], U[2] - U[0]]).T  # 2x2: rows u, v
        if abs(np.linalg.det(S)) < 1e-8:
            continue
        js.append((D @ np.linalg.inv(S)).ravel())
        ws.append(area)
    if not js:
        return np.array([[0.5, 0.0], [0.0, -0.5]])
    js = np.array(js)
    return np.median(js, axis=0).reshape(2, 2)


def hull_shell(points):
    """Sloped (upward) faces of the convex hull of `points` as triangles (list of 3x3 arrays)."""
    bm = bmesh.new()
    for p in points:
        bm.verts.new(Vector(p))
    bmesh.ops.convex_hull(bm, input=bm.verts[:])
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(4), verts=bm.verts[:], edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.normal_update()
    centre = np.mean(np.array(points), axis=0)
    out = []
    for f in bm.faces:
        tri = np.array([list(v.co) for v in f.verts])
        n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        L = np.linalg.norm(n)
        if L < 1e-9:
            continue
        n /= L
        if np.dot(n, tri.mean(axis=0) - centre) < 0:  # outward
            tri = tri[::-1]
            n = -n
        if n[1] < 0.25:
            continue  # undersides and vertical gable ends (the brick gables stay visible)
        out.append(tri)
    bm.free()
    return out


def roof_lod(parts):
    """Replace big MI_RoundTiles components with their hull shells; drop the vine patches (cutout
    cards a few pixels tall at LOD1 distances)."""
    tiles = SLOT_INDEX["MI_RoundTiles"]
    vine = SLOT_INDEX["MI_Vine"]
    out = []
    for p in parts:
        if p.slot == vine:
            continue
        if p.slot != tiles:
            out.append(p)
            continue
        keep_tris = []
        shells = []
        for comp in components(p):
            if len(comp) < 150:
                keep_tris.extend(comp)
                continue
            J = fit_uv_jacobian(p, comp)
            verts = np.unique(p.idx[comp].reshape(-1))
            for tri in hull_shell(p.pos[verts]):
                n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
                n /= np.linalg.norm(n)
                a, b = face_frame(n)
                st = np.array([[np.dot(v, a), np.dot(v, b)] for v in tri])
                uv = st @ J.T
                shells.append((tri, n, uv))
        if keep_tris:
            idx = p.idx[keep_tris]
            used = np.unique(idx.reshape(-1))
            remap = -np.ones(len(p.pos), np.int64)
            remap[used] = np.arange(len(used))
            out.append(Part(p.slot, p.pos[used], p.nrm[used], p.uv[used], p.rgb[used], remap[idx]))
        if shells:
            pos = np.concatenate([s[0] for s in shells])
            nrm = np.concatenate([np.repeat(s[1][None, :], 3, axis=0) for s in shells])
            uv = np.concatenate([s[2] for s in shells])
            out.append(Part(tiles, pos, nrm, uv, np.ones((len(pos), 3)), np.arange(len(pos)).reshape(-1, 3)))
    return out


# ------------------------------------------------------------------------------------------------
# Tree impostors: albedo render (Cycles, orthographic, transparent film) of each tree from the front;
# LOD1 = two crossed double-sided cards at the trunk, both showing that image.
# ------------------------------------------------------------------------------------------------
def render_impostor(name, w_px, h_px):
    """Returns (rgba top-down float array, card half width, card height)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(PREFAB_DIR, name + ".glb"))
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    mn = Vector((1e9,) * 3)
    mx = Vector((-1e9,) * 3)
    for o in objs:
        for v in o.data.vertices:
            c = o.matrix_world @ v.co
            mn = Vector(map(min, mn, c))
            mx = Vector(map(max, mx, c))
    for o in objs:
        for m in o.data.materials:
            nt = m.node_tree
            # The base-colour texture is the one feeding the colour mix / Base Color (not the normal map).
            tex = None
            for l in nt.links:
                if l.from_node.type == "TEX_IMAGE" and l.from_socket.name == "Color" and l.to_node.type in ("MIX", "BSDF_PRINCIPLED", "MIX_RGB"):
                    tex = l.from_node
            out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
            for n in [n for n in nt.nodes if n not in (tex, out)]:
                nt.nodes.remove(n)
            emis = nt.nodes.new("ShaderNodeEmission")
            transp = nt.nodes.new("ShaderNodeBsdfTransparent")
            mix = nt.nodes.new("ShaderNodeMixShader")
            if tex is None:
                raise SystemExit(f"{name}: no base colour texture on {m.name}")
            tex.interpolation = "Linear"
            # The kit multiplies every tree material by COLOR_0 (leaf tint, bark shade); so does the game.
            attr = nt.nodes.new("ShaderNodeVertexColor")
            attr.layer_name = o.data.color_attributes[0].name if o.data.color_attributes else ""
            mul = nt.nodes.new("ShaderNodeMix")
            mul.data_type = "RGBA"
            mul.blend_type = "MULTIPLY"
            mul.inputs[0].default_value = 1.0
            nt.links.new(tex.outputs["Color"], mul.inputs[6])
            nt.links.new(attr.outputs["Color"], mul.inputs[7])
            nt.links.new(mul.outputs[2], emis.inputs["Color"])
            nt.links.new(tex.outputs["Alpha"], mix.inputs[0])
            nt.links.new(transp.outputs[0], mix.inputs[1])
            nt.links.new(emis.outputs[0], mix.inputs[2])
            nt.links.new(mix.outputs[0], out.inputs["Surface"])
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 48
    sc.cycles.use_denoising = False
    sc.cycles.seed = 1
    sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.resolution_x, sc.render.resolution_y = w_px, h_px
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.render.filter_size = 0.8
    # Front view (Blender looks along +Y at the -Y face = the prefab front). Card covers x in [-hw, hw],
    # z in [0, top]; the 1:2 image fits height = 2 * width.
    hw = max(abs(mn.x), abs(mx.x), abs(mn.y), abs(mx.y)) * 1.02
    top = mx.z * 1.01
    scale = max(top, 4 * hw)  # ortho scale spans the image height (h = 2 w)
    hw = scale / 4
    top = scale
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = scale
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = (0.0, -50.0, top / 2)
    cam.rotation_euler = (math.radians(90), 0, 0)
    world = bpy.data.worlds.new("w")
    sc.world = world
    path = os.path.join(OUT, f"_impostor_{name}.png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h_px, w_px, 4)[::-1]
    bpy.data.images.remove(img)
    os.remove(path)
    return px, hw, top


def card_parts(slot, hw, top, u0, u1):
    """Two crossed vertical cards (x-y and z-y planes), double-sided in the game; normals up."""
    pos, uv = [], []
    for axis in (0, 2):
        for (s, y, u, v) in ((-hw, 0.0, u0, 1.0), (hw, 0.0, u1, 1.0), (hw, top, u1, 0.0), (-hw, top, u0, 0.0)):
            p = [0.0, y, 0.0]
            p[axis] = s if axis == 0 else -s
            pos.append(p)
            uv.append((u, v))
    pos = np.array(pos)
    idx = np.array([[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]])
    nrm = np.tile([0.0, 1.0, 0.0], (len(pos), 1))
    return [Part(slot, pos, nrm, np.array(uv), np.ones((len(pos), 3)), idx)]


# ------------------------------------------------------------------------------------------------
# Textures: 512² layers, box/area-filtered from the kit's 1–2k maps (linear light for colour)
# ------------------------------------------------------------------------------------------------
def load_png(fname):
    img = bpy.data.images.load(os.path.join(TEX_DIR, fname))
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1].copy()
    bpy.data.images.remove(img)
    return px


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def area_weights(n_src, n_dst):
    W = np.zeros((n_dst, n_src), np.float64)
    scale = n_src / n_dst
    for i in range(n_dst):
        a, b = i * scale, (i + 1) * scale
        for j in range(int(math.floor(a)), int(math.ceil(b))):
            w = min(b, j + 1) - max(a, j)
            if w > 0:
                W[i, j] = w
        W[i] /= W[i].sum()
    return W


def resample(px, size=None):
    size = size or LAYER
    h, w, c = px.shape
    Wy, Wx = area_weights(h, size), area_weights(w, size)
    out = np.einsum("yh,hwc->ywc", Wy, px)
    return np.einsum("xw,ywc->yxc", Wx, out)


def dilate(rgb, mask, steps=24):
    """Bleed colour into transparent texels so mipmaps don't pull black into the cutout edges."""
    rgb = rgb.copy()
    known = mask > 0.5
    for _ in range(steps):
        if known.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(mask.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = np.roll(known, (dy, dx), axis=(0, 1))
            acc += np.roll(rgb, (dy, dx), axis=(0, 1)) * k[..., None]
            cnt += k
        grow = (~known) & (cnt > 0)
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    if not known.all():
        rgb[~known] = rgb[known].mean(axis=0)
    return rgb


def layer_images(impostors):
    """Per layer: colour (sRGB rgb, top-down), the cutout mask and the normal (rgb) as float arrays."""
    color, mask, normal = [], [], []
    flat = np.zeros((LAYER, LAYER, 3), np.float32)
    flat[..., 0] = flat[..., 1] = 0.5
    flat[..., 2] = 1.0
    solid = np.ones((LAYER, LAYER), np.float32)
    for key, base, nmap, mode in LAYERS:
        a = solid
        if mode == "white":
            c = np.ones((LAYER, LAYER, 3), np.float32)
            n = flat.copy()
        elif mode == "impostor":
            src = impostors[key]
            c = dilate(src[..., :3], src[..., 3])
            n = flat.copy()
            a = (src[..., 3] > 0.5).astype(np.float32)
        elif mode == "nearest":
            src = load_png(base)
            h, w, _ = src.shape
            yi = (np.arange(LAYER) * h // LAYER)
            xi = (np.arange(LAYER) * w // LAYER)
            c = src[yi][:, xi, :3]
            n = flat.copy()
        else:
            src = load_png(base)
            lin = srgb_to_lin(src[..., :3])
            if mode == "cutout":
                a = src[..., 3]
                # premultiplied average, then un-premultiply: no black fringes
                small = resample(np.concatenate([lin * a[..., None], a[..., None]], axis=2))
                alpha = small[..., 3]
                cl = small[..., :3] / np.maximum(alpha, 1e-4)[..., None]
                c = lin_to_srgb(dilate(cl, alpha))
                n = flat.copy()
                a = (alpha > 0.5).astype(np.float32)
            else:
                c = lin_to_srgb(resample(lin))
                if nmap:
                    nsrc = load_png(nmap)[..., :3] * 2 - 1
                    ns = resample(nsrc)
                    ns /= np.maximum(np.linalg.norm(ns, axis=2, keepdims=True), 1e-6)
                    n = ns * 0.5 + 0.5
                else:
                    n = flat.copy()
        color.append(np.clip(c, 0, 1))
        mask.append(a)
        normal.append(np.clip(n, 0, 1))
    return color, mask, normal


def strip_columns(n_layers, size=None):
    """Columns of a strip of n layers: one (the shipped 512 strips) unless that would pass WebP's limit."""
    size = size or LAYER
    return max(1, math.ceil(n_layers * size / WEBP_MAX))


def save_strip(layers, path, quality):
    """Layers (each size x size x ch, top-down) as one WebP: layer i at column i % cols, row i // cols.
    One column is the plain vertical strip; empty grid cells (n not a multiple of cols) stay black."""
    n = len(layers)
    size, ch = layers[0].shape[0], layers[0].shape[2]
    cols = strip_columns(n, size)
    rows = math.ceil(n / cols)
    grid = np.zeros((rows * size, cols * size, ch), np.float32)
    for i, px in enumerate(layers):
        r, c = divmod(i, cols)
        grid[r * size:(r + 1) * size, c * size:(c + 1) * size] = px
    save_webp(grid, path, quality)
    return cols


def save_webp(top_down, path, quality):
    h, w, ch = top_down.shape
    top_down_rgba = top_down if ch == 4 else np.concatenate([top_down, np.ones((h, w, 1), np.float32)], axis=2)
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=ch == 4)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.ascontiguousarray(top_down_rgba[::-1]).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "WEBP"
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)


# ------------------------------------------------------------------------------------------------
# Colliders (game local frame: x right, y up, z front; Blender prefab space is x, -z, y -> x, y, z)
# Each solid: [shape (0 box, 1 cylinder), cx, cz, hx, hz, y0, y1, yaw degrees (CCW from above)].
# Hand-authored from build.py's dimensions (Blender coords: x right, y back, z up; front = -y) where a
# box from the footprint would be wrong (gate passages, courts, stairs, steps); the rest come from the
# ground footprint (vertices 0.05–2 m up) and the full height.
# ------------------------------------------------------------------------------------------------
def B(x, y, hx, hy, z0, z1, yaw=0.0):
    return [0, x, -y, hx, hy, z0, z1, yaw]


def C(x, y, r, z0, z1):
    return [1, x, -y, r, r, z0, z1, 0.0]


def gate_a_solids(dais=True):
    """Opus gate A (round 2): the two pylons and the obelisks; the opening stays clear for the portal.
    The dais (a 0.14 m threshold) has no collider: a solid edge stops walking feet (collide.ts steps
    onto a top only with the centre over it), so players walk over it, their feet a little in it."""
    s = [B(-2.35, 0, 0.75, 0.85, 0, 4.9), B(2.35, 0, 0.75, 0.85, 0, 4.9)]
    if dais:
        s += [C(-3.9, -3.9, 0.31, 0, 2.15), C(3.9, -3.9, 0.31, 0, 2.15)]
    return s


def portal_court_solids():
    s = []
    n, r_in, r_out = 14, 5.65, 6.6
    a_from, a_to = math.radians(-8), math.radians(188)
    for i in range(n):
        a0 = a_from + (a_to - a_from) * i / n
        a1 = a_from + (a_to - a_from) * (i + 1) / n
        am = (a0 + a1) / 2
        rm = (r_in + r_out) / 2
        half = rm * math.sin((a1 - a0) / 2) + 0.12
        # box along the arc chord: local x along the tangent
        yaw = math.degrees(am) + 90.0
        s.append(B(math.cos(am) * rm, math.sin(am) * rm, half, (r_out - r_in) / 2, 0.0, 0.95, yaw))
    for a in (a_from, a_to):
        s.append(B(math.cos(a) * 6.35, math.sin(a) * 6.35, 0.55, 0.55, 0.0, 4.6))
    ya, depth = 4.7, 1.2
    for x in (-3.65, 3.65):
        s.append(B(x, ya + depth / 2, 0.65, depth / 2 + 0.25, 0.0, 9.8))
    s.append(B(0, ya + depth / 2, 3.0, depth / 2 + 0.25, 8.6, 9.8))
    return s


HAND = {
    "wall_seg": [B(0, 0, 2.0, 1.4, 0, 8.3)],
    "wall_seg_ivy": [B(0, 0, 2.0, 1.4, 0, 8.3)],
    "tower_round": [C(0, 0, 3.65, 0, 11.6)],
    "tower_round_roof": [C(0, 0, 3.65, 0, 13.0)],
    "gatehouse": [B(-2.85, 0, 0.95, 2.8, 0, 15.5), B(2.85, 0, 0.95, 2.8, 0, 15.5), B(0, 0, 1.9, 2.8, 5.3, 15.5),
                  C(-5.3, -0.9, 3.25, 0, 13.0), C(5.3, -0.9, 3.25, 0, 13.0),
                  B(-1.55, 0.9, 0.08, 0.95, 0, 3.3, -8), B(1.55, 0.9, 0.08, 0.95, 0, 3.3, 8)],
    "castle_gate": [B(-2.6, 0, 0.9, 2.2, 0, 9.4), B(2.6, 0, 0.9, 2.2, 0, 9.4), B(0, 0, 1.7, 2.2, 4.9, 9.4)],
    "keep": [B(0, 0, 5.45, 5.45, 0, 31.0), B(0, -6.3, 2.2, 1.3, 0, 0.45), B(0, -7.95, 2.2, 0.35, 0, 0.22)],
    "hall_of_firsts": [B(0, 0, 3.65, 5.35, 0, 10.7), B(0, -5.7, 2.0, 0.7, 0, 0.32), C(-2.6, -6.3, 0.42, 0, 2.1), C(2.6, -6.3, 0.42, 0, 2.1)],
    "wall_stair": [B(0.7, -0.7, 4.48, 0.7, 0, 6.2)],
    "portal_court_arcadia": gate_a_solids(),
    "portal_court_hollowmere": gate_a_solids(),
    "portal_court_meridian": gate_a_solids(),
    # Round 2 houses keep the old houses' colliders (the plots).
    "house_a": [B(0, -0.108, 2.417, 2.308, 0, 9.974)],
    "house_b": [B(0, -0.108, 2.417, 3.308, 0, 13.56)],
    "house_c": [B(0, -0.108, 3.417, 2.308, 0, 9.958)],
    "house_d": [B(0, -0.108, 3.417, 3.308, 0, 11.13)],
    "stall_a": [B(0, 0, 1.46, 0.96, 0, 2.3), C(1.85, 0.2, 0.36, 0, 0.95), B(-1.9, 0.3, 0.32, 0.32, 0, 1.1)],
    "stall_b": [B(0, 0, 1.46, 0.96, 0, 2.3), C(1.85, 0.2, 0.36, 0, 0.95), B(-1.9, 0.3, 0.32, 0.32, 0, 1.1)],
    "stall_c": [B(0, 0, 1.46, 0.96, 0, 2.3), C(1.85, 0.2, 0.36, 0, 0.95), B(-1.9, 0.3, 0.32, 0.32, 0, 1.1)],
    "crates": [B(0, 0, 0.55, 0.55, 0, 1.9), C(-0.95, 0.15, 0.36, 0, 0.95), C(1.05, -0.55, 0.32, 0, 0.8)],
    "barrels": [C(0.36, 0.25, 0.78, 0, 1.8)],
    "well": [C(0, 0, 1.1, 0, 3.05)],
    "lamp_post": [C(0, 0, 0.2, 0, 3.3)],
    "bench": [B(0, 0, 0.9, 0.24, 0, 0.95)],
    "banner_pole": [C(0, 0, 0.25, 0, 6.0)],
    "weapon_rack": [B(0, 0, 1.1, 0.2, 0, 1.7)],
    "target": [C(0, 0, 0.5, 0, 2.0)],
    "signpost": [C(0, 0, 0.12, 0, 2.7)],
    "garden_plot": [B(0, 2.1, 3.1, 0.1, 0, 1.0), B(0, -2.1, 3.1, 0.1, 0, 1.0), B(3.1, 0, 0.1, 2.1, 0, 1.0)],
    "woodpile": [B(0, -0.05, 1.3, 0.75, 0, 2.1)],
    "planter": [B(0, 0, 0.9, 0.9, 0, 0.62)],
    "ring_bench": [C(0, 0, 2.0, 0, 0.45)],
    "garden_wall": [B(0, 0, 2.05, 0.32, 0, 1.2)],
    "brazier": [C(0, 0, 0.35, 0, 1.3)],
    "bunting_8": [],
    "bush": [],
    "paving": [],
}


def auto_solids(name, info):
    gmn, gmx = info["gmin"], info["gmax"]
    top = info["max"][2]
    if CLASS.get(name) == "tree":
        r = max(abs(gmn[0]), abs(gmx[0]), abs(gmn[1]), abs(gmx[1]))
        return [C((gmn[0] + gmx[0]) / 2, (gmn[1] + gmx[1]) / 2, min(0.45, max(0.18, r)), 0, 4.0)]
    return [B((gmn[0] + gmx[0]) / 2, (gmn[1] + gmx[1]) / 2, (gmx[0] - gmn[0]) / 2, (gmx[1] - gmn[1]) / 2, 0, top)]


# ------------------------------------------------------------------------------------------------
# GLB writer
# ------------------------------------------------------------------------------------------------
class GLB:
    def __init__(self):
        self.doc = {"asset": {"version": "2.0", "generator": "FIRSTLIGHT tools/blender/portus/pack.py"},
                    "buffers": [], "bufferViews": [], "accessors": [], "meshes": [], "nodes": [],
                    "materials": [{"name": "town_opaque", "doubleSided": True},
                                  {"name": "town_cutout", "doubleSided": True, "alphaMode": "MASK", "alphaCutoff": 0.5}],
                    "scenes": [{"name": "portus_town", "nodes": []}], "scene": 0}
        self.bin = bytearray()

    def view(self, arr, target):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        b = np.ascontiguousarray(arr).tobytes()
        self.bin += b
        self.doc["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": len(b), "target": target})
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, arr, ctype, atype, target, normalized=False, minmax=False):
        v = self.view(arr, target)
        a = {"bufferView": v, "componentType": ctype, "count": int(arr.shape[0]), "type": atype}
        if normalized:
            a["normalized"] = True
        if minmax:
            a["min"] = [float(x) for x in arr.min(axis=0)]
            a["max"] = [float(x) for x in arr.max(axis=0)]
        self.doc["accessors"].append(a)
        return len(self.doc["accessors"]) - 1

    def mesh(self, name, groups):
        prims = []
        for mat, parts in groups:
            if not parts:
                continue
            pos = np.concatenate([p.pos for p in parts]).astype(np.float32)
            nrm = np.concatenate([p.nrm for p in parts])
            nrm = (nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)).astype(np.float32)
            uv = np.concatenate([p.uv for p in parts]).astype(np.float32)
            col = np.concatenate([np.concatenate([np.clip(np.round(p.rgb * 255), 0, 255), np.full((len(p.pos), 1), p.slot)], axis=1) for p in parts]).astype(np.uint8)
            idx, base = [], 0
            for p in parts:
                idx.append(p.idx + base)
                base += len(p.pos)
            idx = np.concatenate(idx).reshape(-1)
            idx = idx.astype(np.uint16 if base < 65536 else np.uint32)
            prims.append({"attributes": {
                "POSITION": self.accessor(pos, 5126, "VEC3", 34962, minmax=True),
                "NORMAL": self.accessor(nrm, 5126, "VEC3", 34962),
                "TEXCOORD_0": self.accessor(uv, 5126, "VEC2", 34962),
                "COLOR_0": self.accessor(col, 5121, "VEC4", 34962, normalized=True),
            }, "indices": self.accessor(idx.reshape(-1, 1), 5123 if idx.dtype == np.uint16 else 5125, "SCALAR", 34963), "material": mat})
        self.doc["meshes"].append({"name": name, "primitives": prims})
        self.doc["nodes"].append({"name": name, "mesh": len(self.doc["meshes"]) - 1})
        self.doc["scenes"][0]["nodes"].append(len(self.doc["nodes"]) - 1)

    def write(self, path, extras):
        self.doc["scenes"][0]["extras"] = extras
        self.doc["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.doc, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        binc = bytes(self.bin) + b"\0" * ((4 - len(self.bin) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(binc)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack("<II", len(binc), 0x004E4942))
            f.write(binc)


def split(parts):
    return [(0, [p for p in parts if not p.cutout]), (1, [p for p in parts if p.cutout])]


# ------------------------------------------------------------------------------------------------
def main():
    layout = json.load(open(os.path.join(DESIGN, "layout.json")))
    extra = json.load(open(os.path.join(DESIGN, "town_extra.json")))
    names = []
    for it in layout:
        if it["prefab"] not in names:
            names.append(it["prefab"])
    missing = [n for n in names if n not in CLASS]
    if missing:
        raise SystemExit(f"prefabs without a class: {missing}")

    # Impostors first: they reset the Blender scene.
    impostor_px = {}
    cards = {}
    for key in ("impostor_broad", "impostor_pine"):
        impostor_px[key] = np.zeros((LAYER, LAYER, 4), np.float32)
    for name, (key, half) in IMPOSTOR_LAYER.items():
        px, hw, top = render_impostor(name, LAYER // 2, LAYER)
        impostor_px[key][:, half * (LAYER // 2):(half + 1) * (LAYER // 2)] = px
        cards[name] = (hw, top, half * 0.5, half * 0.5 + 0.5)
        log(f"impostor {name}: card half width {hw:.2f} m, height {top:.2f} m")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    glb = GLB()
    prefabs = []
    report = {"prefabs": {}}
    for name in names:
        lod0 = parts_of(load_prefab(name))
        cls = CLASS[name]
        lod1 = None
        if cls == "building":
            # An explicit LOD1 prefab (round-2 houses: without the small parts), else the roof shell.
            if os.path.exists(os.path.join(PREFAB_DIR, name + "__L1.glb")):
                lod1 = parts_of(load_prefab(name + "__L1"))
            else:
                lod1 = roof_lod(lod0)
        elif cls == "tree":
            hw, top, u0, u1 = cards[name]
            key, _half = IMPOSTOR_LAYER[name]
            slot = SLOT_INDEX["Impostor_Broad" if key == "impostor_broad" else "Impostor_Pine"]
            lod1 = card_parts(slot, hw, top, u0, u1)
        glb.mesh(name, split(lod0))
        if lod1 is not None:
            glb.mesh(name + "__L1", split(lod1))
        lod_mode = "geom" if lod1 is not None else ("none" if cls == "prop" else "same")
        info = extra["prefabs"][name]
        solids = HAND[name] if name in HAND else auto_solids(name, info)
        pos = np.concatenate([p.pos for p in lod0])
        bound = float(np.max(np.linalg.norm(pos[:, [0, 2]], axis=1)))
        prefabs.append(dict(name=name, cls=cls, lod=lod_mode, tris=[tris(lod0), tris(lod1) if lod1 is not None else 0],
                            height=float(pos[:, 1].max()), radius=bound, solids=[[round(float(v), 3) for v in s] for s in solids]))
        report["prefabs"][name] = dict(cls=cls, lod=lod_mode, lod0=tris(lod0), lod1=tris(lod1) if lod1 is not None else 0,
                                       cutout0=tris([p for p in lod0 if p.cutout]))
        log(f"{name:24s} {cls:9s} LOD0 {tris(lod0):6d}  LOD1 {tris(lod1) if lod1 is not None else '-':>6}  solids {len(solids)}")

    slot_table = []
    for s in SLOTS:
        name, layer, tint, rough, metal, nscale, emis, night, cut = s
        slot_table.append(dict(name=name, layer=LAYER_INDEX[layer], tint=list(tint), rough=rough, metal=metal, normal=nscale,
                               emissive=list(emis), night=list(night), cutout=cut, **({"glow": 1.0} if name in GLOW_SLOTS else {})))
    extras = {"portusTown": {"version": 1, "layerSize": LAYER, "layers": [l[0] for l in LAYERS], "slots": slot_table,
                             "glassSlot": GLASS_SLOT}}
    glb.write(os.path.join(OUT, "portus_raw.glb"), extras)

    color, mask, normal = layer_images(impostor_px)
    save_strip([np.concatenate([c, a[..., None]], axis=2) for c, a in zip(color, mask)], os.path.join(OUT, "portus_color.webp"), 82)
    save_strip(normal, os.path.join(OUT, "portus_normal.webp"), 90)

    town = dict(prefabs=prefabs, layout=layout, streets=extra["streets"], areas=extra["areas"], plaza=extra["plaza"],
                portal_floor=extra["portal_floor"], portals=extra["portals"], juno=extra["juno"], plaque=extra["plaque"],
                dummies=extra["dummies"])
    with open(os.path.join(OUT, "town.json"), "w") as f:
        json.dump(town, f, indent=1)
    report["layers"] = [l[0] for l in LAYERS]
    report["slots"] = [s[0] for s in SLOTS]
    report["slotTable"] = slot_table
    with open(os.path.join(OUT, "pack_report.json"), "w") as f:
        json.dump(report, f, indent=1)
    log("done")


if __name__ == "__main__":
    if not opt("--design") or not opt("--out"):
        raise SystemExit("pack.py: pass --design <build.py output dir> --out <dir>")
    configure(opt("--design"), opt("--out"))
    main()
