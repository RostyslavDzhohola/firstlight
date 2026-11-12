"""Read only glTF meshes and their PNG/bin dependencies, with Blender autoexec disabled."""
import argparse
import json
import math
from pathlib import Path
import sys
import struct
import bpy
import bmesh
from mathutils import Vector, Matrix

p = argparse.ArgumentParser()
p.add_argument('--pack', required=True)
p.add_argument('--out', required=True)
# The HD art pack (tools/blender/artpacks) builds only the mesh atlas, larger: --atlas-size 4096 --atlas-only.
# Tile and border scale with it, so every texel lands at the same normalized UV as in the shipped atlas.
p.add_argument('--atlas-size', type=int, default=2048)
p.add_argument('--atlas-only', action='store_true')
a = p.parse_args(sys.argv[sys.argv.index('--') + 1:])
src = Path(a.pack).resolve() / 'glTF'
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
models = {**{f'{family}_{i}': height for family, height in [('CommonTree', 6.2), ('Pine', 8.2), ('TwistedTree', 6.2), ('DeadTree', 5.7)] for i in range(1, 4)},
          'Bush_Common': 1.1, 'Bush_Common_Flowers': 1.1, 'Fern_1': 0.8,
          'Plant_1': 0.9, 'Plant_1_Big': 1.6, 'Plant_7': 0.8, 'Plant_7_Big': 0.9,
          'Flower_3_Group': 0.65, 'Flower_4_Group': 0.65,
          'Mushroom_Common': 0.45, 'Mushroom_Laetiporus': 0.45,
          **{f'Rock_Medium_{i}': 0.9 for i in range(1, 4)}}

# Validate every URI before Blender's importer can open it. No scripts, remote URLs or traversal.
textures = set()
material_textures = {}
for name in models:
    doc = json.loads((src / f'{name}.gltf').read_text())
    for entry in doc.get('buffers', []) + doc.get('images', []):
        uri = entry.get('uri', '')
        path = (src / uri).resolve()
        if not uri or path.parent != src or path.suffix.lower() not in ('.png', '.bin'):
            raise ValueError(f'unsafe glTF dependency in {name}')
    for mat in doc['materials']:
        tex = mat.get('pbrMetallicRoughness', {}).get('baseColorTexture')
        if tex:
            uri = doc['images'][doc['textures'][tex['index']]['source']]['uri']
            textures.add(uri)
            material_textures[mat['name']] = uri

# One atlas (2048 shipped): 8 x 8 tiles, each with an extruded border (4 px at 2048) to protect mip edges.
import numpy as np
size = a.atlas_size
tile, border = size // 8, size // 512
pixels = np.zeros(size * size * 4, dtype=np.float32)
slots = {}
for idx, uri in enumerate(sorted(textures)):
    if idx >= 64:
        raise ValueError('atlas full')
    image = bpy.data.images.load(str(src / uri), check_existing=True)
    image.scale(tile - border * 2, tile - border * 2)
    data = list(image.pixels)
    tx, ty = idx % 8 * tile, idx // 8 * tile
    w = tile - border * 2
    for y in range(tile):
        sy = min(w - 1, max(0, y - border))
        for x in range(tile):
            sx = min(w - 1, max(0, x - border))
            rgba = data[(sy * w + sx) * 4:(sy * w + sx) * 4 + 4]
            if 'Leaves' in uri or 'Leaf_' in uri:
                # Neutral foliage retains painted detail and takes the body's leaf/blossom tint.
                lum = max(rgba[:3])
                rgba[:3] = [lum] * 3
            j = ((ty + y) * size + tx + x) * 4
            pixels[j:j + 4] = rgba
    slots[uri] = (tx, ty)
atlas = bpy.data.images.new('vegetation_atlas', width=size, height=size, alpha=True)
atlas.pixels.foreach_set(pixels)
atlas.filepath_raw = str(out / 'atlas.png')
atlas.file_format = 'PNG'
atlas.save()
if a.atlas_only:
    print(f'VEGETATION atlas {size}: {len(textures)} tiles of {tile} px')
    sys.exit(0)
