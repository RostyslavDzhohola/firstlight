# FIRSTLIGHT sculpted characters: the build. For one character recipe:
#   1. sculpt: mesh every part's SDF at high resolution (OpenVDB),
#   2. game mesh: cull faces buried inside other parts, decimate each part to its triangle budget,
#   3. skin each part to the shared skeleton (heat weights restricted per part, or rigid/custom),
#   4. UV-unwrap, join, pack one atlas with per-part texel density,
#   5. bake per part (Cycles): tangent normals, high-poly positions/normals/cavity; AO on the game mesh,
#   6. paint the albedo in numpy from those maps (paint functions in the recipe), dilate, save PNGs,
#   7. export the skinned GLB (Role vertex colours for palettes, tangents, no materials) + LOD1.
#
#   blender -b --disable-autoexec --factory-startup --python build.py -- \
#       --char hexwick --ual1 UAL1_Standard.glb --out <dir> [--tex 1024] [--fast]
#
# Our own code: MIT. Outputs (meshes, textures) are CC BY 4.0.

import argparse
import importlib
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "characters"))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bl  # noqa: E402
import sdf as S  # noqa: E402
from part import ROLE_RGBA, Ctx  # noqa: E402

F = np.float32
POS_LO = np.array((-1.25, -0.85, -0.15), dtype=F)
POS_SIZE = 2.6


def log(*a):
    print("CHAR3D", *a, flush=True)


# ---------------------------------------------------------------------------------------------
# geometry


def find_bbox(field, lo=(-1.2, -0.8, -0.1), hi=(1.2, 0.8, 2.3), step=0.025, pad=0.03):
    lo, hi = np.asarray(lo, F), np.asarray(hi, F)
    n = np.ceil((hi - lo) / step).astype(int) + 1
    idx = np.indices(n).reshape(3, -1).T.astype(F)
    P = lo + idx * F(step)
    inside = np.zeros(len(P), bool)
    for s in range(0, len(P), 2_000_000):
        inside[s:s + 2_000_000] = field(P[s:s + 2_000_000]) < step
    if not inside.any():
        raise RuntimeError("part has no surface in the scan box")
    Q = P[inside]
    return Q.min(axis=0) - step - pad, Q.max(axis=0) + step + pad


def face_centres(ob):
    me = ob.data
    c = np.empty(len(me.polygons) * 3, dtype=F)
    me.polygons.foreach_get("center", c)
    return c.reshape(-1, 3)


def face_normals(ob):
    me = ob.data
    n = np.empty(len(me.polygons) * 3, dtype=F)
    me.polygons.foreach_get("normal", n)
    return n.reshape(-1, 3)


_SEGS = None


def skeleton_point(P):
    """Nearest point on the shared skeleton's bone segments (rest pose) for each point."""
    global _SEGS
    if _SEGS is None:
        from skel import Skel
        sk = Skel()
        names = [n for n in sk.names() if "leaf" not in n and n != "root"]
        _SEGS = (np.stack([sk.head(n) for n in names]), np.stack([sk.tail(n) for n in names]))
    A, B = _SEGS
    best = np.full(len(P), np.inf, dtype=F)
    out = np.zeros_like(P)
    for a, b in zip(A, B):
        ab = b - a
        t = np.clip(((P - a) @ ab) / max(float(ab @ ab), 1e-9), 0, 1)
        q = a + t[:, None] * ab
        d = np.einsum("ij,ij->i", P - q, P - q)
        m = d < best
        best[m] = d[m]
        out[m] = q[m]
    return out


