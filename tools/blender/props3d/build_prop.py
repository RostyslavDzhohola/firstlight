# FIRSTLIGHT sculpted props (weapons, held items): the build. The characters' method
# (tools/blender/chars3d) without the rig. For one prop recipe:
#   1. sculpt: mesh every part's SDF at high resolution (OpenVDB), in weapon space (hold.py),
#   2. game mesh: cull faces buried inside other parts, decimate each part to its triangle budget,
#   3. UV-unwrap, join, pack one atlas with per-part texel density,
#   4. bake per part from the sculpt (tangent normals, cavity, occlusion) and paint the albedo in numpy
#      with the recipe's paint functions; alpha = 1 - glow (the painted colour itself glows),
#   5. export a static GLB in weapon space (Role vertex colours for palettes, no materials) + stats.
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python build_prop.py -- \
#       --prop emberglass --out <dir> [--tex 512]
#
# Our own code: MIT. Outputs (meshes, textures) are CC BY 4.0.

import argparse
import importlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "chars3d"))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

import bl  # noqa: E402
import build as B  # noqa: E402  (the character build's bbox scan, culling, UV and PNG helpers)
import hold  # noqa: E402
import sdf as S  # noqa: E402
import texbake as TB  # noqa: E402
from part import ROLE_RGBA, Ctx  # noqa: E402

F = np.float32


def log(*a):
    print("PROP3D", *a, flush=True)


def band_uvs(ob, axis, n):
    """Cut a long part's UV islands into n bands along a weapon axis: one 1.5 m strip (a bow limb, a
    staff, a string) sets the packer's scale for everything, and most of the texture stays empty.
    Moving each band's loops apart disconnects them; pack_uvs() then places the pieces."""
    me = ob.data
    cen = B.face_centres(ob)[:, axis]
    lo, hi = float(cen.min()), float(cen.max()) + 1e-6
    band = np.minimum(((cen - lo) / (hi - lo) * n).astype(int), n - 1)
    uv = np.empty(len(me.loops) * 2, F)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    ls = np.empty(len(me.polygons), np.int32)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    for f, (s, t) in enumerate(zip(ls, lt)):
        uv[s:s + t, 0] += 10.0 * band[f]
    me.uv_layers.active.data.foreach_set("uv", uv.ravel())