mat = bpy.data.materials.new('vegetation_atlas')
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Roughness'].default_value = 0.86
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = atlas
mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
mat.node_tree.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
mat.surface_render_method = 'DITHERED'
mat.use_backface_culling = False
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
# Far trees use two orthographic cutouts baked from the full source mesh. Their foliage is
# neutral grey and bark stays painted, so the client can distinguish the leaf/bark tint in TSL.
import numpy as np
imp_width, imp_height = 1536, 1024
imp_pixels = np.zeros((imp_height, imp_width, 4), dtype=np.float32)
imp_image = bpy.data.images.new('vegetation_impostors', width=imp_width, height=imp_height, alpha=True)
imp_mat = bpy.data.materials.new('vegetation_impostors')
imp_mat.use_nodes = True
imp_tex = imp_mat.node_tree.nodes.new('ShaderNodeTexImage')
imp_tex.image = imp_image
imp_bsdf = imp_mat.node_tree.nodes.get('Principled BSDF')
imp_mat.node_tree.links.new(imp_tex.outputs['Color'], imp_bsdf.inputs['Base Color'])
imp_mat.node_tree.links.new(imp_tex.outputs['Alpha'], imp_bsdf.inputs['Alpha'])
imp_mat.use_backface_culling = False
imp_mat.surface_render_method = 'DITHERED'
# Emission captures painted colour without lights, shadows or tone-map baking.
output = mat.node_tree.nodes.get('Material Output')
emission = mat.node_tree.nodes.new('ShaderNodeEmission')
transparent = mat.node_tree.nodes.new('ShaderNodeBsdfTransparent')
blend = mat.node_tree.nodes.new('ShaderNodeMixShader')
mat.node_tree.links.new(tex.outputs['Color'], emission.inputs['Color'])
mat.node_tree.links.new(tex.outputs['Alpha'], blend.inputs[0])
mat.node_tree.links.new(transparent.outputs[0], blend.inputs[1])
mat.node_tree.links.new(emission.outputs[0], blend.inputs[2])
mat.node_tree.links.new(blend.outputs[0], output.inputs['Surface'])
bpy.ops.object.camera_add()
bake_camera = bpy.context.object
bake_camera.data.type = 'ORTHO'
scene = bpy.context.scene
scene.camera = bake_camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 8
scene.render.film_transparent = True
scene.render.resolution_x = 256
scene.render.resolution_y = 256
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
imp_index = 0
exports = []

