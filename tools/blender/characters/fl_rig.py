# FIRSTLIGHT character builder: rig import, base-body fitting, body-region shells, weighting, export.
# Inputs are third-party CC0 files (Quaternius UAL1 skeleton, Quaternius UBC body) opened as glTF only.
# Our own code: MIT.

import math
import bmesh
import bpy
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree

import fl_geo as G

RIG_NAME = "FL_Rig"


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def _import(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def import_rig(ual_path):
    """The shared skeleton: the Quaternius UAL rig (65 joints, T-pose rest, facing -Y)."""
    objs = _import(ual_path)
    rig = next(o for o in objs if o.type == "ARMATURE")
    for o in objs:
        if o is not rig:
            bpy.data.objects.remove(o, do_unlink=True)
    rig.name = RIG_NAME
    rig.data.name = RIG_NAME
    if rig.animation_data:
        rig.animation_data.action = None
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    return rig


def import_body(ubc_path, rig):
    """Import the UBC body and bake it into the UAL rest pose: each UBC bone is constrained onto the
    matching UAL bone (same names), the deformed mesh is baked, and the body is re-bound to the rig."""
    objs = _import(ubc_path)
    ubc = next(o for o in objs if o.type == "ARMATURE")
    body = next(o for o in objs if o.type == "MESH" and o.name.startswith("SuperHero"))
    for o in objs:
        if o not in (ubc, body):
            bpy.data.objects.remove(o, do_unlink=True)
    for b in ubc.data.bones:
        b.inherit_scale = "NONE"
    for pb in ubc.pose.bones:
        if pb.name not in rig.pose.bones:
            continue
        c = pb.constraints.new("COPY_LOCATION")
        c.target = rig
        c.subtarget = pb.name
        s = pb.constraints.new("STRETCH_TO")
        s.target = rig
        s.subtarget = pb.name
        s.head_tail = 1.0
        s.volume = "NO_VOLUME"
        s.rest_length = pb.bone.length
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = body.evaluated_get(dg)
    m = ev.to_mesh()
    mw = body.matrix_world.copy()
    coords = [mw @ v.co for v in m.vertices]
    ev.to_mesh_clear()
    for md in list(body.modifiers):
        body.modifiers.remove(md)
    body.parent = None
    body.matrix_world = Matrix()
    for v, co in zip(body.data.vertices, coords):
        v.co = co
    bpy.data.objects.remove(ubc, do_unlink=True)
    me = body.data
    if me.has_custom_normals:
        with bpy.context.temp_override(object=body, active_object=body, selected_objects=[body]):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)
    for ca in list(me.color_attributes):
        me.color_attributes.remove(ca)
    me.materials.clear()
    body.name = "BaseBody"
    me.name = "BaseBody"
    for p in me.polygons:
        p.use_smooth = True
    return body


# ---------------------------------------------------------------------------------------------
# bone geometry


class Bones:
    def __init__(self, rig):
        self.rig = rig
        self.b = {b.name: b for b in rig.data.bones}

    def head(self, n):
        return self.rig.matrix_world @ self.b[n].head_local

    def tail(self, n):
        return self.rig.matrix_world @ self.b[n].tail_local

    def mid(self, n, t=0.5):
        return self.head(n).lerp(self.tail(n), t)


def vertex_info(ob):
    """Per-vertex (co, normal, weights dict, dominant bone)."""
    names = {g.index: g.name for g in ob.vertex_groups}
    out = []
    for v in ob.data.vertices:
        w = {names[g.group]: g.weight for g in v.groups if g.weight > 0.0}
        dom = max(w, key=w.get) if w else None
        out.append((v.co.copy(), v.normal.copy(), w, dom))
    return out


def dup(ob, name):
    o = ob.copy()
    o.data = ob.data.copy()
    o.name = name
    o.data.name = name
    bpy.context.scene.collection.objects.link(o)
    return o


def keep_verts(ob, keep):
    """Delete vertices where keep(co, normal, weights, dom) is False."""
    info = vertex_info(ob)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    kill = [bm.verts[i] for i, (co, n, w, d) in enumerate(info) if not keep(co, n, w, d)]
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def keep_faces(ob, keep):
    """Delete faces where keep(centre, normal, dominant-bones-list) is False (then loose verts)."""
    info = vertex_info(ob)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    kill = []
    for f in bm.faces:
        doms = [info[v.index][3] for v in f.verts]
        if not keep(f.calc_center_median(), f.normal, doms):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def offset(ob, amount):
    """Push vertices along their normals; amount may be a number or f(co, normal) -> metres."""
    ob.data.update()
    for v in ob.data.vertices:
        d = amount(v.co, v.normal) if callable(amount) else amount
        v.co = v.co + v.normal * d
    ob.data.update()


def solidify(ob, thickness, offset_=1.0, rim=True):
    md = ob.modifiers.new("solid", "SOLIDIFY")
    md.thickness = thickness
    md.offset = offset_
    md.use_rim = rim
    md.use_even_offset = False
    apply_mod(ob, md)


def apply_mod(ob, md):
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=md.name)


