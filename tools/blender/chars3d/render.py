# FIRSTLIGHT sculpted characters: preview renders of the exported game assets (GLB + albedo + normal
# map + the shared clips), the way the game will draw them.
#
#   blender -b --disable-autoexec --factory-startup --python render.py -- --dir <build dir> \
#       --anims starters_anims.glb --mode turnaround|game|lineup|sheet|palettes --chars hexwick,... --out <png>
#
# Two looks:
#   studio: Principled BSDF (albedo x palette, normal map), soft three-point light: shows the sculpt.
#   game:   an emulation of the client's avatar shader (render/avatars/material.ts): toon ramp on the
#           sun term with shadows, hemisphere fill from looks.ts (Portus), accent emissive, sky-tinted
#           fresnel rim, Khronos PBR Neutral tone mapping like the renderer default.
# Our own code: MIT.

import argparse
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import bl  # noqa: E402

PALETTES = [  # primary, secondary, accent (docs/content.md §8.3)
    ("#E9E4D8", "#6F7780", "#F2B544"),
    ("#C8A97E", "#6B4A32", "#F5A623"),
    ("#1E2F5C", "#C9CED6", "#6FD3FF"),
    ("#5E7A3A", "#8A6A43", "#9BE564"),
    ("#2E2A2B", "#A3402B", "#FF8A3D"),
    ("#4A3260", "#3E5568", "#F09A7A"),
]
DEFAULT_PAL = {"hexwick": 2, "ash": 1, "kappa": 3, "unit7": 0, "ninja": 4}
SCALE = {"hexwick": 0.95, "ash": 1.04, "kappa": 0.9, "unit7": 0.98, "ninja": 0.96}
NAMES = {"hexwick": "Hexwick", "ash": "Brother Ash", "kappa": "Kappa", "unit7": "Unit 7", "ninja": "Ninja"}

# Portus (looks.ts): sun 0xfff1d6 x 3.2 at elevation 0.85 rad, hemisphere sky 0x9fb8ff / ground 0x6a5644 x 1.4
SUN_COL = bl.hex_lin("#fff1d6")
SUN_I = 3.2
HEMI_SKY = bl.hex_lin("#9fb8ff")
HEMI_GND = bl.hex_lin("#6a5644")
HEMI_I = 1.4
RIM = bl.hex_lin("#a8c4ff")


def node(nt, kind, **inputs):
    n = nt.nodes.new(kind)
    for k, v in inputs.items():
        n.inputs[k].default_value = v
    return n


def palette_tint(nt, pal):
    """RGB node output = mix(white, primary, R) -> secondary by G -> accent by B (Role attribute)."""
    prim, sec, acc = (bl.hex_lin(c) + (1.0,) for c in PALETTES[pal])
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "Color"
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(attr.outputs["Color"], sep.inputs["Color"])

    def mix(fac, a, b):
        m = nt.nodes.new("ShaderNodeMix")
        m.data_type = "RGBA"
        nt.links.new(fac, m.inputs["Factor"])
        if isinstance(a, tuple):
            m.inputs["A"].default_value = a
        else:
            nt.links.new(a, m.inputs["A"])
        m.inputs["B"].default_value = b
        return m.outputs["Result"]
    t = mix(sep.outputs["Red"], (1, 1, 1, 1), prim)
    t = mix(sep.outputs["Green"], t, sec)
    t = mix(sep.outputs["Blue"], t, acc)
    return t, sep.outputs["Blue"], acc


def mul(nt, a, b):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    m.blend_type = "MULTIPLY"
    m.inputs["Factor"].default_value = 1.0
    nt.links.new(a, m.inputs["A"])
    if isinstance(b, tuple):
        m.inputs["B"].default_value = b
    else:
        nt.links.new(b, m.inputs["B"])
    return m.outputs["Result"]


def add(nt, a, b):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    m.blend_type = "ADD"
    m.inputs["Factor"].default_value = 1.0
    nt.links.new(a, m.inputs["A"])
    if isinstance(b, tuple):
        m.inputs["B"].default_value = b
    else:
        nt.links.new(b, m.inputs["B"])
    return m.outputs["Result"]


