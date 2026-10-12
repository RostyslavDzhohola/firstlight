# Build the FIRSTLIGHT horse (headless Blender; see build.sh).
#
#   blender -b --disable-autoexec --factory-startup --python build_horse.py -- --fbx Horse.fbx --out horse.glb
#
# Input: Quaternius "LowPoly Animated Animals" (CC0) FBX/Horse.fbx, read untouched.
# Output: one skinned GLB, metres, +Y up, facing +Z (the client's avatar convention):
#   * the horse mesh with our own saddle, blanket, straps and stirrups added (our work, CC BY 4.0);
#   * one vertex-colour "role" mask instead of materials: R = coat, G = mane/tail/hooves,
#     B = blanket (rider accent), black = saddle leather. The client tints per coat;
#   * a `saddle` node parented to the Torso bone at the top of the seat (the rider socket);
#   * four clips renamed idle / walk / run / jump (the pack's Death and WalkSlow are dropped).
import argparse
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--fbx", required=True)
ap.add_argument("--out", required=True)
args = ap.parse_args(argv)

BACK_HEIGHT_M = 1.5  # top of the back above the ground after scaling
CLIPS = {"Idle": "idle", "Walk": "walk", "Run": "run", "Jump": "jump"}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=args.fbx)
arm = bpy.data.objects["Armature"]
obj = bpy.data.objects["Horse"]
me = obj.data
assert arm.type == "ARMATURE" and obj.type == "MESH"
mw = obj.matrix_world
assert all(abs(mw[i][j] - (1.0 if i == j else 0.0)) < 1e-4 for i in range(4) for j in range(4)), f"mesh must sit in armature space: {mw}"

# ---------------------------------------------------------------- clips: keep four, bone channels only
for act in list(bpy.data.actions):
    short = act.name.split("|")[-1]
    if short not in CLIPS:
        bpy.data.actions.remove(act)
        continue
    act.name = CLIPS[short]
    # Object-level loc/rot/scale keys would override the armature's scale in the export: drop them.
    for layer in act.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in list(bag.fcurves):
                    if not fc.data_path.startswith("pose.bones"):
                        bag.fcurves.remove(fc)
    act.use_fake_user = True
if arm.animation_data:
    arm.animation_data.action = None
for pb in arm.pose.bones:  # rest pose for every measurement below
    pb.location = (0, 0, 0)
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.rotation_euler = (0, 0, 0)
    pb.scale = (1, 1, 1)

# ---------------------------------------------------------------- measurements (rest mesh, armature units)
back_top = max(v.co.z for v in me.vertices if abs(v.co.x) < 0.35 and -1.5 < v.co.y < 0.8)
scale = BACK_HEIGHT_M / back_top
print(f"HORSE back top {back_top:.3f} units -> scale {scale:.4f}")

bm_rest = bmesh.new()
bm_rest.from_mesh(me)
bvh = BVHTree.FromBMesh(bm_rest)
BARREL_Z = 3.75  # barrel axis height (between belly ~2.6 and back ~4.9)


def surface(y, theta):
    """Point on the horse's barrel at length `y`, angle `theta` from straight up (+x side positive)."""
    c = Vector((0.0, y, BARREL_Z))
    d = Vector((math.sin(theta), 0.0, math.cos(theta)))
    hit = bvh.ray_cast(c + d * 6.0, -d, 12.0)
    if hit[0] is None:
        return c + d * 0.8, d
    return hit[0], d


# ---------------------------------------------------------------- saddle (our own geometry)
# The FBX brings a plain white "Col" layer; the role mask replaces it (the exporter writes one).
for a in list(me.color_attributes):
    me.color_attributes.remove(a)
me.color_attributes.new("Color", "BYTE_COLOR", "CORNER")
bm = bmesh.new()
bm.from_mesh(me)
deform = bm.verts.layers.deform.verify()
torso = obj.vertex_groups["Torso"].index
col = bm.loops.layers.color["Color"]

# Role colours for the pack's two materials: 0 = coat, 1 = dark (mane, tail, hooves, eyes).
for f in bm.faces:
    rgba = (1.0, 0.0, 0.0, 1.0) if f.material_index == 0 else (0.0, 1.0, 0.0, 1.0)
    for loop in f.loops:
        loop[col] = rgba
base_faces = set(bm.faces)


def add_shell(rows, cols, y0, y1, th0, th1, off_out, off_in, rgba):
    """A thick patch hugging the barrel: outer surface at off_out(t_y, t_th), inner at off_in."""
    outer, inner = [], []
    for i in range(rows + 1):
        ty = i / rows
        y = y0 + (y1 - y0) * ty
        ro, ri = [], []
        for j in range(cols + 1):
            tt = j / cols
            th = th0 + (th1 - th0) * tt
            p, d = surface(y, th)
            ro.append(bm.verts.new(p + d * off_out(ty, tt)))
            ri.append(bm.verts.new(p + d * off_in(ty, tt)))
        outer.append(ro)
        inner.append(ri)
    faces = []
    for i in range(rows):
        for j in range(cols):
            faces.append(bm.faces.new((outer[i][j], outer[i][j + 1], outer[i + 1][j + 1], outer[i + 1][j])))
            faces.append(bm.faces.new((inner[i][j], inner[i + 1][j], inner[i + 1][j + 1], inner[i][j + 1])))
    for i in range(rows):  # side rims
        for j in (0, cols):
            a, b = (outer[i][j], outer[i + 1][j]) if j == 0 else (outer[i + 1][j], outer[i][j])
            c, d = (inner[i + 1][j], inner[i][j]) if j == 0 else (inner[i][j], inner[i + 1][j])
            faces.append(bm.faces.new((a, b, c, d)))
    for i in (0, rows):  # front/back rims
        for j in range(cols):
            a, b = (outer[i][j + 1], outer[i][j]) if i == 0 else (outer[i][j], outer[i][j + 1])
            c, d = (inner[i][j], inner[i][j + 1]) if i == 0 else (inner[i][j + 1], inner[i][j])
            faces.append(bm.faces.new((a, b, c, d)))
    for row in outer + inner:
        for v in row:
            v[deform][torso] = 1.0
    for f in faces:
        for loop in f.loops:
            loop[col] = rgba
    return outer


