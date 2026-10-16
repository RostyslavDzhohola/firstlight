# Design-round buildings (2026-10-15, round 2: the owner's picks) into game prefabs. Two sources:
#   - Opus pieces (tools/blender/round2/opus, built here by script with flkit): kit meshes placed as
#     instances, colour and surface per face corner ("Col", "PBR"), a tint per instance;
#   - Astra GLBs (hash-pinned files from the design round, read as glTF data only): meshes UV-mapped
#     onto a 1024 px palette atlas, one "luminous" material.
# Either way the result is one Blender mesh per prefab for the town/outpost packers: instances joined,
# tints and colours in a "Col" corner colour (linear), every face on one of the shared vertex-colour
# slots (OK_*: the white layer of the strips, so the colour is the vertex colour), and the shading
# baked in so it doesn't go flat in the browser: Cycles ambient occlusion (with a ground plane: walls
# darken toward the ground), a soft height grime and a little painterly value noise.
#
# Runs inside Blender (headless, autoexec off). Pure data in, meshes out.

import math
import os
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

# Vertex-colour slots shared by the Portus and outpost packers (pack.py SLOTS): name -> surface.
OK_SLOTS = ("OK_Matte", "OK_Gloss", "OK_Metal", "OK_Glass", "OK_Glow")


def slot_for(metal, rough, emis, holo=False):
    """The shared slot of a face from its design surface (flkit PBR: metal, roughness, emission)."""
    if holo or emis > 0.05:
        return "OK_Glow"
    if metal >= 0.5:
        return "OK_Metal"
    if rough <= 0.12:
        return "OK_Glass"
    if rough <= 0.42:
        return "OK_Gloss"
    return "OK_Matte"


_mats = {}


def slot_material(name):
    """A material named after a slot that shows the "Col" attribute (so the glTF exporter writes COLOR_0)."""
    m = _mats.get(name) or bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
        if name == "OK_Glow":
            nt.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 2.0
    _mats[name] = m
    return m


# ------------------------------------------------------------------------------------------------
# Opus (flkit) buildings
# ------------------------------------------------------------------------------------------------
def flkit_to_mesh(B, name, skip=(), holo_mats=(1,), membrane_mats=(2,)):
    """Join a flkit Building's placed instances (except mesh names in `skip`) into one mesh in the
    building's own frame: tints baked into Col, faces on the OK_* slots. Membrane faces (the gate's
    portal material) are dropped: the game draws the portal itself."""
    inv = B.origin.inverted()
    bm = bmesh.new()
    col_l = bm.loops.layers.float_color.new("Col")
    slot_l = bm.faces.layers.int.new("slot")
    for ob in B.objs:
        # Kit meshes built twice get ".001" suffixes: match on the base name.
        if ob.data.name.split(".")[0] in skip or not ob.get("counted", True):
            continue
        src = ob.data
        tint = ob.color if any(abs(c - 1.0) > 1e-6 for c in ob.color[:3]) else (1.0, 1.0, 1.0, 1.0)
        M = inv @ ob.matrix_world
        sb = bmesh.new()
        sb.from_mesh(src)
        sb.transform(M)
        if M.determinant() < 0:
            bmesh.ops.reverse_faces(sb, faces=sb.faces)
        c_l = sb.loops.layers.float_color.get("Col")
        p_l = sb.loops.layers.float_color.get("PBR")
        vmap = {}
        for v in sb.verts:
            vmap[v] = bm.verts.new(v.co)
        for f in sb.faces:
            if f.material_index in membrane_mats:
                continue
            try:
                nf = bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.smooth = f.smooth
            pbr = f.loops[0][p_l] if p_l else (0.0, 0.8, 0.0, 1.0)
            name_ = slot_for(pbr[0], pbr[1], pbr[2], f.material_index in holo_mats)
            nf[slot_l] = OK_SLOTS.index(name_)
            for nl, l in zip(nf.loops, f.loops):
                c = l[c_l] if c_l else (1, 1, 1, 1)
                nl[col_l] = (c[0] * tint[0], c[1] * tint[1], c[2] * tint[2], 1.0)
        sb.free()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    _assign_slots(me)
    return me


def _assign_slots(me):
    """Faces' "slot" int attribute -> material slots (OK_* materials), attribute removed."""
    attr = me.attributes.get("slot")
    vals = [d.value for d in attr.data] if attr else [0] * len(me.polygons)
    used = sorted(set(vals))
    for i in used:
        me.materials.append(slot_material(OK_SLOTS[i]))
    index = {s: k for k, s in enumerate(used)}
    for p, v in zip(me.polygons, vals):
        p.material_index = index[v]
    if attr:
        me.attributes.remove(attr)
    me.color_attributes.active_color_name = "Col"


