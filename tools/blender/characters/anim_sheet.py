# FIRSTLIGHT: render a contact sheet of animation clips on one starter (rows = clips, columns = time).
#
#   blender -b --disable-autoexec --factory-startup --python anim_sheet.py -- --char x.glb \
#       --anims clips.glb --clips a,b,c --out sheet.png [--cols 5]

import argparse
import math
import sys

import bpy
from mathutils import Vector


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", required=True)
    ap.add_argument("--anims", required=True)
    ap.add_argument("--clips", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--fps", type=int, default=30)
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
