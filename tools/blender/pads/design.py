# Pad platforms and pad-0 arrival outposts (Arcadia, Hollowmere, Meridian): Phase A design build.
#
#   blender -b --disable-autoexec --factory-startup --python tools/blender/pads/design.py -- \
#     --body arcadia --site <site_arcadia.json> --village <village glTF> --nature <nature glTF> \
#     [--scifi <Modular SciFi MegaKit dir with glTF/ and Textures/>] --out <dir> [--renders a,b|none] [--plan]
#
# The site JSON comes from tools/blender/pads/site_data.mjs (the game's own shared code: ground heights,
# breakables, props, portal, guide, sun). Kit files are read as glTF/PNG data only (headless Blender with
# autoexec off); nothing in a kit is run. Reuses the Portus design build (tools/blender/portus/build.py)
# for its mesh builder, kit import, kit houses and props.
#
# Frame: Blender X = east, Y = north, Z = up at pad 0 (content/places.ts tangentFrame), origin on the
# pad's top centre; the planet centre is at (0, 0, -(R + padH)). Layout coordinates are geodesic
# east/north metres (azimuthal equidistant from pad 0, like Portus' layout.json); yaw in degrees CCW
# from above, 0 = the prefab's front (-Y) faces south. Heights in the site JSON are metres above R.
import bpy, bmesh, sys, os, math, json, random, time
from mathutils import Vector, Matrix, Quaternion

T0 = time.time()
ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

def opt(name, default=None):
    if name in ARGV:
        i = ARGV.index(name)
        return ARGV[i + 1] if i + 1 < len(ARGV) and not ARGV[i + 1].startswith("--") else True
    return default

HERE = os.path.dirname(os.path.abspath(__file__))
BODY = str(opt("--body", "arcadia"))
SITE = json.load(open(str(opt("--site"))))
VIL = str(opt("--village", ""))
NAT = str(opt("--nature", ""))
SCI = str(opt("--scifi", ""))
OUT = os.path.abspath(str(opt("--out", "/tmp/fl-design-pads")))
os.makedirs(OUT, exist_ok=True)
os.environ["PORTUS_VILLAGE_GLTF"] = VIL
os.environ["PORTUS_NATURE_GLTF"] = NAT
sys.path.insert(0, os.path.join(HERE, "..", "portus"))
import build as P   # noqa: E402  (Portus design build: mesh builder, kit import, houses, props)
from build import MB, box, prism, frustum, quad, circle, oriented_box, T, Rz, Rx, Ry, S, pal_uv  # noqa: E402

_footprints = P.footprints
def _safe_footprints(me, trunk=False):
    """Portus' footprints() needs vertices above 0.25 m; flat decal-like prefabs (pads) have none."""
    if any(v.co.z >= 0.25 for v in me.vertices):
        return _footprints(me, trunk)
    pts = [v.co for v in me.vertices] or [Vector((0, 0, 0))]
    mn = [min(p.x for p in pts), min(p.y for p in pts)]; mx = [max(p.x for p in pts), max(p.y for p in pts)]
    hull = P.hull2d(pts)
    return dict(gmin=mn, gmax=mx, fmin=mn, fmax=mx, ghull=hull, fhull=hull)
P.footprints = _safe_footprints

RENDERS = [r for r in str(opt("--renders", "arrival,aerial,pad,plan,sheet")).split(",") if r and r != "none"]
PLAN_ONLY = bool(opt("--plan", False))
SAMPLES = int(opt("--samples", 48))
SCALE = int(opt("--scale", 100))
R = float(SITE["R"])
PADH = float(SITE["padH"])
WATER = float(SITE["waterLevel"])
C = Vector((0.0, 0.0, -(R + PADH)))
B = BODY[0]   # prefab prefix: a_, h_, m_
rng = random.Random(11)

def log(*a):
    print(f"[{time.time() - T0:6.1f}s] [{BODY}]", *a, flush=True)

# --------------------------------------------------------------------------------------------
# Site mapping (geodesic east/north around pad 0) and the ground height field
# --------------------------------------------------------------------------------------------
GRID = SITE["grid"]
GL, GS, GN, GH = GRID["L"], GRID["step"], GRID["n"], GRID["heights"]

def ground(e, n):
    """Ground height above R (the rendered triangle, bilinear between the 1 m samples)."""
    i = (e + GL) / GS
    j = (n + GL) / GS
    i0 = max(0, min(GN - 2, int(math.floor(i))))
    j0 = max(0, min(GN - 2, int(math.floor(j))))
    fi, fj = i - i0, j - j0
    a = GH[j0 * GN + i0]; b = GH[j0 * GN + i0 + 1]; c = GH[(j0 + 1) * GN + i0]; d = GH[(j0 + 1) * GN + i0 + 1]
    return a * (1 - fi) * (1 - fj) + b * fi * (1 - fj) + c * (1 - fi) * fj + d * fi * fj

def up_of(e, n):
    r = math.hypot(e, n)
    if r < 1e-9:
        return Vector((0, 0, 1))
    t, a = r / R, math.atan2(n, e)
    return Vector((math.sin(t) * math.cos(a), math.sin(t) * math.sin(a), math.cos(t)))

def surf(e, n, h):
    """Point at geodesic (e, n), height h above R."""
    return C + up_of(e, n) * (R + h)

def surf_quat(e, n, yaw):
    return Vector((0, 0, 1)).rotation_difference(up_of(e, n)) @ Quaternion((0, 0, 1), math.radians(yaw))

def surf_matrix(e, n, yaw=0.0, h=None, scale=1.0):
    h = ground(e, n) if h is None else h
    return Matrix.LocRotScale(surf(e, n, h), surf_quat(e, n, yaw), Vector((scale,) * 3))

def to_geo(p):
    """Inverse: a Blender-space point -> (east, north, height above R)."""
    v = Vector(p) - C
    L = v.length
    u = v / L
    t = math.acos(max(-1.0, min(1.0, u.z))) * R
    h = math.hypot(u.x, u.y)
    if h < 1e-12:
        return 0.0, 0.0, L - R
    return u.x / h * t, u.y / h * t, L - R

def local_to_geo(e, n, yaw, x, y):
    """Prefab-local (x right, y back) offset of an item at (e, n, yaw) -> site (east, north) (flat approx)."""
    a = math.radians(yaw)
    return e + x * math.cos(a) - y * math.sin(a), n + x * math.sin(a) + y * math.cos(a)

