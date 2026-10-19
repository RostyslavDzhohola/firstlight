# FIRSTLIGHT sculpted props: renders of built props (GLB + albedo + normal), next to today's procedural
# models (weapons.ts, dumped to JSON) and in shipped characters' hands.
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python render_prop.py -- \
#       --dir <build dir> --mode turnaround|compare|hand --props emberglass[,axe,...] --out <png>
#       turnaround: one prop upright from four sides (--zoom z0,z1 for a close-up of a stretch)
#       compare:    for each prop, today's model and the new one side by side, same scale
#       hand:       --shots char:clip:frame,... each prop held in the right-hand socket, game look
#                   (--today: today's model instead); one render per shot, stitched
#
# Looks as chars3d/render.py: studio (Principled) or game (the client's toon avatar shading). Props use
# the avatar material plus their own glow: albedo alpha = 1 - glow, and the painted colour glows.
# Our own code: MIT.

import argparse
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "chars3d"))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

import bl  # noqa: E402
import hold  # noqa: E402
import render as R  # noqa: E402
from preview_prop import stitch  # noqa: E402

TODAY_JSON = "/tmp/fl-props/ref/today_weapons.json"
TODAY_VIEW = {"longbow": {"up": "y", "side": "z"}}  # today's bow runs its limbs along weapon +Y