def delete_faces(ob, kill):
    if not kill.any():
        return
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    dead = [bm.faces[i] for i in np.nonzero(kill)[0]]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def drop_small_islands(ob, min_faces=12):
    """Culling can leave crumbs (a few faces poking out of a garment): drop tiny islands."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    seen = set()
    dead = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]
        isl = []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        if len(isl) < min_faces:
            dead += isl
    if dead:
        bmesh.ops.delete(bm, geom=dead, context="FACES")
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
        bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def copy_object(ob, name):
    o = ob.copy()
    o.data = ob.data.copy()
    o.name = name
    o.data.name = name
    bpy.context.scene.collection.objects.link(o)
    return o


# ---------------------------------------------------------------------------------------------
# skinning


def bone_chain(sd, *names):
    return [f"{n}_{sd}" for n in names]


def apply_weights(ob, rig, spec, lookup=None):
    kind = spec[0]
    ob.vertex_groups.clear()
    if kind == "copy":
        # weights from an already-skinned part underneath (armour plates on a suit, straps on a robe)
        src = lookup[spec[1]]
        md = ob.modifiers.new("dt", "DATA_TRANSFER")
        md.object = src
        md.use_vert_data = True
        md.data_types_verts = {"VGROUP_WEIGHTS"}
        md.vert_mapping = "POLYINTERP_NEAREST"
        md.layers_vgroup_select_src = "ALL"
        md.layers_vgroup_select_dst = "NAME"
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
            bpy.ops.object.datalayout_transfer(modifier=md.name)
        bl.apply_mod(ob, md)
    elif kind == "rigid":
        g = ob.vertex_groups.new(name=spec[1])
        g.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")
    elif kind == "fn":
        co = np.empty(len(ob.data.vertices) * 3, dtype=F)
        ob.data.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        ws = spec[1](co)  # dict bone -> (N,) weights
        tot = sum(ws.values())
        tot = np.where(tot > 1e-6, tot, 1.0)
        for bname, w in ws.items():
            w = w / tot
            g = ob.vertex_groups.new(name=bname)
            for val in np.unique(np.round(w, 3)):
                if val <= 1e-3:
                    continue
                ids = np.nonzero(np.round(w, 3) == val)[0].tolist()
                g.add(ids, float(val), "REPLACE")
    elif kind == "auto":
        allowed = set(spec[1])
        saved = {}
        for b in rig.data.bones:
            saved[b.name] = b.use_deform
            b.use_deform = b.name in allowed
        for o in bpy.context.scene.objects:
            o.select_set(False)
        ob.select_set(True)
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[ob, rig],
                                       selected_editable_objects=[ob, rig]):
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        for b in rig.data.bones:
            b.use_deform = saved[b.name]
        for md in list(ob.modifiers):
            ob.modifiers.remove(md)
        ob.parent = None
        # vertices the heat solve missed: give them the nearest allowed bone
        names = {g.index: g.name for g in ob.vertex_groups}
        orphans = [v.index for v in ob.data.vertices if not any(g.weight > 1e-4 for g in v.groups)]
        if orphans:
            fallback = spec[2] if len(spec) > 2 else spec[1][0]
            g = ob.vertex_groups.get(fallback) or ob.vertex_groups.new(name=fallback)
            g.add(orphans, 1.0, "REPLACE")
            log("  orphans", ob.name, len(orphans), "->", fallback)
        if len(spec) > 3 and spec[3] is not None:
            blend_weights(ob, spec[3])
    else:
        raise ValueError(kind)
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.vertex_group_clean(group_select_mode="ALL", limit=0.01)
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)


def blend_weights(ob, fn):
    """Mix existing weights with fn(P) -> (blend (N,), {bone: (N,)}) where blend > 0 (e.g. a robe skirt that
    should follow the pelvis and thighs smoothly rather than the heat solution)."""
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=F)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    b, ws = fn(co)
    names = [g.name for g in ob.vertex_groups]
    cur = {nm: np.zeros(n, F) for nm in names}
    for v in me.vertices:
        for g in v.groups:
            cur[names[g.group]][v.index] = g.weight
    tot_new = sum(ws.values())
    tot_new = np.where(tot_new > 1e-6, tot_new, 1.0)
    allb = set(cur) | set(ws)
    out = {}
    for nm in allb:
        a = cur.get(nm, np.zeros(n, F))
        w = ws.get(nm, np.zeros(n, F)) / tot_new
        out[nm] = a * (1 - b) + w * b
    for nm, w in out.items():
        g = ob.vertex_groups.get(nm) or ob.vertex_groups.new(name=nm)
        g.remove(list(range(n)))
        nz = np.nonzero(w > 1e-3)[0]
        for i in nz.tolist():
            g.add([i], float(w[i]), "REPLACE")


# ---------------------------------------------------------------------------------------------
# UVs


def uv_unwrap(ob, angle, texel):
    """Smart-project a smoothed copy (decimated sculpts have noisy face normals that shatter the
    islands), then copy the UVs back: same topology, so loop order matches."""
    proxy = copy_object(ob, ob.name + "_uvproxy")
    bm = bmesh.new()
    bm.from_mesh(proxy.data)
    for _ in range(12):
        bmesh.ops.smooth_vert(bm, verts=[v for v in bm.verts if not v.is_boundary], factor=0.6,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(proxy.data)
    bm.free()
    for o in bpy.context.scene.objects:
        o.select_set(False)
    proxy.select_set(True)
    bpy.context.view_layer.objects.active = proxy
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    me = ob.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uvp = np.empty(len(proxy.data.loops) * 2, dtype=F)
    proxy.data.uv_layers.active.data.foreach_get("uv", uvp)
    me.uv_layers.active.data.foreach_set("uv", uvp)
    bpy.data.objects.remove(proxy, do_unlink=True)
    uv = np.empty(len(me.loops) * 2, dtype=F)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    co = np.empty(len(me.vertices) * 3, dtype=F)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    # area ratio -> uniform density, times the part's texel weight
    a3 = a2 = 0.0
    for p in me.polygons:
        li = list(p.loop_indices)
        vi = [me.loops[i].vertex_index for i in li]
        for k in range(1, len(li) - 1):
            v0, v1, v2 = co[vi[0]], co[vi[k]], co[vi[k + 1]]
            a3 += 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0))
            u0, u1, u2 = uv[li[0]], uv[li[k]], uv[li[k + 1]]
            a2 += 0.5 * abs((u1[0] - u0[0]) * (u2[1] - u0[1]) - (u2[0] - u0[0]) * (u1[1] - u0[1]))
    s = math.sqrt(a3 / max(a2, 1e-12)) * texel
    uv *= s
    me.uv_layers.active.data.foreach_set("uv", uv.ravel())


def pack_uvs(ob, margin):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")


# ---------------------------------------------------------------------------------------------
# main


def build(recipe_name, ual1, out_dir, tex=1024, fast=False, keep_blend=None, only=None):
    t0 = time.time()
    import fl_rig as R
    import texbake as TB
    bl.reset()
    rig = R.import_rig(ual1)
    rec = importlib.import_module(f"recipes.{recipe_name}")
    parts = rec.parts()
    if only:
        parts = [p for p in parts if p.name in only]
    sc = bpy.context.scene
    lows = []
    boxes = {}
    for p in parts:
        boxes[p.name] = p.bbox or find_bbox(p.field)
    for pid, p in enumerate(parts, start=1):
        t = time.time()
        bb = boxes[p.name]
        vox = p.vox * (1.6 if fast else 1.0)
        V, T, Q, frac = S.mesh_field(p.field, bb[0], bb[1], vox)
        lo = bl.mesh_from_arrays(p.name, V, Q, T)
        nhi = len(V)
        if p.single_side:
            # cloth is modelled as a thin solid; the game keeps only the side facing away from the
            # body (the material is double-sided). Thin = the part ends within 2.2 cm behind the face.
            cen = face_centres(lo)
            nrm = face_normals(lo)
            thin = p.field(cen - nrm * F(0.022)) > 0
            to_body = skeleton_point(cen) - cen
            inner = thin & (np.einsum("ij,ij->i", nrm, to_body) > 0)
            delete_faces(lo, inner)
        # pre-decimate, cull what is buried inside other parts, then decimate to the budget
        bl.decimate(lo, target_tris=p.tris * 12)
        cen = face_centres(lo)
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
        delete_faces(lo, kill)
        bl.decimate(lo, target_tris=p.tris)
        drop_small_islands(lo)
        if len(lo.data.polygons) == 0:  # entirely hidden under other parts
            bpy.data.objects.remove(lo, do_unlink=True)
            log(f"part {p.name}: fully hidden, skipped")
            continue
        lo.data.shade_smooth()
        apply_weights(lo, rig, p.weights or ("rigid", "spine_02"), {o.name: o for o in lows})
        uv_unwrap(lo, p.uv_angle, p.texel)
        me = lo.data
        at = me.attributes.new("part_id", "INT", "FACE")
        at.data.foreach_set("value", np.full(len(me.polygons), pid, dtype=np.int32))
        role = me.color_attributes.new("Role", "FLOAT_COLOR", "POINT")
        role.data.foreach_set("color", np.tile(np.array(ROLE_RGBA[p.role], F), len(me.vertices)))
        lows.append(lo)
        log(f"part {p.name}: sculpt {nhi} verts (band {frac:.2f}) -> {bl.tri_count(lo)} tris, {time.time() - t:.1f}s")
    for o in sc.objects:
        o.select_set(False)
    for lo in lows:
        lo.select_set(True)
    bpy.context.view_layer.objects.active = lows[0]
    bpy.ops.object.join()
    char = lows[0]
    char.name = recipe_name
    char.data.name = recipe_name
    pack_uvs(char, 0.003)
    tris = bl.tri_count(char)
    log(f"joined: {tris} tris, {len(char.data.vertices)} verts, {time.time() - t0:.0f}s")

    # texture maps from the sculpt
    P3, N3, UV3, PID = TB.mesh_tris(char)
    pid_map, pos, nrm_lo, tan, bit = TB.rasterise(P3, N3, UV3, PID, tex)
    covered = pid_map > 0
    log(f"raster {covered.mean():.2f} coverage, {time.time() - t0:.0f}s")
    albedo = np.zeros((tex, tex, 4), F)
    nmap = np.zeros((tex, tex, 4), F)
    nmap[..., 3] = 1
    for pid, p in enumerate(parts, start=1):
        sel = pid_map == pid
        if not sel.any():
            continue
        t = time.time()
        Plo = pos[sel]
        Phi, Nhi = TB.project(p.field, Plo)
        # guard: texels whose projection wandered (thin parts) keep the low-poly surface
        bad = np.linalg.norm(Phi - Plo, axis=1) > 0.02
        Phi[bad] = Plo[bad]
        Nhi[bad] = nrm_lo[sel][bad]
        if p.bump is not None:
            Nhi = p.bump(Phi, Nhi)
        cav = np.tanh(TB.curvature(p.field, Phi, 0.003) * 0.004).astype(F)
        # occlusion from every part whose box comes near this one
        lo_b, hi_b = Phi.min(axis=0) - 0.12, Phi.max(axis=0) + 0.12
        near = [q.field for q in parts if (q.occlude or q is p) and
                not (np.any(boxes[q.name][0] > hi_b) or np.any(boxes[q.name][1] < lo_b))]

        def allf(X, fs=near):
            d = fs[0](X)
            for f in fs[1:]:
                d = np.minimum(d, f(X))
            return d
        ao = TB.sdf_ao(allf, Phi + Nhi * F(0.0015), Nhi)
        ctx = Ctx(p, Phi.astype(F), Nhi.astype(F), cav, ao)
        res = p.paint(ctx) if p.paint else np.full((ctx.n, 3), 0.7, F)
        rgb, emis = res if isinstance(res, tuple) else (res, None)
        albedo[sel, :3] = np.clip(rgb, 0, 1)
        # alpha = 1 - accent: most texels stay opaque, so a browser that premultiplies alpha on decode
        # can't wipe the colour (the client reads painted = 1 - alpha)
        albedo[sel, 3] = 1.0 if emis is None else 1.0 - np.clip(emis, 0, 1)
        nmap[sel, :3] = TB.tangent_normals(Nhi, nrm_lo[sel], tan[sel], bit[sel])
        log(f"  paint {p.name}: {int(sel.sum())} texels, {time.time() - t:.1f}s")
    albedo, _ = TB.dilate(albedo, covered, 12)
    nmap, m2 = TB.dilate(nmap, covered, 12)
    nmap[~m2] = (0.5, 0.5, 1.0, 1.0)
    os.makedirs(out_dir, exist_ok=True)
    save_png(albedo, os.path.join(out_dir, f"{recipe_name}_albedo.png"), alpha=True)
    save_png(nmap, os.path.join(out_dir, f"{recipe_name}_normal.png"), alpha=False)

    # export
    char.data.materials.clear()
    if "part_id" in char.data.attributes:
        char.data.attributes.remove(char.data.attributes["part_id"])
    md = char.modifiers.new("Armature", "ARMATURE")
    md.object = rig
    char.parent = rig
    export_glb(rig, char, os.path.join(out_dir, f"{recipe_name}.glb"))
    if keep_blend:
        bpy.ops.wm.save_as_mainfile(filepath=keep_blend, compress=True)
    log(f"DONE {recipe_name}: {tris} tris, {time.time() - t0:.0f}s")
    return tris


def save_png(arr, path, alpha):
    """Write via a Blender image (arr rows are bottom-up like Blender pixels). Colour data in arr is
    already sRGB-encoded where it should be (albedo), raw for normal maps."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=alpha, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    a = arr.copy()
    if not alpha:
        a[..., 3] = 1.0
    img.pixels.foreach_set(np.clip(a, 0, 1).astype(F).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def export_glb(rig, mesh, path):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    rig.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig
    me = mesh.data
    role = me.color_attributes.get("Role")
    me.color_attributes.active_color = role
    me.color_attributes.render_color_index = me.color_attributes.find("Role")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_animations=False,
        export_skins=True, export_morph=False, export_materials="NONE", export_vertex_color="NAME",
        export_vertex_color_name="Role", export_all_vertex_colors=False, export_texcoords=True,
        export_normals=True, export_tangents=False, export_yup=True, export_apply=False,
        export_def_bones=False, export_leaf_bone=False, export_extras=False,
        export_rest_position_armature=True)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", required=True)
    ap.add_argument("--ual1", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tex", type=int, default=1024)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--blend", default="")
    ap.add_argument("--only", default="")
    a = ap.parse_args(argv)
    build(a.char, a.ual1, a.out, a.tex, a.fast, a.blend or None, set(a.only.split(",")) if a.only else None)
