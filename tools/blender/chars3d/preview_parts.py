# FIRSTLIGHT sculpted characters: fast part-by-part preview. Meshes the first N parts of a recipe at a
# coarse voxel size (no culling, skinning, UVs or bakes), colours each part flat, and renders it from the
# front and three-quarters in one image, so each part can be checked before the next one is built.
#
#   blender -b --disable-autoexec --factory-startup --python preview_parts.py -- \
#       --char mage --upto 3 --out /tmp/mage_step3.png [--vox 0.005] [--skeleton]
#
# Our own code: MIT.

import argparse
import colorsys
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bl  # noqa: E402
import sdf as S  # noqa: E402
from build import find_bbox  # noqa: E402

ROLE_TINT = {"fixed": None, "primary": "#5a3d78", "secondary": "#41607a", "accent": "#f0a070"}


def part_colour(i, p):
    if p.paint is not None:
        # the recipe's own paint on a few samples gives the part's average colour
        from part import Ctx
        P = np.zeros((8, 3), np.float32)
        N = np.tile(np.array([[0, -1, 0]], np.float32), (8, 1))
        try:
            res = p.paint(Ctx(p, P, N, np.zeros(8, np.float32), np.ones(8, np.float32)))
            rgb = res[0] if isinstance(res, tuple) else res
            c = np.clip(np.asarray(rgb, np.float32).mean(axis=0), 0, 1)
            tint = ROLE_TINT.get(p.role)
            if tint and np.ptp(c) < 0.05 and c.mean() > 0.75:  # palette-tinted white: show the default tint
                c = np.array(bl.hex_lin(tint)) ** (1 / 2.2)
            return tuple(float(x) for x in c)
        except Exception:  # noqa: BLE001 - previews must not die on paint code that needs real samples
            pass
    r, g, b = colorsys.hsv_to_rgb((i * 0.13) % 1.0, 0.45, 0.85)
    return (r, g, b)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", required=True)
    ap.add_argument("--upto", type=int, default=99)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--vox", type=float, default=0.005)
    ap.add_argument("--res", type=int, default=900)
    ap.add_argument("--skeleton", action="store_true")
    ap.add_argument("--focus", default="", help="x,y,z,dist: closeup target instead of the full body")
    a = ap.parse_args(argv)
    bl.reset()
    rec = importlib.import_module(f"recipes.{a.char}")
    parts = rec.parts()
    if a.only:
        keep = set(a.only.split(","))
        parts = [p for p in parts if p.name in keep]
    else:
        parts = parts[:a.upto]
    objs = []
    for i, p in enumerate(parts):
        bb = p.bbox or find_bbox(p.field)
        V, T, Q, _ = S.mesh_field(p.field, bb[0], bb[1], min(a.vox, p.vox * 2.5))
        ob = bl.mesh_from_arrays(p.name, V, Q, T)
        ob.data.shade_smooth()
        rgb = part_colour(i, p)
        ob.data.materials.append(bl.flat_material(p.name, [c ** 2.2 for c in rgb], 0.7))
        objs.append(ob)
        print("PREVIEW part", p.name, len(V), "verts", flush=True)
    if a.skeleton:
        from skel import Skel
        sk = Skel()
        for n in sk.names():
            h, t = sk.head(n), sk.tail(n)
            L = float(np.linalg.norm(t - h))
            if L < 1e-4 or "leaf" in n:
                continue
            bpy.ops.mesh.primitive_cylinder_add(radius=0.004, depth=L, location=tuple((h + t) / 2))
            c = bpy.context.active_object
            d = (t - h) / L
            c.rotation_mode = "QUATERNION"
            from mathutils import Vector
            c.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(tuple(d)))
            c.data.materials.append(bl.flat_material("bone", (0.9, 0.1, 0.1), 0.5))
            objs.append(c)
    # second copy turned to three-quarters (and a third, side-on), side by side
    for k, (dx, ang) in enumerate(((0.95, -40), (1.9, -90))):
        for ob in list(objs):
            c = ob.copy()
            c.data = ob.data
            bpy.context.scene.collection.objects.link(c)
            c.rotation_mode = "XYZ"
            c.rotation_euler = (0, 0, 0)
            # rotate about the character's axis, then shift
            from mathutils import Matrix
            c.matrix_world = Matrix.Translation((dx, 0, 0)) @ Matrix.Rotation(math.radians(ang), 4, "Z") @ ob.matrix_world
    sc = bpy.context.scene
    bl.eevee(a.res, int(a.res * 0.75), 32)
    bl.world_gradient((0.42, 0.47, 0.56), (0.22, 0.2, 0.19), 0.8)
    sc.view_settings.view_transform = "AgX"
    bl.sun("key", 3.4, (1.0, 0.95, 0.88), 40, -35, 4)
    bl.sun("fill", 0.9, (0.75, 0.82, 1.0), 15, 70, 10)
    bl.sun("rim", 2.4, (0.85, 0.9, 1.0), 30, 165, 3)
    if a.focus:
        x, y, z, dist = (float(v) for v in a.focus.split(","))
        sc.render.resolution_x = int(a.res * 1.4)
        cam = bl.camera("cam", (x + 0.95, y, z), (0, -1, 0.05), dist, lens=50)
    else:
        sc.render.resolution_x = int(a.res * 1.4)
        cam = bl.camera("cam", (0.95, 0, 0.98), (0, -1, 0.03), 7.0, lens=50)
    sc.camera = cam
    bl.render(a.out)
    print("PREVIEW DONE", a.out, flush=True)


main()