def impostor(base, name, height):
    global imp_index
    corners = [base.matrix_world @ Vector(c) for c in base.bound_box]
    lo = Vector([min(v[i] for v in corners) for i in range(3)])
    hi = Vector([max(v[i] for v in corners) for i in range(3)])
    size = max(height, hi.x - lo.x, hi.y - lo.y) * 1.06
    middle = (lo + hi) / 2
    views = []
    for view in (0, 1):
        bpy.context.view_layer.update()
        bake_camera.location = middle + (Vector((0, -size * 3, 0)) if view == 0 else Vector((size * 3, 0, 0)))
        bake_camera.rotation_euler = (middle - bake_camera.location).to_track_quat('-Z', 'Y').to_euler()
        bake_camera.data.ortho_scale = size
        file = out / f'{name}-{view}.png'
        scene.render.filepath = str(file)
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(str(file), check_existing=False)
        data = np.empty(256 * 256 * 4, dtype=np.float32)
        image.pixels.foreach_get(data)
        tx, ty = imp_index % 6 * 256, imp_index // 6 * 256
        imp_pixels[ty:ty + 256, tx:tx + 256] = data.reshape((256, 256, 4))
        views.append((tx, ty))
        imp_index += 1
        bpy.data.images.remove(image)
    # Two fixed perpendicular cards retain the deterministic yaw, with no camera sorting.
    verts = [(-size/2, 0, height/2-size/2), (size/2, 0, height/2-size/2),
             (size/2, 0, height/2+size/2), (-size/2, 0, height/2+size/2),
             (0, -size/2, height/2-size/2), (0, size/2, height/2-size/2),
             (0, size/2, height/2+size/2), (0, -size/2, height/2+size/2)]
    geo = bpy.data.meshes.new(f'{name}_impostor')
    geo.from_pydata(verts, [], [(0, 1, 2), (0, 2, 3), (4, 5, 6), (4, 6, 7)])
    uv = geo.uv_layers.new(name='UVMap')
    local = [(0,0),(1,0),(1,1),(0,1)] * 2
    for poly in geo.polygons:
        tx, ty = views[poly.index // 2]
        for li in poly.loop_indices:
            u, v = local[geo.loops[li].vertex_index]
            uv.data[li].uv = ((tx + u * 256) / imp_width, (ty + v * 256) / imp_height)
    role = geo.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
    for datum in role.data:
        datum.color = (1, 0, 0, 1)
    geo.materials.append(imp_mat)
    obj = bpy.data.objects.new(f'{name}_L1', geo)
    bpy.context.collection.objects.link(obj)
    obj.hide_render = True
    exports.append(obj)
    return 4

manifest = {}
for name, height in models.items():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(src / f'{name}.gltf'))
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == 'MESH']
    points = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    lo = Vector([min(v[i] for v in points) for i in range(3)])
    hi = Vector([max(v[i] for v in points) for i in range(3)])
    # Blender importer has converted glTF +Y up to Blender +Z up. Export converts it back.
    scale = height / (hi.z - lo.z)
    roots = [v for v in points if v.z <= lo.z + (hi.z - lo.z) * 0.04]
    center = Vector((sum(v.x for v in roots) / len(roots), sum(v.y for v in roots) / len(roots), lo.z))
    for o in meshes:
        world = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
        for v in o.data.vertices:
            v.co = (world @ v.co - center) * scale
        for old in list(o.data.color_attributes):
            o.data.color_attributes.remove(old)
        roles = o.data.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
        uv = o.data.uv_layers.active
        for poly in o.data.polygons:
            material = o.data.materials[poly.material_index]
            uri = material_textures[material.name.split('.')[0]]
            tx, ty = slots[uri]
            role = (1, 0, 0, 1) if ('Leaves' in uri or 'Leaf_' in uri or name.startswith(('Fern', 'Plant', 'Bush'))) else (0, 1, 0, 1) if 'Bark' in uri else (0, 0, 1, 1) if ('Rock' in uri or name.startswith('Pebble')) else (0, 0, 0, 1)
            for li in poly.loop_indices:
                u, v = uv.data[li].uv
                uv.data[li].uv = ((tx + border + min(1, max(0, u)) * (tile - 2 * border)) / size,
                                  (ty + border + min(1, max(0, v)) * (tile - 2 * border)) / size)
                roles.data[li].color = role
        o.data.materials.clear()
        o.data.materials.append(mat)
        for poly in o.data.polygons:
            poly.material_index = 0
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    base = bpy.context.object
    tris = sum(len(p.vertices) - 2 for p in base.data.polygons)
    tree = 'Tree' in name or name.startswith('Pine')
    manifest[name] = {'height': height, 'sourceTriangles': tris, 'lodTriangles': [], 'far': 'crossed-impostor' if tree else 'decimated'}
    for lod in (0, 1):
        if tree and lod == 1:
            manifest[name]['lodTriangles'].append(impostor(base, name, height))
            continue
        obj = base.copy()
        obj.data = base.data.copy()
        bpy.context.collection.objects.link(obj)
        obj.name = f'{name}_L{lod}'
        tree = 'Tree' in name or name.startswith('Pine')
        cap = (900 if tree else 320) if lod == 0 else (96 if tree else 32)
        bpy.context.view_layer.objects.active = obj
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00001)
        bm.to_mesh(obj.data)
        bm.free()
        dec = obj.modifiers.new('budget', 'DECIMATE')
        dec.ratio = min(1, cap / max(1, tris))
        bpy.ops.object.modifier_apply(modifier=dec.name)
        tri = obj.modifiers.new('triangles', 'TRIANGULATE')
        bpy.ops.object.modifier_apply(modifier=tri.name)
        # Collapse can move the lowest trunk/plant vertices. Restore the base and original
        # height on each LOD so switching distance never makes a root float or changes scale.
        low = min(v.co.z for v in obj.data.vertices)
        high = max(v.co.z for v in obj.data.vertices)
        roots = [v.co for v in obj.data.vertices if v.co.z <= low + (high - low) * 0.04]
        rx = sum(v.x for v in roots) / len(roots)
        ry = sum(v.y for v in roots) / len(roots)
        for v in obj.data.vertices:
            v.co.x -= rx
            v.co.y -= ry
            v.co.z = (v.co.z - low) * height / max(0.001, high - low)
        for datum in obj.data.uv_layers.active.data:
            datum.uv.x = min(1, max(0, datum.uv.x))
            datum.uv.y = min(1, max(0, datum.uv.y))
        manifest[name]['lodTriangles'].append(len(obj.data.polygons))
        obj.hide_render = True
        exports.append(obj)
    for o in imported:
        if o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)
imp_image.pixels.foreach_set(imp_pixels.ravel())
imp_image.filepath_raw = str(out / 'impostors.png')
imp_image.file_format = 'PNG'
imp_image.save()
# Restore the atlas material for the exported near meshes.
mat.node_tree.links.new(bsdf.outputs[0], output.inputs['Surface'])
bpy.ops.object.select_all(action='DESELECT')
for o in exports:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out / 'vegetation.glb'), export_format='GLB', use_selection=True,
                         export_yup=True, export_vertex_color='NAME', export_vertex_color_name='Color', export_all_vertex_colors=False, export_animations=False, export_materials='EXPORT', export_image_format='AUTO')
# Blender exports DITHERED as BLEND. The runtime and stored asset both use cutout alpha.
file = out / 'vegetation.glb'
binary = file.read_bytes()
length = struct.unpack_from('<I', binary, 12)[0]
doc = json.loads(binary[20:20 + length])
for material in doc['materials']:
    material['alphaMode'] = 'MASK'
    material['alphaCutoff'] = 0.5
chunk = json.dumps(doc, separators=(',', ':')).encode()
chunk += b' ' * ((-len(chunk)) % 4)
rest = binary[20 + length:]
file.write_bytes(struct.pack('<III', 0x46546C67, 2, 20 + len(chunk) + len(rest)) +
                 struct.pack('<II', len(chunk), 0x4E4F534A) + chunk + rest)
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'VEGETATION {len(models)} models, {len(textures)} atlas tiles')
