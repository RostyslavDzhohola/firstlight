# Preview the round-2 pieces as the game will shade them: vertex colours only (baked AO, grime and
# noise), the OK_* slots' roughness, a warm sun and a soft sky. One image of all pieces side by side.
#   blender -b --disable-autoexec --factory-startup --python preview.py -- --out <png> [--pieces house,gate_a,...]
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pieces as PC  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
opt = {argv[i][2:]: argv[i + 1] for i in range(0, len(argv) - 1, 2) if argv[i].startswith("--")}
OUT = opt.get("out", "/tmp/fl-b2/preview.png")
WANT = opt.get("pieces", "house_a,house_d,gate_a,gate_b,waystation,shelter").split(",")

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

builders = {
    "house_a": lambda: PC.house(4.53, 4.32, 0, "house_a"),
    "house_b": lambda: PC.house(4.53, 6.32, 1, "house_b"),
    "house_c": lambda: PC.house(6.53, 4.32, 2, "house_c"),
    "house_d": lambda: PC.house(6.53, 6.32, 3, "house_d"),
    "gate_a": lambda: PC.gate_a("arcadia", "gate_a"),
    "gate_a_pad": lambda: PC.gate_a("portus", "gate_a_pad", dais=False),
    "gate_b": lambda: PC.gate_b("gate_b"),
    "waystation": lambda: PC.waystation("waystation"),
    "shelter": lambda: PC.shelter("shelter"),
}
x = 0.0
objs = []
for key in WANT:
    me = builders[key]()
    xs = [v.co.x for v in me.vertices]
    w = max(xs) - min(xs)
    ob = bpy.data.objects.new(key, me)
    sc.collection.objects.link(ob)
    ob.location = (x - min(xs), 0, 0)
    x += w + 3.0
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    print(f"PIECE {key}: {tris} triangles, {w:.1f} m wide, materials {[m.name for m in me.materials]}")
    objs.append(ob)

# Materials as the game sees them: base colour = Col, the slot's roughness, glow emissive.
ROUGH = {"OK_Matte": 0.85, "OK_Gloss": 0.4, "OK_Metal": 0.35, "OK_Glass": 0.15, "OK_Glow": 0.5}
for m in bpy.data.materials:
    if m.name in ROUGH and m.use_nodes:
        b = m.node_tree.nodes.get("Principled BSDF")
        b.inputs["Roughness"].default_value = ROUGH[m.name]
        b.inputs["Metallic"].default_value = 0.0

# Ground, sun, sky.
gme = bpy.data.meshes.new("ground")
import bmesh  # noqa: E402
bm = bmesh.new()
bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=200)
bm.to_mesh(gme)
bm.free()
g = bpy.data.objects.new("ground", gme)
sc.collection.objects.link(g)
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.42, 0.40, 0.36, 1)
gme.materials.append(gm)
sun = bpy.data.lights.new("sun", "SUN")
sun.energy = 3.2
sun.color = (1.0, 0.93, 0.82)
so = bpy.data.objects.new("sun", sun)
so.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
sc.collection.objects.link(so)
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.45, 0.6, 0.85, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
sc.world = world
cam = bpy.data.cameras.new("cam")
cam.lens = 30
co = bpy.data.objects.new("cam", cam)
sc.collection.objects.link(co)
cx = (x - 3.0) / 2
co.location = (cx, -max(24.0, x * 0.95), max(9.0, x * 0.3))
d = Vector((cx, 0, 3)) - co.location
co.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
sc.camera = co
sc.render.engine = "CYCLES"
sc.cycles.samples = 24
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 1600, 800
sc.view_settings.view_transform = "AgX"
sc.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("wrote", OUT)