def scale_col(nt, a, s):
    m = nt.nodes.new("ShaderNodeVectorMath")
    m.operation = "SCALE"
    nt.links.new(a, m.inputs[0])
    if isinstance(s, (int, float)):
        m.inputs["Scale"].default_value = s
    else:
        nt.links.new(s, m.inputs["Scale"])
    return m.outputs[0]


def make_material(name, albedo_path, normal_path, pal, look, sun_dir=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    alb = nt.nodes.new("ShaderNodeTexImage")
    alb.image = bpy.data.images.load(albedo_path, check_existing=True)
    alb.image.colorspace_settings.name = "sRGB"
    alb.image.alpha_mode = "CHANNEL_PACKED"
    nrm = nt.nodes.new("ShaderNodeTexImage")
    nrm.image = bpy.data.images.load(normal_path, check_existing=True)
    nrm.image.colorspace_settings.name = "Non-Color"
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
    tint, role_b, acc = palette_tint(nt, pal)
    base = mul(nt, alb.outputs["Color"], tint)
    # accent: role-accent parts glow, plus the painted mask (embroidery, lenses) = 1 - albedo alpha
    painted = nt.nodes.new("ShaderNodeMath")
    painted.operation = "SUBTRACT"
    painted.inputs[0].default_value = 1.0
    nt.links.new(alb.outputs["Alpha"], painted.inputs[1])
    amax = nt.nodes.new("ShaderNodeMath")
    amax.operation = "MAXIMUM"
    nt.links.new(role_b, amax.inputs[0])
    nt.links.new(painted.outputs[0], amax.inputs[1])
    # painted accents take the accent colour in the albedo too
    am = nt.nodes.new("ShaderNodeMix")
    am.data_type = "RGBA"
    nt.links.new(painted.outputs[0], am.inputs["Factor"])
    nt.links.new(base, am.inputs["A"])
    am.inputs["B"].default_value = acc
    base = am.outputs["Result"]
    emis = scale_col(nt, mul(nt, amax.outputs[0], acc), 2.2)
    if look == "studio":
        b = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(base, b.inputs["Base Color"])
        nt.links.new(nmap.outputs["Normal"], b.inputs["Normal"])
        b.inputs["Roughness"].default_value = 0.72
        nt.links.new(emis, b.inputs["Emission Color"])
        b.inputs["Emission Strength"].default_value = 1.0
        nt.links.new(b.outputs[0], out.inputs[0])
        return m
    # game look: emulate the toon avatar material (see header)
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    nt.links.new(nmap.outputs["Normal"], diff.inputs["Normal"])
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(s2r.outputs["Color"], bw.inputs[0])
    # sun-only lighting: value = k * N.L * shadow, k measured for a sun of strength SUN_I
    nl = nt.nodes.new("ShaderNodeMath")
    nl.operation = "DIVIDE"
    nt.links.new(bw.outputs[0], nl.inputs[0])
    nl.inputs[1].default_value = SUN_I / math.pi
    lit = nt.nodes.new("ShaderNodeMapRange")
    lit.inputs["From Min"].default_value = 0.0
    lit.inputs["From Max"].default_value = 0.025
    lit.interpolation_type = "SMOOTHSTEP"
    nt.links.new(nl.outputs[0], lit.inputs["Value"])
    band = nt.nodes.new("ShaderNodeMapRange")
    band.inputs["From Min"].default_value = 0.0
    band.inputs["From Max"].default_value = 0.14
    band.inputs["To Min"].default_value = 0.62
    band.inputs["To Max"].default_value = 1.0
    band.interpolation_type = "SMOOTHSTEP"
    nt.links.new(nl.outputs[0], band.inputs["Value"])
    ramp = nt.nodes.new("ShaderNodeMath")
    ramp.operation = "MULTIPLY"
    nt.links.new(lit.outputs[0], ramp.inputs[0])
    nt.links.new(band.outputs[0], ramp.inputs[1])
    sun_term = scale_col(nt, ramp.outputs[0], 1.0)
    sun_rgb = mul(nt, sun_term, tuple(c * SUN_I / math.pi for c in SUN_COL) + (1,))
    # hemisphere fill by world-space normal Z
    sepn = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(nmap.outputs["Normal"], sepn.inputs[0])
    hz = nt.nodes.new("ShaderNodeMapRange")
    hz.inputs["From Min"].default_value = -1
    hz.inputs["From Max"].default_value = 1
    nt.links.new(sepn.outputs["Z"], hz.inputs["Value"])
    hm = nt.nodes.new("ShaderNodeMix")
    hm.data_type = "RGBA"
    nt.links.new(hz.outputs[0], hm.inputs["Factor"])
    hm.inputs["A"].default_value = tuple(c * HEMI_I / math.pi for c in HEMI_GND) + (1,)
    hm.inputs["B"].default_value = tuple(c * HEMI_I / math.pi for c in HEMI_SKY) + (1,)
    light = add(nt, sun_rgb, hm.outputs["Result"])
    col = mul(nt, base, light)
    # fresnel rim: (1 - N.V)^3 * 0.32 * rim colour
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.5
    nt.links.new(nmap.outputs["Normal"], lw.inputs["Normal"])
    pw = nt.nodes.new("ShaderNodeMath")
    pw.operation = "POWER"
    nt.links.new(lw.outputs["Facing"], pw.inputs[0])
    pw.inputs[1].default_value = 3.0
    rim = scale_col(nt, mul(nt, scale_col(nt, pw.outputs[0], 0.32), RIM + (1,)), 1.0)
    col = add(nt, add(nt, col, emis), rim)
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(col, em.inputs["Color"])
    em.inputs["Strength"].default_value = 1.0
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


def load_anims(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    for o in set(bpy.data.objects) - before:
        o.hide_render = True
        o.hide_viewport = True
    return {a.name: a for a in bpy.data.actions}


def add_character(dir_, name, pal, look, x=0.0, rot_z=0.0, action=None, frame=0, y=0.0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(dir_, f"{name}.glb"))
    new = list(set(bpy.data.objects) - before)
    mat = make_material(f"{name}_{pal}_{look}", os.path.join(dir_, f"{name}_albedo.png"),
                        os.path.join(dir_, f"{name}_normal.png"), pal, look)
    arm = None
    for o in new:
        if o.type == "MESH" and o.parent is None:  # the importer's bone-shape icosphere
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        if o.type == "MESH":
            o.data.materials.clear()
            o.data.materials.append(mat)
        if o.type == "ARMATURE":
            arm = o
    root = arm
    s = SCALE.get(name, 1.0)
    root.scale = (s, s, s)
    root.location = (x, y, 0)
    root.rotation_euler = (0, 0, math.radians(rot_z))
    if arm and action:
        arm.animation_data_create()
        arm.animation_data.action = action
        if action.slots:
            arm.animation_data.action_slot = action.slots[0]
    return root, arm


def setup_world(look, transparent=False):
    sc = bpy.context.scene
    if look == "game":
        w = bl.world_gradient(bl.hex_lin("#93c0f2"), bl.hex_lin("#e9c3a6"), 0.0, bl.hex_lin("#ffdcc0"))
        sc.view_settings.view_transform = "Khronos PBR Neutral"
    else:
        w = bl.world_gradient((0.42, 0.47, 0.56), (0.22, 0.2, 0.19), 0.7)
        sc.view_settings.view_transform = "AgX"
    sc.render.film_transparent = transparent
    return w


def backdrop(look, size=40):
    bpy.ops.mesh.primitive_plane_add(size=size)
    p = bpy.context.active_object
    m = bpy.data.materials.new("floor")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    if look == "game":
        b.inputs["Base Color"].default_value = (*bl.hex_lin("#7aa05a"), 1)
    else:
        b.inputs["Base Color"].default_value = (0.32, 0.31, 0.3, 1)
    b.inputs["Roughness"].default_value = 0.9
    p.data.materials.append(m)
    return p


def lights(look):
    if look == "game":
        # Portus sun: elevation 0.85 rad (48.7 deg), from the front-left
        bl.sun("sun", SUN_I, SUN_COL, 48.7, -35, angle_deg=1.5)
    else:
        bl.sun("key", 3.6, (1.0, 0.95, 0.88), 40, -35, 4)
        bl.sun("fill", 0.9, (0.75, 0.82, 1.0), 15, 70, 10)
        bl.sun("rim", 2.6, (0.85, 0.9, 1.0), 30, 165, 3)


def label(text, loc, size=0.08):
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body = text
    cu.size = size
    cu.align_x = "CENTER"
    o = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (math.radians(90), 0, 0)
    m = bpy.data.materials.new("txt")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
    cu.materials.append(m) if hasattr(cu, "materials") else None
    o.data.materials.append(m)
    return o


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--anims", default="")
    ap.add_argument("--mode", default="turnaround")
    ap.add_argument("--chars", default="hexwick")
    ap.add_argument("--look", default="studio")
    ap.add_argument("--clip", default="idle")
    ap.add_argument("--frame", type=int, default=20)
    ap.add_argument("--palettes", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--res", type=int, default=1600)
    ap.add_argument("--samples", type=int, default=64)
    a = ap.parse_args(argv)
    bl.reset()
    sc = bpy.context.scene
    names = a.chars.split(",")
    pals = [int(x) for x in a.palettes.split(",")] if a.palettes else [DEFAULT_PAL.get(n, 0) for n in names]
    acts = load_anims(a.anims) if a.anims else {}
    act = acts.get(a.clip)
    sc.render.fps = 30
    bl.eevee(a.res, a.res, a.samples)
    setup_world(a.look)
    lights(a.look)
    backdrop(a.look)
    if a.mode == "turnaround":
        n = names[0]
        angles = [0, -40, -90, 180]
        sp = 0.95
        for i, ang in enumerate(angles):
            add_character(a.dir, n, pals[0], a.look, x=(i - 1.5) * sp, rot_z=ang, action=act)
        sc.frame_set(a.frame)
        sc.render.resolution_x = a.res
        sc.render.resolution_y = int(a.res * 0.62)
        cam = bl.camera("cam", (0, 0, 0.92), (0, -1, 0.04), 7.2, lens=50)
    elif a.mode == "hero":
        n = names[0]
        add_character(a.dir, n, pals[0], a.look, rot_z=-28, action=act)
        sc.frame_set(a.frame)
        sc.render.resolution_x = int(a.res * 0.75)
        sc.render.resolution_y = a.res
        cam = bl.camera("cam", (0, 0, 1.0), (0.12, -1, 0.1), 4.6, lens=55)
    elif a.mode == "portrait":
        n = names[0]
        add_character(a.dir, n, pals[0], a.look, rot_z=-25, action=act)
        sc.frame_set(a.frame)
        sc.render.resolution_x = a.res
        sc.render.resolution_y = a.res
        cam = bl.camera("cam", (0, 0, 1.58), (0.1, -1, 0.05), 1.9, lens=70)
    elif a.mode == "lineup":
        sp = 1.05
        for i, (n, p) in enumerate(zip(names, pals)):
            add_character(a.dir, n, p, a.look, x=(i - (len(names) - 1) / 2) * sp, rot_z=-15, action=act)
        sc.frame_set(a.frame)
        sc.render.resolution_x = a.res
        sc.render.resolution_y = int(a.res * 0.5)
        cam = bl.camera("cam", (0, 0, 0.95), (0.1, -1, 0.08), 3.0 + 1.3 * len(names), lens=50)
    elif a.mode == "palettes":
        n = names[0]
        for i in range(6):
            add_character(a.dir, n, i, a.look, x=(i - 2.5) * 0.9, rot_z=-20, action=act)
        sc.frame_set(a.frame)
        sc.render.resolution_x = a.res
        sc.render.resolution_y = int(a.res * 0.42)
        cam = bl.camera("cam", (0, 0, 0.95), (0.05, -1, 0.06), 8.6, lens=50)
    else:
        raise SystemExit(f"unknown mode {a.mode}")
    sc.camera = cam
    bl.render(a.out)


main()
