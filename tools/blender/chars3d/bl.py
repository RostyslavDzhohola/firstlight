# FIRSTLIGHT sculpted characters: small Blender helpers (mesh from numpy, materials, render setup).
# Runs inside Blender 5.x, headless. Our own code: MIT.

import math

import bpy
import numpy as np
from mathutils import Vector


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_from_arrays(name, verts, quads=None, tris=None, coll=None):
    quads = np.zeros((0, 4), dtype=np.int64) if quads is None else np.asarray(quads)
    tris = np.zeros((0, 3), dtype=np.int64) if tris is None else np.asarray(tris)
    me = bpy.data.meshes.new(name)
    nv = len(verts)
    me.vertices.add(nv)
    me.vertices.foreach_set("co", np.asarray(verts, dtype=np.float32).ravel())
    nl = quads.size + tris.size
    nf = len(quads) + len(tris)
    me.loops.add(nl)
    loops = np.concatenate([quads.ravel(), tris.ravel()]).astype(np.int32)
    me.loops.foreach_set("vertex_index", loops)
    me.polygons.add(nf)
    starts = np.concatenate([np.arange(len(quads)) * 4, quads.size + np.arange(len(tris)) * 3]).astype(np.int32)
    me.polygons.foreach_set("loop_start", starts)
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    ob = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(ob)
    me.shade_smooth()
    return ob


def apply_mod(ob, md):
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=md.name)


def decimate(ob, ratio=None, target_tris=None):
    tris = tri_count(ob)
    if target_tris:
        ratio = min(1.0, target_tris / max(tris, 1))
    if ratio >= 0.999:
        return
    md = ob.modifiers.new("dec", "DECIMATE")
    md.decimate_type = "COLLAPSE"
    md.ratio = ratio
    md.use_collapse_triangulate = True
    apply_mod(ob, md)


def tri_count(ob):
    me = ob.data
    return sum(len(p.vertices) - 2 for p in me.polygons)


def flat_material(name, rgb, rough=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    return m


def srgb_to_lin(c):
    return tuple((x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c)


def hex_lin(h):
    h = h.lstrip("#")
    return srgb_to_lin(tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))


def camera(name, target, direction, dist, lens=50, ortho=None):
    sc = bpy.context.scene
    cam = bpy.data.cameras.new(name)
    co = bpy.data.objects.new(name, cam)
    sc.collection.objects.link(co)
    t = Vector(target)
    d = Vector(direction).normalized()
    co.location = t + d * dist
    co.rotation_euler = (t - co.location).to_track_quat("-Z", "Y").to_euler()
    cam.lens = lens
    if ortho:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho
    cam.clip_start = 0.05
    cam.clip_end = 100
    return co


def sun(name, energy, color, elev_deg, az_deg, angle_deg=2.0):
    """Sun shining from azimuth az (0 = from the front, i.e. from -Y; 90 = from the character's left +X)."""
    sc = bpy.context.scene
    L = bpy.data.lights.new(name, "SUN")
    L.energy = energy
    L.color = color
    L.angle = math.radians(angle_deg)
    o = bpy.data.objects.new(name, L)
    sc.collection.objects.link(o)
    el, az = math.radians(elev_deg), math.radians(az_deg)
    src = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    o.rotation_euler = (-src).to_track_quat("-Z", "Y").to_euler()
    return o


def world_gradient(sky, ground, strength=1.0, horizon=None):
    sc = bpy.context.scene
    w = bpy.data.worlds.new("world")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    geo = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Generated"], sep.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = -1
    mr.inputs["From Max"].default_value = 1
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs[0], ramp.inputs[0])
    ramp.color_ramp.elements[0].position = 0.45
    ramp.color_ramp.elements[0].color = (*ground, 1)
    ramp.color_ramp.elements[1].position = 0.6
    ramp.color_ramp.elements[1].color = (*sky, 1)
    if horizon:
        e = ramp.color_ramp.elements.new(0.52)
        e.color = (*horizon, 1)
    nt.links.new(ramp.outputs[0], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    return w


def eevee(res_x, res_y, samples=64, film_transparent=False):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = res_x
    sc.render.resolution_y = res_y
    sc.render.resolution_percentage = 100
    try:
        sc.eevee.taa_render_samples = samples
    except Exception:
        pass
    for attr, val in (("use_shadows", True), ("use_raytracing", True)):
        try:
            setattr(sc.eevee, attr, val)
        except Exception:
            pass
    sc.render.film_transparent = film_transparent
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "None"


def render(path):
    sc = bpy.context.scene
    sc.render.filepath = path
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
