# Portus town: render the PACKED town (what the game ships) in Blender, to check the packing:
# geometry per prefab, material slots, texture layers, tints and cutouts. Not the game's lighting.
#
#   KEEP_WORK=1 tools/blender/portus/build.sh        # prints the work folder
#   blender -b --disable-autoexec --factory-startup --python tools/blender/portus/preview.py -- \
#     --packed <work>/packed --out /tmp/portus_preview.png [--view plaza_eye|aerial|street_eye] [--lod 0|1]
#
# Reads portus_raw.glb (uncompressed), town.json, pack_report.json and the two WebP strips from
# <work>/packed. Each item is placed like the game does (town frame at the pole, geodesic east/north,
# yaw counter-clockwise from above), here in Blender's Z-up frame (east +x, north +y).
import bpy, sys, os, json, math
from mathutils import Matrix, Vector, Quaternion

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def opt(name, default=None):
    return ARGV[ARGV.index(name) + 1] if name in ARGV else default


PACKED = os.path.abspath(opt("--packed", ""))
OUT = os.path.abspath(opt("--out", "/tmp/portus_preview.png"))
VIEW = opt("--view", "plaza_eye")
LOD = int(opt("--lod", "0"))
R = 150.0
town = json.load(open(os.path.join(PACKED, "town.json")))
report = json.load(open(os.path.join(PACKED, "pack_report.json")))
slots = report["slotTable"]
N = len(report["layers"])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(PACKED, "portus_raw.glb"))
color_img = bpy.data.images.load(os.path.join(PACKED, "portus_color.webp"))
normal_img = bpy.data.images.load(os.path.join(PACKED, "portus_normal.webp"))
normal_img.colorspace_settings.name = "Non-Color"