def prop_material(name, look, pal, albedo=None, normal=None, flat=None, glow=0.0):
    """albedo/normal PNG paths (built props), or flat=(sRGB rgb) with an optional glow (today's)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    if albedo:
        alb = nt.nodes.new("ShaderNodeTexImage")
        alb.image = bpy.data.images.load(albedo, check_existing=True)
        alb.image.colorspace_settings.name = "sRGB"
        alb.image.alpha_mode = "CHANNEL_PACKED"
        nrm = nt.nodes.new("ShaderNodeTexImage")
        nrm.image = bpy.data.images.load(normal, check_existing=True)
        nrm.image.colorspace_settings.name = "Non-Color"
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
        tint, role_b, acc = R.palette_tint(nt, pal)
        base = R.mul(nt, alb.outputs["Color"], tint)
        painted = nt.nodes.new("ShaderNodeMath")
        painted.operation = "SUBTRACT"
        painted.inputs[0].default_value = 1.0
        nt.links.new(alb.outputs["Alpha"], painted.inputs[1])
        own = R.scale_col(nt, R.scale_col(nt, alb.outputs["Color"], painted.outputs[0]), 2.2)
        emis = R.add(nt, own, R.scale_col(nt, R.mul(nt, role_b, acc), 2.2))
        R.finish_material(nt, out, base, nmap.outputs["Normal"], emis, look)
    else:
        rgb = nt.nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = (*bl.srgb_to_lin(flat), 1)
        emis = R.scale_col(nt, rgb.outputs[0], glow)
        R.finish_material(nt, out, rgb.outputs[0], None, emis, look)
    return m


def load_prop(dir_, name, look, pal):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(dir_, f"{name}.glb"))
    ob = next(o for o in set(bpy.data.objects) - before if o.type == "MESH")
    ob.data.materials.clear()
    ob.data.materials.append(prop_material(f"{name}_{look}_{pal}", look, pal,
                                           os.path.join(dir_, f"{name}_albedo.png"), os.path.join(dir_, f"{name}_normal.png")))
    return [ob]


def load_today(wid, look):
    objs = hold.today_meshes(TODAY_JSON, wid)
    if look == "game":
        for o in objs:
            b = o.data.materials[0].node_tree.nodes["Principled BSDF"]
            lin = b.inputs["Base Color"].default_value[:3]
            srgb = tuple(c ** (1 / 2.2) for c in lin)
            glow = b.inputs["Emission Strength"].default_value if any(b.inputs["Emission Color"].default_value[:3]) else 0
            o.data.materials.clear()
            o.data.materials.append(prop_material(o.name + "_game", look, 0, flat=srgb, glow=min(glow, 2.2)))
    return objs


def view_of(name):
    try:
        return importlib.import_module(f"items.{name}").VIEW
    except ModuleNotFoundError:
        return {"up": "z", "side": "y"}


def place(objs, M, weapon_space):
    """Set the display transform: M maps weapon space to the world; GLB meshes are in Blender axes."""
    B2W = hold.w2b_matrix().inverted()
    for o in objs:
        o.matrix_world = M if weapon_space else M @ B2W


def bounds(objs, M, weapon_space):
    B2W = hold.w2b_matrix().inverted()
    pts = []
    for o in objs:
        T = M if weapon_space else M @ B2W
        pts += [T @ v.co for v in o.data.vertices]
    P = np.array(pts)
    return P.min(axis=0), P.max(axis=0)


def stage(look, res_x, res_y):
    bl.eevee(res_x, res_y, 64)
    R.setup_world(look)
    R.lights(look)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--mode", default="turnaround")
    ap.add_argument("--props", default="emberglass")
    ap.add_argument("--look", default="studio")
    ap.add_argument("--pal", type=int, default=-1, help="palette index (default: the holder's, or 0)")
    ap.add_argument("--zoom", default="")
    ap.add_argument("--shots", default="")
    ap.add_argument("--today", action="store_true")
    ap.add_argument("--chars", default="/tmp/fl-props/ref")
    ap.add_argument("--res", type=int, default=900)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    bl.reset()
    sc = bpy.context.scene
    names = a.props.split(",")
    if a.mode in ("turnaround", "compare"):
        stage(a.look, a.res, int(a.res * 1.3))
        items = []  # (objs, weapon_space, view)
        for n in names:
            pal = max(a.pal, 0)
            if a.mode == "compare":
                items.append((load_today(n, a.look), True, TODAY_VIEW.get(n, view_of(n))))
            items.append((load_prop(a.dir, n, a.look, pal), False, view_of(n)))
        angles = (0, -45, -90, 180) if a.mode == "turnaround" else (-30,)
        x, lo_all, hi_all = 0.0, None, None
        placed = []
        for objs, ws, v in items:
            D = hold.display_matrix(v["up"], v["side"])
            for k, ang in enumerate(angles):
                group = objs if k == 0 else [o.copy() for o in objs]
                for o in group:
                    if o.name not in sc.collection.objects:
                        sc.collection.objects.link(o)
                M0 = Matrix.Rotation(math.radians(ang), 4, "Z") @ D
                lo, hi = bounds(group, M0, ws)
                if a.zoom:
                    z0, z1 = (float(t) for t in a.zoom.split(","))
                    lo[2], hi[2] = z0, z1
                w = float(max(hi[0] - lo[0], 0.04))
                M = Matrix.Translation((x - lo[0], 0, -lo[2] if not a.zoom else 0)) @ M0
                place(group, M, ws)
                placed.append((x, w))
                x += w + 0.06 if not a.zoom else w + 0.03
                lo_all = lo if lo_all is None else np.minimum(lo_all, lo)
                hi_all = hi if hi_all is None else np.maximum(hi_all, hi)
        width = x
        z0 = 0 if not a.zoom else lo_all[2]
        z1 = (hi_all[2] - lo_all[2]) if not a.zoom else hi_all[2]
        h = float(z1 - z0)
        sc.render.resolution_y = int(a.res * 1.3)
        sc.render.resolution_x = max(int(sc.render.resolution_y * width / h), 200)
        span = (h if sc.render.resolution_y >= sc.render.resolution_x else width) * 1.08
        sc.camera = bl.camera("cam", (width / 2 - 0.03, 0, (z0 + z1) / 2), (0, -1, 0.04), 8.0, lens=50, ortho=span)
        bl.render(a.out)
        print("RENDER DONE", a.out, flush=True)
        return

    # hand: one render per shot, stitched
    from clips import Clips
    stage(a.look, int(a.res * 0.8), int(a.res * 1.2))
    if a.look == "game":
        R.backdrop(a.look)
    clips = Clips(os.path.join(a.chars, "starters_anims.glb"))
    sc.camera = bl.camera("cam_hand", (0, 0, 1.0), (0.3, -1, 0.12), 6.5, lens=50, ortho=2.6)
    paths, prev = [], []
    for i, (ch, clip, frame) in enumerate(s.split(":") for s in a.shots.split(",")):
        for o in prev:
            o.hide_render = True
        before = set(bpy.data.objects)
        pal = a.pal if a.pal >= 0 else R.DEFAULT_PAL.get(ch, 0)
        _, arm = R.add_character(a.chars, ch, pal, a.look, rot_z=-20)
        n = names[i % len(names)]
        objs = load_today(n, a.look) if a.today else load_prop(a.dir, n, a.look, pal)
        hold.hold(arm, objs, weapon_space_data=a.today)
        clips.pose([arm], clip, int(frame))
        path = a.out.replace(".png", f"_{i}.png")
        bl.render(path)
        paths.append(path)
        prev = list(set(bpy.data.objects) - before)
    stitch(paths, a.out)
    print("RENDER DONE", a.out, flush=True)


if __name__ == "__main__":
    main()