def add_box(center, size, rgba):
    r = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(center) @ Matrix.Diagonal((*size, 1.0)))
    for v in r["verts"]:
        v[deform][torso] = 1.0
    faces = {f for v in r["verts"] for f in v.link_faces}
    for f in faces:
        for loop in f.loops:
            loop[col] = rgba


LEATHER = (0.0, 0.0, 0.0, 1.0)
BLANKET = (0.0, 0.0, 1.0, 1.0)
Y_FRONT, Y_BACK = -1.35, 0.55  # head is towards -Y


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


# Blanket: wide and thin, draping down both flanks, a little longer than the seat.
add_shell(3, 8, Y_FRONT - 0.3, Y_BACK + 0.3, math.radians(-78), math.radians(78),
          lambda ty, tt: 0.07, lambda ty, tt: 0.01, BLANKET)


# Seat: rises into a pommel at the front and a taller cantle at the back; dips in the middle.
def seat_out(ty, tt):
    across = abs(tt - 0.5) * 2  # 0 centre, 1 edge
    rise = 0.32 * smooth((0.22 - ty) / 0.22) + 0.42 * smooth((ty - 0.72) / 0.28)
    return 0.2 + rise * (1 - 0.6 * across) - 0.06 * across


seat = add_shell(6, 6, Y_FRONT, Y_BACK, math.radians(-48), math.radians(48), seat_out, lambda ty, tt: 0.07, LEATHER)

# Straps and stirrups on both flanks, hanging from the seat's middle.
y_mid = (Y_FRONT + Y_BACK) / 2 - 0.1
for side in (-1, 1):
    top, d = surface(y_mid, side * math.radians(55))
    top = top + d * 0.1
    foot = Vector((side * 1.18, y_mid, 3.0))
    mid = (top + foot) / 2
    add_box(Vector((mid.x, y_mid, mid.z)), (0.06, 0.14, (top.z - foot.z)), LEATHER)
    add_box(Vector((foot.x, y_mid, foot.z - 0.06)), (0.26, 0.34, 0.06), LEATHER)  # tread
    for k in (-1, 1):
        add_box(Vector((foot.x, y_mid + k * 0.16, foot.z + 0.06)), (0.06, 0.04, 0.26), LEATHER)

# The rider socket: top of the seat at its lowest point along the spine line.
seat_row = min((r[len(r) // 2] for r in seat), key=lambda v: v.co.z)
socket_local = seat_row.co.copy()
print(f"HORSE seat socket (units) {tuple(round(c, 3) for c in socket_local)}")

bm.normal_update()
bm.to_mesh(me)
bm.free()
bm_rest.free()
me.color_attributes.active_color = me.color_attributes["Color"]
me.color_attributes.render_color_index = 0
me.update()

# No materials: the client supplies one per coat and reads the role mask.
me.materials.clear()

# ---------------------------------------------------------------- scale, socket, export
arm.scale = (scale, scale, scale)
bpy.context.view_layer.update()
sock = bpy.data.objects.new("saddle", None)
bpy.context.scene.collection.objects.link(sock)
sock.parent = arm
sock.parent_type = "BONE"
sock.parent_bone = "Torso"
bpy.context.view_layer.update()
sock.matrix_world = arm.matrix_world @ Matrix.Translation(socket_local)
bpy.context.view_layer.update()
print(f"HORSE seat socket (m) {tuple(round(c, 3) for c in sock.matrix_world.translation)}")

roles = {}
for d in me.color_attributes["Color"].data:
    k = "".join(str(round(c)) for c in d.color[:3])
    roles[k] = roles.get(k, 0) + 1
print(f"HORSE role mask corners {roles} (100 coat, 010 mane, 001 blanket, 000 leather)")
me.calc_loop_triangles()
print(f"HORSE tris {len(me.loop_triangles)} verts {len(me.vertices)} bones {len(arm.data.bones)}")
print("HORSE clips", sorted(a.name for a in bpy.data.actions), "fps", bpy.context.scene.render.fps)

bpy.ops.export_scene.gltf(
    filepath=args.out,
    export_format="GLB",
    export_yup=True,
    export_apply=False,
    export_materials="NONE",
    export_vertex_color="ACTIVE",
    export_all_vertex_colors=False,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_force_sampling=True,
    export_anim_single_armature=True,
    export_skins=True,
    export_morph=False,
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)
print(f"HORSE wrote {args.out}")