# ------------------------------------------------------------------------------------------------
# Astra GLBs (palette atlas)
# ------------------------------------------------------------------------------------------------
def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def astra_to_mesh(path, name, drop=()):
    """Import an Astra building GLB (glTF data only) and join it into one mesh: every face corner's
    colour sampled from the palette atlas at its UV (linear), the luminous material on OK_Glow, the
    rest matte (gloss for low roughness). Blender's glTF importer puts it Z-up; front = -Y."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH" and not any(d in o.name for d in drop)]
    img = None
    for m in bpy.data.materials:
        if m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image is not None:
                    img = n.image
    if img is None:
        raise RuntimeError(f"{path}: no palette image")
    w, h = img.size
    px = list(img.pixels)  # RGBA floats, bottom row first (Blender images); already linear? palette PNG is sRGB
    lin = img.colorspace_settings.name.lower().startswith("srgb")

    def sample(u, v):
        x = min(w - 1, max(0, int(u % 1.0 * w)))
        y = min(h - 1, max(0, int(v % 1.0 * h)))
        k = (y * w + x) * 4
        r, g, b = px[k], px[k + 1], px[k + 2]
        return (srgb_to_lin(r), srgb_to_lin(g), srgb_to_lin(b)) if lin else (r, g, b)

    bm = bmesh.new()
    col_l = bm.loops.layers.float_color.new("Col")
    slot_l = bm.faces.layers.int.new("slot")
    for o in meshes:
        sb = bmesh.new()
        sb.from_mesh(o.data)
        sb.transform(o.matrix_world)
        uv_l = sb.loops.layers.uv.active
        vmap = {v: bm.verts.new(v.co) for v in sb.verts}
        mats = o.data.materials
        for f in sb.faces:
            try:
                nf = bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.smooth = f.smooth
            mat = mats[f.material_index] if f.material_index < len(mats) else None
            glow = mat is not None and "lumin" in mat.name.lower()
            rough = 0.57
            if mat is not None and mat.use_nodes:
                bsdf = mat.node_tree.nodes.get("Principled BSDF")
                if bsdf is not None:
                    rough = bsdf.inputs["Roughness"].default_value
            nf[slot_l] = OK_SLOTS.index(slot_for(0.0, max(rough, 0.45), 1.0 if glow else 0.0))
            for nl, l in zip(nf.loops, f.loops):
                uv = l[uv_l].uv if uv_l else (0.5, 0.5)
                c = sample(uv[0], uv[1])
                nl[col_l] = (c[0], c[1], c[2], 1.0)
        sb.free()
    for o in new:
        bpy.data.objects.remove(o)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    _assign_slots(me)
    return me


# ------------------------------------------------------------------------------------------------
# Baked shading
# ------------------------------------------------------------------------------------------------
def _hash3(x, y, z):
    h = math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
    return h - math.floor(h)


def _value_noise(p, scale):
    x, y, z = p.x * scale, p.y * scale, p.z * scale
    xi, yi, zi = math.floor(x), math.floor(y), math.floor(z)
    xf, yf, zf = x - xi, y - yi, z - zi
    s = lambda t: t * t * (3 - 2 * t)
    u, v, w = s(xf), s(yf), s(zf)
    acc = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                wgt = (u if dx else 1 - u) * (v if dy else 1 - v) * (w if dz else 1 - w)
                acc += wgt * _hash3(xi + dx, yi + dy, zi + dz)
    return acc


def bake_shading(me, ao_strength=0.75, ao_distance=1.6, samples=48, grime=0.18, grime_height=1.3, noise=0.07, seed=0):
    """Bake ambient occlusion (Cycles, with a ground plane at z = 0), a soft darkening toward the
    ground and a little world-space value noise into the "Col" corner colours. Glowing faces keep
    their colour. The mesh must be in its prefab frame (ground at z = 0)."""
    # A scene of its own (the object and a ground plane): the bake's ray tracing sees nothing else.
    sc = bpy.data.scenes.new("round2_bake")
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    sc.cycles.device = "CPU"
    sc.world = bpy.data.worlds.new("round2_bake_world")
    sc.world.light_settings.distance = ao_distance
    ob = bpy.data.objects.new(me.name + "_bake", me)
    sc.collection.objects.link(ob)
    gme = bpy.data.meshes.new("bake_ground")
    gb = bmesh.new()
    bmesh.ops.create_grid(gb, x_segments=1, y_segments=1, size=60)
    gb.to_mesh(gme)
    gb.free()
    ground = bpy.data.objects.new("bake_ground", gme)
    sc.collection.objects.link(ground)
    ao = me.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
    me.color_attributes.active_color = ao
    vl = sc.view_layers[0]
    ground.select_set(False, view_layer=vl)
    ob.select_set(True, view_layer=vl)
    vl.objects.active = ob
    sc.render.bake.target = "VERTEX_COLORS"
    with bpy.context.temp_override(scene=sc, view_layer=vl, active_object=ob, object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    col = me.color_attributes["Col"].data
    aod = me.color_attributes["AO"].data
    glow = {i for i, m in enumerate(me.materials) if m and m.name == "OK_Glow"}
    rng = random.Random(seed)
    off = Vector((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))
    for poly in me.polygons:
        if poly.material_index in glow:
            continue
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            a = aod[li].color[0]
            k = 1.0 - ao_strength * (1.0 - a)
            hz = max(0.0, min(1.0, v.z / grime_height))
            k *= 1.0 - grime * (1.0 - hz) ** 2
            k *= 1.0 + noise * (2.0 * _value_noise(v + off, 0.9) - 1.0)
            c = col[li].color
            col[li].color = (c[0] * k, c[1] * k, c[2] * k, 1.0)
    me.color_attributes.remove(me.color_attributes["AO"])
    me.color_attributes.active_color_name = "Col"
    bpy.data.objects.remove(ob)
    bpy.data.objects.remove(ground)
    bpy.data.meshes.remove(gme)
    world = sc.world
    bpy.data.scenes.remove(sc)
    bpy.data.worlds.remove(world)
    return me


def ensure_uv(me):
    """The packers read TEXCOORD_0: vertex-colour slots sample the white layer, so any UV will do."""
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    for d in me.uv_layers[0].data:
        d.uv = (0.5, 0.5)
    return me
