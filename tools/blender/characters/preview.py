# FIRSTLIGHT character preview: imports the exported starter GLBs (+ optional clips GLB) and renders
# a lineup with EEVEE using a node material that mirrors the runtime shader (atlas x palette by role).
#
#   blender -b --disable-autoexec --factory-startup --python preview.py -- --dir <glb dir> --out x.png
#       [--anims anims.glb --clip Idle --frame 10] [--palettes 2,1,3,0] [--view front|back|side|close]

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

PALETTES = [  # primary, secondary, accent (docs/content.md §8.3)
    ("#E9E4D8", "#6F7780", "#F2B544"),
    ("#C8A97E", "#6B4A32", "#F5A623"),
    ("#1E2F5C", "#C9CED6", "#6FD3FF"),
    ("#5E7A3A", "#8A6A43", "#9BE564"),
    ("#2E2A2B", "#A3402B", "#FF8A3D"),
    ("#4A3260", "#3E5568", "#F09A7A"),
]
DEFAULT_PAL = {"hexwick": 2, "ash": 1, "kappa": 3, "unit7": 0}
ORDER = ["hexwick", "ash", "kappa", "unit7"]


def lin(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c) + (1.0,)


def make_mat(atlas, pal):
    m = bpy.data.materials.new(f"pal{pal}")
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.75
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = atlas
    tex.interpolation = "Linear"
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Color"
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(attr.outputs["Color"], sep.inputs["Color"])
    prim, sec, acc = (lin(c) for c in PALETTES[pal])

    def rgb(c):
        n = nt.nodes.new("ShaderNodeRGB")
        n.outputs[0].default_value = c
        return n.outputs[0]

    def mix(fac, a, b):
        n = nt.nodes.new("ShaderNodeMix")
        n.data_type = "RGBA"
        nt.links.new(fac, n.inputs["Factor"])
        if isinstance(a, tuple):
            n.inputs["A"].default_value = a
        else:
            nt.links.new(a, n.inputs["A"])
        if isinstance(b, tuple):
            n.inputs["B"].default_value = b
        else:
            nt.links.new(b, n.inputs["B"])
        return n.outputs["Result"]

    tint = mix(sep.outputs["Red"], (1, 1, 1, 1), prim)
    tint = mix(sep.outputs["Green"], tint, sec)
    tint = mix(sep.outputs["Blue"], tint, acc)
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    nt.links.new(tex.outputs["Color"], mul.inputs["A"])
    nt.links.new(tint, mul.inputs["B"])
    nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Emission Strength"])
    em = nt.nodes.new("ShaderNodeRGB")
    em.outputs[0].default_value = acc
    nt.links.new(em.outputs[0], bsdf.inputs["Emission Color"])
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return m


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--anims", default="")
    ap.add_argument("--clip", default="")
    ap.add_argument("--frame", type=float, default=0.0)
    ap.add_argument("--palettes", default="")
    ap.add_argument("--view", default="front")
    ap.add_argument("--only", default="")
    ap.add_argument("--res", type=int, default=1100)
    a = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    atlas = bpy.data.images.load(os.path.join(a.dir, "starters_atlas.png"))
    names = [n for n in ORDER if not a.only or n in a.only.split(",")]
    pals = [int(x) for x in a.palettes.split(",")] if a.palettes else [DEFAULT_PAL[n] for n in names]
    clip_action = None
    if a.anims:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=a.anims)
        for o in set(bpy.data.objects) - before:
            o.hide_render = True
        clip_action = next((ac for ac in bpy.data.actions if ac.name.startswith(a.clip)), None)
        print("clip", a.clip, "->", clip_action.name if clip_action else None)
    spacing = 1.1
    for i, (n, pal) in enumerate(zip(names, pals)):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(a.dir, f"{n}.glb"))
        new = set(bpy.data.objects) - before
        mat = make_mat(atlas, pal)
        for o in new:
            if o.type == "MESH":
                o.data.materials.clear()
                o.data.materials.append(mat)
            if o.parent is None:
                o.location.x = (i - (len(names) - 1) / 2) * spacing
            if o.type == "ARMATURE" and clip_action:
                o.animation_data_create()
                o.animation_data.action = clip_action
                if clip_action.slots:
                    o.animation_data.action_slot = clip_action.slots[0]
    sc.frame_set(int(a.frame))
    sc.render.engine = "BLENDER_EEVEE"
    w = len(names)
    sc.render.resolution_x = a.res if w > 1 else int(a.res * 0.6)
    sc.render.resolution_y = int(a.res * 0.62) if w > 1 else a.res
    world = bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.42, 0.47, 0.55, 1)
    bg.inputs["Strength"].default_value = 0.6
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.2
    sun.color = (1.0, 0.93, 0.82)
    so = bpy.data.objects.new("sun", sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), 0, math.radians(-35))
    rim = bpy.data.lights.new("rim", "SUN")
    rim.energy = 1.4
    rim.color = (0.7, 0.8, 1.0)
    ro = bpy.data.objects.new("rim", rim)
    sc.collection.objects.link(ro)
    ro.rotation_euler = (math.radians(60), 0, math.radians(160))
    bpy.ops.mesh.primitive_plane_add(size=30)
    cam = bpy.data.cameras.new("cam")
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    target = Vector((0, 0, 0.95))
    dist = 2.2 + 1.05 * w
    views = {"front": (0.35, -1.0, 0.18), "back": (-0.3, 1.0, 0.2), "side": (1.0, -0.15, 0.15),
             "close": (0.4, -1.0, 0.05)}
    d = Vector(views.get(a.view, views["front"])).normalized()
    if a.view == "close":
        target = Vector((0, 0, 1.62))
        dist = 1.4 + 0.9 * (w - 1)
    co.location = target + d * dist
    co.rotation_euler = (target - co.location).to_track_quat("-Z", "Y").to_euler()
    cam.lens = 50
    sc.render.filepath = a.out
    sc.view_settings.view_transform = "AgX"
    bpy.ops.render.render(write_still=True)


main()