def decimate(ob, ratio):
    if ratio >= 0.999:
        return
    md = ob.modifiers.new("dec", "DECIMATE")
    md.decimate_type = "COLLAPSE"
    md.ratio = ratio
    md.use_collapse_triangulate = False
    apply_mod(ob, md)


def tile_object(ob, atlas, tile_fn, uv_fn=None):
    """Assign tiles to an existing object's faces: tile_fn(centre, normal) -> tile name; optional
    uv_fn(co, tile_name) -> (u, v) in tile space for pattern tiles."""
    me = ob.data
    ftile, fuv = [], []
    for p in me.polygons:
        t = tile_fn(p.center, p.normal)
        ftile.append(t)
        if uv_fn:
            uv = [uv_fn(me.vertices[me.loops[li].vertex_index].co, t) for li in p.loop_indices]
            fuv.append(uv if all(x is not None for x in uv) else None)
        else:
            fuv.append(None)
    G.apply_tiles(ob, ftile, fuv, atlas)


# ---------------------------------------------------------------------------------------------
# weights


def set_weights(ob, fn):
    """fn(co) -> {bone: weight}; replaces all groups."""
    ob.vertex_groups.clear()
    groups = {}
    for v in ob.data.vertices:
        w = fn(v.co)
        tot = sum(w.values()) or 1.0
        for bname, wt in w.items():
            if wt <= 1e-4:
                continue
            g = groups.get(bname) or ob.vertex_groups.new(name=bname)
            groups[bname] = g
            g.add([v.index], wt / tot, "REPLACE")


def rigid(bone):
    return lambda co: {bone: 1.0}


class BodyWeights:
    """Nearest-surface weight lookup on the fitted base body (inverse-distance blend of k nearest)."""

    def __init__(self, body):
        self.info = vertex_info(body)
        self.kd = KDTree(len(self.info))
        for i, (co, n, w, d) in enumerate(self.info):
            self.kd.insert(co, i)
        self.kd.balance()

    def __call__(self, co, allow=None, k=6):
        acc = {}
        for (pco, i, dist) in self.kd.find_n(co, k):
            wt = 1.0 / (dist + 0.01) ** 2
            for b, x in self.info[i][2].items():
                if allow and b not in allow:
                    continue
                acc[b] = acc.get(b, 0.0) + x * wt
        if not acc:
            return {"spine_02": 1.0}
        return acc


def chain_weights(chain, blend=0.06):
    """Weights along a bone chain [(bone, head, tail), ...]: project onto the segments and blend
    across joints over `blend` metres."""
    def fn(co):
        best = []
        for bname, h, t in chain:
            d = t - h
            L2 = d.length_squared or 1e-9
            s = (co - h).dot(d) / L2
            best.append((bname, s, d.length))
        w = {}
        n = len(best)
        for i, (bname, s, L) in enumerate(best):
            lo = 0.0 if i > 0 else -1e9
            hi = 1.0 if i < n - 1 else 1e9
            bl = blend / max(L, 1e-6)
            a = G.smoothstep(lo - bl, lo + bl, s) if i > 0 else 1.0
            b = 1.0 - G.smoothstep(hi - bl, hi + bl, s) if i < n - 1 else 1.0
            val = a * b
            if val > 0:
                w[bname] = val
        if not w:
            w = {best[-1][0]: 1.0}
        return w
    return fn


def finalize_weights(ob, rig, limit=4):
    ob.parent = rig
    md = ob.modifiers.new("Armature", "ARMATURE")
    md.object = rig
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob],
                                   selected_editable_objects=[ob]):
        bpy.ops.object.vertex_group_clean(group_select_mode="ALL", limit=0.01)
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=limit)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    # every vertex must carry at least one weight
    names = {g.index: g.name for g in ob.vertex_groups}
    orphan = [v.index for v in ob.data.vertices if not v.groups]
    if orphan:
        g = ob.vertex_groups.get("spine_02") or ob.vertex_groups.new(name="spine_02")
        g.add(orphan, 1.0, "REPLACE")
    return len(orphan)


# ---------------------------------------------------------------------------------------------
# export


def export_glb(rig, mesh, path):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    rig.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig
    me = mesh.data
    if "tile" in me.attributes:
        me.attributes.remove(me.attributes["tile"])
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


def smooth_verts(ob, pred, factor=0.5, iterations=10):
    """Laplacian-style smoothing of vertices passing pred(co, dom) (irons out anatomy under cloth)."""
    info = vertex_info(ob)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    sel = [bm.verts[i] for i, (co, n, w, d) in enumerate(info) if pred(co, d) and not bm.verts[i].is_boundary]
    for _ in range(iterations):
        bmesh.ops.smooth_vert(bm, verts=sel, factor=factor, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def smooth_boundary(ob, iterations=6, factor=0.5):
    """Relax open borders (cut lines through the body mesh are saw-toothed)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bverts = [v for v in bm.verts if v.is_boundary]
    for _ in range(iterations):
        new = {}
        for v in bverts:
            nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nb) == 2:
                avg = (nb[0].co + nb[1].co) * 0.5
                new[v] = v.co.lerp(avg, factor)
        for v, co in new.items():
            v.co = co
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
