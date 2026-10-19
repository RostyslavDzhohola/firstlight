# FIRSTLIGHT sculpted props: fast part-by-part preview. Meshes the first N parts of a prop recipe at a
# coarse voxel size (no culling, UVs or bakes), colours each part flat and renders it upright from the
# side, three-quarters and edge-on; with --hand it also renders the prop held by shipped characters in
# given clip frames at game scale (the posed preview: a prop that reads upright can still sit badly in
# the hand). --today <id> previews today's procedural model (weapons.ts, dumped to JSON) instead.
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python preview_prop.py -- \
#       --prop emberglass --upto 3 --out /tmp/p.png [--hand hexwick:cast:14,ash:idle:20 --chars <dir>]
#
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
import sdf as S  # noqa: E402
from build import find_bbox  # noqa: E402
from preview_parts import part_colour  # noqa: E402


def stitch(paths, out):
    """Side by side (same height) with numpy on Blender images; Blender's Python has no PIL."""
    ims = [bpy.data.images.load(p) for p in paths]
    h = ims[0].size[1]
    arrs = []
    for im in ims:
        w, hh = im.size
        a = np.empty(w * hh * 4, np.float32)
        im.pixels.foreach_get(a)
        arrs.append(a.reshape(hh, w, 4)[:h])
    full = np.concatenate(arrs, axis=1)
    img = bpy.data.images.new("stitch", full.shape[1], full.shape[0], alpha=True)
    img.pixels.foreach_set(full.ravel())
    img.filepath_raw = out
    img.file_format = "PNG"
    img.save()


def lights():
    bl.world_gradient((0.42, 0.47, 0.56), (0.22, 0.2, 0.19), 0.8)
    bpy.context.scene.view_settings.view_transform = "AgX"
    bl.sun("key", 3.4, (1.0, 0.95, 0.88), 40, -35, 4)
    bl.sun("fill", 0.9, (0.75, 0.82, 1.0), 15, 70, 10)
    bl.sun("rim", 2.4, (0.85, 0.9, 1.0), 30, 165, 3)


def prop_objects(a):
    """Flat-coloured meshes in weapon space: the recipe's first parts, or today's model."""
    if a.today:
        return hold.today_meshes(a.today_json, a.today), {"up": a.up or "z", "side": a.side or "y"}
    rec = importlib.import_module(f"items.{a.prop}")
    parts = rec.parts()
    if a.only:
        keep = set(a.only.split(","))
        parts = [p for p in parts if p.name in keep]
    else:
        parts = parts[:a.upto]
    lo_s, hi_s = rec.SCAN
    objs = []
    for i, p in enumerate(parts):
        bb = p.bbox or find_bbox(p.field, lo_s, hi_s, step=0.008, pad=0.01)
        V, T, Q, _ = S.mesh_field(p.field, bb[0], bb[1], min(a.vox, p.vox * 2.5))
        ob = bl.mesh_from_arrays(p.name, V, Q, T)
        ob.data.shade_smooth()
        rgb = part_colour(i, p)
        ob.data.materials.append(bl.flat_material(p.name, [c ** 2.2 for c in rgb], 0.6))
        objs.append(ob)
        print("PREVIEW part", p.name, len(V), "verts", flush=True)
    return objs, getattr(rec, "VIEW", {"up": "z", "side": "y"})


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--prop", default="")
    ap.add_argument("--today", default="", help="weapon id: preview today's procedural model instead")
    ap.add_argument("--today-json", default="/tmp/fl-props/ref/today_weapons.json")
    ap.add_argument("--up", default="")
    ap.add_argument("--side", default="")
    ap.add_argument("--upto", type=int, default=99)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--vox", type=float, default=0.002)
    ap.add_argument("--res", type=int, default=800)
    ap.add_argument("--zoom", default="", help="z0,z1: frame only this stretch of the upright prop (weapon units)")
    ap.add_argument("--hand", default="", help="char:clip:frame,... held by shipped characters")
    ap.add_argument("--chars", default="/tmp/fl-props/ref", help="character GLBs + PNG textures + starters_anims.glb")
    a = ap.parse_args(argv)
    bl.reset()
    sc = bpy.context.scene
    objs, view = prop_objects(a)
    D = hold.display_matrix(view["up"], view["side"])
    # bounds in the display frame, to place three copies and frame them
    pts = np.concatenate([np.array([D @ v.co for v in o.data.vertices]) for o in objs])
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    height = float(hi[2] - lo[2])
    z0, z1 = (float(v) for v in a.zoom.split(",")) if a.zoom else (float(lo[2]), float(hi[2]))
    sel = pts[(pts[:, 2] >= z0) & (pts[:, 2] <= z1)]
    width = max(float(np.ptp(sel[:, 0])), float(np.ptp(sel[:, 1])), 0.02)
    gap = width * 1.5 + 0.02
    copies = []
    for o in objs:
        o.hide_render = True
    for k, ang in enumerate((0, -40, -90)):
        for ob in objs:
            c = ob.copy()
            c.data = ob.data
            c.hide_render = False
            sc.collection.objects.link(c)
            c.matrix_world = Matrix.Translation((k * gap, 0, -lo[2])) @ Matrix.Rotation(math.radians(ang), 4, "Z") @ D
            copies.append(c)
    bl.eevee(a.res, int(a.res * 1.2), 32)
    lights()
    cx = gap
    span = max((z1 - z0) * 1.15, (2 * gap + width) * 1.2 / 0.83)
    cam = bl.camera("cam", (cx, 0, (z0 + z1) * 0.5 - lo[2]), (0, -1, 0.04), 6.0, lens=50, ortho=span)
    sc.camera = cam
    views = a.out if not a.hand else a.out.replace(".png", "_views.png")
    bl.render(views)
    if not a.hand:
        print("PREVIEW DONE", a.out, flush=True)
        return

    # held: shipped characters posed at clip frames, holding a copy in the right-hand socket; one
    # render per shot (each its own clip and frame), stitched after the views
    import render as R
    from clips import Clips
    for c in copies + objs:
        c.hide_render = True
    clips = Clips(os.path.join(a.chars, "starters_anims.glb"))
    sc.render.resolution_x = int(a.res * 0.8)
    sc.render.resolution_y = int(a.res * 1.2)
    sc.camera = bl.camera("cam_hand", (0, 0, 1.0), (0.3, -1, 0.12), 6.5, lens=50, ortho=2.6)
    shots, prev = [], []
    for i, (ch, clip, frame) in enumerate(s.split(":") for s in a.hand.split(",")):
        for o in prev:
            o.hide_render = True
        before = set(bpy.data.objects)
        _, arm = R.add_character(a.chars, ch, R.DEFAULT_PAL.get(ch, 0), "studio", rot_z=-20)
        held = []
        for ob in objs:
            c = ob.copy()
            c.data = ob.data
            c.hide_render = False
            sc.collection.objects.link(c)
            held.append(c)
        hold.hold(arm, held, weapon_space_data=True)
        clips.pose([arm], clip, int(frame))
        path = a.out.replace(".png", f"_hand{i}.png")
        bl.render(path)
        shots.append(path)
        prev = list(set(bpy.data.objects) - before)
    stitch([views] + shots, a.out)
    print("PREVIEW DONE", a.out, flush=True)


if __name__ == "__main__":
    main()