def build(name, out_dir, tex=512):
    t0 = time.time()
    bl.reset()
    rec = importlib.import_module(f"items.{name}")  # items/, not recipes/: chars3d has that package
    parts = rec.parts()
    lo_s, hi_s = rec.SCAN
    boxes = {p.name: p.bbox or B.find_bbox(p.field, lo_s, hi_s, step=0.008, pad=0.01) for p in parts}
    lows, stats = [], {}
    for pid, p in enumerate(parts, start=1):
        t = time.time()
        bb = boxes[p.name]
        V, T, Q, frac = S.mesh_field(p.field, bb[0], bb[1], p.vox)
        lo = bl.mesh_from_arrays(p.name, V, Q, T)
        nhi = len(V)
        bl.decimate(lo, target_tris=p.tris * 12)
        cen = B.face_centres(lo)
        kill = np.zeros(len(cen), bool)
        if p.cull:
            for q in parts:
                if q is p or not q.occlude:
                    continue
                qb = boxes[q.name]
                inb = np.all((cen > qb[0]) & (cen < qb[1]), axis=1)
                if inb.any():
                    k = np.zeros(len(cen), bool)
                    k[inb] = q.field(cen[inb]) < -p.cull_eps
                    kill |= k
        if p.keep is not None:
            kill |= ~p.keep(cen)
        B.delete_faces(lo, kill)
        bl.decimate(lo, target_tris=p.tris)
        B.drop_small_islands(lo, min_faces=6)
        if len(lo.data.polygons) == 0:
            bpy.data.objects.remove(lo, do_unlink=True)
            log(f"part {p.name}: fully hidden, skipped")
            continue
        lo.data.shade_smooth()
        B.uv_unwrap(lo, p.uv_angle, p.texel)
        if getattr(p, "uv_bands", None):
            band_uvs(lo, *p.uv_bands)
        me = lo.data
        at = me.attributes.new("part_id", "INT", "FACE")
        at.data.foreach_set("value", np.full(len(me.polygons), pid, dtype=np.int32))
        role = me.color_attributes.new("Role", "FLOAT_COLOR", "POINT")
        role.data.foreach_set("color", np.tile(np.array(ROLE_RGBA[p.role], F), len(me.vertices)))
        lows.append(lo)
        stats[p.name] = bl.tri_count(lo)
        log(f"part {p.name}: sculpt {nhi} verts (band {frac:.2f}) -> {stats[p.name]} tris, {time.time() - t:.1f}s")
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for lo in lows:
        lo.select_set(True)
    bpy.context.view_layer.objects.active = lows[0]
    bpy.ops.object.join()
    ob = lows[0]
    ob.name = ob.data.name = name
    B.pack_uvs(ob, 3.0 / tex)
    tris = bl.tri_count(ob)
    log(f"joined: {tris} tris, {len(ob.data.vertices)} verts, {time.time() - t0:.0f}s")

    # texture maps from the sculpt (as chars3d/build.py, with prop-sized occlusion and guards)
    P3, N3, UV3, PID = TB.mesh_tris(ob)
    pid_map, pos, nrm_lo, tan, bit = TB.rasterise(P3, N3, UV3, PID, tex)
    covered = pid_map > 0
    log(f"raster {covered.mean():.2f} coverage")
    albedo = np.zeros((tex, tex, 4), F)
    nmap = np.zeros((tex, tex, 4), F)
    nmap[..., 3] = 1
    for pid, p in enumerate(parts, start=1):
        sel = pid_map == pid
        if not sel.any():
            continue
        Plo = pos[sel]
        Phi, Nhi = TB.project(p.field, Plo)
        # thin parts (a blade's last millimetres, a bow limb): the nearest sculpt surface can be the
        # opposite face, whose normal points away; keep the low-poly surface there
        bad = (np.linalg.norm(Phi - Plo, axis=1) > 0.008) | (np.einsum("ij,ij->i", Nhi, nrm_lo[sel]) < 0.2)
        Phi[bad] = Plo[bad]
        Nhi[bad] = nrm_lo[sel][bad]
        if p.bump is not None:
            Nhi = p.bump(Phi, Nhi)
        cav = np.tanh(TB.curvature(p.field, Phi, 0.0015) * 0.002).astype(F)
        lo_b, hi_b = Phi.min(axis=0) - 0.06, Phi.max(axis=0) + 0.06
        near = [q.field for q in parts if (q.occlude or q is p) and
                not (np.any(boxes[q.name][0] > hi_b) or np.any(boxes[q.name][1] < lo_b))]

        def allf(X, fs=near):
            d = fs[0](X)
            for f in fs[1:]:
                d = np.minimum(d, f(X))
            return d
        ao = TB.sdf_ao(allf, Phi + Nhi * F(0.001), Nhi, dists=(0.003, 0.008, 0.016, 0.03, 0.05))
        ctx = Ctx(p, Phi.astype(F), Nhi.astype(F), cav, ao)
        res = p.paint(ctx) if p.paint else np.full((ctx.n, 3), 0.7, F)
        rgb, glow = res if isinstance(res, tuple) else (res, None)
        albedo[sel, :3] = np.clip(rgb, 0, 1)
        albedo[sel, 3] = 1.0 if glow is None else 1.0 - np.clip(glow, 0, 1)
        nmap[sel, :3] = TB.tangent_normals(Nhi, nrm_lo[sel], tan[sel], bit[sel])
    albedo, _ = TB.dilate(albedo, covered, 8)
    nmap, m2 = TB.dilate(nmap, covered, 8)
    nmap[~m2] = (0.5, 0.5, 1.0, 1.0)
    os.makedirs(out_dir, exist_ok=True)
    B.save_png(albedo, os.path.join(out_dir, f"{name}_albedo.png"), alpha=True)
    B.save_png(nmap, os.path.join(out_dir, f"{name}_normal.png"), alpha=False)

    # export: weapon axes -> Blender axes, so the exporter's Blender -> glTF turn gives weapon axes back
    ob.data.materials.clear()
    ob.data.attributes.remove(ob.data.attributes["part_id"])
    ob.data.transform(Matrix(hold.w2b_matrix()))
    ob.data.update()
    for o in bpy.context.scene.objects:
        o.select_set(o is ob)
    bpy.context.view_layer.objects.active = ob
    me = ob.data
    me.color_attributes.active_color = me.color_attributes["Role"]
    me.color_attributes.render_color_index = me.color_attributes.find("Role")
    path = os.path.join(out_dir, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_animations=False, export_skins=False,
        export_morph=False, export_materials="NONE", export_vertex_color="NAME", export_vertex_color_name="Role",
        export_all_vertex_colors=False, export_texcoords=True, export_normals=True, export_tangents=False,
        export_yup=True, export_apply=False, export_extras=False)
    info = {"prop": name, "tris": tris, "verts": len(me.vertices), "parts": stats, "tex": tex,
            "seconds": round(time.time() - t0, 1)}
    with open(os.path.join(out_dir, f"{name}_stats.json"), "w") as fh:
        json.dump(info, fh, indent=1)
    log(f"DONE {name}: {tris} tris, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--prop", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tex", type=int, default=512)
    a = ap.parse_args(argv)
    build(a.prop, a.out, a.tex)