# --------------------------------------------------------------------------------------------
# Per-body look (render/looks.ts) and material variants
# --------------------------------------------------------------------------------------------
def hexrgb(h):
    """sRGB hex -> linear rgb."""
    c = [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

SUN = SITE["sun"]
LOOK = dict(
    arcadia=dict(grass=(0x2c7a34, 0x9fdc58), soil=0x6b5a3a, leaf=(0x3f9a3a, 0x7cc84a), bark=0x6b4a2f, rock=(0x7d8a80, 0xa3ada6),
                 pine=0x2a6a3c, dead=0x6a5a50, reed=0x7a9a4a, scrub=0x8a9a4a, flower=0xffd27a, sun_el=SUN["elev"], sun_az=-40.0),
    hollowmere=dict(grass=(0x2a3324, 0x6e7a4a), soil=0x3a3040, leaf=(0x4f5a3c, 0x6e6a4a), bark=0x4a3a40, rock=(0x5a5068, 0x7a6e8c),
                    pine=0x2f3a30, dead=0x5e5060, reed=0x6b7a4a, scrub=0x5a5a40, flower=0x9effd8, sun_el=SUN["elev"], sun_az=125.0),
    meridian=dict(grass=(0x7a5a30, 0xc8a060), soil=0xb0552e, leaf=(0x8a8a4a, 0xa89a5a), bark=0x6a4a30, rock=(0xa8452c, 0xc9663a),
                  pine=0x5a6a3a, dead=0x7a5a40, reed=0x9a8a5a, scrub=0x9a8048, flower=0xffc7a0, sun_el=SUN["elev"], sun_az=-55.0),
)[BODY]

# Linear multiplier tints of the kit materials per body (the game's slot tints, townMaterial.ts:
# a linear multiply only, no desaturation, so the design never relies on what the shader can't do).
TINTS = dict(
    arcadia={},
    hollowmere={"MI_UnevenBrick": (0.70, 0.66, 0.82), "MI_Plaster": (0.62, 0.60, 0.72), "MI_RockTrim": (0.62, 0.60, 0.74),
                "MI_WoodTrim": (0.52, 0.46, 0.50), "MI_WoodTrim_Wear": (0.50, 0.45, 0.50), "MI_Brick": (0.62, 0.58, 0.70),
                "MI_RoundTiles": (0.42, 0.40, 0.52), "MI_MetalOrnaments": (0.55, 0.55, 0.62)},
    meridian={"MI_RockTrim": (1.0, 0.86, 0.76), "MI_UnevenBrick": (1.0, 0.82, 0.70)},
)[BODY]

def bsdf(m):
    return next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

def tint_material(m, rgb):
    nt = m.node_tree
    b = bsdf(m)
    links = list(b.inputs["Base Color"].links)
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    mix.inputs["B"].default_value = (*rgb, 1)
    if links:
        src = links[0].from_socket
        nt.links.remove(links[0])
        nt.links.new(src, mix.inputs["A"])
    else:
        mix.inputs["A"].default_value = b.inputs["Base Color"].default_value
    nt.links.new(mix.outputs["Result"], b.inputs["Base Color"])

def simple_mat(name, rgb, rough=0.8, metal=0.0, emit=None, emit_k=0.0, alpha=1.0, srgb_hex=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = bsdf(m)
    col = hexrgb(srgb_hex) if srgb_hex is not None else rgb
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = emit_k
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
    P.MATS[name] = m
    return m

NEW_SLOTS = {  # slots the pack step adds over the 'white' layer (linear colour, roughness, emissive)
    "M_Brass": dict(color=0xc8902e, rough=0.45, metal=0.3), "M_Bone": dict(color=0xd8d0c0, rough=0.7),
    "M_GlowTeal": dict(color=0x1f6a5c, emissive=0x5effd0), "M_GlowAmber": dict(color=0x6a3a08, emissive=0xffb347),
    "M_GlowWarm": dict(color=0x5a3010, emissive=0xffc070),
}

def setup_materials():
    P.preload_materials()   # kit materials + M_Cloth (palette) + M_Glow
    for k, rgb in TINTS.items():
        if k in P.MATS:
            tint_material(P.MATS[k], rgb)
    # Kit metal never reflects anything in the game (no environment map): keep it low here too.
    for m in P.MATS.values():
        if m.use_nodes:
            try:
                b = bsdf(m)
                if b.inputs["Metallic"].default_value > 0.4 and not b.inputs["Metallic"].links:
                    b.inputs["Metallic"].default_value = 0.35
            except StopIteration:
                pass
    # New slots (white layer + tint + emissive): brass inlays, teal grave-light, amber light strips.
    simple_mat("M_Brass", hexrgb(0xc8902e), rough=0.45, metal=0.3)
    simple_mat("M_GlowTeal", hexrgb(0x1f6a5c), rough=0.5, emit=hexrgb(0x5effd0), emit_k=3.0)
    simple_mat("M_GlowAmber", hexrgb(0x6a3a08), rough=0.5, emit=hexrgb(0xffb347), emit_k=3.5)
    simple_mat("M_GlowWarm", hexrgb(0x5a3010), rough=0.5, emit=hexrgb(0xffc070), emit_k=2.5)
    simple_mat("M_Bone", hexrgb(0xd8d0c0), rough=0.7)

# --------------------------------------------------------------------------------------------
# Prefab registry: colliders (shared solids) and classes, authored with each prefab
# --------------------------------------------------------------------------------------------
SOLIDS = {}    # prefab -> list of (shape, cx, cy, hx, hy, z0, z1, yaw) in Blender prefab space (y = back)
CLASS = {}     # prefab -> building | prop | static | pad | decal
NOTE = {}      # prefab -> short description

def sbox(name, x0, y0, x1, y1, z0, z1, yaw=0.0):
    SOLIDS.setdefault(name, []).append((0, (x0 + x1) / 2, (y0 + y1) / 2, abs(x1 - x0) / 2, abs(y1 - y0) / 2, z0, z1, yaw))

def scyl(name, cx, cy, r, z0, z1):
    SOLIDS.setdefault(name, []).append((1, cx, cy, r, r, z0, z1, 0.0))

def reg(name, cls, note=""):
    CLASS[name] = cls
    NOTE[name] = note
    SOLIDS.setdefault(name, [])

def finish(p, cls, note="", **kw):
    reg(p.name, cls, note)
    return p.finish(**kw)

# --------------------------------------------------------------------------------------------
# Scene context: the real ground, water, natural props, breakables and the game's own objects
# (stand-ins only: none of this is in the layout or the budget)
# --------------------------------------------------------------------------------------------
PALETTE_T = dict(   # world/palette.ts (sRGB hex)
    arcadia=dict(grass=0x3fae4a, grass2=0x8fd14f, rock=0x6f7d74, rock2=0x9aa39c, sand=0xf2d58a, bed=0x2e7f78, bands=None),
    hollowmere=dict(grass=0x4f5a3c, grass2=0x6e6a4a, rock=0x4a4258, rock2=0x6c6080, sand=0x6b5f55, bed=0x2b2633, bands=None),
    meridian=dict(grass=0x9a6a3c, grass2=0xb8854a, rock=0xa8452c, rock2=0xc9663a, sand=0xf0e6d8, bed=0xd8d0c4,
                  bands=[0xb24a2c, 0xd27a44, 0x8e3524, 0xe09a5a, 0xa5402a]),
)[BODY]

def _mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

def _smooth(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)

def terrain_color(h_abs, flat, nz):
    """world/palette.ts terrainColor, in Python (linear rgb)."""
    p = PALETTE_T
    h = h_abs - WATER
    rock = _mix(hexrgb(p["rock"]), hexrgb(p["rock2"]), 0.5 + 0.5 * nz)
    if p["bands"]:
        bi = math.floor((h_abs + 50) / 6)
        rock = _mix(hexrgb(p["bands"][bi % len(p["bands"])]), rock, 0.25)
    grass = _mix(hexrgb(p["grass"]), hexrgb(p["grass2"]), 0.5 + 0.5 * nz)
    rk = 1 - _smooth(0.72, 0.9, flat)
    c = _mix(grass, rock, rk)
    sand_t = 1 - _smooth(0.6, 1.8, h)
    c = _mix(c, hexrgb(p["sand"]), sand_t * (1 - rk * 0.6))
    if h < -0.4:
        c = _mix(hexrgb(p["sand"]), hexrgb(p["bed"]), _smooth(-0.4, -4, h))
    return c

def vnoise(e, n):
    return math.sin(e * 0.37 + math.sin(n * 0.21) * 2.1) * 0.5 + math.sin(n * 0.43 + math.cos(e * 0.17) * 1.7) * 0.5

def build_ground(extent=150.0, step=1.0):
    k = int(extent / step)
    verts, cols = [], []
    idx = {}
    for j in range(-k, k + 1):
        for i in range(-k, k + 1):
            e, n = i * step, j * step
            if math.hypot(e, n) > extent + step:
                continue
            idx[(i, j)] = len(verts)
            verts.append(surf(e, n, ground(e, n)))
    faces = []
    for j in range(-k, k):
        for i in range(-k, k):
            q = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            if all(x in idx for x in q):
                faces.append(tuple(idx[x] for x in q))
    me = bpy.data.meshes.new("ground")
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate()
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    me.update()
    me.calc_normals_split() if hasattr(me, "calc_normals_split") else None
    rev = {v: kk for kk, v in idx.items()}
    for vi, v in enumerate(me.vertices):
        i, j = rev[vi]
        e, n = i * step, j * step
        nrm = v.normal
        upv = up_of(e, n)
        flat = abs(nrm.dot(upv))
        c = terrain_color(ground(e, n), flat, vnoise(e, n))
        ca.data[vi].color = (*c, 1)
    for p in me.polygons:
        p.use_smooth = True
    m = bpy.data.materials.new("M_Ground")
    m.use_nodes = True
    nt = m.node_tree
    b = bsdf(m)
    at = nt.nodes.new("ShaderNodeVertexColor"); at.layer_name = "Col"
    noise = nt.nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 0.6; noise.inputs["Detail"].default_value = 6
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeMapRange"); ramp.inputs["To Min"].default_value = 0.82; ramp.inputs["To Max"].default_value = 1.12
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"; mul.inputs["Factor"].default_value = 1.0
    nt.links.new(at.outputs["Color"], mul.inputs["A"])
    nt.links.new(ramp.outputs["Result"], mul.inputs["B"])
    nt.links.new(mul.outputs["Result"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.95
    bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.25
    n2 = nt.nodes.new("ShaderNodeTexNoise"); n2.inputs["Scale"].default_value = 9.0
    nt.links.new(tc.outputs["Object"], n2.inputs["Vector"])
    nt.links.new(n2.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    me.materials.append(m)
    o = bpy.data.objects.new("ground", me)
    P.SC.collection.objects.link(o)
    # the rest of the planet (below the horizon beyond the grid)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=R + PADH - 1.5, location=C)
    sph = bpy.context.active_object
    sph.name = "planet"
    sm = bpy.data.materials.new("M_Planet"); sm.use_nodes = True
    bsdf(sm).inputs["Base Color"].default_value = (*terrain_color(PADH + 2, 1.0, 0.0), 1)
    bsdf(sm).inputs["Roughness"].default_value = 0.95
    sph.data.materials.append(sm)
    log("ground", len(verts), "verts")
    return o

def build_water(extent=150.0, step=3.0):
    k = int(extent / step)
    verts, faces, idx = [], [], {}
    for j in range(-k, k + 1):
        for i in range(-k, k + 1):
            e, n = i * step, j * step
            if math.hypot(e, n) > extent + step:
                continue
            idx[(i, j)] = len(verts)
            verts.append(surf(e, n, WATER))
    for j in range(-k, k):
        for i in range(-k, k):
            q = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            if all(x in idx for x in q):
                # only where the ground reaches below the water nearby
                if min(ground(i * step + a, j * step + b) for a in (0, step) for b in (0, step)) < WATER + 0.2:
                    faces.append(tuple(idx[x] for x in q))
    me = bpy.data.meshes.new("water")
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate()
    for p in me.polygons:
        p.use_smooth = True
    look = dict(arcadia=(0x3fe0c8, 0x0d5a78), hollowmere=(0x2f8a80, 0x101a30), meridian=(0x4fd0c8, 0x135c6a))[BODY]
    m = bpy.data.materials.new("M_Water"); m.use_nodes = True
    b = bsdf(m)
    b.inputs["Base Color"].default_value = (*hexrgb(look[1]), 1)
    b.inputs["Roughness"].default_value = 0.06
    b.inputs["IOR"].default_value = 1.33
    try:
        b.inputs["Coat Weight"].default_value = 0.0
    except Exception:
        pass
    b.inputs["Alpha"].default_value = 0.82
    try:
        m.surface_render_method = "BLENDED"
    except Exception:
        pass
    nt = m.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 1.2; nz.inputs["Detail"].default_value = 4
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.08
    nt.links.new(nz.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    me.materials.append(m)
    o = bpy.data.objects.new("water", me)
    P.SC.collection.objects.link(o)
    return o

# Natural props (render/vegetationModels.ts) with the body's tints (render/propGeometry.ts).
VEG_MODELS = dict(
    oak=["CommonTree_1", "CommonTree_2", "CommonTree_3"], pine=["Pine_1", "Pine_2", "Pine_3"],
    bush=["Bush_Common", "Bush_Common_Flowers"], rock=["Rock_Medium_1", "Rock_Medium_2", "Rock_Medium_3"],
    boulder=["Rock_Medium_1", "Rock_Medium_2", "Rock_Medium_3"], deadtree=["DeadTree_1", "DeadTree_2", "DeadTree_3"],
    reed=["Plant_1_Big", "Plant_1"], scrub=["Plant_7", "Plant_7_Big"], fern=["Fern_1"],
    flower=["Flower_3_Group", "Flower_4_Group"], mushroom=["Mushroom_Common", "Mushroom_Laetiporus"],
)
if BODY == "hollowmere":
    VEG_MODELS["oak"] = ["TwistedTree_1", "TwistedTree_2", "TwistedTree_3"]
VEG_H = dict(oak=6.5, pine=8.5, bush=1.1, rock=0.9, boulder=2.3, deadtree=6.0, reed=1.7, scrub=0.9, fern=0.8, flower=0.65, mushroom=0.45)
_VEG = {}

def veg_mesh(model, kind):
    key = (model, kind)
    if key in _VEG:
        return _VEG[key]
    parts = P.kit(model, NAT)
    objs = []
    for me in parts:
        m2 = me.copy()
        objs.append(bpy.data.objects.new("v", m2))
    for o in objs:
        P.SC.collection.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    me = o.data
    zs = [v.co.z for v in me.vertices]
    hgt = max(zs) - min(zs)
    me.transform(S(VEG_H[kind] / max(hgt, 1e-3)))
    # body tints: leaves/needles/flowers/rocks/bark (copies of the kit materials)
    for i, m in enumerate(me.materials):
        if m is None:
            continue
        nm = m.name
        tint = None
        if "Leaves" in nm or "Leaf" in nm:
            tint = hexrgb(LOOK["pine"] if kind == "pine" else LOOK["leaf"][0])
        elif "Bark" in nm:
            tint = hexrgb(LOOK["dead"] if kind == "deadtree" else LOOK["bark"])
        elif "Rock" in nm:
            tint = hexrgb(LOOK["rock"][0])
        elif "Grass" in nm or "Plant" in nm:
            tint = hexrgb(LOOK["reed"] if kind == "reed" else LOOK["scrub"])
        if tint:
            key2 = f"{nm}__{BODY}_{kind}"
            mm = bpy.data.materials.get(key2)
            if mm is None:
                mm = m.copy(); mm.name = key2
                nt_ = mm.node_tree; b_ = bsdf(mm)
                lk_ = list(b_.inputs["Base Color"].links)
                if lk_:
                    bw = nt_.nodes.new("ShaderNodeRGBToBW")
                    src_ = lk_[0].from_socket
                    nt_.links.remove(lk_[0])
                    nt_.links.new(src_, bw.inputs[0])
                    nt_.links.new(bw.outputs[0], b_.inputs["Base Color"])
                tint_material(mm, tuple(min(1.0, x * 2.4) for x in tint))
            me.materials[i] = mm
    P.SC.collection.objects.unlink(o)
    _VEG[key] = me
    return me

def spire_mesh(seed):
    mb = MB()
    bands = [0xb24a2c, 0xd27a44, 0x8e3524, 0xe09a5a, 0xa5402a]
    for s in range(7):
        h = 15 / 7
        r0 = 1.8 - (s / 7) * 1.3
        r1 = 1.8 - ((s + 1) / 7) * 1.3
        off = (((seed * 31 + s * 17) % 100) / 100 - 0.5) * 0.25
        mat = f"M_Band{s % 5}"
        if mat not in P.MATS:
            simple_mat(mat, hexrgb(bands[s % 5]), rough=0.9)
        tmp = MB()
        frustum(tmp, r0, r1, 0, h, 6, mat)
        mb.extend(tmp, T(off, -off, h * s))
    return mb.mesh(f"spire{seed}")

PROP_DROPS = set()   # indices of natural props removed by the outpost (visual-only, PROPS_VERSION bump)

def place_props(keep_out):
    """Instance every rendered natural prop near pad 0, except those `keep_out(e, n, r)` rejects."""
    coll = bpy.data.collections.new("props")
    P.SC.collection.children.link(coll)
    nkeep = 0
    for i, p in enumerate(SITE["props"]):
        kind = p["kind"]
        rr = {"oak": 1.2, "pine": 1.0, "deadtree": 0.9, "spire": 1.8, "boulder": 1.7, "rock": 0.7}.get(kind, 0.4) * p["scale"]
        if keep_out(p["east"], p["north"], rr):
            PROP_DROPS.add(i)
            continue
        if kind == "spire":
            me = spire_mesh(i)
        else:
            models = VEG_MODELS.get(kind)
            if not models:
                continue
            v = int((abs(p["yaw"]) * 1e4)) % len(models)
            me = veg_mesh(models[v], kind)
        o = bpy.data.objects.new(f"prop_{kind}_{i}", me)
        o.matrix_world = surf_matrix(p["east"], p["north"], math.degrees(p["yaw"]), h=p["h"] - 0.03, scale=p["scale"])
        coll.objects.link(o)
        nkeep += 1
    log(f"natural props: {nkeep} kept, {len(PROP_DROPS)} cleared by the outpost")

# Breakables (client breakableIntact.ts palette, collider-sized shapes).
BRK_PAL = dict(
    arcadia=dict(wood=0xd8a560, wood2=0xb37d3e, frame=0xa06a36, barrel=0x2fb3a3, band=0x3b3b44, stone=0xd8d0bc, figure=0x4a7fd0, figure2=0xf2c14e, wall=0x8a96a8),
    hollowmere=dict(wood=0x7a6250, wood2=0x5e4a3a, frame=0x45382e, barrel=0x4a3a30, band=0x24242c, stone=0x7c7290, figure=0xd8d0c0, figure2=0x7f9478, wall=0xc8c0b0),
    meridian=dict(wood=0x5c636c, wood2=0x515860, frame=0xffb347, barrel=0xd88a2a, band=0x2a2e34, stone=0xb4aa9a, figure=0xc8d0d8, figure2=0xe8eef4, wall=0xb0a898),
)[BODY]

def bmat(key):
    name = f"M_Brk_{key}"
    if name not in P.MATS:
        simple_mat(name, hexrgb(BRK_PAL[key]), rough=0.8)
    return name

def breakable_mesh(b):
    mb = MB()
    k = b["kind"]
    hx, hz, h = b["hx"], b["hz"], b["h"]
    if k == "crate":
        box(mb, -hx, -hz, 0, hx, hz, h, bmat("wood"))
        for z in (0.02, h - 0.1):
            box(mb, -hx - 0.02, -hz - 0.02, z, hx + 0.02, hz + 0.02, z + 0.08, bmat("frame"))
    elif k in ("barrel", "fueldrum"):
        frustum(mb, hx * 0.9, hx, 0, h / 2, 12, bmat("barrel")); frustum(mb, hx, hx * 0.9, h / 2, h, 12, bmat("barrel"), cap=True)
        for z in (0.12, h - 0.18):
            frustum(mb, hx * 0.96 + 0.01, hx * 0.96 + 0.01, z, z + 0.05, 12, bmat("band"))
    elif k == "fence":
        for x in (-hx + 0.08, hx - 0.08):
            box(mb, x - 0.07, -0.07, 0, x + 0.07, 0.07, h, bmat("wood2"))
        for z in (0.35, 0.8):
            box(mb, -hx, -hz * 0.5, z, hx, hz * 0.5, z + 0.14, bmat("wood"))
    elif k == "pillar":
        frustum(mb, hx, hx * 0.92, 0.3, 3.9, 10, bmat("stone"))
        box(mb, -0.42, -0.42, 0, 0.42, 0.42, 0.3, bmat("stone")); box(mb, -0.42, -0.42, 3.9, 0.42, 0.42, 4.2, bmat("stone"))
    elif k == "statue":
        box(mb, -0.45, -0.45, 0, 0.45, 0.45, 0.5, bmat("stone"))
        frustum(mb, 0.38, 0.3, 0.5, 1.85, 8, bmat("figure")); frustum(mb, 0.3, 0.22, 1.85, 2.4, 8, bmat("figure"))
        frustum(mb, 0.2, 0.0, 2.35, 2.75, 6, bmat("figure2"))
    elif k == "campwall":
        box(mb, -hx, -hz, 0, hx, hz, h, bmat("wall"))
        for i in range(8):
            x0 = -hx + i * (2 * hx / 8)
            box(mb, x0, -hz - 0.01, h - 0.35, x0 + hx / 8, hz + 0.01, h - 0.15, bmat("frame") if i % 2 else bmat("band"))
    else:
        box(mb, -hx, -hz, 0, hx, hz, h, bmat("stone"))
    return mb.mesh("brk_" + b["id"])

def place_breakables():
    coll = bpy.data.collections.new("breakables")
    P.SC.collection.children.link(coll)
    for b in SITE["breakables"]:
        me = breakable_mesh(b)
        o = bpy.data.objects.new("brk_" + b["id"], me)
        r = Vector(b["right"]); u = Vector(b["up"]); f = Vector(b["fwd"])
        # breakable local frame: x = right, y = up, z = forward (three) -> Blender: x right, y = -forward? use basis
        M = Matrix((r, -f, u)).transposed().to_4x4()
        M.translation = Vector(b["base"]) - Vector((0, 0, 0.0))
        o.matrix_world = M
        coll.objects.link(o)
    log("breakables", len(SITE["breakables"]))

def figure(name, colors, h=1.75):
    """A game avatar stand-in (body, head, hat)."""
    mb = MB()
    for i, (key, rgb) in enumerate(colors.items()):
        simple_mat(f"M_fig_{key}", hexrgb(rgb), rough=0.7)
    frustum(mb, 0.16, 0.18, 0, 0.85, 8, "M_fig_legs")
    frustum(mb, 0.22, 0.26, 0.85, 1.42, 8, "M_fig_body")
    tmp = MB(); frustum(tmp, 0.0, 0.0, 0, 0, 3, "M_fig_skin")
    frustum(mb, 0.13, 0.14, 1.42, 1.52, 8, "M_fig_skin")
    frustum(mb, 0.15, 0.13, 1.52, 1.75, 8, "M_fig_skin", cap=True)
    frustum(mb, 0.3, 0.16, 1.7, 1.82, 10, "M_fig_hat", cap=True)
    return mb.mesh(name)

GAME = {}   # fixed features in the site frame

def place_game_objects():
    """Stand-ins for the game's own objects at pad 0: safe ring, beam, portal ring/disc/label, guide."""
    coll = bpy.data.collections.new("game")
    P.SC.collection.children.link(coll)
    def add(name, me, M):
        o = bpy.data.objects.new(name, me); o.matrix_world = M; coll.objects.link(o); return o
    simple_mat("M_SafeRing", hexrgb(0x72f1b8), rough=0.5, emit=hexrgb(0x72f1b8), emit_k=1.6, alpha=0.55)
    simple_mat("M_Beam", hexrgb(0xffd8a8), rough=0.5, emit=hexrgb(0xffd8a8), emit_k=0.35, alpha=0.12)
    simple_mat("M_Portal", hexrgb(0xffd8a8), rough=0.5, emit=hexrgb(0xffd8a8), emit_k=4.0)
    simple_mat("M_PortalDisc", hexrgb(0xffd8a8), rough=0.5, emit=hexrgb(0xffd8a8), emit_k=0.9, alpha=0.35)
    # safe ring torus at PAD_SAFE_RADIUS, 0.3 m above the pad (follows the pad's tangent plane like the game)
    bpy.ops.mesh.primitive_torus_add(major_radius=12.0, minor_radius=0.08, major_segments=96, minor_segments=6, location=(0, 0, 0.3))
    t = bpy.context.active_object; t.name = "safe_ring"; t.data.materials.append(P.MATS["M_SafeRing"])
    P.SC.collection.objects.unlink(t); coll.objects.link(t)
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.25, depth=60, location=(0, 0, 30), end_fill_type="NOTHING")
    bm_ = bpy.context.active_object; bm_.name = "beam"; bm_.data.materials.append(P.MATS["M_Beam"])
    P.SC.collection.objects.unlink(bm_); coll.objects.link(bm_)
    # portal home
    pt = SITE["portals"][0]
    base = Vector(pt["base"]); ctr = Vector(pt["center"]); face = Vector(pt["facing"])
    GAME["portal"] = (pt["east"], pt["north"])
    right = face.cross(Vector((0, 0, 1))).normalized()
    M = Matrix((right, Vector((0, 0, 1)).cross(right) * -1, Vector((0, 0, 1)))).transposed().to_4x4()
    bpy.ops.mesh.primitive_torus_add(major_radius=2.2, minor_radius=0.16, major_segments=48, minor_segments=12)
    ring = bpy.context.active_object; ring.name = "portal_ring"; ring.data.materials.append(P.MATS["M_Portal"])
    ring.matrix_world = Matrix.Translation(ctr) @ Matrix.Rotation(math.radians(90), 4, "X")
    bpy.ops.mesh.primitive_circle_add(vertices=40, radius=2.05, fill_type="NGON")
    disc = bpy.context.active_object; disc.name = "portal_disc"; disc.data.materials.append(P.MATS["M_PortalDisc"])
    disc.matrix_world = Matrix.Translation(ctr) @ Matrix.Rotation(math.radians(90), 4, "X")
    for o in (ring, disc):
        P.SC.collection.objects.unlink(o); coll.objects.link(o)
    # label "PORTUS" 3.2 m above the ring centre, facing the pad
    cu = bpy.data.curves.new("label", "FONT"); cu.body = "PORTUS"; cu.size = 0.9; cu.align_x = "CENTER"; cu.extrude = 0.0
    lab = bpy.data.objects.new("portal_label", cu)
    simple_mat("M_Label", (1, 1, 1), emit=(1.0, 0.85, 0.7), emit_k=2.0)
    cu.materials.append(P.MATS["M_Label"])
    lab.matrix_world = Matrix.Translation(ctr + Vector((0, 0, 3.2))) @ Matrix.Rotation(math.radians(90), 4, "X")
    coll.objects.link(lab)
    # guide on the pad
    g = next(o for o in SITE["objects"] if o["look"] == "guide")
    GAME["guide"] = (g["east"], g["north"])
    gcol = dict(arcadia=dict(legs=0x6a5a3a, body=0x4f8a3a, skin=0xe8c4a0, hat=0xd8b860),
                hollowmere=dict(legs=0x2a2430, body=0x3a3248, skin=0xd8c8b8, hat=0x24202c),
                meridian=dict(legs=0x3a3f47, body=0xe07a2a, skin=0xc89a78, hat=0x3a3f47))[BODY]
    add("guide", figure("guide_fig", gcol), surf_matrix(g["east"], g["north"], 200.0, h=PADH + 0.02))
    log("game objects: portal", GAME["portal"], "guide", GAME["guide"])

# ============================================================================================
# Shared geometry helpers
# ============================================================================================
def cyl(mb, M, r, z0, z1, n=10, mat="MI_RockTrim", mode="planar", band=None, cap=True, r1=None):
    tmp = MB()
    frustum(tmp, r, r if r1 is None else r1, z0, z1, n, mat, mode=mode, band=band, cap=cap)
    mb.extend(tmp, M)

def ring_cells(mb, radii, segs, z, cell, a0=0.0, zf=None):
    """Flat disc partitioned into rings (radii ascending, radii[0] may be 0) and `segs` sectors;
    cell(ring, seg, a_mid) -> (material, mode, band) or None. Planar UVs, face up. zf(r) optional height."""
    zf = zf or (lambda r: z)
    for ri in range(len(radii) - 1):
        r0, r1 = radii[ri], radii[ri + 1]
        for si in range(segs):
            a = a0 + 2 * math.pi * si / segs
            b = a0 + 2 * math.pi * (si + 1) / segs
            spec = cell(ri, si, (a + b) / 2)
            if spec is None:
                continue
            mat, mode, band = spec
            if r0 < 1e-6:
                pts = [(0, 0, zf(0)), (r1 * math.cos(a), r1 * math.sin(a), zf(r1)), (r1 * math.cos(b), r1 * math.sin(b), zf(r1))]
            else:
                pts = [(r0 * math.cos(a), r0 * math.sin(a), zf(r0)), (r1 * math.cos(a), r1 * math.sin(a), zf(r1)),
                       (r1 * math.cos(b), r1 * math.sin(b), zf(r1)), (r0 * math.cos(b), r0 * math.sin(b), zf(r0))]
            if mode == "band":
                # radial band mapping: u along the arc, v across the ring
                L = (b - a) * (r0 + r1) / 2
                v0, v1 = P.BAND[band]
                uo = si * L / 4
                uvs = [(uo, v0), (uo, v1), (uo + L / 4, v1), (uo + L / 4, v0)] if r0 > 1e-6 else [(uo, v0), (uo, v1), (uo + L / 4, v1)]
                mb.face(pts, mat, uvs)
            else:
                quad(mb, pts, mat, mode=mode, band=band)

def star_poly(n, r_in, r_out, a0=math.pi / 2):
    pts = []
    for i in range(2 * n):
        r = r_out if i % 2 == 0 else r_in
        a = a0 + math.pi * i / n
        pts.append((r * math.cos(a), r * math.sin(a)))
    return pts

def flat_poly(mb, M, poly, mat, both=True, band=None, mode="pal"):
    """A thin flat shape in the local XZ plane (front -Y), both faces."""
    pts = [M @ Vector((x, 0, z)) for x, z in poly]
    uv = [pal_uv(band)] * len(pts) if mode == "pal" else [(x / 2, z / 2) for x, z in poly]
    mb.face(list(reversed(pts)), mat, list(reversed(uv)))
    if both:
        pts2 = [M @ Vector((x, 0.02, z)) for x, z in poly]
        mb.face(pts2, mat, uv)

def sun_disc(mb, M, r=0.6, rays=12, mat="M_Brass"):
    """Golden sun: a disc and pointed rays in the local XZ plane (front -Y), slightly thick."""
    disc = [(r * math.cos(2 * math.pi * k / 16), r * math.sin(2 * math.pi * k / 16)) for k in range(16)]
    flat_poly(mb, M @ T(0, -0.03, 0), disc, mat, mode="planar")
    for k in range(rays):
        a = 2 * math.pi * k / rays
        w = math.pi / rays * 0.55
        tri = [((r * 0.92) * math.cos(a - w), (r * 0.92) * math.sin(a - w)), (r * 1.75 * math.cos(a), r * 1.75 * math.sin(a)),
               ((r * 0.92) * math.cos(a + w), (r * 0.92) * math.sin(a + w))]
        flat_poly(mb, M @ T(0, -0.02, 0), tri, mat, mode="planar")

def hanging_lantern(mb, M, glow="M_GlowWarm", s=1.0):
    """Iron cage lantern hanging from a short chain (origin = hook point)."""
    oriented_box(mb, M @ T(0, 0, -0.25 * s), 0.03, 0.03, 0.25 * s, "MI_MetalOrnaments")
    oriented_box(mb, M @ T(0, 0, -0.33 * s), 0.26 * s, 0.26 * s, 0.07 * s, "MI_MetalOrnaments")
    oriented_box(mb, M @ T(0, 0, -0.71 * s), 0.2 * s, 0.2 * s, 0.38 * s, glow)
    oriented_box(mb, M @ T(0, 0, -0.79 * s), 0.26 * s, 0.26 * s, 0.08 * s, "MI_MetalOrnaments")
    for sx in (-1, 1):
        for sy in (-1, 1):
            oriented_box(mb, M @ T(sx * 0.12 * s, sy * 0.12 * s, -0.72 * s), 0.035, 0.035, 0.4 * s, "MI_MetalOrnaments")

def plank_door(mb, M, w, h, band="dark"):
    """Plank door leaf on the local XZ plane (front -Y) with two iron bands."""
    oriented_box(mb, M @ T(0, 0, 0), w, 0.08, h, "MI_WoodTrim", mode="band", band=band)
    for z in (h * 0.2, h * 0.72):
        oriented_box(mb, M @ T(0, -0.05, z), w * 0.94, 0.03, 0.08, "MI_MetalOrnaments")

def slate_roof(mb, w, d, z, rise, over=0.45, mat="MI_RockTrim", ridge="y", courses=7, gable_mat="MI_UnevenBrick", gables=True):
    """Gable roof of overlapping slate courses (custom: the kit's tile roofs are terracotta).
    Ridge along y (or x). Walls below at |x| <= w/2, |y| <= d/2; eaves at z."""
    if ridge == "x":
        tmp = MB()
        slate_roof(tmp, d, w, z, rise, over, mat, "y", courses, gable_mat, gables)
        mb.extend(tmp, Rz(90))
        return
    hw = w / 2 + over
    L = d / 2 + over
    zt = z + rise * (hw / (w / 2))
    zb = z - rise * (over / (w / 2))
    for side in (-1, 1):
        for c in range(courses):
            t0, t1 = c / courses, (c + 1) / courses
            x0 = side * hw * (1 - t0); x1 = side * hw * (1 - t1)
            z0 = zb + (zt - zb) * t0; z1 = zb + (zt - zb) * t1
            lip = 0.06
            pts = [(x0, -L, z0 - lip), (x0, L, z0 - lip), (x1, L, z1), (x1, -L, z1)]
            if side < 0:
                pts = [pts[1], pts[0], pts[3], pts[2]]
            quad(mb, pts, mat, mode="band", band="slab", tileu=3.0)
            # course edge (thickness)
            e = [(x0, -L, z0 - lip - 0.07), (x0, L, z0 - lip - 0.07), (x0, L, z0 - lip), (x0, -L, z0 - lip)]
            if side < 0:
                e = [e[1], e[0], e[3], e[2]]
            quad(mb, e, mat, mode="band", band="ashlar", tileu=3.0)
        # underside
        pts = [(side * hw, -L, zb - 0.1), (0, -L, zt - 0.1), (0, L, zt - 0.1), (side * hw, L, zb - 0.1)]
        if side > 0:
            pts = list(reversed(pts))
        quad(mb, pts, "MI_WoodTrim", mode="band", band="dark")
    # ridge cap
    box(mb, -0.14, -L, zt - 0.05, 0.14, L, zt + 0.12, mat, mode="band", band="ashlar")
    # verge ends (closed triangles) and gables
    for sy in (-1, 1):
        tri = [(-hw, sy * L, zb - 0.1), (hw, sy * L, zb - 0.1), (0, sy * L, zt - 0.1)]
        if sy > 0:
            tri = list(reversed(tri))
        mb.face(tri, mat, P.uv_planar(tri, Vector((0, sy, 0))))
        if gables:
            g = [(-w / 2, sy * d / 2, z), (w / 2, sy * d / 2, z), (0, sy * d / 2, z + rise)]
            if sy > 0:
                g = list(reversed(g))
            mb.face(g, gable_mat, P.uv_planar(g, Vector((0, sy, 0))))

def low_wall(mb, x0, x1, y, h=1.0, t=0.6, mat="MI_RockTrim", band="field", cap=True):
    box(mb, x0, y - t / 2, -0.5, x1, y + t / 2, h, mat, mode="band", band=band, skip=("-z",))
    if cap:
        box(mb, x0 - 0.05, y - t / 2 - 0.06, h, x1 + 0.05, y + t / 2 + 0.06, h + 0.12, "MI_RockTrim", mode="band", band="slab", skip=("-z",))

def solid_from_footprint(name, top, pad=0.0):
    info = P.PREFAB_INFO[name]
    (x0, y0), (x1, y1) = info["gmin"], info["gmax"]
    sbox(name, x0 - pad, y0 - pad, x1 + pad, y1 + pad, 0.0, top)

# ============================================================================================
# Pad platforms (every pad), pad-0 gates and the waystones (other pads)
# ============================================================================================
def apron_z(r):
    """The flat ground around a pad falls away with the curve: decal height at radius r (m)."""
    return -r * r / (2 * R) + 0.03

def pad_shell(mb, rim_mat, rim_band):
    """The game pad's envelope: top r 8 at +0.02, bevelled side to r 8.6 at -0.58."""
    frustum(mb, 8.45, 8.0, apron_z(8.45), 0.02, 64, rim_mat, mode="band", band=rim_band)
    frustum(mb, 8.6, 8.45, -0.58, apron_z(8.45), 64, rim_mat, mode="band", band=rim_band)

def build_pad_platform():
    name = f"{B}_pad"
    p = P.Prefab(name, lod="pad")
    mb = p.mb
    zap = lambda r: 0.02
    if BODY == "arcadia":
        # Dawnpad: sandstone flags, a brass sunburst of 12 rays, dressed rim, paved apron.
        radii = [0, 1.3, 1.5, 4.4, 4.7, 7.2, 8.0]
        def cell(ri, si, am):
            if ri == 0: return ("M_Brass", "planar", None)
            if ri == 1: return ("MI_RockTrim", "band", "slab")
            if ri == 2:
                ray = (si % 4) in (0,)
                return ("M_Brass", "planar", None) if ray else ("MI_Brick", "planar", None)
            if ri == 3: return ("MI_RockTrim", "band", "slab")
            if ri == 4: return ("MI_Brick", "planar", None)
            return ("MI_RockTrim", "band", "ashlar")
        ring_cells(mb, radii, 48, 0.02, cell, a0=-math.pi / 48 * 1.5)
        pad_shell(mb, "MI_RockTrim", "ashlar")
        ring_cells(mb, [8.45, 10.0, 10.35], 48, 0, lambda ri, si, am: ("MI_Brick", "planar", None) if ri == 0 else ("MI_RockTrim", "band", "slab"), zf=apron_z)
    elif BODY == "hollowmere":
        # Lanternfall: dark slate, two teal grave-light inlay rings, an eight-point rosette.
        radii = [0, 1.0, 1.15, 3.3, 3.42, 6.3, 6.42, 7.2, 8.0]
        def cell(ri, si, am):
            if ri == 0: return ("MI_UnevenBrick", "planar", None)
            if ri in (1, 3, 5): return ("M_Bone", "planar", None) if ri != 1 else ("MI_RockTrim", "band", "slab")
            if ri == 2: return ("MI_RockTrim", "band", "slab") if si % 6 < 3 else ("MI_UnevenBrick", "planar", None)
            if ri == 4: return ("MI_UnevenBrick", "planar", None)
            if ri == 6: return ("MI_RockTrim", "band", "slab")
            return ("MI_RockTrim", "band", "ashlar")
        ring_cells(mb, radii, 48, 0.02, cell)
        pad_shell(mb, "MI_RockTrim", "ashlar")
        ring_cells(mb, [8.45, 10.0, 10.35], 48, 0, lambda ri, si, am: ("MI_UnevenBrick", "planar", None) if ri == 0 else ("MI_RockTrim", "band", "slab"), zf=apron_z)
    else:
        # Waystation Nine: a light composite deck, dark panel rings, a teal light strip and an
        # amber/black hazard rim; the hex glyph at the centre.
        radii = [0, 1.6, 1.75, 5.0, 5.4, 6.85, 7.0, 7.4, 8.0]
        def cell(ri, si, am):
            if ri == 0: return ("MI_Trim_01", "planar", None)
            if ri == 1: return ("M_GlowAmber", "planar", None)
            if ri == 2: return ("MI_Trim_03_Deck", "planar", None)
            if ri == 3: return ("MI_Trim_01", "planar", None)
            if ri == 4: return ("MI_Trim_03_Deck", "planar", None)
            if ri == 5: return ("M_GlowAmber", "planar", None)
            if ri == 6: return ("MI_Trim_01", "planar", None)
            return ("M_Cloth", "pal", "gold") if si % 2 == 0 else ("M_Cloth", "pal", "dark")
        ring_cells(mb, radii, 64, 0.02, cell)
        pad_shell(mb, "MI_Trim_01", "slab")
        ring_cells(mb, [8.45, 10.0, 10.35], 64, 0, lambda ri, si, am: ("MI_RockTrim", "band", "slab") if ri == 0 else ("MI_Trim_01", "planar", None), zf=apron_z)
    return finish(p, "pad", "landing platform (visual only: same top height and footprint as the game's pad)")

def build_waystone():
    """Marker beside every other pad (r 9.6 on the pad's south side): cheap, instanced."""
    name = f"{B}_waystone"
    p = P.Prefab(name, lod="waystone")
    mb = p.mb
    if BODY == "arcadia":
        box(mb, -0.45, -0.3, -0.4, 0.45, 0.3, 0.15, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
        prism(mb, [(-0.32, -0.18), (0.32, -0.18), (0.36, 0.18), (-0.36, 0.18)], 0.15, 1.75, "MI_RockTrim", mode="band", band="ashlar")
        frustum(mb, 0.34, 0.12, 1.75, 2.0, 4, "MI_RockTrim", mode="band", band="slab", a0=math.pi / 4)
        sun_disc(mb, T(0, -0.2, 1.35), r=0.17)
        scyl(name, 0, 0, 0.45, 0, 2.0)
    elif BODY == "hollowmere":
        box(mb, -0.35, -0.35, -0.4, 0.35, 0.35, 0.3, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
        box(mb, -0.07, -0.07, 0.3, 0.07, 0.07, 2.9, "MI_MetalOrnaments")
        box(mb, -0.07, -0.65, 2.75, 0.07, 0.07, 2.85, "MI_MetalOrnaments")
        hanging_lantern(mb, T(0, -0.58, 2.75), "M_GlowTeal")
        scyl(name, 0, 0, 0.36, 0, 2.9)
    else:
        box(mb, -0.4, -0.4, -0.4, 0.4, 0.4, 0.2, "MI_RockTrim", mode="band", band="slab")
        frustum(mb, 0.22, 0.14, 0.2, 2.4, 6, "MI_Trim_03")
        frustum(mb, 0.2, 0.2, 2.4, 2.75, 6, "M_GlowAmber", cap=True)
        frustum(mb, 0.25, 0.25, 0.9, 1.0, 6, "MI_Trim_01")
        scyl(name, 0, 0, 0.4, 0, 2.75)
    return finish(p, "prop", "marker beside pads 1..n")

def portal_dais(mb, top_mat, rim_mat, rim_band, inlay=None):
    """Replaces the game's portal base (cylinder r 2.6-3.0, top 0.2 above the pad): same top height."""
    radii = [0, 2.2, 2.45, 2.85, 3.15]
    def cell(ri, si, am):
        if ri == 0: return None   # under the ring: the game's glowing disc stands here; keep the stone below it
        if ri == 2 and inlay: return (inlay, "planar", None)
        return (top_mat, "planar", None) if ri < 3 else (rim_mat, "band", rim_band)
    ring_cells(mb, [0, 2.2], 32, 0.2, lambda ri, si, am: (top_mat, "planar", None))
    ring_cells(mb, radii[1:], 32, 0.2, lambda ri, si, am: cell(ri + 1, si, am))
    tmp = MB(); frustum(tmp, 3.45, 3.15, -0.35, 0.2, 32, rim_mat, mode="band", band=rim_band); mb.extend(tmp)

def build_gate():
    """Pad-0 portal gate, placed on the portal's base (portal frame: front -Y faces the pad)."""
    name = f"{B}_gate"
    p = P.Prefab(name, lod="gate")
    mb = p.mb
    if BODY == "arcadia":
        # The Dawn Gate: two dressed-stone posts, an oak lintel with a brass sun, green/gold banners.
        portal_dais(mb, "MI_RockTrim", "MI_RockTrim", "ashlar", inlay="M_Brass")
        for sx in (-1, 1):
            x = sx * 3.75
            box(mb, x - 0.55, -0.55, -0.4, x + 0.55, 0.55, 0.6, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
            box(mb, x - 0.4, -0.4, 0.6, x + 0.4, 0.4, 5.5, "MI_UnevenBrick")
            box(mb, x - 0.5, -0.5, 5.5, x + 0.5, 0.5, 5.75, "MI_RockTrim", mode="band", band="slab")
            box(mb, x - 0.43, -0.43, 2.4, x + 0.43, 0.43, 2.6, "MI_RockTrim", mode="band", band="slab")
            sbox(name, x - 0.55, -0.55, x + 0.55, 0.55, 0, 5.75)
            hanging_lantern(mb, T(x, -0.62, 4.9), "M_GlowWarm")
            box(mb, x - 0.05, -0.62, 4.85, x + 0.05, -0.4, 4.95, "MI_MetalOrnaments")
        box(mb, -4.6, -0.42, 5.75, 4.6, 0.42, 6.35, "MI_WoodTrim", mode="band", band="dark")
        box(mb, -4.75, -0.48, 6.35, 4.75, 0.48, 6.5, "MI_WoodTrim", mode="band", band="plank")
        for sx in (-1, 1):
            oriented_box(mb, T(sx * 3.1, 0, 5.2) @ Ry(sx * 40), 0.18, 0.3, 0.9, "MI_WoodTrim", mode="band", band="dark")
        sun_disc(mb, T(0, -0.5, 7.35), r=0.62)
        box(mb, -0.12, -0.2, 6.5, 0.12, 0.2, 6.75, "MI_WoodTrim", mode="band", band="dark")
        for sx in (-1, 1):
            P.banner(mb, T(sx * 2.85, -0.45, 5.72), 0.62, 2.1, ("green", "gold"))
    elif BODY == "hollowmere":
        # The bell gate: paired dark timber posts on stone feet, a heavy carved beam, a narrow slate
        # hood over the tolling bell above the ring, grave-light lanterns on iron arms.
        portal_dais(mb, "MI_UnevenBrick", "MI_RockTrim", "ashlar", inlay="M_Bone")
        for sx in (-1, 1):
            for sy in (-1, 1):
                x, y = sx * 3.6, sy * 0.55
                box(mb, x - 0.3, y - 0.3, -0.4, x + 0.3, y + 0.3, 0.55, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
                box(mb, x - 0.15, y - 0.15, 0.55, x + 0.15, y + 0.15, 5.6, "MI_WoodTrim", mode="band", band="dark")
            scyl(name, sx * 3.6, 0, 0.45, 0, 5.6)
            oriented_box(mb, T(sx * 3.6, 0, 2.6), 0.22, 1.3, 0.16, "MI_WoodTrim", mode="band", band="dark")
            oriented_box(mb, T(sx * 3.6, 0, 4.6), 0.22, 1.3, 0.16, "MI_WoodTrim", mode="band", band="dark")
            oriented_box(mb, T(sx * 2.85, 0, 4.9) @ Ry(sx * 45), 0.16, 0.2, 1.1, "MI_WoodTrim", mode="band", band="dark")
            # lantern on an iron arm, hanging toward the pad
            box(mb, sx * 3.6 - 0.04, -1.3, 4.3, sx * 3.6 + 0.04, -0.15, 4.38, "MI_MetalOrnaments")
            hanging_lantern(mb, T(sx * 3.6, -1.22, 4.3), "M_GlowTeal")
        box(mb, -4.25, -0.32, 5.6, 4.25, 0.32, 6.15, "MI_WoodTrim", mode="band", band="dark")
        box(mb, -4.4, -0.38, 6.15, 4.4, 0.38, 6.3, "MI_WoodTrim", mode="band", band="plank")
        for sx in (-1, 1):
            oriented_box(mb, T(sx * 4.4, 0, 5.75), 0.3, 0.5, 0.3, "MI_RockTrim", mode="band", band="slab")
        # bell hood (1.8 m wide) over the beam, the bell hanging in front of it (rim 6.4 m, well above the ring)
        tmp = MB(); slate_roof(tmp, 1.7, 1.4, 7.3, 0.9, over=0.2, ridge="y", courses=3, gables=False); mb.extend(tmp, Rz(90))
        for sx in (-1, 1):
            box(mb, sx * 0.8 - 0.09, -0.09, 6.3, sx * 0.8 + 0.09, 0.09, 7.35, "MI_WoodTrim", mode="band", band="dark")
        box(mb, -0.9, -0.1, 7.15, 0.9, 0.1, 7.3, "MI_WoodTrim", mode="band", band="dark")
        cyl(mb, T(0, 0, 7.15), 0.04, -0.35, 0.0, 6, "MI_MetalOrnaments")
        tmp = MB(); frustum(tmp, 0.55, 0.28, 0.0, 0.62, 12, "M_Brass", cap=True); frustum(tmp, 0.6, 0.55, -0.1, 0.0, 12, "M_Brass")
        mb.extend(tmp, T(0, -0.55, 6.5))
        box(mb, -0.08, -0.6, 7.1, 0.08, 0.05, 7.2, "MI_MetalOrnaments")
    else:
        # The checkpoint scanner: two white composite columns with amber strips, a beam with the
        # scanner bar and the hex-glyph sign of Meridian Oversight.
        portal_dais(mb, "MI_Trim_03", "MI_Trim_01", "slab", inlay="M_GlowAmber")
        for sx in (-1, 1):
            x = sx * 3.75
            box(mb, x - 0.65, -0.75, -0.4, x + 0.65, 0.75, 0.35, "MI_Trim_01", mode="planar")
            box(mb, x - 0.45, -0.6, 0.35, x + 0.45, 0.6, 6.2, "MI_Trim_03", mode="planar")
            box(mb, x - sx * 0.47 - 0.02, -0.25, 0.8, x - sx * 0.47 + 0.02, 0.25, 5.6, "M_GlowAmber")
            for z in (1.6, 3.2, 4.8):
                box(mb, x - 0.48, -0.63, z, x + 0.48, 0.63, z + 0.12, "MI_Trim_01")
            sbox(name, x - 0.65, -0.75, x + 0.65, 0.75, 0, 6.2)
        box(mb, -4.5, -0.6, 6.2, 4.5, 0.6, 7.0, "MI_Trim_01")
        box(mb, -2.6, -0.08, 6.05, 2.6, 0.08, 6.2, "M_GlowAmber")
        box(mb, -1.6, -0.2, 7.0, 1.6, 0.2, 8.6, "MI_Trim_03")
        hex_glyph(mb, T(0, -0.22, 7.8), 0.62)
    return finish(p, "static", "pad-0 portal gate; replaces the game's portal base (same top height)")

def hex_glyph(mb, M, r, mat="M_GlowAmber", back="MI_Trim_01"):
    """Meridian Oversight's hexagonal glyph (our own): a hex ring with a horizontal bar, front -Y."""
    outer = [(r * math.cos(math.pi / 6 + k * math.pi / 3), r * math.sin(math.pi / 6 + k * math.pi / 3)) for k in range(6)]
    inner = [(0.78 * x, 0.78 * z) for x, z in outer]
    for k in range(6):
        a, b = outer[k], outer[(k + 1) % 6]
        c, d = inner[(k + 1) % 6], inner[k]
        flat_poly(mb, M, [a, b, c, d], mat, both=False, mode="planar")
    flat_poly(mb, M, [(-0.55 * r, -0.09 * r), (0.55 * r, -0.09 * r), (0.55 * r, 0.09 * r), (-0.55 * r, 0.09 * r)], mat, both=False, mode="planar")
    flat_poly(mb, M @ T(0, 0.01, 0), [(-0.12 * r, 0.09 * r), (0.12 * r, 0.09 * r), (0.12 * r, 0.5 * r), (-0.12 * r, 0.5 * r)], mat, both=False, mode="planar")

# ============================================================================================
# Sci-fi kit (Quaternius Modular SciFi MegaKit, CC0): glTF modules whose texture URIs point at
# siblings that live in Textures/; materials are canonicalised by name like the village kit.
# ============================================================================================
_kit_village = P.kit
def _kit_any(name, src=None):
    """Portus' kit() plus 'SF:<module>' for the sci-fi kit (Prefab.k resolves kit() at call time)."""
    if name.startswith("SF:"):
        return sf(name[3:])
    return _kit_village(name, src)
P.kit = _kit_any

def sf(name):
    """Import a sci-fi module once (cached in the Portus kit cache under 'SF:<name>')."""
    key = "SF:" + name
    if key in P._MOD:
        return P._MOD[key]
    path = None
    for sub in ("Walls", "Platforms", "Columns", "Props", "Aliens"):
        cand = os.path.join(SCI, "glTF", sub, name + ".gltf")
        if os.path.exists(cand):
            path = cand
            break
    if path is None:
        raise RuntimeError("sci-fi module missing: " + name)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    out = []
    for o in new:
        if o.type == "MESH":
            me = o.data.copy()
            me.transform(o.matrix_world)
            # The kit's decal sheet carries its own fictional brand name and logo: never use it (IP line;
            # Meridian Oversight's hex glyph and our stencil lettering replace it).
            decal = {i for i, m in enumerate(me.materials) if m is not None and "Decal" in m.name}
            if decal:
                bm = bmesh.new(); bm.from_mesh(me)
                bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in decal], context="FACES")
                bm.to_mesh(me); bm.free()
            for i, m in enumerate(me.materials):
                if m is not None:
                    me.materials[i] = P.canon(m)
            while len(me.uv_layers) > 1:
                me.uv_layers.remove(me.uv_layers[-1])
            if me.uv_layers:
                me.uv_layers[0].name = "UVMap"
            me.name = "SF_" + name
            out.append(me)
    for o in new:
        bpy.data.objects.remove(o)
    # resolve textures from the kit's Textures folder
    for im in bpy.data.images:
        fp = bpy.path.abspath(im.filepath) if im.filepath else ""
        if fp and not os.path.exists(fp):
            alt = os.path.join(SCI, "Textures", os.path.basename(fp))
            if os.path.exists(alt):
                im.filepath = alt
                im.reload()
    P._MOD[key] = out
    return out

DECK_TINT = 0.82   # Meridian's pad deck: the light composite toned down (Phase B review)

def setup_scifi_materials():
    for m in ("WallAstra_Straight", "WallWindow_Straight", "TopPlastic_Straight", "Platform_Simple", "Door_Metal"):
        sf(m)
    # Glass: dark, opaque (like the village kit's window glass in Portus); metal kept low (no env map).
    if "M_Glass" in P.MATS:
        P.tune_glass(P.MATS["M_Glass"])
    for nm, m in list(P.MATS.items()):
        if nm.startswith("MI_Trim") or nm.startswith("MI_Padded"):
            try:
                b = bsdf(m)
                for l in list(b.inputs["Metallic"].links):
                    m.node_tree.links.remove(l)
                b.inputs["Metallic"].default_value = 0.15
            except StopIteration:
                pass
    deck = P.MATS["MI_Trim_03"].copy()
    deck.name = "MI_Trim_03_Deck"
    tint_material(deck, (DECK_TINT,) * 3)
    P.MATS["MI_Trim_03_Deck"] = deck
    log("sci-fi materials:", sorted(k for k in P.MATS if k.startswith("MI_Trim") or k.startswith("MI_Padded") or k.startswith("M_")))

# ============================================================================================
# Layout: placements in the pad-0 frame, ground snapping, world footprints
# ============================================================================================
LAYOUT = []
PATHS = []      # dict(name, pts=[(e, n)...], width, mat)

def put(prefab, e, n, yaw=0.0, scale=1.0, base="auto", h=None, label=None, water=False):
    LAYOUT.append(dict(prefab=prefab, east=float(e), north=float(n), yaw=float(yaw), scale=float(scale), base=base, h=h,
                       label=label or prefab, water=water))

def path(name, pts, width=2.2, mat="MI_RockTrim"):
    PATHS.append(dict(name=name, pts=[(float(a), float(b)) for a, b in pts], width=width, mat=mat))

def item_xy(it, x, y):
    s = it["scale"]
    return local_to_geo(it["east"], it["north"], it["yaw"], x * s, y * s)

def hull_world(it, key="ghull"):
    return [item_xy(it, x, y) for x, y in P.PREFAB_INFO[it["prefab"]][key]]

def resolve_bases():
    for it in LAYOUT:
        if it["h"] is not None:
            it["base_h"] = it["h"]; it["gmin"] = it["gmax"] = it["gc"] = ground(it["east"], it["north"])
            continue
        pts = hull_world(it) + [(it["east"], it["north"])]
        hs = [ground(e, n) for e, n in pts]
        gc = ground(it["east"], it["north"])
        it["gmin"], it["gmax"], it["gc"] = min(hs), max(hs), gc
        if it["base"] == "pad":
            it["base_h"] = PADH
        elif it["base"] == "max":
            it["base_h"] = max(hs) - 0.05
        elif it["base"] == "min":
            it["base_h"] = min(hs)
        else:
            it["base_h"] = max(min(hs), min(max(hs) - 0.12, gc + 0.05))

def solids_world(it):
    """Each collider solid of an item as a site polygon (east, north) + vertical span (abs heights)."""
    out = []
    s = it["scale"]
    for (shape, cx, cy, hx, hy, z0, z1, yaw) in SOLIDS.get(it["prefab"], []):
        if shape == 0:
            a = math.radians(yaw)
            corners = []
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                x = cx + sx * hx * math.cos(a) - sy * hy * math.sin(a)
                y = cy + sx * hx * math.sin(a) + sy * hy * math.cos(a)
                corners.append(item_xy(it, x, y))
            poly = corners
        else:
            poly = [item_xy(it, cx + hx * math.cos(2 * math.pi * k / 16), cy + hx * math.sin(2 * math.pi * k / 16)) for k in range(16)]
        out.append(dict(poly=poly, z0=it["base_h"] + z0 * s, z1=it["base_h"] + z1 * s, shape=shape))
    return out

def breakable_poly(b):
    r = Vector(b["right"]); f = Vector(b["fwd"])
    re = (r.x, r.y); fe = (f.x, f.y)
    ln = math.hypot(*re); re = (re[0] / ln, re[1] / ln)
    ln = math.hypot(*fe); fe = (fe[0] / ln, fe[1] / ln)
    polys = []
    def boxp(cx, cz, hx, hz):
        return [(b["east"] + (cx + sx * hx) * re[0] + (cz + sz * hz) * fe[0], b["north"] + (cx + sx * hx) * re[1] + (cz + sz * hz) * fe[1])
                for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    def circ(r_):
        return [(b["east"] + r_ * math.cos(2 * math.pi * k / 16), b["north"] + r_ * math.sin(2 * math.pi * k / 16)) for k in range(16)]
    polys.append(boxp(0, 0, b["hx"], b["hz"]) if b["shape"] == 0 else circ(b["hx"]))
    for q in b.get("parts", []):
        polys.append(boxp(0, 0, q["hx"], q["hz"]) if q["shape"] == 0 else circ(q["hx"]))
    return polys

# --- 2D geometry for validation ---
def _seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0 if L2 < 1e-12 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

def _inside(p, poly):
    x, y = p; c = False
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            c = not c
    return c

def poly_gap(a, b):
    """Distance between two convex polygons (0 if they overlap)."""
    if any(_inside(p, b) for p in a) or any(_inside(p, a) for p in b):
        return 0.0
    d = 1e9
    for p in a:
        for i in range(len(b)):
            d = min(d, _seg_dist(p, b[i], b[(i + 1) % len(b)]))
    for p in b:
        for i in range(len(a)):
            d = min(d, _seg_dist(p, a[i], a[(i + 1) % len(a)]))
    return d

def point_poly_dist(p, poly):
    if _inside(p, poly):
        return 0.0
    return min(_seg_dist(p, poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly)))

JUMP_REACH = 1.21 + 0.35   # jump apex (movement.ts) + the step band of a top (collide.ts)

def validate():
    problems, warns, stats = [], [], {}
    port = GAME["portal"]
    guide = GAME["guide"]
    brk = [(b, breakable_poly(b)) for b in SITE["breakables"]]
    min_brk = 1e9
    all_solids = []
    for idx, it in enumerate(LAYOUT):
        sw = solids_world(it)
        it["solids_w"] = sw
        for s_ in sw:
            all_solids.append((idx, s_))
        cls = CLASS.get(it["prefab"], "prop")
        r = math.hypot(it["east"], it["north"])
        # ground fit
        drop = it["base_h"] - it["gmin"]
        bury = it["gmax"] - it["base_h"]
        if cls in ("building", "static") and not it["water"] and (drop > 1.3 or bury > 0.6):
            warns.append(f"{it['label']}: slope under footprint (base {it['base_h']:.2f}, ground {it['gmin']:.2f}..{it['gmax']:.2f})")
        if not it["water"] and cls not in ("pad", "decal") and it["gc"] < WATER + 0.15:
            problems.append(f"{it['label']}: centre stands in water (ground {it['gc']:.2f})")
        for s_ in sw:
            for b, polys in brk:
                for bp in polys:
                    g = poly_gap(s_["poly"], bp)
                    min_brk = min(min_brk, g)
                    if g < 1.2:
                        problems.append(f"{it['label']}: {g:.2f} m from breakable {b['id']} ({b['kind']}): no walkable gap")
                    elif g < 2.0:
                        warns.append(f"{it['label']}: {g:.2f} m from breakable {b['id']} ({b['kind']})")
            if it["prefab"] != f"{B}_gate":
                # portal approach corridor and reach zone, the pad and the spawn ring, the guide
                d_port = min(point_poly_dist(port, s_["poly"]), 99)
                if d_port < 5.0:
                    problems.append(f"{it['label']}: {d_port:.2f} m from the portal ring")
                for k in range(11):
                    pt = (port[0] * k / 10, port[1] * k / 10)
                    if point_poly_dist(pt, s_["poly"]) < 2.6:
                        problems.append(f"{it['label']}: blocks the walk from the pad into the portal")
                        break
                if min(point_poly_dist((0, 0), s_["poly"]), 99) < 9.2:
                    problems.append(f"{it['label']}: on the pad or its rim (r < 9.2)")
                if point_poly_dist(guide, s_["poly"]) < 2.5:
                    problems.append(f"{it['label']}: crowds the guide")
    stats["min_gap_to_breakables"] = round(min_brk, 2)
    # structure-structure gaps (different items)
    min_ss = 1e9
    for i in range(len(all_solids)):
        for j in range(i + 1, len(all_solids)):
            a, sa = all_solids[i]; b, sb = all_solids[j]
            if a == b:
                continue
            g = poly_gap(sa["poly"], sb["poly"])
            if 0.0 < g < 1.3:
                warns.append(f"{LAYOUT[a]['label']} / {LAYOUT[b]['label']}: {g:.2f} m gap (too narrow to pass)")
            if g > 0:
                min_ss = min(min_ss, g)
    stats["min_gap_between_structures"] = round(min_ss, 2)
    # perches: a top reachable by jumping (from the ground or from another reachable top, breakables
    # included) that stands more than 1.6 m above the ground around it
    tops = []
    for idx, s_ in all_solids:
        e, n = sum(p[0] for p in s_["poly"]) / len(s_["poly"]), sum(p[1] for p in s_["poly"]) / len(s_["poly"])
        tops.append(dict(kind="structure", label=LAYOUT[idx]["label"], poly=s_["poly"], top=s_["z1"], g=min(ground(*p) for p in s_["poly"] + [(e, n)])))
    for b, polys in brk:
        tops.append(dict(kind="breakable", label=b["id"], poly=polys[0], top=b["baseH"] + b["h"], g=b["baseH"]))
    reach = [False] * len(tops)
    for i, t in enumerate(tops):
        reach[i] = t["top"] - t["g"] <= JUMP_REACH
    changed = True
    while changed:
        changed = False
        for i, t in enumerate(tops):
            if reach[i]:
                continue
            for j, u in enumerate(tops):
                if reach[j] and u is not t and poly_gap(t["poly"], u["poly"]) < 3.5 and t["top"] - u["top"] <= JUMP_REACH:
                    reach[i] = True; changed = True
                    break
    perches = [t for i, t in enumerate(tops) if reach[i] and t["kind"] == "structure" and t["top"] - t["g"] > 1.6]
    for t in perches:
        # Inside the outpost wall (round 2) nobody fights: a perch there can't keep a player out of an
        # NPC's reach, so it is only noted. The wall itself (on the zone's edge) still counts.
        ce = sum(q[0] for q in t["poly"]) / len(t["poly"]); cn = sum(q[1] for q in t["poly"]) / len(t["poly"])
        msg = f"PERCH: {t['label']} top {t['top'] - t['g']:.2f} m above the ground is reachable by jumping"
        if math.hypot(ce, cn) < WALL["radius"] - 1.5:
            warns.append(msg + " (inside the outpost wall)")
        else:
            problems.append(msg)
    stats["low_tops_reachable"] = sorted({t["label"] for i, t in enumerate(tops) if reach[i] and t["kind"] == "structure"})
    for p_ in problems:
        log("PROBLEM", p_)
    for w in warns:
        log("warn", w)
    log(f"validation: {len(problems)} problems, {len(warns)} warnings; {stats}")
    return problems, warns, stats

# ============================================================================================
# Ground decals (paths), scene assembly, overlays, lighting and renders
# ============================================================================================
def build_paths():
    """Paths as ground decals: strips following the real ground (3-5 cm above it)."""
    if not PATHS:
        return None
    mb = MB()
    for pa in PATHS:
        pts = pa["pts"]
        w = pa["width"] / 2
        dense = []
        for i in range(len(pts) - 1):
            a, b = Vector(pts[i]), Vector(pts[i + 1])
            n = max(1, int((b - a).length / 0.8))
            for k in range(n):
                dense.append(a.lerp(b, k / n))
        dense.append(Vector(pts[-1]))
        run = 0.0
        for i in range(len(dense) - 1):
            a, b = dense[i], dense[i + 1]
            d = (b - a).normalized()
            nrm = Vector((-d.y, d.x))
            pa_ = a + nrm * w; pb_ = a - nrm * w; pc_ = b - nrm * w; pd_ = b + nrm * w
            # rounded edges: shrink the ends a little so strips overlap without seams
            q = [surf(p.x, p.y, ground(p.x, p.y) + 0.035 + 0.003 * (i % 2)) for p in (pa_, pb_, pc_, pd_)]
            L = (b - a).length
            uv = [(run / 2, 0), (run / 2, w), ((run + L) / 2, w), ((run + L) / 2, 0)]
            if pa["mat"] in ("MI_RockTrim",):
                v0, v1 = P.BAND["field"]
                uv = [(run / 4, v0), (run / 4, v1), ((run + L) / 4, v1), ((run + L) / 4, v0)]
            mb.face(q, pa["mat"], uv)
            run += L
    me = mb.mesh(f"{B}_paths")
    o = bpy.data.objects.new(f"{B}_paths", me)
    P.SC.collection.objects.link(o)
    tris = sum(len(p_.vertices) - 2 for p_ in me.polygons)
    P.PREFAB_INFO[f"{B}_paths"] = dict(tris=tris, mats=[m.name for m in me.materials], lod="decal")
    CLASS[f"{B}_paths"] = "decal"
    return o

def instance_layout():
    coll = bpy.data.collections.new("outpost")
    P.SC.collection.children.link(coll)
    for i, it in enumerate(LAYOUT):
        o = bpy.data.objects.new(f"L{i:03d}_{it['prefab']}", P.PREFABS[it["prefab"]].data)
        o.matrix_world = surf_matrix(it["east"], it["north"], it["yaw"], h=it["base_h"], scale=it["scale"])
        coll.objects.link(o)
    return coll

def overlay(coll_name, polys, z_lift, color, width=0.14, fill_alpha=0.0):
    """Outlines (and optional translucent fill) of ground polygons, for the aerial."""
    mname = f"M_ov_{coll_name}"
    simple_mat(mname, color, rough=0.5, emit=color, emit_k=2.5)
    mb = MB()
    for poly in polys:
        n = len(poly)
        for i in range(n):
            a, b = Vector(poly[i]), Vector(poly[(i + 1) % n])
            d = (b - a)
            if d.length < 1e-6:
                continue
            nrm = Vector((-d.y, d.x)).normalized() * width
            q = [a - nrm, a + nrm, b + nrm, b - nrm]
            pts = [surf(p.x, p.y, ground(p.x, p.y) + z_lift) for p in q]
            mb.face(pts, mname, [(0, 0)] * 4)
    me = mb.mesh("ov_" + coll_name)
    o = bpy.data.objects.new("ov_" + coll_name, me)
    P.SC.collection.objects.link(o)
    if fill_alpha > 0:
        fname = f"M_ovf_{coll_name}"
        simple_mat(fname, color, rough=0.5, emit=color, emit_k=0.8, alpha=fill_alpha)
        mb2 = MB()
        for poly in polys:
            c = Vector((sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)))
            for i in range(len(poly)):
                a, b = Vector(poly[i]), Vector(poly[(i + 1) % len(poly)])
                pts = [surf(p.x, p.y, ground(p.x, p.y) + z_lift - 0.01) for p in (c, a, b)]
                mb2.face(pts, fname, [(0, 0)] * 3)
        o2 = bpy.data.objects.new("ovf_" + coll_name, mb2.mesh("ovf_" + coll_name))
        P.SC.collection.objects.link(o2)
        return [o, o2]
    return [o]

def ring_poly(r, n=96, c=(0.0, 0.0)):
    return [(c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n)) for k in range(n)]

def build_overlays():
    objs = []
    objs += overlay("brk", [p for b in SITE["breakables"] for p in breakable_poly(b)], 0.12, (1.0, 0.08, 0.04), width=0.09, fill_alpha=0.55)
    objs += overlay("brk_clear", [ring_poly(b["foot"] + 2.0, 32, (b["east"], b["north"])) for b in SITE["breakables"]], 0.1, (1.0, 0.35, 0.1), width=0.05)
    objs += overlay("solids", [s_["poly"] for it in LAYOUT for s_ in it.get("solids_w", [])], 0.14, (0.1, 0.35, 1.0), width=0.1, fill_alpha=0.25)
    objs += overlay("rings", [ring_poly(40), ring_poly(45)], 0.15, (1.0, 0.15, 0.6), width=0.12)
    for o in objs:
        o.hide_render = True
    return objs

def setup_sky():
    lk = SUN
    w = bpy.data.worlds.new("sky"); P.SC.world = w
    w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    # view-direction elevation in the pad frame (world Z ~ local up near the pad)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    mr = nt.nodes.new("ShaderNodeMapRange"); mr.inputs["From Min"].default_value = -0.2; mr.inputs["From Max"].default_value = 1.0
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    cr = ramp.color_ramp
    cr.elements[0].position = 0.0; cr.elements[0].color = (*hexrgb(lk["ground"]), 1)
    cr.elements[1].position = 1.0; cr.elements[1].color = (*hexrgb(lk["zenith"]), 1)
    e = cr.elements.new(0.17); e.color = (*hexrgb(lk["horizon"]), 1)
    e = cr.elements.new(0.28); e.color = (*hexrgb(lk["mid"]), 1)
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = dict(arcadia=1.0, hollowmere=1.9, meridian=1.0)[BODY]
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    setup_fog(w)

FOG = {}
FOG_COLOR = dict(arcadia=0xb8e4e0, hollowmere=0x8e6aa8, meridian=0xf2c8a8)

def _sock(n, ident, out=False):
    socks = n.outputs if out else n.inputs
    for sck in socks:
        if sck.identifier == ident:
            return sck
    raise KeyError(ident)

def setup_fog(world):
    """The game's distance fog (looks.ts fogDensity from fogStart) as a compositor pass:
    fog = 1 - exp(-density * (d - start)), over geometry only; the sky comes from the environment pass."""
    dens, start = SUN["fogDensity"], SUN["fogStart"]
    world.mist_settings.start = start
    world.mist_settings.depth = 600.0
    world.mist_settings.falloff = "LINEAR"
    vl = P.SC.view_layers[0]
    vl.use_pass_mist = True
    vl.use_pass_environment = True
    P.SC.render.film_transparent = True
    ng = bpy.data.node_groups.new("fog", "CompositorNodeTree")
    P.SC.compositing_node_group = ng
    rl = ng.nodes.new("CompositorNodeRLayers")
    m1 = ng.nodes.new("ShaderNodeMath"); m1.operation = "MULTIPLY"; m1.inputs[1].default_value = -dens * 600.0
    FOG["node"] = m1; FOG["k"] = -dens * 600.0
    ng.links.new(rl.outputs["Mist"], m1.inputs[0])
    ex = ng.nodes.new("ShaderNodeMath"); ex.operation = "EXPONENT"
    ng.links.new(m1.outputs[0], ex.inputs[0])
    inv = ng.nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.inputs[0].default_value = 1.0
    ng.links.new(ex.outputs[0], inv.inputs[1])
    mx = ng.nodes.new("ShaderNodeMix"); mx.data_type = "RGBA"
    ng.links.new(inv.outputs[0], _sock(mx, "Factor_Float"))
    ng.links.new(rl.outputs["Image"], _sock(mx, "A_Color"))
    _sock(mx, "B_Color").default_value = (*hexrgb(FOG_COLOR[BODY]), 1)
    sky = ng.nodes.new("ShaderNodeMix"); sky.data_type = "RGBA"
    ng.links.new(rl.outputs["Alpha"], _sock(sky, "Factor_Float"))
    ng.links.new(rl.outputs["Environment"], _sock(sky, "A_Color"))
    ng.links.new(_sock(mx, "Result_Color", out=True), _sock(sky, "B_Color"))
    out = ng.nodes.new("NodeGroupOutput")
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    ng.links.new(_sock(sky, "Result_Color", out=True), out.inputs[0])
    log(f"fog: density {dens} from {start} m (looks.ts), colour #{FOG_COLOR[BODY]:06x}")

def add_sun():
    el, az = LOOK["sun_el"], math.radians(LOOK["sun_az"])
    src = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    l = bpy.data.lights.new("sun", "SUN")
    l.energy = dict(arcadia=4.2, hollowmere=3.4, meridian=5.0)[BODY]
    l.color = hexrgb(SUN["color"])
    l.angle = math.radians(1.0)
    o = bpy.data.objects.new("sun", l)
    P.SC.collection.objects.link(o)
    o.rotation_euler = (-src).to_track_quat("-Z", "Y").to_euler()
    log(f"sun: elevation {math.degrees(el):.1f} deg (looks.ts), azimuth {LOOK['sun_az']:.0f} deg from east")
    return o

def game_camera(player_e=0.0, player_n=-2.0, heading_deg=90.0, pitch=-0.15, dist=4.6):
    """The game's third-person arrival camera (PlayerController.placeCamera): 75 deg vertical FOV."""
    up = Vector((0, 0, 1))
    fwd = Vector((math.cos(math.radians(heading_deg)), math.sin(math.radians(heading_deg)), 0))
    right = fwd.cross(up).normalized()
    look = (Matrix.Rotation(pitch, 3, right) @ fwd).normalized()
    pos = surf(player_e, player_n, ground(player_e, player_n) + 0.0)
    head = pos + up * 1.65
    cam_pos = head - look * dist + right * 0.55 + up * 0.25
    target = head + look * 6 + right * 0.55
    c = P.add_camera("cam_arrival")
    c.data.sensor_fit = "VERTICAL"
    c.data.angle = math.radians(75)
    P.look_at(c, cam_pos, target)
    return c, pos, heading_deg

def render(cam, name):
    path = os.path.join(OUT, f"{BODY}_{name}.png")
    P.render_to(cam, path)
    return path

# ============================================================================================
# ARCADIA: Dawnpad, a shepherd's hamlet on a lakeside peninsula (green and gold)
# ============================================================================================
def build_arcadia():
    # --- windmill (hero, across the pond behind the portal) ---
    p = P.Prefab("a_windmill", lod="tower custom; cap kit-textured; sails cloth")
    mb = p.mb
    frustum(mb, 3.45, 3.15, -1.4, 0.55, 18, "MI_RockTrim", mode="band", band="ashlar")
    quad(mb, [(*q, 0.55) for q in circle(3.15, 18, math.pi / 18)], "MI_RockTrim", mode="band", band="slab")
    frustum(mb, 3.0, 2.3, 0.55, 9.6, 18, "MI_UnevenBrick", tile=2.0)
    frustum(mb, 2.84, 2.82, 4.55, 4.8, 18, "MI_RockTrim", mode="band", band="slab", cap=False)
    frustum(mb, 2.5, 2.5, 9.45, 9.75, 18, "MI_RockTrim", mode="band", band="slab", cap=True)
    frustum(mb, 2.75, 0.0, 9.7, 13.6, 18, "MI_RoundTiles", tile=2.0)
    cyl(mb, T(0, 0, 13.4), 0.09, 0, 0.9, 6, "MI_MetalOrnaments")
    sun_disc(mb, T(0, 0, 14.25) @ Rz(0), r=0.18)
    # door, windows (south face, -Y)
    face_y = -2.93
    P.reveal(mb, (0, face_y - 0.06, 0), (1, 0, 0), (0, 0, 1), P.arch_shape(0, 0.55, 1.3, 2.5, 6), 0.35, "MI_RockTrim", back_mat="MI_WoodTrim")
    plank_door(mb, T(0, face_y + 0.3, 0.55), 1.25, 2.4)
    for (a, z) in ((-90, 6.6), (-35, 3.4), (-145, 3.4), (60, 5.2), (130, 7.0)):
        rr = 3.0 - 0.7 * (z / 9.6) + 0.04
        o = Vector((math.cos(math.radians(a)) * rr, math.sin(math.radians(a)) * rr, 0))
        uax = Vector((-math.sin(math.radians(a)), math.cos(math.radians(a)), 0))
        P.recess_window(mb, o, uax, z, 0.7, 1.1, depth=0.25, arched=True)
    # windshaft and sails (X pattern, facing south)
    oriented_box(mb, T(0, -2.55, 10.9) @ Rx(90), 0.34, 0.34, 1.4, "MI_WoodTrim", mode="band", band="dark")
    cyl(mb, T(0, -3.25, 10.9) @ Rx(90), 0.42, -0.25, 0.25, 10, "MI_WoodTrim", mode="band", band="dark")
    for k in range(4):
        a = math.radians(45 + 90 * k)
        Mk = T(0, -3.35, 10.9) @ Ry(-math.degrees(a))
        oriented_box(mb, Mk @ T(0, 0, 0.2), 0.16, 0.16, 6.4, "MI_WoodTrim", mode="band", band="dark")
        # lattice frame + cloth on one side of the stock
        for j in range(5):
            z = 1.6 + j * 1.15
            oriented_box(mb, Mk @ T(0.62, -0.02, z), 1.35, 0.06, 0.07, "MI_WoodTrim", mode="band", band="plank")
        oriented_box(mb, Mk @ T(1.28, -0.02, 1.55), 0.07, 0.06, 4.75, "MI_WoodTrim", mode="band", band="plank")
        flat_poly(mb, Mk @ T(0, -0.05, 0), [(0.1, 1.6), (1.25, 1.6), (1.25, 6.2), (0.1, 6.2)], "M_Cloth", band="cream")
    # a small lean-to store on the north side
    box(mb, -1.6, 2.6, -0.6, 1.6, 4.4, 2.0, "MI_UnevenBrick", top=("MI_RockTrim", "band", "slab"))
    pts = [(-1.8, 4.6, 2.1), (1.8, 4.6, 2.1), (1.8, 2.5, 2.9), (-1.8, 2.5, 2.9)]
    quad(mb, list(reversed(pts)), "MI_WoodTrim", mode="band", band="plank", tileu=2.0)
    scyl("a_windmill", 0, 0, 3.15, 0, 9.7)
    sbox("a_windmill", -1.65, 2.5, 1.65, 4.45, 0, 2.9)
    finish(p, "static", "Dawnpad windmill: stone tower, tiled cap, four cloth sails (hero landmark north of the pond)")

    # --- Lark's cottage (two storeys, kit modules) ---
    def cot_extra(p_, top):
        P.awning(p_.mb, -1.0, 1.0, -2.09, 2.75, colors=("green", "cream"), depth=1.0, drop=0.4)
        P.hanging_sign(p_.mb, 2.95, -2.1, 3.0, "green")
        p_.k("Prop_Vine5", -3.1, -0.4, 2.8, -90)
        for x in (-2.0, 2.0):
            oriented_box(p_.mb, T(x, -2.25, H_UP + 0.62), 1.1, 0.28, 0.24, "MI_WoodTrim", mode="band", band="dark")
            oriented_box(p_.mb, T(x, -2.25, H_UP + 0.86), 1.0, 0.24, 0.16, "M_Cloth", pal="red" if x < 0 else "gold")
    P.house("a_cottage", 6, 4, [
        ("stone", {"front": "WDW", "right": "WS", "back": "SSS", "left": "SW"}),
        ("plaster", {"front": "wFw", "right": "XW", "back": "SXS", "left": "WX"}),
    ], ridge="x", chimney=(1.6, 0.9, 0.6), extras=cot_extra, lod="kit house; LOD1 roof shell")
    reg("a_cottage", "building", "Lark's cottage: stone and plaster, two storeys, green awning, flower boxes")
    solid_from_footprint("a_cottage", 6.24 + 3.73)

    # --- barn (timber on a stone plinth, kit tile roof 8x10, plank gables) ---
    p = P.Prefab("a_barn", lod="kit roof 8x10 + custom; LOD1 roof shell")
    mb = p.mb
    w, d, eave = 8.0, 10.0, 4.0
    box(mb, -w / 2 - 0.2, -d / 2 - 0.2, -1.2, w / 2 + 0.2, d / 2 + 0.2, 0.45, "MI_RockTrim", mode="band", band="ashlar", skip=("-z",), top=("MI_RockTrim", "band", "slab"))
    for (x0, y0, x1, y1) in ((-w / 2, -d / 2, w / 2, -d / 2), (w / 2, -d / 2, w / 2, d / 2), (w / 2, d / 2, -w / 2, d / 2), (-w / 2, d / 2, -w / 2, -d / 2)):
        quad(mb, [(x0, y0, 0.45), (x1, y1, 0.45), (x1, y1, eave), (x0, y0, eave)], "MI_WoodTrim", mode="band", band="plank", tileu=3.0)
    for x in (-w / 2, w / 2):
        for y in (-d / 2, 0, d / 2):
            box(mb, x - 0.15, y - 0.15, 0.45, x + 0.15, y + 0.15, eave + 0.1, "MI_WoodTrim", mode="band", band="dark")
    for y in (-d / 2, d / 2):
        box(mb, -w / 2, y - 0.14, eave - 0.2, w / 2, y + 0.14, eave + 0.05, "MI_WoodTrim", mode="band", band="dark")
    rise = 6.0
    for sy in (-1, 1):
        g = [(-w / 2, sy * d / 2, eave), (w / 2, sy * d / 2, eave), (0, sy * d / 2, eave + rise * 0.95)]
        if sy > 0:
            g = list(reversed(g))
        quad(mb, g, "MI_WoodTrim", mode="band", band="plank", tileu=3.0)
    p.k("Roof_RoundTiles_8x10", 0, 0, eave)
    # big doors and the hayloft
    oriented_box(mb, T(0, -d / 2 - 0.12, 0.45), 3.4, 0.18, 3.4, "MI_WoodTrim", mode="band", band="dark")
    for sx in (-1, 1):
        oriented_box(mb, T(sx * 0.85, -d / 2 - 0.24, 2.1) @ Ry(sx * 38), 0.14, 0.06, 3.6, "MI_WoodTrim", mode="band", band="plank")
    oriented_box(mb, T(0, -d / 2 - 0.1, 5.0), 1.5, 0.16, 1.4, "MI_WoodTrim", mode="band", band="dark")
    oriented_box(mb, T(0, -d / 2 - 0.9, 6.6), 0.18, 1.8, 0.18, "MI_WoodTrim", mode="band", band="dark")
    for sx in (-1, 1):
        for yy in (-2.5, 2.5):
            oriented_box(mb, T(sx * (w / 2 + 0.03), yy, 2.2), 0.06, 1.0, 0.8, "MI_WindowGlass")
    P.banner(mb, T(-2.6, -d / 2 - 0.2, 3.7), 0.7, 1.8, ("green", "gold"))
    sbox("a_barn", -w / 2 - 0.2, -d / 2 - 0.25, w / 2 + 0.2, d / 2 + 0.2, 0, eave + 0.1)
    sbox("a_barn", -2.6, -d / 2, 2.6, d / 2, eave, eave + 3.6)
    finish(p, "building", "barn: plank walls on a stone plinth, tiled roof, big doors and hayloft facing the pad")

    # --- well (Portus design, re-used as a prefab) ---
    p = P.Prefab("a_well", lod="custom, minimal")
    mb = p.mb
    n = 14
    co, ci = circle(1.05, n), circle(0.75, n)
    prism(mb, co, -0.4, 0.85, "MI_UnevenBrick", cap_top=False)
    prism(mb, list(reversed(ci)), 0.0, 0.85, "MI_UnevenBrick", cap_top=False)
    for i in range(n):
        j = (i + 1) % n
        quad(mb, [(*co[i], 0.85), (*co[j], 0.85), (*ci[j], 0.85), (*ci[i], 0.85)], "MI_RockTrim", mode="band", band="slab")
    quad(mb, [(*q, 0.35) for q in ci], "MI_WindowGlass")
    for sx in (-1, 1):
        box(mb, sx * 0.95 - 0.09, -0.09, 0.85, sx * 0.95 + 0.09, 0.09, 2.6, "MI_WoodTrim", mode="band", band="plank")
    box(mb, -1.1, -0.06, 2.0, 1.1, 0.06, 2.12, "MI_WoodTrim", mode="band", band="plank")
    tmp = MB()
    slate_roof(tmp, 1.9, 2.4, 2.25, 0.8, over=0.25, mat="MI_WoodTrim", courses=3, gables=False)
    mb.extend(tmp)
    P.barrel(mb, T(0.3, 0.0, 1.35), h=0.32, r=0.16)
    scyl("a_well", 0, 0, 1.1, 0, 3.05)
    finish(p, "prop", "well with a shingled hood")

    # --- dawn shrine ---
    p = P.Prefab("a_shrine", lod="custom, minimal")
    mb = p.mb
    box(mb, -1.6, -1.6, -0.5, 1.6, 1.6, 0.2, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    box(mb, -1.15, -1.15, 0.2, 1.15, 1.15, 0.42, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    frustum(mb, 0.4, 0.33, 0.42, 2.5, 10, "MI_RockTrim", mode="band", band="ashlar")
    box(mb, -0.52, -0.52, 2.5, 0.52, 0.52, 2.72, "MI_RockTrim", mode="band", band="slab")
    sun_disc(mb, T(0, 0, 3.45), r=0.55)
    sun_disc(mb, T(0, 0.04, 3.45) @ Rz(180), r=0.55)
    for sx in (-1, 1):
        box(mb, sx * 1.0 - 0.14, -0.9, 0.42, sx * 1.0 + 0.14, -0.62, 1.1, "MI_RockTrim", mode="band", band="ashlar")
        frustum(mb, 0.06, 0.06, 1.1, 1.32, 6, "M_GlowWarm", cap=True)
    for i, (x, c) in enumerate(((-0.7, "red"), (-0.25, "gold"), (0.25, "white"), (0.7, "gold"))):
        box(mb, x - 0.2, 0.95, 0.2, x + 0.2, 1.45, 0.42, "MI_RockTrim", mode="band", band="field")
        oriented_box(mb, T(x, 1.2, 0.42), 0.32, 0.36, 0.16, "M_Cloth", pal=c)
    sbox("a_shrine", -1.6, -1.6, 1.6, 1.6, 0, 0.42)
    scyl("a_shrine", 0, 0, 0.52, 0, 2.72)
    finish(p, "prop", "dawn shrine: a stepped plinth, a column and a brass sun facing both ways")

    # --- jetty (walkable deck, land end at +0.3) ---
    p = P.Prefab("a_jetty", lod="custom")
    mb = p.mb
    L = 7.0
    box(mb, -0.95, 0.0, 0.15, 0.95, L, 0.3, "MI_WoodTrim", mode="band", band="plank", top=("MI_WoodTrim", "band", "plank"))
    for y in (0.4, 2.6, 4.8, L - 0.2):
        for sx in (-1, 1):
            box(mb, sx * 0.95 - 0.11, y - 0.11, -2.4, sx * 0.95 + 0.11, y + 0.11, 0.62 if y > 0.5 else 0.3, "MI_WoodTrim", mode="band", band="dark")
    for sx in (-1, 1):
        box(mb, sx * 0.95 - 0.05, 2.6, 0.55, sx * 0.95 + 0.05, L - 0.2, 0.62, "MI_WoodTrim", mode="band", band="dark")
    box(mb, 0.75, L - 0.35, 0.3, 0.9, L - 0.2, 2.4, "MI_WoodTrim", mode="band", band="dark")
    box(mb, 0.35, L - 0.32, 2.3, 0.9, L - 0.22, 2.38, "MI_WoodTrim", mode="band", band="dark")
    hanging_lantern(mb, T(0.42, L - 0.27, 2.3), "M_GlowWarm", s=0.8)
    sbox("a_jetty", -1.05, 0.0, 1.05, L, -2.4, 0.3)
    finish(p, "static", "lakeside jetty: walkable plank deck, rails, a lantern at the end")

    p = P.Prefab("a_rowboat", lod="custom")
    mb = p.mb
    hull = [(-0.55, -1.6), (0.0, -2.2), (0.55, -1.6), (0.6, 1.4), (0.0, 1.9), (-0.6, 1.4)]
    prism(mb, hull, -0.15, 0.42, "MI_WoodTrim", mode="band", band="dark", cap_top=False)
    quad(mb, [(*q, 0.05) for q in hull], "MI_WoodTrim", mode="band", band="plank")
    for y in (-0.6, 0.6):
        box(mb, -0.55, y - 0.12, 0.25, 0.55, y + 0.12, 0.32, "MI_WoodTrim", mode="band", band="plank")
    oriented_box(mb, T(0.2, 0.2, 0.36) @ Rz(12) @ Ry(80), 0.05, 0.05, 2.4, "MI_WoodTrim", mode="band", band="plank")
    finish(p, "prop", "moored rowboat (no collider: it floats on the water)")

    # --- sheepfold: dry-stone walls in a U open to the pad, hay rack, trough ---
    p = P.Prefab("a_fold", lod="custom")
    mb = p.mb
    low_wall(mb, -4.3, 4.3, 3.0, h=1.0)
    tmp = MB(); low_wall(tmp, -2.2, 3.0, 0.0, h=1.0); mb.extend(tmp, T(-4.0, 0, 0) @ Rz(90))
    tmp = MB(); low_wall(tmp, -2.2, 3.0, 0.0, h=1.0); mb.extend(tmp, T(4.0, 0, 0) @ Rz(90))
    box(mb, -1.4, 1.7, 0.0, 1.4, 2.3, 0.55, "MI_RockTrim", mode="band", band="ashlar", top=("MI_WindowGlass", "planar"))
    for x in (-1.0, 1.0):
        box(mb, x - 0.06, 2.15, 0, x + 0.06, 2.27, 1.9, "MI_WoodTrim", mode="band", band="dark")
    # hay rack (low: no perch next to the 1 m walls)
    box(mb, -1.2, -0.45, 0.0, 1.2, 0.45, 0.25, "MI_WoodTrim", mode="band", band="dark")
    frustum(mb, 0.0, 0.0, 0, 0, 3, "M_Cloth", mode="pal", band="gold")
    oriented_box(mb, T(0, 0, 0.25), 2.2, 0.75, 0.6, "M_Cloth", pal="gold")
    sbox("a_fold", -1.2, -0.45, 1.2, 0.45, 0, 0.85)
    sbox("a_fold", -4.35, 2.65, 4.35, 3.35, 0, 1.12)
    sbox("a_fold", -4.35, -2.2, -3.65, 3.35, 0, 1.12)
    sbox("a_fold", 3.65, -2.2, 4.35, 3.35, 0, 1.12)
    finish(p, "static", "sheepfold: low dry-stone walls (open toward the pad), haystack, trough")

    # --- haystack, beehives, garden, banner, lamp, bench, signpost (small props) ---
    p = P.Prefab("a_hay", lod="custom")
    frustum(p.mb, 1.35, 1.15, -0.2, 1.3, 12, "M_Cloth", mode="pal", band="gold")
    frustum(p.mb, 1.15, 0.0, 1.3, 2.7, 12, "M_Cloth", mode="pal", band="gold")
    cyl(p.mb, T(0, 0, 2.5), 0.05, 0, 0.6, 5, "MI_WoodTrim", mode="band", band="dark")
    scyl("a_hay", 0, 0, 1.3, 0, 2.7)
    finish(p, "prop", "haystack")

    p = P.Prefab("a_hives", lod="custom")
    mb = p.mb
    box(mb, -1.3, -0.3, 0.42, 1.3, 0.3, 0.52, "MI_WoodTrim", mode="band", band="plank")
    for x in (-1.1, 1.1):
        box(mb, x - 0.06, -0.25, 0, x + 0.06, 0.25, 0.42, "MI_WoodTrim", mode="band", band="dark")
    for x in (-0.8, 0.0, 0.8):
        mb_tmp = MB(); frustum(mb_tmp, 0.3, 0.27, 0.0, 0.28, 8, "M_Cloth", mode="pal", band="gold"); frustum(mb_tmp, 0.27, 0.0, 0.28, 0.53, 8, "M_Cloth", mode="pal", band="gold")
        mb.extend(mb_tmp, T(x, 0, 0.52))
    sbox("a_hives", -1.35, -0.32, 1.35, 0.32, 0, 1.05)
    finish(p, "prop", "bench of three straw beehives")

    p = P.Prefab("a_garden", lod="custom")
    mb = p.mb
    for (x0, y0, x1, y1) in ((-2.6, -2.1, 2.6, -1.8), (-2.6, 1.8, 2.6, 2.1), (-2.6, -1.8, -2.3, 1.8), (2.3, -1.8, 2.6, 1.8)):
        box(mb, x0, y0, -0.3, x1, y1, 0.3, "MI_RockTrim", mode="band", band="field", skip=("-z",))
    for j in range(3):
        p.k("Prop_Vine9", 0.0, -1.2 + 1.2 * j, -0.25, 0, (1.15, 0.55, 0.7))
    finish(p, "prop", "vegetable garden in a low stone border (no collider: 0.3 m, walk-over)")

    p = P.Prefab("a_banner", lod="custom")
    box(p.mb, -0.25, -0.25, -0.3, 0.25, 0.25, 0.4, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    box(p.mb, -0.06, -0.06, 0.4, 0.06, 0.06, 6.0, "MI_WoodTrim", mode="band", band="dark")
    sun_disc(p.mb, T(0, 0, 6.25), r=0.14)
    P.banner(p.mb, T(0, -0.1, 5.6), 0.8, 2.6, ("green", "gold"))
    scyl("a_banner", 0, 0, 0.25, 0, 6.0)
    finish(p, "prop", "banner pole, green and gold")

    p = P.Prefab("a_lamp", lod="custom")
    mb = p.mb
    box(mb, -0.2, -0.2, -0.3, 0.2, 0.2, 0.35, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    box(mb, -0.08, -0.08, 0.35, 0.08, 0.08, 3.3, "MI_WoodTrim", mode="band", band="dark")
    box(mb, -0.05, -0.75, 3.1, 0.05, 0.05, 3.2, "MI_MetalOrnaments")
    hanging_lantern(mb, T(0, -0.68, 3.1), "M_GlowWarm")
    scyl("a_lamp", 0, 0, 0.22, 0, 3.3)
    finish(p, "prop", "lamp post with a hanging lantern")

    p = P.Prefab("a_bench", lod="custom")
    box(p.mb, -0.9, -0.22, 0.42, 0.9, 0.22, 0.5, "MI_WoodTrim", mode="band", band="plank")
    for x in (-0.7, 0.7):
        box(p.mb, x - 0.06, -0.18, 0, x + 0.06, 0.18, 0.42, "MI_WoodTrim", mode="band", band="dark")
    box(p.mb, -0.9, 0.16, 0.5, 0.9, 0.24, 0.95, "MI_WoodTrim", mode="band", band="plank")
    sbox("a_bench", -0.9, -0.24, 0.9, 0.24, 0, 0.5)
    finish(p, "prop", "bench")

    p = P.Prefab("a_signpost", lod="custom")
    mb = p.mb
    box(mb, -0.08, -0.08, -0.3, 0.08, 0.08, 2.7, "MI_WoodTrim", mode="band", band="dark")
    for i, (a, z) in enumerate(((20, 2.3), (150, 1.95), (-70, 1.6))):
        M = T(0, 0, z) @ Rz(a)
        oriented_box(mb, M @ T(0.6, 0, -0.14), 1.1, 0.05, 0.26, "MI_WoodTrim", mode="band", band="plank")
    scyl("a_signpost", 0, 0, 0.2, 0, 2.7)
    finish(p, "prop", "signpost")

    p = P.Prefab("a_woodpile", lod="custom")
    mb = p.mb
    for row in range(3):
        for i in range(5 - row):
            tmp = MB()
            frustum(tmp, 0.16, 0.16, -1.0, 1.0, 7, "MI_WoodTrim", mode="band", band="dark", cap=True)
            mb.extend(tmp, T(-0.66 + i * 0.33 + row * 0.165, 0, 0.17 + row * 0.29) @ Ry(90))
    for x in (-1.2, 1.2):
        box(mb, x - 0.06, 0.4, 0, x + 0.06, 0.52, 2.0, "MI_WoodTrim", mode="band", band="dark")
        box(mb, x - 0.06, -0.62, 0, x + 0.06, -0.5, 1.6, "MI_WoodTrim", mode="band", band="dark")
    pts = [(-1.4, -0.85, 1.55), (1.4, -0.85, 1.55), (1.4, 0.7, 2.1), (-1.4, 0.7, 2.1)]
    quad(mb, pts, "MI_WoodTrim", mode="band", band="plank", tileu=2.0); quad(mb, list(reversed(pts)), "MI_WoodTrim", mode="band", band="dark", tileu=2.0)
    sbox("a_woodpile", -1.3, -0.7, 1.3, 0.6, 0, 2.1)
    finish(p, "prop", "woodpile under a lean-to roof")

    def hut_extra(p_, top):
        P.awning(p_.mb, -1.4, 1.4, -2.09, 2.6, colors=("teal", "cream"), depth=0.9, drop=0.35)
        oriented_box(p_.mb, T(1.4, -2.3, 0.0), 0.9, 0.5, 0.45, "MI_WoodTrim", mode="band", band="plank")
    P.house("a_hut", 4, 4, [("stone", {"front": "DW", "right": "WS", "back": "SS", "left": "SW"})],
            chimney=(-1.1, 1.1, 0.3), extras=hut_extra, lod="kit cottage; LOD1 roof shell")
    reg("a_hut", "building", "fisher's hut: one-storey stone cottage by the water, striped awning")
    solid_from_footprint("a_hut", 3.12 + 3.73)
    P.nature_prefab("a_oak", "CommonTree_3", lod="tree; impostor beyond 60 m", light=(0.25, 0.7))
    reg("a_oak", "tree", "oak (nature kit, lightened): part of the outpost, shades the paths")
    scyl("a_oak", 0, 0, 0.45, 0, 4.0)

H_UP = 3.12  # village kit storey height (upper floor windows)

def face_pad(e, n, extra=0.0):
    """Yaw that turns a prefab's front (-Y) toward the pad centre."""
    return math.degrees(math.atan2(-e, n)) + extra

def layout_arcadia():
    put("a_pad", 0, 0, 0, base="pad", h=PADH)
    pe, pn = GAME["portal"]
    put("a_gate", pe, pn, 0, h=PADH, label="dawn gate")
    # across the pond: the farmstead (windmill, barn, haystacks)
    put("a_windmill", 20.5, 36.5, face_pad(20.5, 36.5), label="windmill")
    put("a_hut", -16.5, 6.0, face_pad(-16.5, 6.0), label="fisher's hut")
    put("a_oak", -12.0, -12.5, 0, label="oak SW")
    put("a_oak", -8.0, -24.5, 120, scale=0.9, label="oak S")
    put("a_oak", 25.5, 7.5, 230, scale=1.1, label="oak E")
    put("a_barn", -0.5, 42.5, face_pad(-0.5, 42.5), label="barn")
    put("a_hay", 7.2, 35.8, 0, label="haystack N")
    put("a_hay", -8.2, 44.5, 40, scale=0.9, label="haystack N2")
    # on the peninsula
    put("a_cottage", 16.5, 10.5, face_pad(16.5, 10.5), label="Lark's cottage")
    put("a_woodpile", 21.8, 5.0, face_pad(21.8, 5.0) + 15, label="woodpile")
    put("a_well", -7.5, 12.5, 30, label="well")
    put("a_bench", -10.0, 10.0, face_pad(-10.0, 10.0), label="bench W")
    put("a_jetty", -14.6, 14.2, 45, water=True, label="jetty")
    put("a_rowboat", -19.6, 18.0, 20, h=WATER - 0.08, water=True, label="rowboat")
    put("a_shrine", -3.5, -19.5, face_pad(-3.5, -19.5), label="dawn shrine")
    put("a_bench", 0.6, -15.8, face_pad(0.6, -15.8), label="bench S")
    put("a_fold", 11.0, -17.5, face_pad(11.0, -17.5), label="sheepfold")
    put("a_garden", 2.5, -25.5, face_pad(2.5, -25.5), label="garden")
    put("a_hives", -5.5, -27.0, face_pad(-5.5, -27.0), label="beehives")
    put("a_banner", -10.8, -1.0, 90, label="banner W")
    put("a_banner", 10.8, 1.5, -90, label="banner E")
    put("a_signpost", -8.5, -10.5, 25, label="signpost")
    for (e, n) in ((-5.0, 15.5), (-1.0, 27.0), (-3.6, 33.6), (12.0, 7.0), (-11.5, 7.0), (-6.5, -15.0), (10.0, -11.0)):
        put("a_lamp", e, n, face_pad(e, n) + 180, label="lamp")
    path("north causeway", [(-4.5, 9.4), (-3.6, 16.0), (-2.2, 22.0), (-1.6, 29.0), (0.6, 35.0), (2.6, 38.0)], 2.2)
    path("windmill", [(0.6, 35.0), (8.0, 35.0), (16.2, 34.6)], 1.8)
    path("jetty", [(-7.8, 5.5), (-11.2, 9.6), (-14.2, 13.9)], 2.0)
    path("hut", [(-9.6, 2.2), (-13.4, 4.4)], 1.8)
    path("cottage", [(8.8, 4.3), (13.6, 7.6)], 2.0)
    path("shrine", [(-2.2, -9.9), (-3.0, -16.4)], 2.0)
    path("fold", [(5.2, -8.6), (8.2, -12.2)], 1.8)

# ============================================================================================
# HOLLOWMERE: Lanternfall, a lantern-lit chapel hamlet at the fen's edge (violet dusk, teal light)
# ============================================================================================
def lancet(mb, origin, uax, z0, w, h, glow="M_GlowTeal"):
    """Pointed window recess with a glowing back (origin on the wall face)."""
    origin, uax = Vector(origin), Vector(uax)
    vax = Vector((0, 0, 1))
    r = w / 2
    pts = [(-r, z0), (r, z0), (r, z0 + h - w * 0.8)]
    for i in range(1, 6):
        a = i / 6
        pts.append((r * (1 - a) ** 0.8, z0 + h - w * 0.8 + w * 0.8 * math.sin(a * math.pi / 2)))
    pts.append((0, z0 + h))
    for i in range(5, 0, -1):
        a = i / 6
        pts.append((-r * (1 - a) ** 0.8, z0 + h - w * 0.8 + w * 0.8 * math.sin(a * math.pi / 2)))
    pts.append((-r, z0 + h - w * 0.8))
    nrm = uax.cross(vax).normalized()
    P.reveal(mb, origin + nrm * 0.02, uax, vax, pts, 0.32, "MI_RockTrim", back_mat=glow)
    M = Matrix((uax, -nrm, vax)).transposed().to_4x4()
    M.translation = origin + nrm * 0.08 + Vector((0, 0, z0 - 0.14))
    oriented_box(mb, M, w + 0.3, 0.22, 0.14, "MI_RockTrim", mode="band", band="slab")

def build_hollowmere():
    # --- the chapel: nave along x, long side and porch facing the pad, west tower with a spire ---
    p = P.Prefab("h_chapel", lod="custom stone + slate; LOD1: drop buttress offsets, merge courses")
    mb = p.mb
    hw, hd, wall = 6.0, 3.5, 5.2
    box(mb, -hw - 0.3, -hd - 0.3, -1.6, hw + 0.3, hd + 0.3, 0.4, "MI_RockTrim", mode="band", band="ashlar", skip=("-z",), top=("MI_RockTrim", "band", "slab"))
    openings = {"front": [(-3.6, 1.0, 1.1, 3.0, "arch"), (3.6, 1.0, 1.1, 3.0, "arch")],
                "back": [(-3.0, 1.2, 1.0, 2.8, "arch"), (0.0, 1.2, 1.0, 2.8, "arch"), (3.0, 1.2, 1.0, 2.8, "arch")],
                "right": [(0.0, 1.8, 1.6, 2.4, "arch")]}
    P.walls_with_openings(mb, hw, hd, 0.4, wall, openings, mat="MI_UnevenBrick")
    # teal-lit lancets (replace the dark glass of the arched recesses with grave-light behind tracery)
    for x in (-3.6, 3.6):
        oriented_box(mb, T(x, -hd - 0.05, 1.0) , 0.06, 0.05, 2.7, "MI_RockTrim", mode="band", band="slab")
    # buttresses
    for x in (-hw, -1.8, 1.8, hw):
        for sy in (-1, 1):
            y = sy * hd
            box(mb, x - 0.35, y - (0.75 if sy < 0 else 0.0), -0.6, x + 0.35, y + (0.0 if sy < 0 else 0.75), 3.6, "MI_UnevenBrick")
            pts = [(x - 0.36, y + sy * 0.76, 3.6), (x + 0.36, y + sy * 0.76, 3.6), (x + 0.36, y, 4.8), (x - 0.36, y, 4.8)]
            quad(mb, pts if sy > 0 else list(reversed(pts)), "MI_RockTrim", mode="band", band="slab")
    box(mb, -hw - 0.12, -hd - 0.12, wall - 0.2, hw + 0.12, hd + 0.12, wall + 0.05, "MI_RockTrim", mode="band", band="slab")
    tmp = MB()
    slate_roof(tmp, 2 * hd, 2 * hw, wall, 3.4, over=0.5, ridge="y", courses=8)
    mb.extend(tmp, Rz(90))
    # rose window in the east gable
    P.reveal(mb, (hw + 0.02, 0, 0), (0, 1, 0), (0, 0, 1), [(0.75 * math.cos(2 * math.pi * k / 12), wall + 1.4 + 0.75 * math.sin(2 * math.pi * k / 12)) for k in range(12)], 0.3, "MI_RockTrim", back_mat="M_GlowTeal")
    # south porch with the door
    px = 1.0
    box(mb, px - 1.4, -hd - 1.9, -0.6, px + 1.4, -hd, 0.42, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    for sx in (-1, 1):
        box(mb, px + sx * 1.15 - 0.22, -hd - 1.75, 0.42, px + sx * 1.15 + 0.22, -hd, 2.6, "MI_UnevenBrick")
    tmp = MB(); slate_roof(tmp, 2.9, 2.1, 2.6, 1.3, over=0.25, courses=4); mb.extend(tmp, T(px, -hd - 0.95, 0))
    plank_door(mb, T(px, -hd + 0.06, 0.42), 1.4, 2.2)
    hanging_lantern(mb, T(px + 0.95, -hd - 1.85, 2.5), "M_GlowTeal", s=0.8)
    # west tower: four stages, belfry openings, spire, bell
    tx, tw, th = -hw - 1.8, 1.85, 12.0
    box(mb, tx - tw - 0.25, -tw - 0.25, -1.6, tx + tw + 0.25, tw + 0.25, 0.4, "MI_RockTrim", mode="band", band="ashlar", skip=("-z",), top=("MI_RockTrim", "band", "slab"))
    tops = {"front": [(0.0, 3.0, 0.7, 1.6, "arch"), (0.0, 8.7, 1.1, 2.2, "arch")], "back": [(0.0, 8.7, 1.1, 2.2, "arch")],
            "left": [(0.0, 8.7, 1.1, 2.2, "arch"), (0.0, 4.5, 0.7, 1.6, "arch")], "right": [(0.0, 8.7, 1.1, 2.2, "arch")]}
    tmp = MB(); P.walls_with_openings(tmp, tw, tw, 0.4, th, tops, mat="MI_UnevenBrick"); mb.extend(tmp, T(tx, 0, 0))
    for z in (4.1, 8.3):
        box(mb, tx - tw - 0.12, -tw - 0.12, z, tx + tw + 0.12, tw + 0.12, z + 0.22, "MI_RockTrim", mode="band", band="slab")
    box(mb, tx - tw - 0.18, -tw - 0.18, th, tx + tw + 0.18, tw + 0.18, th + 0.35, "MI_RockTrim", mode="band", band="slab")
    tmp = MB(); frustum(tmp, (tw + 0.3) * 1.414, 0.0, th + 0.35, th + 6.4, 4, "MI_RockTrim", mode="band", band="slab", a0=math.pi / 4); mb.extend(tmp, T(tx, 0, 0))
    cyl(mb, T(tx, 0, th + 6.3), 0.05, 0, 1.2, 6, "MI_MetalOrnaments")
    hanging_lantern(mb, T(tx + 0.5, 0, th + 7.0), "M_GlowTeal", s=0.6)
    cyl(mb, T(tx, 0, 0), 0.5, 9.0, 9.7, 10, "M_Brass", r1=0.26)
    oriented_box(mb, T(tx, 0, 9.7), 2.0 * tw - 0.4, 0.16, 0.16, "MI_WoodTrim", mode="band", band="dark")
    mb.M = ["M_GlowTeal" if m_ == "MI_WindowGlass" else m_ for m_ in mb.M]   # lancets lit by grave-light
    sbox("h_chapel", -hw - 0.3, -hd - 0.8, hw + 0.3, hd + 0.8, 0, wall)
    sbox("h_chapel", -hw, -hd, hw, hd, wall, wall + 2.6)
    sbox("h_chapel", tx - tw - 0.25, -tw - 0.25, tx + tw + 0.25, tw + 0.25, 0, th + 0.35)
    sbox("h_chapel", px - 1.4, -hd - 1.9, px + 1.4, -hd, 0, 2.6)
    finish(p, "building", "Lanternfall chapel: stone nave with buttresses and teal-lit lancets, slate roof, south porch, west tower with belfry, bell and spire")

    # --- the sexton's house: stone and dark plaster, slate roof, teal lantern ---
    def sex_roof(p_, top):
        slate_roof(p_.mb, 4.0, 6.0, top, 3.0, over=0.4, courses=7, gable_mat="MI_Plaster")
        p_.k("Prop_Chimney2", -1.0, 1.8, top + 0.9)
        hanging_lantern(p_.mb, T(1.05, -3.25, 2.75), "M_GlowTeal", s=0.8)
        oriented_box(p_.mb, T(1.05, -3.15, 2.72), 0.06, 0.4, 0.06, "MI_MetalOrnaments")
        p_.k("Prop_Vine2", 2.1, 0.5, 2.6, 90)
    P.house("h_house", 4, 6, [
        ("stone", {"front": "AW", "right": "WSS", "back": "SS", "left": "SSW"}),
        ("plaster", {"front": "tt", "right": "SWX", "back": "SX", "left": "XWS"}),
    ], roof_mod=sex_roof, lod="kit walls + slate roof; LOD1 merge courses")
    reg("h_house", "building", "the sexton's house: two storeys, stone and dark plaster, slate roof, a grave-light lantern at the door")
    solid_from_footprint("h_house", 6.24 + 3.0)

    def cot_roof(p_, top):
        slate_roof(p_.mb, 4.0, 4.0, top, 2.6, over=0.35, courses=6)
        p_.k("Prop_Chimney2", 1.1, 1.0, top + 0.5)
        hanging_lantern(p_.mb, T(-0.95, -2.35, 2.6), "M_GlowTeal", s=0.8)
        oriented_box(p_.mb, T(-0.95, -2.2, 2.57), 0.06, 0.35, 0.06, "MI_MetalOrnaments")
        p_.k("Prop_Vine1", -2.1, 0.6, 1.2, -90)
    P.house("h_cottage", 4, 4, [("stone", {"front": "DW", "right": "WS", "back": "SS", "left": "SW"})], roof_mod=cot_roof, lod="kit walls + slate roof")
    reg("h_cottage", "building", "the lamplighter's cottage: one storey, stone, slate roof, a lantern at the door")
    solid_from_footprint("h_cottage", 3.12 + 2.6)

    # --- headstones (three shapes), graveyard wall ---
    p = P.Prefab("h_stone_a", lod="custom")
    prism(p.mb, [(-0.32, -0.08), (0.32, -0.08), (0.32, 0.08), (-0.32, 0.08)], -0.3, 0.75, "MI_RockTrim", mode="band", band="slab")
    tmp = MB(); frustum(tmp, 0.32, 0.32, -0.08, 0.08, 10, "MI_RockTrim", mode="band", band="slab", cap=True); p.mb.extend(tmp, T(0, 0, 0.75) @ Rx(90))
    sbox("h_stone_a", -0.34, -0.1, 0.34, 0.1, 0, 1.07)
    finish(p, "prop", "headstone (rounded tablet)")
    p = P.Prefab("h_stone_b", lod="custom")
    prism(p.mb, [(-0.1, -0.1), (0.1, -0.1), (0.1, 0.1), (-0.1, 0.1)], -0.3, 1.25, "MI_RockTrim", mode="band", band="ashlar")
    box(p.mb, -0.42, -0.1, 0.75, 0.42, 0.1, 0.95, "MI_RockTrim", mode="band", band="ashlar")
    box(p.mb, -0.3, -0.3, -0.3, 0.3, 0.3, 0.12, "MI_RockTrim", mode="band", band="slab")
    sbox("h_stone_b", -0.42, -0.3, 0.42, 0.3, 0, 1.25)
    finish(p, "prop", "grave marker (post with a crossbar)")
    p = P.Prefab("h_stone_c", lod="custom")
    box(p.mb, -0.45, -0.45, -0.3, 0.45, 0.45, 0.35, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    frustum(p.mb, 0.3, 0.2, 0.35, 2.2, 4, "MI_RockTrim", mode="band", band="slab", a0=math.pi / 4)
    frustum(p.mb, 0.22, 0.0, 2.2, 2.55, 4, "MI_RockTrim", mode="band", band="slab", a0=math.pi / 4)
    sbox("h_stone_c", -0.45, -0.45, 0.45, 0.45, 0, 2.55)
    finish(p, "prop", "obelisk memorial")
    p = P.Prefab("h_wall", lod="custom")
    box(p.mb, -2.0, -0.25, -0.6, 2.0, 0.25, 0.95, "MI_UnevenBrick", skip=("-z",))
    box(p.mb, -2.05, -0.31, 0.95, 2.05, 0.31, 1.07, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    sbox("h_wall", -2.05, -0.31, 2.05, 0.31, 0, 1.07)
    finish(p, "static", "graveyard wall, 4 m, low")

    # --- the signature lantern post: crooked iron, hanging cage lantern ---
    p = P.Prefab("h_lantern", lod="custom")
    mb = p.mb
    box(mb, -0.28, -0.28, -0.4, 0.28, 0.28, 0.32, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    oriented_box(mb, T(0, 0, 0.32) @ Ry(4), 0.12, 0.12, 3.2, "MI_MetalOrnaments")
    oriented_box(mb, T(0.22, 0, 3.45) @ Ry(-70), 0.08, 0.08, 0.95, "MI_MetalOrnaments")
    oriented_box(mb, T(0.95, 0, 3.72) @ Ry(-100), 0.07, 0.07, 0.35, "MI_MetalOrnaments")
    hanging_lantern(mb, T(1.05, 0, 3.62), "M_GlowTeal")
    scyl("h_lantern", 0, 0, 0.28, 0, 3.6)
    finish(p, "prop", "crooked iron lantern post with a teal grave-light (Lanternfall)")

    # --- bell frame (the tolling bell) ---
    p = P.Prefab("h_bell", lod="custom")
    mb = p.mb
    for sx in (-1, 1):
        x = sx * 1.5
        oriented_box(mb, T(x, -0.7, 0) @ Rx(-12), 0.22, 0.22, 3.75, "MI_WoodTrim", mode="band", band="dark")
        oriented_box(mb, T(x, 0.7, 0) @ Rx(12), 0.22, 0.22, 3.75, "MI_WoodTrim", mode="band", band="dark")
        box(mb, x - 0.3, -1.0, -0.3, x + 0.3, 1.0, 0.15, "MI_RockTrim", mode="band", band="ashlar")
    box(mb, -1.75, -0.14, 3.55, 1.75, 0.14, 3.85, "MI_WoodTrim", mode="band", band="dark")
    frustum(mb, 0.72, 0.36, 2.25, 3.25, 14, "M_Brass", cap=True)
    frustum(mb, 0.78, 0.72, 2.12, 2.25, 14, "M_Brass")
    oriented_box(mb, T(0, 0, 3.25), 0.12, 0.12, 0.3, "MI_MetalOrnaments")
    oriented_box(mb, T(0.45, 0, 0.9), 0.05, 0.05, 1.3, "M_Cloth", pal="linen")
    for sx in (-1, 1):
        sbox("h_bell", sx * 1.5 - 0.3, -1.0, sx * 1.5 + 0.3, 1.0, 0, 3.85)
    finish(p, "static", "tolling bell in a timber frame (walk under it: the bell's rim is at 2.1 m)")

    # --- boardwalk over the pond, the ferryman's skiff, shed, candle shrine ---
    p = P.Prefab("h_boardwalk", lod="custom")
    mb = p.mb
    L = 7.5
    box(mb, -1.0, 0.0, 0.15, 1.0, L, 0.3, "MI_WoodTrim", mode="band", band="dark", top=("MI_WoodTrim", "band", "dark"))
    for y in (0.4, 2.8, 5.2, L - 0.2):
        for sx in (-1, 1):
            oriented_box(mb, T(sx * 1.0, y, -2.4) @ Ry(sx * 3), 0.2, 0.2, 2.75 if y > 0.5 else 2.7, "MI_WoodTrim", mode="band", band="dark")
    for sx in (-1, 1):
        box(mb, sx * 1.0 - 0.05, 2.8, 0.6, sx * 1.0 + 0.05, L - 0.2, 0.68, "MI_WoodTrim", mode="band", band="dark")
    box(mb, -1.1, L - 0.32, 0.3, -0.95, L - 0.17, 2.9, "MI_MetalOrnaments")
    box(mb, -1.1, L - 0.3, 2.85, -0.4, L - 0.2, 2.92, "MI_MetalOrnaments")
    hanging_lantern(mb, T(-0.48, L - 0.25, 2.85), "M_GlowTeal", s=0.85)
    sbox("h_boardwalk", -1.1, 0.0, 1.1, L, -2.4, 0.3)
    finish(p, "static", "boardwalk over the pond: walkable dark planks, rails, a teal lantern at the end")
    p = P.Prefab("h_skiff", lod="custom")
    mb = p.mb
    hull = [(-0.6, -2.4), (0.0, -2.9), (0.6, -2.4), (0.6, 2.4), (0.0, 2.9), (-0.6, 2.4)]
    prism(mb, hull, -0.1, 0.32, "MI_WoodTrim", mode="band", band="dark", cap_top=False)
    quad(mb, [(*q, 0.05) for q in hull], "MI_WoodTrim", mode="band", band="dark")
    box(mb, -0.05, 2.2, 0.05, 0.05, 2.3, 2.0, "MI_MetalOrnaments")
    hanging_lantern(mb, T(0, 2.25, 2.0) @ T(0, 0.35, 0), "M_GlowTeal", s=0.7)
    box(mb, -0.05, 2.2, 1.95, 0.05, 2.65, 2.02, "MI_MetalOrnaments")
    finish(p, "prop", "the ferryman's skiff, moored (no collider)")
    p = P.Prefab("h_shed", lod="custom")
    mb = p.mb
    box(mb, -1.6, -1.1, -0.5, 1.6, 1.1, 0.15, "MI_RockTrim", mode="band", band="ashlar", skip=("-z",))
    for (x0, y0, x1, y1) in ((1.5, -1.0, 1.5, 1.0), (1.5, 1.0, -1.5, 1.0), (-1.5, 1.0, -1.5, -1.0)):
        h0, h1 = (2.0 if y0 < 0 else 2.6), (2.6 if y1 > 0 else 2.0)
        quad(mb, [(x0, y0, 0.15), (x1, y1, 0.15), (x1, y1, h1), (x0, y0, h0)], "MI_WoodTrim", mode="band", band="dark", tileu=2.0)
    for x in (-1.5, 1.5):
        box(mb, x - 0.08, -1.08, 0.15, x + 0.08, -0.92, 2.0, "MI_WoodTrim", mode="band", band="dark")
    pts = [(-1.8, -1.5, 1.9), (1.8, -1.5, 1.9), (1.8, 1.3, 2.75), (-1.8, 1.3, 2.75)]
    quad(mb, list(reversed(pts)), "MI_RockTrim", mode="band", band="slab", tileu=2.0); quad(mb, pts, "MI_WoodTrim", mode="band", band="dark", tileu=2.0)
    for i, x in enumerate((-0.9, -0.2, 0.5)):
        oriented_box(mb, T(x, 0.8, 0.15) @ Ry(8 - i * 6), 0.07, 0.07, 2.2, "MI_WoodTrim", mode="band", band="plank")
    flat_poly(mb, T(0.9, 0.95, 0), [(0, 0.5), (0.9, 0.5), (0.9, 1.8), (0, 1.8)], "M_Cloth", band="linen")
    sbox("h_shed", -1.6, -1.1, 1.6, 1.1, 0, 2.6)
    finish(p, "static", "ferryman's lean-to shed with oars and nets")
    p = P.Prefab("h_shrine", lod="custom")
    mb = p.mb
    box(mb, -0.9, -0.55, -0.4, 0.9, 0.55, 0.35, "MI_RockTrim", mode="band", band="ashlar", top=("MI_RockTrim", "band", "slab"))
    box(mb, -0.75, -0.4, 0.35, 0.75, 0.4, 2.1, "MI_UnevenBrick")
    P.reveal(mb, (0, -0.42, 0), (1, 0, 0), (0, 0, 1), P.arch_shape(0, 0.75, 0.9, 1.45, 6), 0.3, "MI_RockTrim", back_mat="MI_WoodTrim")
    tmp = MB(); slate_roof(tmp, 1.6, 1.0, 2.1, 0.55, over=0.15, courses=3, gables=False); mb.extend(tmp, Rz(90))
    for i, (x, h) in enumerate(((-0.25, 0.22), (0.0, 0.32), (0.22, 0.18), (-0.1, 0.14), (0.3, 0.26))):
        frustum(mb, 0.035, 0.035, 0.75, 0.75 + h, 6, "MI_Plaster", cap=True)
        frustum(mb, 0.03, 0.0, 0.75 + h, 0.75 + h + 0.07, 4, "M_GlowWarm")
    sbox("h_shrine", -0.9, -0.55, 0.9, 0.55, 0, 2.5)
    finish(p, "prop", "wayside candle shrine")

def layout_hollowmere():
    put("h_pad", 0, 0, 0, base="pad", h=PADH)
    pe, pn = GAME["portal"]
    put("h_gate", pe, pn, 0, h=PADH, label="lych-gate")
    put("h_chapel", -0.5, 22.5, 0, h=1.75, label="chapel")
    put("h_house", -19.0, 19.0, face_pad(-19.0, 19.0), label="sexton's house")
    put("h_bell", -12.5, -14.5, face_pad(-12.5, -14.5), label="bell frame")
    put("h_shrine", 12.5, -19.0, face_pad(12.5, -19.0), label="candle shrine")
    put("h_boardwalk", -18.6, 3.2, 90, water=True, label="boardwalk")
    put("h_skiff", -24.5, 5.4, 8, h=WATER - 0.06, water=True, label="skiff")
    put("h_shed", -17.5, 9.0, face_pad(-17.5, 9.0), label="ferry shed")
    put("h_cottage", 17.5, 9.0, face_pad(17.5, 9.0), label="lamplighter's cottage")
    # graveyard on the slope east of the chapel: walls with a gap, headstones snapped one by one
    put("h_wall", 11.4, 20.6, 4, label="graveyard wall S1")
    put("h_wall", 17.5, 19.9, -4, label="graveyard wall S2")
    put("h_wall", 21.6, 23.0, 88, label="graveyard wall E1")
    put("h_wall", 21.9, 27.1, 92, label="graveyard wall E2")
    rr = random.Random(5)
    stones = [(10.5, 23.0), (13.0, 23.4), (15.6, 23.2), (18.2, 22.8), (11.0, 26.0), (13.8, 25.8), (16.4, 26.4), (19.0, 25.6),
              (12.2, 29.0), (15.0, 29.4), (17.8, 28.8)]
    for i, (e, n) in enumerate(stones):
        put(("h_stone_a", "h_stone_b", "h_stone_a", "h_stone_b")[i % 4], e, n, rr.uniform(-12, 12), label=f"headstone {i}")
    put("h_stone_c", 20.2, 30.6, 10, label="obelisk")
    for (e, n) in ((-6.0, 11.0), (-4.2, 16.5), (4.4, 19.6), (-9.5, -9.0), (9.0, -9.5), (-12.0, 4.5), (11.6, 4.0), (-14.0, 13.5), (4.5, -15.5), (14.5, 12.5)):
        put("h_lantern", e, n, face_pad(e, n) + 90, label="lantern")
    path("chapel", [(-4.6, 9.2), (-3.2, 13.5), (-0.6, 15.6), (0.5, 16.6)], 2.0, mat="MI_UnevenBrick")
    path("graveyard", [(-0.6, 15.6), (6.0, 18.8), (14.4, 19.0), (14.6, 21.6)], 1.8, mat="MI_UnevenBrick")
    path("house", [(-8.4, 5.0), (-13.0, 11.0), (-16.5, 15.2)], 1.8, mat="MI_UnevenBrick")
    path("landing", [(-9.8, 1.6), (-14.0, 2.6), (-18.4, 3.2)], 1.8, mat="MI_UnevenBrick")
    path("bell", [(-7.2, -6.6), (-11.2, -12.2)], 1.6, mat="MI_UnevenBrick")
    path("shrine", [(6.8, -7.6), (11.4, -16.8)], 1.6, mat="MI_UnevenBrick")

# ============================================================================================
# MERIDIAN: Waystation Nine, an Oversight relay and courier stop in a red canyon bowl by a brine lake
# ============================================================================================
FONT5x7 = {
    "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"], "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"], "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"], "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"], "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"], "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    " ": ["00000"] * 7,
}

def block_text(mb, M, text, px, mat):
    """Stencil block letters (our own 5x7 pixel font) on the local XZ plane, centred, front -Y."""
    w = len(text) * 6 * px - px
    x0 = -w / 2
    for ci, ch in enumerate(text):
        rows = FONT5x7[ch]
        for r, row in enumerate(rows):
            c = 0
            while c < 5:
                if row[c] == "1":
                    c2 = c
                    while c2 + 1 < 5 and row[c2 + 1] == "1":
                        c2 += 1
                    xa = x0 + (ci * 6 + c) * px; xb = x0 + (ci * 6 + c2 + 1) * px
                    za = (6 - r) * px; zb = (7 - r) * px
                    flat_poly(mb, M, [(xa, za), (xb, za), (xb, zb), (xa, zb)], mat, both=False, mode="planar")
                    c = c2 + 1
                else:
                    c += 1

def build_meridian():
    # --- relay mast (hero): lattice tower, dishes, beacons, equipment cabinet ---
    p = P.Prefab("m_mast", lod="custom lattice; LOD1: drop braces beyond 90 m")
    mb = p.mb
    Hm = 24.0
    def leg(t, sx, sy):
        hw = 1.5 * (1 - t) + 0.45 * t
        return Vector((sx * hw, sy * hw, t * Hm))
    box(mb, -2.4, -2.4, -0.6, 2.4, 2.4, 0.3, "MI_RockTrim", mode="band", band="slab")
    for sx in (-1, 1):
        for sy in (-1, 1):
            a, b = leg(0, sx, sy), leg(1, sx, sy)
            d = b - a
            M = Matrix.Translation(a) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
            oriented_box(mb, M, 0.22, 0.22, d.length, "MI_Trim_03")
    nseg = 8
    for k in range(nseg):
        t0, t1 = k / nseg, (k + 1) / nseg
        for (sx0, sy0, sx1, sy1) in ((-1, -1, 1, -1), (1, -1, 1, 1), (1, 1, -1, 1), (-1, 1, -1, -1)):
            for (u0, u1) in (((sx0, sy0, t0), (sx1, sy1, t1)), ((sx1, sy1, t0), (sx0, sy0, t1))):
                a = leg(u0[2], u0[0], u0[1]); b = leg(u1[2], u1[0], u1[1])
                d = b - a
                M = Matrix.Translation(a) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
                oriented_box(mb, M, 0.08, 0.08, d.length, "MI_Trim_01")
            a = leg(t1, sx0, sy0); b = leg(t1, sx1, sy1); d = b - a
            M = Matrix.Translation(a) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
            oriented_box(mb, M, 0.1, 0.1, d.length, "MI_Trim_03")
    # platform, dishes, antenna, beacons
    box(mb, -1.3, -1.3, 15.6, 1.3, 1.3, 15.8, "MI_Trim_01")
    for (z, ang, r) in ((16.6, -60, 1.25), (12.2, 150, 0.95)):
        M = T(0, 0, z) @ Rz(ang) @ T(1.2, 0, 0) @ Ry(80)
        tmp = MB(); frustum(tmp, r, r * 0.35, 0.0, 0.45, 14, "MI_Trim_03", cap=False); frustum(tmp, r * 0.35, r, 0.45, 0.0, 14, "MI_Trim_01")
        oriented_box(tmp, T(0, 0, 0.3), 0.06, 0.06, 0.9, "MI_Trim_01"); mb.extend(tmp, M)
    cyl(mb, T(0, 0, Hm), 0.07, 0, 5.0, 6, "MI_Trim_03")
    for z in (8.0, 16.0, Hm, Hm + 5.0):
        box(mb, -0.2, -0.2, z - 0.1, 0.2, 0.2, z + 0.25, "M_GlowAmber")
    box(mb, 1.7, -0.9, 0.3, 2.6, 0.9, 2.2, "MI_Trim_01")
    box(mb, 1.68, -0.6, 1.5, 1.72, 0.6, 1.62, "M_GlowAmber")
    for sx in (-1, 1):
        for sy in (-1, 1):
            scyl("m_mast", sx * 1.5, sy * 1.5, 0.28, 0, 8.0)
    sbox("m_mast", 1.7, -0.9, 2.6, 0.9, 0, 2.2)
    finish(p, "static", "relay mast: 24 m white lattice tower, two dishes, amber beacons, equipment cabinet")

    # --- Oversight checkpoint office: 2 x 2 bays, two storeys of sci-fi wall modules ---
    p = P.Prefab("m_office", lod="sci-fi kit modules; LOD1 = textured box")
    mb = p.mb
    W, D, Hs = 8.0, 8.0, 3.0
    box(mb, -W / 2 - 0.6, -D / 2 - 0.6, -1.0, W / 2 + 0.6, D / 2 + 0.6, 0.35, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    lower = {"front": ["WallWindow_Straight", "WallAstra_Straight"], "back": ["WallAstra_Straight_Divided", "WallAstra_Straight"],
             "right": ["WallAstra_Straight", "WallWindow_Straight"], "left": ["WallAstra_Straight_Flat_Window", "WallAstra_Straight"]}
    for side, ang, origin, step in (("front", -90, (-2, -D / 2), (4, 0)), ("back", 90, (2, D / 2), (-4, 0)), ("right", 0, (W / 2, -2), (0, 4)), ("left", 180, (-W / 2, 2), (0, -4))):
        for i in range(2):
            cx, cy = origin[0] + step[0] * i, origin[1] + step[1] * i
            a = math.radians(ang)
            p.k("SF:" + lower[side][i], M=T(cx - math.cos(a) * 2.0, cy - math.sin(a) * 2.0, 0.35) @ Rz(ang + 180))
            p.k("SF:TopPlastic_Straight", M=T(cx - math.cos(a) * 2.0, cy - math.sin(a) * 2.0, 0.35) @ Rz(ang + 180))
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(mb, sx * W / 2 - 0.55, sy * D / 2 - 0.55, 0.35, sx * W / 2 + 0.55, sy * D / 2 + 0.55, 5.9, "MI_Trim_03")
            box(mb, sx * W / 2 - 0.57, sy * D / 2 - 0.57, 2.9, sx * W / 2 + 0.57, sy * D / 2 + 0.57, 3.05, "M_GlowAmber")
    box(mb, -W / 2 - 0.4, -D / 2 - 0.4, 5.35, W / 2 + 0.4, D / 2 + 0.4, 5.6, "MI_Trim_01")
    box(mb, -W / 2 + 0.1, -D / 2 + 0.1, 0.35, W / 2 - 0.1, D / 2 - 0.1, 5.35, "MI_Trim_01", skip=("-z",))
    # entrance canopy, the glyph sign, roof dish and antenna
    box(mb, -2.6, -D / 2 - 2.2, 3.4, 2.6, -D / 2 - 0.4, 3.65, "MI_Trim_03")
    box(mb, -2.6, -D / 2 - 2.25, 3.38, 2.6, -D / 2 - 2.15, 3.48, "M_GlowAmber")
    for sx in (-1, 1):
        box(mb, sx * 2.4 - 0.12, -D / 2 - 2.1, 0.35, sx * 2.4 + 0.12, -D / 2 - 1.86, 3.4, "MI_Trim_01")
    box(mb, -1.8, -D / 2 - 0.45, 5.6, 1.8, -D / 2 - 0.25, 7.3, "MI_Trim_01")
    hex_glyph(mb, T(0, -D / 2 - 0.47, 6.45), 0.68)
    tmp = MB(); frustum(tmp, 1.0, 0.3, 0.0, 0.4, 12, "MI_Trim_03"); frustum(tmp, 0.3, 1.0, 0.4, 0.0, 12, "MI_Trim_01")
    mb.extend(tmp, T(2.4, 2.4, 6.4) @ Rz(30) @ Ry(55))
    box(mb, 2.3, 2.3, 5.6, 2.5, 2.5, 6.4, "MI_Trim_01")
    cyl(mb, T(-2.6, 2.6, 5.6), 0.05, 0, 3.0, 6, "MI_Trim_03")
    box(mb, -2.7, 2.5, 8.5, -2.5, 2.7, 8.7, "M_GlowAmber")
    sbox("m_office", -W / 2 - 0.6, -D / 2 - 0.6, W / 2 + 0.6, D / 2 + 0.6, 0, 5.6)
    sbox("m_office", -2.6, -D / 2 - 2.2, 2.6, -D / 2 - 0.6, 3.4, 3.65)
    for sx in (-1, 1):
        sbox("m_office", sx * 2.4 - 0.15, -D / 2 - 2.15, sx * 2.4 + 0.15, -D / 2 - 1.8, 0, 3.4)
    finish(p, "building", "Oversight checkpoint office: white composite modules, amber light bands, hex-glyph sign, roof dish")

    # --- courier depot: a ribbed half-barrel hangar with a big shutter door ---
    p = P.Prefab("m_hangar", lod="custom; LOD1 halve the arch segments")
    mb = p.mb
    rr_, L = 4.6, 12.0
    box(mb, -rr_ - 0.4, -L / 2 - 0.4, -1.0, rr_ + 0.4, L / 2 + 0.4, 0.3, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    nseg = 12
    for k in range(nseg):
        a0 = math.pi * k / nseg; a1 = math.pi * (k + 1) / nseg
        p0 = (rr_ * math.cos(a0), 0.3 + rr_ * math.sin(a0)); p1 = (rr_ * math.cos(a1), 0.3 + rr_ * math.sin(a1))
        pts = [(p0[0], L / 2, p0[1]), (p1[0], L / 2, p1[1]), (p1[0], -L / 2, p1[1]), (p0[0], -L / 2, p0[1])]
        quad(mb, pts, "MI_Trim_02", uvs=[(k / nseg * 2, 0.0), ((k + 1) / nseg * 2, 0.0), ((k + 1) / nseg * 2, 1.5), (k / nseg * 2, 1.5)])
    for y in (-L / 2, -L / 4, 0, L / 4, L / 2):
        for k in range(nseg):
            a0 = math.pi * k / nseg; a1 = math.pi * (k + 1) / nseg
            p0 = Vector(((rr_ + 0.12) * math.cos(a0), y, 0.3 + (rr_ + 0.12) * math.sin(a0))); p1 = Vector(((rr_ + 0.12) * math.cos(a1), y, 0.3 + (rr_ + 0.12) * math.sin(a1)))
            d = p1 - p0
            M = Matrix.Translation(p0) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
            oriented_box(mb, M, 0.22, 0.3, d.length, "MI_Trim_01")
    for sy in (-1, 1):
        poly = [(rr_ * math.cos(math.pi * k / nseg), 0.3 + rr_ * math.sin(math.pi * k / nseg)) for k in range(nseg + 1)]
        pts = [(x, sy * L / 2, z) for x, z in poly]
        mb.face(pts if sy < 0 else list(reversed(pts)), "MI_Trim_03", [(x / 4, z / 4) for x, z in poly])
    oriented_box(mb, T(0, -L / 2 - 0.08, 0.3), 5.0, 0.14, 4.0, "MI_Trim_01")
    for z in (0.9, 1.7, 2.5, 3.3):
        oriented_box(mb, T(0, -L / 2 - 0.16, z), 4.9, 0.04, 0.06, "MI_Trim_03")
    oriented_box(mb, T(0, -L / 2 - 0.2, 4.4), 3.2, 0.06, 0.18, "M_GlowAmber")
    for i in range(10):
        oriented_box(mb, T(-2.25 + i * 0.5, -L / 2 - 0.17, 0.3), 0.25, 0.04, 0.3, "M_Cloth", pal="gold" if i % 2 else "dark")
    block_text(mb, T(0, -L / 2 - 0.12, 5.4), "9", 0.16, "M_Cloth")
    sbox("m_hangar", -rr_ - 0.4, -L / 2 - 0.4, rr_ + 0.4, L / 2 + 0.4, 0, 2.6)
    sbox("m_hangar", -3.4, -L / 2 - 0.3, 3.4, L / 2 + 0.3, 2.6, 4.9)
    finish(p, "building", "courier depot: ribbed half-barrel hangar, shutter door with hazard foot, a big stencilled 9")

    # --- condenser: water tank on legs, pump house, overhead pipe to the lake ---
    p = P.Prefab("m_condenser", lod="custom")
    mb = p.mb
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(mb, sx * 1.6 - 0.15, sy * 1.6 - 0.15, -0.5, sx * 1.6 + 0.15, sy * 1.6 + 0.15, 3.0, "MI_Trim_01")
    frustum(mb, 2.3, 2.3, 3.0, 7.6, 16, "MI_Trim_03", cap=False)
    frustum(mb, 2.3, 0.6, 7.6, 8.6, 16, "MI_Trim_03", cap=True)
    frustum(mb, 2.35, 2.35, 3.0, 3.25, 16, "MI_Trim_01", cap=True)
    for z in (4.6, 6.2):
        frustum(mb, 2.34, 2.34, z, z + 0.18, 16, "MI_Trim_01", cap=False)
    frustum(mb, 2.33, 2.33, 5.35, 5.5, 16, "M_GlowTeal", cap=False)
    box(mb, 2.3, -0.3, 3.2, 2.45, 0.3, 8.2, "MI_Trim_01")
    for x0, x1 in ((2.6, 10.0),):
        oriented_box(mb, T((x0 + x1) / 2, 0, 3.4) @ Ry(90) @ T(0, 0, -(x1 - x0) / 2), 0.4, 0.4, x1 - x0, "MI_Trim_02")
    for x in (5.0, 8.0):
        box(mb, x - 0.12, -0.12, -0.5, x + 0.12, 0.12, 3.2, "MI_Trim_01")
    box(mb, 9.4, -0.35, -1.5, 10.2, 0.35, 3.6, "MI_Trim_01")
    box(mb, -1.4, -3.9, -0.5, 1.4, -2.4, 2.4, "MI_Trim_03")
    box(mb, -1.42, -3.92, 1.6, 1.42, -2.38, 1.75, "M_GlowAmber")
    for sx in (-1, 1):
        for sy in (-1, 1):
            sbox("m_condenser", sx * 1.6 - 0.2, sy * 1.6 - 0.2, sx * 1.6 + 0.2, sy * 1.6 + 0.2, 0, 3.0)
    scyl("m_condenser", 0, 0, 2.35, 3.0, 8.6)
    sbox("m_condenser", -1.4, -3.9, 1.4, -2.4, 0, 2.4)
    sbox("m_condenser", 4.85, -0.15, 5.15, 0.15, 0, 3.2)
    sbox("m_condenser", 7.85, -0.15, 8.15, 0.15, 0, 3.2)
    finish(p, "static", "water condenser: tank on legs with a teal level light, pump house, overhead pipe to the brine lake")

    # --- habitation module, fuel island, solar canopy, light pylon, kiosk, billboard ---
    p = P.Prefab("m_hab", lod="sci-fi kit modules")
    mb = p.mb
    box(mb, -4.4, -2.4, -0.8, 4.4, 2.4, 0.35, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    for side, ang, cx, cy in (("front", -90, -2, -2), ("front", -90, 2, -2), ("back", 90, 2, 2), ("back", 90, -2, 2), ("right", 0, 4, 0), ("left", 180, -4, 0)):
        a = math.radians(ang)
        mod = "WallWindow_Straight" if (side == "front" and cx < 0) else "WallAstra_Straight"
        p.k("SF:" + mod, M=T(cx - math.cos(a) * 2.0, cy - math.sin(a) * 2.0, 0.35) @ Rz(ang + 180))
    box(mb, -3.9, -1.9, 0.35, 3.9, 1.9, 3.3, "MI_Trim_01", skip=("-z",))
    box(mb, -4.3, -2.3, 3.3, 4.3, 2.3, 3.55, "MI_Trim_03")
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(mb, sx * 4.0 - 0.35, sy * 2.0 - 0.35, 0.35, sx * 4.0 + 0.35, sy * 2.0 + 0.35, 3.4, "MI_Trim_03")
    box(mb, 1.2, -0.8, 3.55, 2.6, 0.8, 4.3, "MI_Trim_01")
    box(mb, -3.0, -2.36, 2.5, 0.0, -2.3, 2.6, "M_GlowAmber")
    sbox("m_hab", -4.4, -2.4, 4.4, 2.4, 0, 3.55)
    finish(p, "building", "habitation module: two kit bays long, window, roof unit, amber strip")

    p = P.Prefab("m_fuel", lod="custom")
    mb = p.mb
    box(mb, -3.2, -1.1, -0.4, 3.2, 1.1, 0.22, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    for i in range(16):
        box(mb, -3.2 + i * 0.4, -1.12, 0.0, -3.0 + i * 0.4, 1.12, 0.23, "M_Cloth", pal="gold" if i % 2 else "dark")
    for x in (-1.4, 1.4):
        box(mb, x - 0.45, -0.35, 0.22, x + 0.45, 0.35, 2.05, "MI_Trim_03")
        box(mb, x - 0.3, -0.37, 1.3, x + 0.3, -0.35, 1.75, "M_GlowAmber")
        box(mb, x - 0.47, -0.37, 0.22, x + 0.47, 0.37, 0.5, "MI_Trim_01")
    for x in (-3.0, 3.0):
        box(mb, x - 0.2, -0.2, 0.22, x + 0.2, 0.2, 4.3, "MI_Trim_01")
    box(mb, -4.2, -2.8, 4.3, 4.2, 2.8, 4.65, "MI_Trim_03")
    box(mb, -4.22, -2.82, 4.3, 4.22, 2.82, 4.4, "M_GlowAmber")
    sbox("m_fuel", -3.2, -1.1, 3.2, 1.1, 0, 0.22)
    for x in (-1.4, 1.4):
        sbox("m_fuel", x - 0.47, -0.37, x + 0.47, 0.37, 0, 2.05)
    for x in (-3.0, 3.0):
        scyl("m_fuel", x, 0, 0.25, 0, 4.3)
    finish(p, "static", "fuel island: two pumps on a hazard-edged plinth under a lit canopy")

    p = P.Prefab("m_solar", lod="custom")
    mb = p.mb
    for x in (-3.0, 0.0, 3.0):
        box(mb, x - 0.12, -0.12, -0.4, x + 0.12, 0.12, 2.6, "MI_Trim_01")
    M = T(0, 0, 2.9) @ Rx(-22)
    oriented_box(mb, M @ T(0, 0, -0.06), 7.6, 3.4, 0.06, "MI_Trim_01")
    for i in range(4):
        for j in range(2):
            oriented_box(mb, M @ T(-2.85 + i * 1.9, -0.82 + j * 1.64, 0), 1.8, 1.55, 0.04, "MI_WindowGlass")
    for x in (-3.0, 0.0, 3.0):
        scyl("m_solar", x, 0, 0.16, 0, 2.6)
    finish(p, "static", "solar canopy on posts (walk under it)")

    p = P.Prefab("m_pylon", lod="custom")
    mb = p.mb
    box(mb, -0.4, -0.4, -0.4, 0.4, 0.4, 0.25, "MI_RockTrim", mode="band", band="slab")
    frustum(mb, 0.24, 0.12, 0.25, 4.4, 6, "MI_Trim_03")
    frustum(mb, 0.26, 0.26, 1.0, 1.15, 6, "M_GlowAmber", cap=False)
    frustum(mb, 0.2, 0.2, 4.4, 4.95, 6, "M_GlowTeal", cap=True)
    frustum(mb, 0.28, 0.22, 4.95, 5.1, 6, "MI_Trim_01", cap=True)
    scyl("m_pylon", 0, 0, 0.4, 0, 4.4)
    finish(p, "prop", "chrome-white light pylon with a teal head and amber band")

    p = P.Prefab("m_billboard", lod="custom")
    mb = p.mb
    for x in (-2.6, 2.6):
        box(mb, x - 0.22, -0.22, -0.5, x + 0.22, 0.22, 4.0, "MI_Trim_01")
    box(mb, -3.4, -0.25, 4.0, 3.4, 0.25, 7.6, "MI_Trim_03")
    box(mb, -3.2, -0.27, 4.2, 3.2, -0.25, 7.4, "MI_Trim_01")
    hex_glyph(mb, T(-2.0, -0.29, 5.8), 0.95)
    block_text(mb, T(0.8, -0.29, 5.95), "WAYSTATION", 0.07, "M_GlowAmber")
    block_text(mb, T(0.8, -0.29, 4.75), "9", 0.13, "M_GlowAmber")
    for x in (-2.6, 2.6):
        sbox("m_billboard", x - 0.25, -0.25, x + 0.25, 0.25, 0, 4.0)
    finish(p, "static", "Waystation Nine billboard: the Oversight hex glyph and stencil lettering")

    p = P.Prefab("m_kiosk", lod="custom")
    mb = p.mb
    box(mb, -0.6, -0.4, -0.3, 0.6, 0.4, 0.2, "MI_RockTrim", mode="band", band="slab")
    box(mb, -0.45, -0.25, 0.2, 0.45, 0.25, 2.1, "MI_Trim_03")
    oriented_box(mb, T(0, -0.3, 1.25) @ Rx(-12), 0.7, 0.06, 0.6, "M_GlowAmber")
    box(mb, -0.55, -0.45, 2.1, 0.55, 0.45, 2.25, "MI_Trim_01")
    sbox("m_kiosk", -0.6, -0.45, 0.6, 0.45, 0, 2.25)
    finish(p, "prop", "info kiosk with an amber screen")

def layout_meridian():
    put("m_pad", 0, 0, 0, base="pad", h=PADH)
    pe, pn = GAME["portal"]
    put("m_gate", pe, pn, 0, h=PADH, label="checkpoint gate")
    put("m_mast", -7.0, 40.5, 20, label="relay mast")
    put("m_office", -9.0, 30.5, face_pad(-9.0, 30.5), label="Oversight office")
    put("m_hab", 9.0, 24.0, face_pad(9.0, 24.0), label="hab module N")
    put("m_condenser", 9.6, 13.6, -20, label="condenser")
    put("m_billboard", -17.0, 13.0, face_pad(-17.0, 13.0), label="billboard")
    put("m_hangar", -20.0, -9.0, face_pad(-20.0, -9.0), label="courier depot")
    put("m_hab", -1.5, -24.0, face_pad(-1.5, -24.0), label="hab module S")
    put("m_fuel", 9.5, -16.0, face_pad(9.5, -16.0) + 90, label="fuel island")
    put("m_solar", -6.5, 17.0, face_pad(-6.5, 17.0), label="solar canopy")
    put("m_kiosk", -6.0, -11.0, face_pad(-6.0, -11.0), label="kiosk")
    for (e, n) in ((-5.0, 12.0), (5.0, 12.0), (-11.0, 0.5), (11.0, 3.5), (-3.5, 21.0), (3.0, 19.5), (-11.0, -12.5), (6.0, -12.0), (-5.0, 33.0)):
        put("m_pylon", e, n, 0, label="light pylon")
    path("north", [(-3.6, 9.6), (-2.6, 16.0), (-4.0, 22.0), (-6.4, 24.0)], 2.4, mat="MI_RockTrim")
    path("mast", [(-2.6, 16.0), (-0.6, 26.0), (-1.4, 33.0), (-4.6, 37.6)], 2.0, mat="MI_RockTrim")
    path("hab N", [(3.4, 10.0), (6.4, 19.0)], 2.0, mat="MI_RockTrim")
    path("condenser", [(8.0, 5.6), (8.4, 9.4)], 2.0, mat="MI_RockTrim")
    path("depot", [(-9.2, -4.4), (-14.4, -6.6)], 2.4, mat="MI_RockTrim")
    path("south", [(-1.0, -10.3), (-1.4, -19.8)], 2.2, mat="MI_RockTrim")
    path("fuel", [(5.6, -8.6), (8.0, -12.4)], 2.0, mat="MI_RockTrim")

# ============================================================================================
# Round 2 (2026-10-15, the owner's picks): walls round the outposts, the new gates, Waystation
# Nine (Meridian), the stilt shelter (Hollowmere) and a shop stall in every outpost
# ============================================================================================
ROUND2 = os.path.abspath(os.path.join(HERE, "..", "round2"))
if ROUND2 not in sys.path:
    sys.path.insert(0, ROUND2)

# The wall ring round pad 0 (radius to the wall's centre line) and its gates (bearings, degrees from
# north toward east). Inside is the outpost's safe zone (packages/shared/src/planet/zones.ts).
# Arcadia's farmstead across the pond (barn, windmill, haystacks) stays outside: its fields are wild.
WALL = dict(
    arcadia=dict(radius=32.0, gates=[359.0, 110.0, 180.0]),
    hollowmere=dict(radius=42.0, gates=[330.0, 75.0, 195.0]),
    meridian=dict(radius=48.0, gates=[5.0, 250.0, 185.0]),
)[BODY]
WALL_SEG = 4.2          # segment length along the ring
WALL_H = 3.4            # wall top above its base
WALL_T = 0.8            # thickness
GATE_W = 7.0            # the gate prefab's length along the ring (opening 4.2 m)
GATE_OPEN = 4.2
WALL_SKIRT = 4.0        # the wall goes this far below its base (it stands on the highest ground under it)

def keep_r2_colors(p, cls, note):
    return finish(p, cls, note, keep_colors=True)

def r2_mesh_prefab(name, me, cls, note, solids):
    """A prefab from a round-2 vertex-colour mesh (pieces.py) with hand-authored solids."""
    p = P.Prefab(name, lod=note)
    p.parts.append((me, Matrix.Identity(4)))
    for sol in solids:
        (sbox if sol[0] == "box" else scyl)(name, *sol[1:])
    return keep_r2_colors(p, cls, note)

def build_round2_gate():
    """Pad-0 portal gate (round 2): Arcadia and Hollowmere get Astra's pale stone arch (gate B, scaled
    so the game's 2.2 m portal ring clears its piers), Meridian the Opus floating-arch gate (gate A,
    without its dais: it stands on the platform's edge, toward Portus). Front -Y faces the pad."""
    import pieces
    name = f"{B}_gate"
    if BODY == "meridian":
        me = pieces.gate_a("portus", name + "_r2", dais=False)
        me.transform(T(0, 0, -0.40))           # the pylons stand on the platform (no dais)
        sol = [("box", sx * 2.35 - 0.75, -0.85, sx * 2.35 + 0.75, 0.85, 0, 4.7) for sx in (-1, 1)]
        return r2_mesh_prefab(name, me, "static", "round 2 gate A (Opus) on the pad edge; the game draws the membrane", sol)
    me = pieces.gate_b(name + "_r2")
    # Piers: vertices between 0.6 and 3.0 m up, left and right of the centre line.
    xs = [v.co.x for v in me.vertices if 0.6 < v.co.z < 3.0]
    inner = min(abs(x) for x in xs if abs(x) > 0.5) if xs else 2.2
    k = max(1.0, (2.2 + 0.16 + 0.25) / inner)
    me.transform(Matrix.Diagonal((k, k, k, 1.0)))
    piers = [v.co for v in me.vertices if 0.6 * k < v.co.z < 3.0 * k]
    sol = []
    for sx in (-1, 1):
        side = [c for c in piers if c.x * sx > inner * k * 0.98]
        if side:
            sol.append(("box", min(c.x for c in side), min(c.y for c in side), max(c.x for c in side), max(c.y for c in side), 0, 5.0 * k))
    # The plinth has no solid: it stands on the portal's base (0.2 m under the platform), its top a
    # few centimetres over the deck, like the old gates' daises.
    log(f"gate B: pier inner face {inner:.2f} m -> scale {k:.2f}")
    return r2_mesh_prefab(name, me, "static", f"round 2 gate B (Astra), scale {k:.2f}; the game draws the ring", sol)

def build_round2_buildings():
    import pieces
    if BODY == "meridian":
        me = pieces.waystation("m_waystation_r2")
        # outpost.py: the two-tier plinth (half 8.6 x 6.4 and 8.0 x 5.8 round y 0.4, steps in front), the
        # drum (r 4.2 round (0, 0.6)), the canopy strut's foot, the spire, the sign, the tanks, the
        # annex, bollards, planters and the holo post. The saucer and canopy are overhead.
        ZP = 0.5
        sol = [("box", -8.6, -6.0, 8.6, 6.8, 0, 0.26), ("box", -8.0, -5.4, 8.0, 6.2, 0, ZP),
               ("cyl", 0, 0.6, 4.3, 0, 3.9), ("cyl", 0, -8.4, 0.5, 0, 2.4), ("cyl", -6.7, 2.6, 0.9, 0, 5.0),
               ("box", 5.0, -5.2, 6.8, -4.0, 0, 6.9), ("box", -5.4, 3.7, -1.2, 6.7, 0, 2.6),
               ("box", 2.9, 2.3, 7.1, 5.7, 0, 4.2), ("cyl", -5.6, -2.9, 0.8, 0, ZP + 0.55), ("cyl", 2.9, -3.6, 0.68, 0, ZP + 0.47),
               ("cyl", -2.9, -4.2, 0.15, 0, ZP + 1.5)]
        sol += [("cyl", x, y, 0.2, 0, ZP + 0.9) for (x, y) in ((-7.2, -4.4), (-3.0, -5.0), (3.0, -5.0), (7.2, -4.4), (-7.6, 0.4), (7.6, 0.4))]
        r2_mesh_prefab("m_waystation", me, "building", "round 2 Waystation Nine (Opus outpost A)", sol)
    if BODY == "hollowmere":
        me = pieces.shelter("h_shelter_r2")
        xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
        # One block over the deck and stilts (the stairs are a hop up the front, drawn only).
        sol = [("box", min(xs) + 0.2, min(ys) + 0.2, max(xs) - 0.2, max(ys) - 0.2, 0, max(zs))]
        r2_mesh_prefab("h_shelter", me, "building", "round 2 stilt shelter (Astra outpost B)", sol)

def build_walls():
    """The outpost wall: a segment (WALL_SEG along X, outside = -Y), a post for the joints and a gate
    (opening GATE_OPEN across the ring; the game's border line runs through it)."""
    L, H, t = WALL_SEG, WALL_H, WALL_T / 2
    # ---- segment
    name = f"{B}_ringwall"
    p = P.Prefab(name, lod="wall segment")
    mb = p.mb
    if BODY == "meridian":
        # (Low tier budget: the glow is the cap's top, a teal line along the wall at night.)
        box(mb, -L / 2, -t, -WALL_SKIRT, L / 2, t, H, "MI_Trim_01", skip=("-z",))
        box(mb, -L / 2 - 0.02, -t - 0.08, H, L / 2 + 0.02, t + 0.08, H + 0.18, "MI_Trim_03", skip=("-z",), top=("M_GlowTeal", "planar", None))
    else:
        mat = "MI_RockTrim" if BODY == "arcadia" else "MI_UnevenBrick"
        box(mb, -L / 2, -t, -WALL_SKIRT, L / 2, t, H, mat, mode="band" if mat == "MI_RockTrim" else "planar", band="field" if mat == "MI_RockTrim" else None, skip=("-z",))
        box(mb, -L / 2 - 0.02, -t - 0.1, H, L / 2 + 0.02, t + 0.1, H + 0.22, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    sbox(name, -L / 2, -t, L / 2, t, -WALL_SKIRT, H + 0.2)   # down to the skirt: no gap under it on a slope
    finish(p, "static", "outpost wall segment (round 2)")
    # ---- post (at the joints: hides height steps between segments)
    name = f"{B}_ringpost"
    p = P.Prefab(name, lod="wall post")
    mb = p.mb
    if BODY == "meridian":
        box(mb, -0.55, -0.6, -WALL_SKIRT, 0.55, 0.6, H + 0.6, "MI_Trim_03", skip=("-z",), top=("M_GlowAmber", "planar", None))
    else:
        box(mb, -0.6, -0.6, -WALL_SKIRT, 0.6, 0.6, H + 0.5, "MI_RockTrim", mode="band", band="ashlar", skip=("-z",))
        box(mb, -0.72, -0.72, H + 0.5, 0.72, 0.72, H + 0.72, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
    scyl(name, 0, 0, 0.75, -WALL_SKIRT, H + 0.8)
    finish(p, "static", "outpost wall post (round 2)")
    # ---- gate: two towers and a lintel; the opening runs along Y (through the ring)
    name = f"{B}_ringgate"
    p = P.Prefab(name, lod="wall gate")
    mb = p.mb
    o, tw = GATE_OPEN / 2, (GATE_W - GATE_OPEN) / 2
    for sx in (-1, 1):
        x0, x1 = sorted((sx * o, sx * (o + tw)))
        if BODY == "meridian":
            box(mb, x0, -0.9, -WALL_SKIRT, x1, 0.9, 5.6, "MI_Trim_03", skip=("-z",))
            box(mb, x0 - 0.02, -0.92, 4.9, x1 + 0.02, 0.92, 5.05, "M_GlowTeal", skip=("-z", "+z"))
        else:
            box(mb, x0, -0.9, -WALL_SKIRT, x1, 0.9, 5.4, "MI_RockTrim", mode="band", band="ashlar", skip=("-z",))
            box(mb, x0 - 0.1, -1.0, 5.4, x1 + 0.1, 1.0, 5.65, "MI_RockTrim", mode="band", band="slab", skip=("-z",))
            hanging_lantern(mb, T(sx * (o + tw / 2), -1.05, 4.6), "M_GlowTeal" if BODY == "hollowmere" else "M_GlowWarm")
        sbox(name, x0, -0.9, x1, 0.9, -WALL_SKIRT, 5.6)
    if BODY == "meridian":
        box(mb, -o - tw, -0.7, 5.6, o + tw, 0.7, 6.4, "MI_Trim_01")
        box(mb, -o, -0.72, 5.5, o, 0.72, 5.62, "M_GlowAmber", skip=("-z",))
    elif BODY == "arcadia":
        box(mb, -o - tw, -0.55, 5.0, o + tw, 0.55, 5.6, "MI_WoodTrim", mode="band", band="dark")
        sun_disc(mb, T(0, -0.6, 6.1), r=0.5)
        for sx in (-1, 1):
            P.banner(mb, T(sx * (o + tw / 2), -0.95, 5.3), 0.7, 2.2, ("green", "gold"))
    else:
        box(mb, -o - tw, -0.5, 5.0, o + tw, 0.5, 5.5, "MI_WoodTrim", mode="band", band="dark")
        tmp = MB(); slate_roof(tmp, GATE_W + 0.6, 2.2, 5.5, 1.1, over=0.25, ridge="x", courses=4, gables=False); mb.extend(tmp)
    finish(p, "static", "outpost wall gate (round 2)")

def build_shop():
    """The shop stall (round 2: a shop in every safe zone): a counter under an awning with goods and a
    hanging coin sign; the vendor spot is 1.6 m in front of the counter (front -Y)."""
    name = f"{B}_shop"
    p = P.Prefab(name, lod="shop stall")
    mb = p.mb
    W, D = 3.6, 2.0
    if BODY == "meridian":
        box(mb, -W / 2, -D / 2, -0.4, W / 2, D / 2, 0.15, "MI_Trim_03", skip=("-z",))
        box(mb, -W / 2 + 0.1, -D / 2 + 0.1, 0.15, W / 2 - 0.1, -D / 2 + 0.75, 1.05, "MI_Trim_01")
        box(mb, -W / 2 + 0.08, -D / 2 + 0.08, 1.05, W / 2 - 0.08, -D / 2 + 0.8, 1.12, "MI_Trim_03")
        box(mb, -W / 2 + 0.1, -D / 2 + 0.06, 0.6, W / 2 - 0.1, -D / 2 + 0.09, 0.66, "M_GlowTeal")
        for sx in (-1, 1):
            box(mb, sx * W / 2 - 0.12, D / 2 - 0.3, 0.15, sx * W / 2 + 0.12, D / 2, 2.9, "MI_Trim_03")
        box(mb, -W / 2 - 0.2, -D / 2 - 0.4, 2.9, W / 2 + 0.2, D / 2 + 0.1, 3.1, "MI_Trim_01")
        box(mb, -W / 2 - 0.2, -D / 2 - 0.42, 2.94, W / 2 + 0.2, -D / 2 - 0.38, 3.06, "M_GlowAmber")
        box(mb, -0.9, D / 2 - 0.25, 1.4, 0.9, D / 2 - 0.15, 2.6, "MI_Trim_02")
        hex_glyph(mb, T(0, D / 2 - 0.27, 2.0), 0.42, mat="M_GlowTeal")
    else:
        P.goods(mb, T(0, -D / 2 + 0.45, 0.92), ("red", "gold", "green", "linen"))
        box(mb, -W / 2 + 0.05, -D / 2 + 0.05, 0, W / 2 - 0.05, -D / 2 + 0.85, 0.92, "MI_WoodTrim", mode="band", band="dark", top=("MI_WoodTrim", "band", "plank"))
        for sx in (-1, 1):
            box(mb, sx * W / 2 - 0.07, -D / 2 - 0.07, -0.3, sx * W / 2 + 0.07, -D / 2 + 0.07, 2.4, "MI_WoodTrim", mode="band", band="plank")
            box(mb, sx * W / 2 - 0.07, D / 2 - 0.07, -0.3, sx * W / 2 + 0.07, D / 2 + 0.07, 2.9, "MI_WoodTrim", mode="band", band="plank")
        cols = ("teal", "cream") if BODY == "hollowmere" else ("green", "gold")
        n = 10
        for i in range(n):
            a = -W / 2 - 0.15 + (W + 0.3) * i / n
            b = -W / 2 - 0.15 + (W + 0.3) * (i + 1) / n
            c = cols[i % 2]
            pts = [(a, -D / 2 - 0.5, 2.25), (b, -D / 2 - 0.5, 2.25), (b, D / 2 + 0.1, 3.0), (a, D / 2 + 0.1, 3.0)]
            mb.face(pts, "M_Cloth", [pal_uv(c)] * 4); mb.face(list(reversed(pts)), "M_Cloth", [pal_uv(c)] * 4)
            v = [(a, -D / 2 - 0.5, 1.98), (b, -D / 2 - 0.5, 1.98), (b, -D / 2 - 0.5, 2.25), (a, -D / 2 - 0.5, 2.25)]
            mb.face(v, "M_Cloth", [pal_uv(c)] * 4); mb.face(list(reversed(v)), "M_Cloth", [pal_uv(c)] * 4)
        box(mb, -W / 2 - 0.05, D / 2 - 0.12, 0.9, W / 2 + 0.05, D / 2, 2.9, "MI_WoodTrim", mode="band", band="plank")
        # hanging coin sign on an iron arm at the right front post
        box(mb, W / 2 - 0.04, -D / 2 - 0.9, 2.55, W / 2 + 0.04, -D / 2, 2.62, "MI_MetalOrnaments")
        sun_disc(mb, T(W / 2, -D / 2 - 0.75, 2.15), r=0.32)
    sbox(name, -W / 2, -D / 2, W / 2, D / 2, 0, 2.9)
    finish(p, "prop", "shop stall (round 2): the vendor stands behind the counter, the buyer at its front")

def wall_ring():
    """The wall round the outpost: each arc between two gates split into equal runs of segments (their
    ends tucked 0.3 m into the gate towers, neighbours overlapping a little), segments over water left
    out (the lake shore closes the ring there), posts on the joints, the gates on their bearings."""
    R_, gates = WALL["radius"], sorted(WALL["gates"])
    def at(b, r=R_):
        a = math.radians(b)
        return math.sin(a) * r, math.cos(a) * r
    def wet(b0, b1):
        for t in (0.0, 0.5, 1.0):
            for dr in (-WALL_T / 2 - 0.3, WALL_T / 2 + 0.3):
                e, n_ = at(b0 + (b1 - b0) * t, R_ + dr)
                if ground(e, n_) < WATER + 0.2:
                    return True
        return False
    tuck = math.degrees((GATE_W / 2 - 0.3) / R_)
    joints = []
    for i, g in enumerate(gates):
        g1 = gates[(i + 1) % len(gates)] + (360.0 if i == len(gates) - 1 else 0.0)
        b0, b1 = g + tuck, g1 - tuck
        arc = math.radians(b1 - b0) * R_
        n = max(1, math.ceil(arc / (WALL_SEG - 0.05)))
        step = (b1 - b0) / n
        for k in range(n):
            s0, s1 = b0 + k * step, b0 + (k + 1) * step
            if wet(s0, s1):
                continue
            e, n_ = at((s0 + s1) / 2)
            put(f"{B}_ringwall", e, n_, (-(s0 + s1) / 2) % 360.0, base="max", label="wall")
            for jb, inner in ((s0, k == 0), (s1, k == n - 1)):
                if not inner:
                    joints.append(jb % 360.0)
    for jb in sorted(set(round(j, 4) for j in joints)):
        e, n_ = at(jb)
        put(f"{B}_ringpost", e, n_, (-jb) % 360.0, base="max", label="wall post")
    for g in gates:
        e, n_ = at(g)
        put(f"{B}_ringgate", e, n_, (-g) % 360.0, base="max", label="wall gate")

def gate_path(g, inner_pts, width=2.4, mat="MI_RockTrim"):
    """A path from just outside a wall gate in to `inner_pts` (site east/north)."""
    a = math.radians(g)
    out = [(math.sin(a) * (WALL["radius"] + 4.0), math.cos(a) * (WALL["radius"] + 4.0)),
           (math.sin(a) * (WALL["radius"] - 3.0), math.cos(a) * (WALL["radius"] - 3.0))]
    path(f"gate {g:.0f}", out + list(inner_pts), width, mat=mat)

# The shop stall (round 2): the keeper stands behind the counter (SHOP_SPOTS pos), buyers in front.
SHOP_AT = dict(arcadia=(-9.5, -17.5), hollowmere=(-1.0, -19.0), meridian=(-12.0, 6.5))[BODY]
SHOP_KEEPER_Y = 0.35   # prefab-local y (back of the counter; front is -Y)
SHOP = {}

def place_shop():
    e, n_ = SHOP_AT
    yaw = face_pad(e, n_)
    put(f"{B}_shop", e, n_, yaw, label="shop stall")
    ke, kn = local_to_geo(e, n_, yaw, 0.0, SHOP_KEEPER_Y)
    SHOP.update(at=[round(ke, 3), round(kn, 3)], item=len(LAYOUT) - 1)

def layout_round2():
    """Round 2 over the Phase B layout: the new gate on the portal, Waystation Nine (Meridian, in place
    of the courier depot) and the stilt shelter (Hollowmere, in place of the ferry shed), the wall ring
    with its gates and paths, the shop stall."""
    drop = dict(arcadia=(), hollowmere=("h_shed",), meridian=("m_hangar",))[BODY]
    # Small lights standing where the wall now runs go (Arcadia's lamp by the north causeway).
    lights = {f"{B}_lamp", f"{B}_lantern", f"{B}_pylon"}
    near_wall = lambda it: it["prefab"] in lights and abs(math.hypot(it["east"], it["north"]) - WALL["radius"]) < 3.0
    LAYOUT[:] = [it for it in LAYOUT if it["prefab"] not in drop and not near_wall(it)]
    PATHS[:] = [pa for pa in PATHS if not (BODY == "meridian" and pa["name"] == "depot")]
    for it in LAYOUT:
        if it["prefab"] == f"{B}_gate":
            it["h"] = PADH - 0.2 if BODY != "meridian" else PADH
    for it in LAYOUT:
        # The wider gate B leaves this lantern too close to its pier: a step out.
        if BODY == "hollowmere" and it["prefab"] == "h_lantern" and (it["east"], it["north"]) == (-6.0, 11.0):
            it["east"], it["north"] = -7.4, 12.4
    if BODY == "meridian":
        # On the flattest ground west of the pad (0.55 m across its plinth), facing the pad.
        put("m_waystation", -26.0, -1.0, face_pad(-26.0, -1.0), label="Waystation Nine")
        path("waystation", [(-8.9, -2.4), (-16.0, -2.8)], 2.4, mat="MI_RockTrim")
        gate_path(5.0, [(-0.6, 37.0), (-1.4, 33.0)], 2.2)
        gate_path(250.0, [(-28.0, -14.0), (-17.0, -12.0), (-9.5, -6.0)], 2.2)
        gate_path(185.0, [(2.0, -34.0), (6.4, -24.5), (5.2, -15.5), (2.8, -10.0)], 2.2)
    elif BODY == "hollowmere":
        put("h_shelter", -17.5, 9.0, face_pad(-17.5, 9.0), label="stilt shelter")
        gate_path(330.0, [(-13.5, 27.0), (-11.0, 17.0), (-13.0, 11.0)], 1.8, mat="MI_UnevenBrick")
        gate_path(75.0, [(29.0, 5.0), (19.0, 3.2), (10.5, 2.5)], 1.8, mat="MI_UnevenBrick")
        gate_path(195.0, [(-8.0, -24.0), (-7.2, -6.6)], 1.8, mat="MI_UnevenBrick")
    else:
        gate_path(359.0, [(-1.6, 29.0)], 2.2)
        gate_path(110.0, [(16.0, -11.0), (8.2, -12.2)], 2.0)
        gate_path(180.0, [(-0.6, -22.0), (-1.6, -12.0)], 2.0)
    wall_ring()
    place_shop()

def build_prefabs_round2():
    build_pad_platform()
    build_round2_gate()
    build_waystone()
    dict(arcadia=build_arcadia, hollowmere=lambda: build_hollowmere(), meridian=lambda: build_meridian())[BODY]()
    build_round2_buildings()
    build_walls()
    build_shop()

def build_prefabs():
    build_pad_platform()
    build_gate()
    build_waystone()
    dict(arcadia=build_arcadia, hollowmere=lambda: build_hollowmere(), meridian=lambda: build_meridian())[BODY]()

def write_outputs(problems, warns, stats):
    lay = []
    for it in LAYOUT:
        lay.append(dict(prefab=it["prefab"], east=round(it["east"], 3), north=round(it["north"], 3), yaw=round(it["yaw"], 2),
                        scale=it["scale"], base=round(it["base_h"], 3), label=it["label"],
                        solids=[dict(poly=[[round(a, 3), round(b, 3)] for a, b in s_["poly"]], z0=round(s_["z0"], 3), z1=round(s_["z1"], 3)) for s_ in it.get("solids_w", [])]))
    prefabs = {}
    for k, info in P.PREFAB_INFO.items():
        if k not in CLASS:
            continue
        tr = info.get("tris", 0)
        mats = info.get("mats", [])
        prefabs[k] = dict(cls=CLASS[k], tris=tr, mats=mats, note=NOTE.get(k, ""),
                          solids=[[s_[0], round(s_[1], 3), round(-s_[2], 3), round(s_[3], 3), round(s_[4], 3), round(s_[5], 3), round(s_[6], 3), s_[7]] for s_ in SOLIDS.get(k, [])],
                          size=[round(info["max"][i] - info["min"][i], 2) for i in range(3)] if "max" in info else None)
    out = dict(body=BODY, R=R, padH=PADH, frame="pad 0: east/north geodesic metres (content/places.ts tangentFrame), yaw deg CCW, 0 = front faces south; solids [shape, cx, cz(front), hx, hz, y0, y1, yaw] prefab frame",
               layout=lay, paths=PATHS, prefabs=prefabs, validation=dict(problems=problems, warnings=warns, stats=stats), budget=BUDGET,
               slot_tints={k: list(v) for k, v in TINTS.items()}, new_slots=NEW_SLOTS,
               props_cleared=sorted(PROP_DROPS), wall=dict(radius=WALL["radius"], gates=WALL["gates"]), shop=SHOP)
    with open(os.path.join(OUT, f"{BODY}_layout.json"), "w") as f:
        json.dump(out, f, indent=1)
    plan = dict(items=[dict(prefab=it["prefab"], label=it["label"], east=it["east"], north=it["north"],
                            fp=[list(p) for p in (it["solids_w"][0]["poly"] if it.get("solids_w") else [])],
                            solids=[[list(p) for p in s_["poly"]] for s_ in it.get("solids_w", [])]) for it in LAYOUT],
                paths=PATHS)
    with open(os.path.join(OUT, f"{BODY}_plan.json"), "w") as f:
        json.dump(plan, f)

CUTOUT = ("MI_Vine", "Leaves_NormalTree", "Leaves_Pine", "Flowers", "Leaves", "Leaf_Pine", "Grass", "Plant")

def tris_by_mat(name):
    me = P.PREFABS[name].data if name in P.PREFABS else None
    out = {}
    if me is None:
        return out
    for poly in me.polygons:
        m = me.materials[poly.material_index].name if me.materials and me.materials[poly.material_index] else "?"
        out[m] = out.get(m, 0) + len(poly.vertices) - 2
    return out

def lod1_tris(name):
    """LOD1 estimate (Portus pack rules): kit tile roofs -> 2-slope shells, no vine patches, trees -> crossed cards."""
    cls = CLASS.get(name, "prop")
    tb = tris_by_mat(name)
    t = sum(tb.values())
    if cls == "tree":
        return 4
    t -= tb.get("MI_Vine", 0)
    if tb.get("MI_RoundTiles", 0) > 200:
        t -= tb["MI_RoundTiles"] - 60
    return max(t, 0)

def budget():
    rows = {}
    for it in LAYOUT:
        rows[it["prefab"]] = rows.get(it["prefab"], 0) + 1
    total = total1 = 0
    cut = False
    lines = []
    for k, c in sorted(rows.items(), key=lambda kv: -P.PREFAB_INFO[kv[0]]["tris"] * kv[1]):
        t = P.PREFAB_INFO[k]["tris"]
        t1 = lod1_tris(k)
        total += t * c
        total1 += t1 * c
        if any(any(cn in m for cn in CUTOUT) for m in tris_by_mat(k)):
            cut = True
        lines.append(f"{k:16s} {t:7d} x {c:2d} = {t * c:7d}   LOD1 {t1 * c:7d}  {CLASS.get(k, '')}")
    if f"{B}_paths" in P.PREFAB_INFO:
        t = P.PREFAB_INFO[f"{B}_paths"]["tris"]
        total += t; total1 += t
        lines.append(f"{B + '_paths':16s} {t:7d} x  1 = {t:7d}   LOD1 {t:7d}  decal (ground paths)")
    other = len(SITE["pads"]) - 1
    pt = P.PREFAB_INFO[f"{B}_pad"]["tris"] + P.PREFAB_INFO[f"{B}_waystone"]["tris"]
    lines.append("")
    lines.append(f"other pads: {other} x ({B}_pad + {B}_waystone) = {pt} tris each, one InstancedMesh; pads are >= 554 m apart, so at")
    lines.append("pad 0 none is within the pad cull distance (0.9 x the 520 m load radius, Game.ts -> Portals.update): 0 extra triangles there.")
    draws_med = 2 + (2 if cut else 0)
    draws_low = 1 + (1 if cut else 0)
    lines.append("")
    lines.append(f"PER TIER at the pad-0 arrival view (estimate; Portus D41 pattern: one merged mesh per material class and LOD):")
    lines.append(f"  Medium/High/Ultra: LOD0 {total} tris; draws {1 + (1 if cut else 0)} view + {1 + (1 if cut else 0)} shadow (depth-only copy) = {draws_med}")
    lines.append(f"  Low:               LOD1 {total1} tris; draws {draws_low}, no shadows, no normal maps")
    lines.append(f"  Replaced: the old pad-0 cylinder and portal base (-2 draws); other pads' cylinders -> 1 instanced draw when in range.")
    BUDGET.update(lod0=total, lod1=total1, draws_medium=draws_med, draws_low=draws_low, cutout=cut)
    return total, lines

BUDGET = {}

def main():
    P.init_scene()
    setup_materials()
    if BODY == "meridian":
        setup_scifi_materials()
    build_prefabs_round2()
    log("prefabs:", len(CLASS))
    place_game_objects()
    dict(arcadia=layout_arcadia, hollowmere=lambda: layout_hollowmere(), meridian=lambda: layout_meridian())[BODY]()
    layout_round2()
    resolve_bases()
    problems, warns, stats = validate()
    total, lines = budget()
    for l in lines:
        log("BUDGET", l)
    log("BUDGET total", total)
    build_paths()
    if PLAN_ONLY or opt("--export-only", False):
        write_outputs(problems, warns, stats)
        if opt("--export-only", False):
            export_prefabs()
        return
    # the scene
    def keep_out(e, n, r):
        for it in LAYOUT:
            for s_ in it.get("solids_w", []):
                if point_poly_dist((e, n), s_["poly"]) < r + 2.5:
                    return True
            if it["prefab"] in (f"{B}_pad",):
                continue
            if math.hypot(e - it["east"], n - it["north"]) < r + 1.5:
                return True
        for pa in PATHS:
            for i in range(len(pa["pts"]) - 1):
                if _seg_dist((e, n), pa["pts"][i], pa["pts"][i + 1]) < pa["width"] / 2 + r + 0.6:
                    return True
        return False
    build_ground()
    build_water()
    place_props(keep_out)
    place_breakables()
    instance_layout()
    total, lines = budget()
    write_outputs(problems, warns, stats)
    with open(os.path.join(OUT, f"{BODY}_budget.txt"), "w") as f:
        f.write(f"{BODY} pad-0 outpost + pad platform: LOD0 triangles as laid out\n\n" + "\n".join(lines) + f"\n\nTOTAL {total}\n")
    if opt("--probe", False):
        dg = bpy.context.evaluated_depsgraph_get()
        for (e, n) in ((9.0, 0.0), (0.0, -9.0), (6.5, -6.5), (0.0, -5.0), (10.2, 0.0)):
            hit = P.SC.ray_cast(dg, surf(e, n, PADH + 5), Vector((0, 0, -1)))
            log("PROBE", (e, n), hit[0], round(hit[1].z, 4) if hit[0] else None, hit[4].name if hit[0] else None,
                hit[4].active_material.name if hit[0] and hit[4].active_material else None)
        return
    P.setup_render()
    setup_sky()
    add_sun()
    ov = build_overlays()
    do_renders(ov)
    log("done")

def do_renders(ov):
    show = lambda objs, on: [setattr(o, "hide_render", not on) for o in objs]
    if "arrival" in RENDERS:
        # the game's arrival view: spawn ring on pad 0, camera facing the reference direction (north)
        cam, ppos, _ = game_camera(0.0, -2.0, 90.0)
        fig = bpy.data.objects.new("player", figure("player_fig", dict(legs=0x3a3a48, body=0x2f6fb0, skin=0xe0b898, hat=0x2a2a30)))
        fig.matrix_world = surf_matrix(0.0, -2.0, 0.0, h=PADH + 0.02)
        P.SC.collection.objects.link(fig)
        render(cam, "arrival")
        fig.hide_render = True
    if "arrival_wide" in RENDERS:
        cam = P.add_camera("cam_wide", 18)
        P.look_at(cam, surf(0, -9, PADH + 1.8), surf(0, 20, PADH + 3.5))
        render(cam, "arrival_wide")
    if FOG:
        FOG["node"].inputs[1].default_value = FOG["k"] * 0.35   # aerials: the game's fog thins with height (falloff)
    if BODY == "hollowmere":
        P.SC.view_settings.exposure = 0.8   # aerials only: dusk is too dark to read the layout
    if "aerial" in RENDERS:
        show(ov, True)
        cam = P.add_camera("cam_aerial", AERIAL[BODY][2])
        P.look_at(cam, surf(*AERIAL[BODY][0]), surf(*AERIAL[BODY][1]))
        render(cam, "aerial")
        show(ov, False)
    if "aerial_clean" in RENDERS:
        cam = P.add_camera("cam_aerial2", AERIAL[BODY][2])
        P.look_at(cam, surf(*AERIAL[BODY][0]), surf(*AERIAL[BODY][1]))
        render(cam, "aerial_clean")
    if FOG:
        FOG["node"].inputs[1].default_value = FOG["k"]
    P.SC.view_settings.exposure = 0.0
    if "pad" in RENDERS:
        cam = P.add_camera("cam_pad", 24)
        P.look_at(cam, surf(*PADCAM[BODY][0]), surf(*PADCAM[BODY][1]))
        render(cam, "pad")
    if "top" in RENDERS:
        show(ov, True)
        cam = P.add_camera("cam_top", 50)
        cam.data.type = "ORTHO"; cam.data.ortho_scale = 110
        P.look_at(cam, surf(4, 8, PADH + 300), surf(4, 8, PADH), roll_up=Vector((0, 1, 0)))
        render(cam, "top")
        show(ov, False)
    for extra in [r for r in RENDERS if r.startswith("eye:")]:
        # eye:<name>:e/n/h:te/tn/th:lens (heights above the ground there)
        _, nm, a, b, lens = extra.split(":")
        cam = P.add_camera("cam_" + nm, float(lens))
        a = [float(x) for x in a.split("/")]; b = [float(x) for x in b.split("/")]
        P.look_at(cam, surf(a[0], a[1], ground(a[0], a[1]) + a[2]), surf(b[0], b[1], ground(b[0], b[1]) + b[2]))
        render(cam, nm)
    if "sheet" in RENDERS:
        for o in P.SC.objects:
            if o.type != "LIGHT":
                o.hide_render = True
        P.SC.compositing_node_group = None
        P.SC.render.film_transparent = False
        w = bpy.data.worlds.new("studio"); w.use_nodes = True
        bgn = next(n_ for n_ in w.node_tree.nodes if n_.type == "BACKGROUND")
        bgn.inputs[0].default_value = (0.55, 0.62, 0.72, 1); bgn.inputs[1].default_value = 1.2
        P.SC.world = w
        names = [k for k in CLASS if k in P.PREFABS and CLASS[k] not in ("decal",)]
        P.lineup_sheet(names, os.path.join(OUT, f"{BODY}_prefabs.png"), res=(2400, 900))
    if "export" in RENDERS:
        export_prefabs()

# camera specs: (eye (e, n, h above R), target (e, n, h), lens)
AERIAL = dict(
    arcadia=((-38.0, -48.0, PADH + 46.0), (4.0, 14.0, PADH - 2.0), 22),
    hollowmere=((-40.0, -46.0, PADH + 44.0), (2.0, 14.0, PADH - 2.0), 22),
    meridian=((-40.0, -48.0, PADH + 46.0), (2.0, 12.0, PADH - 2.0), 22),
)
PADCAM = dict(
    arcadia=((8.5, -15.5, PADH + 6.8), (0.0, 2.5, PADH + 0.8), 22),
    hollowmere=((8.5, -15.5, PADH + 6.8), (0.0, 2.5, PADH + 1.0), 22),
    meridian=((-8.5, -15.5, PADH + 6.8), (0.0, 2.5, PADH + 0.8), 22),
)

def export_prefabs():
    """One GLB per prefab used (Y-up, front +Z in glTF), textures shared in prefabs/textures."""
    import shutil
    pdir = str(opt("--export-dir", os.path.join(OUT, f"{BODY}_prefabs")))
    tmp = os.path.join(OUT, "scratch", f"gltf_{BODY}")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    os.makedirs(pdir, exist_ok=True)
    for f_ in os.listdir(pdir):
        if f_.endswith(".glb"):
            os.remove(os.path.join(pdir, f_))
    used = {it["prefab"] for it in LAYOUT} | {f"{B}_waystone", f"{B}_pad"}
    imgs = set()
    for name in sorted(used):
        obj = P.PREFABS[name]
        obj.hide_set(False)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        gl = os.path.join(tmp, name + ".gltf")
        bpy.ops.export_scene.gltf(filepath=gl, export_format="GLTF_SEPARATE", export_texture_dir="textures",
                                  use_selection=True, export_yup=True, export_apply=False, export_animations=False,
                                  export_cameras=False, export_lights=False, export_extras=False, export_keep_originals=False)
        obj.hide_set(True)
        P.pack_glb(gl, os.path.join(pdir, name + ".glb"))
        with open(gl) as f_:
            for im in json.load(f_).get("images", []):
                imgs.add(im["uri"])
    shutil.rmtree(os.path.join(pdir, "textures"), ignore_errors=True)
    os.makedirs(os.path.join(pdir, "textures"), exist_ok=True)
    for u in imgs:
        src = os.path.join(tmp, u)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(pdir, u))
    log(f"exported {len(used)} GLBs, {len(imgs)} textures -> {pdir}")

main()