def slot_material(i, s):
    m = bpy.data.materials.new(f"slot_{i}_{s['name']}")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeUVMap")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(uv.outputs["UV"], sep.inputs[0])
    # glTF v = 1 - Blender v; layer i spans image v in [1 - (i + 1)/N, 1 - i/N].
    one_minus = nt.nodes.new("ShaderNodeMath"); one_minus.operation = "SUBTRACT"; one_minus.inputs[0].default_value = 1.0
    nt.links.new(sep.outputs["Y"], one_minus.inputs[1])
    fr = nt.nodes.new("ShaderNodeMath"); fr.operation = "FRACT"
    nt.links.new(one_minus.outputs[0], fr.inputs[0])
    add = nt.nodes.new("ShaderNodeMath"); add.operation = "ADD"; add.inputs[1].default_value = s["layer"]
    nt.links.new(fr.outputs[0], add.inputs[0])
    div = nt.nodes.new("ShaderNodeMath"); div.operation = "DIVIDE"; div.inputs[1].default_value = N
    nt.links.new(add.outputs[0], div.inputs[0])
    vimg = nt.nodes.new("ShaderNodeMath"); vimg.operation = "SUBTRACT"; vimg.inputs[0].default_value = 1.0
    nt.links.new(div.outputs[0], vimg.inputs[1])
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(sep.outputs["X"], comb.inputs[0])
    nt.links.new(vimg.outputs[0], comb.inputs[1])
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = color_img; tex.extension = "REPEAT"
    nt.links.new(comb.outputs[0], tex.inputs[0])
    vc = nt.nodes.new("ShaderNodeVertexColor")
    mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"; mul.inputs[0].default_value = 1.0
    nt.links.new(tex.outputs["Color"], mul.inputs[6])
    nt.links.new(vc.outputs["Color"], mul.inputs[7])
    tint = nt.nodes.new("ShaderNodeMix"); tint.data_type = "RGBA"; tint.blend_type = "MULTIPLY"; tint.inputs[0].default_value = 1.0
    tint.inputs[7].default_value = (*s["tint"], 1.0)
    nt.links.new(mul.outputs[2], tint.inputs[6])
    nt.links.new(tint.outputs[2], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = s["rough"]
    bsdf.inputs["Metallic"].default_value = s["metal"]
    if s["normal"] > 0:
        ntex = nt.nodes.new("ShaderNodeTexImage"); ntex.image = normal_img; ntex.extension = "REPEAT"
        nt.links.new(comb.outputs[0], ntex.inputs[0])
        nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = s["normal"]
        nt.links.new(ntex.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if s["cutout"]:
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        m.blend_method = "CLIP" if hasattr(m, "blend_method") else m.blend_method
    if s["emissive"][3] > 0:
        bsdf.inputs["Emission Color"].default_value = (*s["emissive"][:3], 1.0)
        bsdf.inputs["Emission Strength"].default_value = s["emissive"][3] * 2
    return m


mats = [slot_material(i, s) for i, s in enumerate(slots)]

# Per prefab node: one mesh object with per-face materials from the slot in COLOR_0.a.
protos = {}
for o in list(bpy.context.scene.objects):
    if o.type != "MESH":
        continue
    name = o.parent.name if o.parent and o.parent.type == "EMPTY" else o.name
    name = name.split(".")[0]
    me = o.data
    ca = me.color_attributes[0] if me.color_attributes else None
    me.materials.clear()
    for m in mats:
        me.materials.append(m)
    if ca is not None:
        for poly in me.polygons:
            if ca.domain == "CORNER":
                a = ca.data[poly.loop_indices[0]].color[3]
            else:
                a = ca.data[me.loops[poly.loop_indices[0]].vertex_index].color[3]
            poly.material_index = min(len(mats) - 1, int(round(a * 255)))
    o.matrix_parent_inverse = Matrix.Identity(4)
    protos.setdefault(name, []).append(o)

for objs in protos.values():
    for o in objs:
        o.hide_render = True
        o.hide_viewport = True

coll = bpy.context.scene.collection
cls = {p["name"]: p for p in town["prefabs"]}
for it in town["layout"]:
    pre = cls[it["prefab"]]
    key = it["prefab"] + ("__L1" if LOD == 1 and pre["lod"] == "geom" else "")
    e, n = it["east"], it["north"]
    r = math.hypot(e, n)
    t = r / R
    a = math.atan2(n, e)
    up = Vector((math.sin(t) * math.cos(a), math.sin(t) * math.sin(a), math.cos(t)))
    q = Vector((0, 0, 1)).rotation_difference(up) @ Quaternion((0, 0, 1), math.radians(it["yaw"]))
    mw = Matrix.Translation(Vector((0, 0, -R)) + R * up) @ q.to_matrix().to_4x4() @ Matrix.Scale(it.get("scale", 1.0), 4)
    for src in protos.get(key, []):
        o = src.copy()
        o.hide_render = o.hide_viewport = False
        o.parent = None
        o.matrix_world = mw @ src.matrix_basis if src.parent is None else mw @ src.matrix_local
        coll.objects.link(o)

# Ground sphere and sky like the game's Portus look (grass green, warm sun at 0.85 rad).
bpy.ops.mesh.primitive_uv_sphere_add(radius=R - 0.01, location=(0, 0, -R), segments=256, ring_count=128)
ground = bpy.context.active_object
gm = bpy.data.materials.new("ground"); gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.13, 0.3, 0.09, 1)
ground.data.materials.append(gm)
sun = bpy.data.lights.new("sun", "SUN"); sun.energy = 4.0; sun.color = (1.0, 0.95, 0.85)
so = bpy.data.objects.new("sun", sun); coll.objects.link(so)
so.rotation_euler = (math.radians(90 - 48.7), 0, math.radians(180 + 34))
w = bpy.data.worlds.new("w"); bpy.context.scene.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0.45, 0.62, 0.9, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.9


def eye(e, n, h, te, tn, th):
    def p(e_, n_, h_):
        r = math.hypot(e_, n_); t = r / R; a = math.atan2(n_, e_)
        up = Vector((math.sin(t) * math.cos(a), math.sin(t) * math.sin(a), math.cos(t)))
        return Vector((0, 0, -R)) + (R + h_) * up
    cam = bpy.data.cameras.new("cam"); cam.lens = 18 if VIEW != "aerial" else 24
    co = bpy.data.objects.new("cam", cam); coll.objects.link(co)
    pos, tgt = p(e, n, h), p(te, tn, th)
    co.location = pos
    d = (tgt - pos).normalized()
    co.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = co


VIEWS = {"plaza_eye": (0, -6, 1.7, 0, 40, 6), "street_eye": (-24, 0.5, 1.7, -60, 1, 3), "aerial": (0, -95, 70, 0, 8, 0)}
eye(*VIEWS[VIEW])
sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = 1600, 900
sc.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Standard"
sc.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("[preview] wrote", OUT)
