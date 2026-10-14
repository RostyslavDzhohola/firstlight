"""Optional offline style check of the uncompressed build, with the client's role-mask tints."""
import sys
from pathlib import Path
import math
import bpy
from mathutils import Vector

src, out = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=src)
names = ['CommonTree_1', 'Pine_1', 'TwistedTree_1', 'DeadTree_1']
kept = []
for o in list(bpy.data.objects):
    if o.type != 'MESH' or not any(o.name == f'{n}_L{l}' for n in names for l in (0, 1)):
        bpy.data.objects.remove(o, do_unlink=True)
        continue
    name, lod = o.name.rsplit('_L', 1)
    i = names.index(name)
    # Raw GLB is imported into Blender +Z up; its geometry is already normalized.
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.location.x += i * 10 - 15
    o.location.y += int(lod) * 12
    if name.startswith('DeadTree') and lod == '1':
        o.data.materials[0] = o.data.materials[0].copy()
        o.data.materials[0].name = 'dead_impostor'
    kept.append(o)
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    images = [n for n in m.node_tree.nodes if n.type == 'TEX_IMAGE']
    if not bsdf or not images:
        continue
    nodes, links = m.node_tree.nodes, m.node_tree.links
    tex = images[0]
    col = nodes.new('ShaderNodeVertexColor')
    col.layer_name = 'Color'
    split = nodes.new('ShaderNodeSeparateXYZ')
    links.new(col.outputs['Color'], split.inputs[0])
    if m.name.startswith('vegetation_impostors'):
        tex_split = nodes.new('ShaderNodeSeparateXYZ')
        links.new(tex.outputs['Color'], tex_split.inputs[0])
        deltas = []
        for a, b in [('X', 'Y'), ('Y', 'Z')]:
            sub = nodes.new('ShaderNodeMath'); sub.operation = 'SUBTRACT'
            links.new(tex_split.outputs[a], sub.inputs[0]); links.new(tex_split.outputs[b], sub.inputs[1])
            absolute = nodes.new('ShaderNodeMath'); absolute.operation = 'ABSOLUTE'
            links.new(sub.outputs[0], absolute.inputs[0]); deltas.append(absolute.outputs[0])
        total = nodes.new('ShaderNodeMath'); total.operation = 'ADD'
        links.new(deltas[0], total.inputs[0]); links.new(deltas[1], total.inputs[1])
        leaf = nodes.new('ShaderNodeMath'); leaf.operation = 'LESS_THAN'; leaf.inputs[1].default_value = 0.025
        links.new(total.outputs[0], leaf.inputs[0])
        bark = nodes.new('ShaderNodeMath'); bark.operation = 'SUBTRACT'; bark.inputs[0].default_value = 1
        links.new(leaf.outputs[0], bark.inputs[1])
        role = nodes.new('ShaderNodeCombineXYZ')
        links.new(leaf.outputs[0], role.inputs['X']); links.new(bark.outputs[0], role.inputs['Y'])
        links.new(role.outputs[0], split.inputs[0])
    elif m.name == 'dead_impostor':
        for link in list(split.inputs[0].links): links.remove(link)
        split.inputs[0].default_value = (0, 1, 0)
    terms = []
    for channel, tint in zip('XYZ', [(0.18, 0.45, 0.10), (1, 1, 1), (1, 1, 1)]):
        term = nodes.new('ShaderNodeVectorMath')
        term.operation = 'SCALE'
        term.inputs[0].default_value = tint
        links.new(split.outputs[channel], term.inputs[3])
        terms.append(term.outputs['Vector'])
    add = nodes.new('ShaderNodeVectorMath')
    add.operation = 'ADD'
    links.new(terms[0], add.inputs[0])
    links.new(terms[1], add.inputs[1])
    add2 = nodes.new('ShaderNodeVectorMath')
    add2.operation = 'ADD'
    links.new(add.outputs['Vector'], add2.inputs[0])
    links.new(terms[2], add2.inputs[1])
    mul = nodes.new('ShaderNodeVectorMath')
    mul.operation = 'MULTIPLY'
    links.new(tex.outputs['Color'], mul.inputs[0])
    links.new(add2.outputs['Vector'], mul.inputs[1])
    links.new(mul.outputs['Vector'], bsdf.inputs['Base Color'])
    links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    m.surface_render_method = 'DITHERED'
bpy.ops.mesh.primitive_plane_add(size=200)
plane = bpy.context.object
plane.location.z = -0.05
material = bpy.data.materials.new('ground')
material.diffuse_color = (0.3, 0.36, 0.4, 1)
plane.data.materials.append(material)
bpy.ops.object.light_add(type='SUN', location=(0, -10, 20))
sun = bpy.context.object
sun.rotation_euler = (0.3, -0.5, -0.5)
sun.data.energy = 2.2
bpy.ops.object.camera_add(location=(22, -38, 28))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 6, 3)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 54
scene = bpy.context.scene
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.world.use_nodes = True
scene.world.node_tree.nodes.get('Background').inputs['Color'].default_value = (0.5, 0.6, 0.7, 1)
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0.6
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
