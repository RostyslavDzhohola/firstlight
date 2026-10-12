# FIRSTLIGHT: render a contact sheet of animation clips on one starter (rows = clips, columns = time).
#
#   blender -b --disable-autoexec --factory-startup --python anim_sheet.py -- --char x.glb \
#       --anims clips.glb --clips a,b,c --out sheet.png [--cols 5]

import argparse
import math
import sys

import bpy
from mathutils import Vector


def attach_test_weapon(arm, kind):
    """Mirror of the client's socket: grip = lerp(hand_r, middle_01_r, 0.75) - 2.5 cm up-axis, weapon
    axes aligned with the model at rest (three +Z forward = Blender -Y, three +Y up = Blender +Z)."""
    bpy.context.view_layer.update()
    b = arm.data.bones
    h = arm.matrix_world @ b["hand_r"].head_local
    m = arm.matrix_world @ b["middle_01_r"].head_local
    grip = h.lerp(m, 0.75) + Vector((0, 0, -0.025))
    if kind == "sword":
        size, centre = Vector((0.02, 0.8, 0.012)), grip + Vector((0, -0.45, 0))
    else:  # gun basis: muzzle along the knuckles (-X for the right hand), top towards the thumb (-Y)
        size, centre = Vector((0.35, 0.08, 0.05)), grip + Vector((-0.1, -0.05, 0))
    hx, hy, hz = size / 2
    vs = [(x, y, z) for x in (-hx, hx) for y in (-hy, hy) for z in (-hz, hz)]
    fs = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me = bpy.data.meshes.new("prop")
    me.from_pydata(vs, [], fs)
    ob = bpy.data.objects.new("prop", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = centre
    bpy.context.view_layer.update()
    mw = ob.matrix_world.copy()
    ob.parent = arm
    ob.parent_type = "BONE"
    ob.parent_bone = "hand_r"
    bpy.context.view_layer.update()
    ob.matrix_world = mw


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", required=True)
    ap.add_argument("--anims", required=True)
    ap.add_argument("--clips", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--weapon", default="", help="sword|gun: attach a test prop at the client's hand_r socket")
    a = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = a.fps
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=a.anims)
    for o in set(bpy.data.objects) - before:
        bpy.data.objects.remove(o, do_unlink=True)
    for ac in bpy.data.actions:
        ac.use_fake_user = True
    clips = a.clips.split(",")
    rows = len(clips)
    sp = 1.3
    for r, cname in enumerate(clips):
        act = next((x for x in bpy.data.actions if x.name == cname or x.name.startswith(cname + "_")
                    or x.name.split("|")[-1] == cname), None)
        if not act:
            print("missing clip", cname)
            continue
        f0, f1 = act.frame_range
        for c in range(a.cols):
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=a.char)
            new = set(bpy.data.objects) - before
            arm = next(o for o in new if o.type == "ARMATURE")
            for o in new:
                if o.parent is None:
                    o.location = (c * sp, 0, -r * 2.1)
            if a.weapon:
                attach_test_weapon(arm, a.weapon)
            frame = f0 + (f1 - f0) * c / max(1, a.cols - 1)
            ad = arm.animation_data_create()
            tr = ad.nla_tracks.new()
            st = tr.strips.new(act.name, 1, act)
            st.action_frame_start = frame
            st.action_frame_end = frame + 1
            st.frame_end = 1000
            st.extrapolation = "HOLD"
            if act.slots:
                st.action_slot = act.slots[0]
        txt = bpy.data.curves.new(f"t{r}", "FONT")
        txt.body = f"{cname} ({(f1 - f0) / a.fps:.2f}s)"
        to = bpy.data.objects.new(f"t{r}", txt)
        sc.collection.objects.link(to)
        to.location = (-1.9, 0, -r * 2.1 + 0.9)
        to.rotation_euler = (math.radians(90), 0, 0)
        to.scale = (0.18, 0.18, 0.18)
    sc.frame_set(1)
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "SINGLE"
    w = a.cols * sp + 2.4
    h = rows * 2.1
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = max(w, h * 1.0)
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    co.location = Vector(((a.cols - 1) * sp / 2 - 1.0, -10, -(rows - 1) * 2.1 / 2 + 0.9))
    co.rotation_euler = (math.radians(90), 0, math.radians(20) * 0)
    sc.render.resolution_x = 1400
    sc.render.resolution_y = int(1400 * h / w) if h < w else 1400
    sc.render.filepath = a.out
    bpy.ops.render.render(write_still=True)


main()
