# FIRSTLIGHT sculpted props: the shipped clips (apps/client/public/assets-dev/characters/
# starters_anims.glb) on a shipped character in Blender. That GLB is a bare node tree with no skin, so
# Blender imports it as one empty per joint with object actions, not as an armature. This drives a
# character's armature from those empties: the offset between a joint node's rest frame and the bone's
# rest frame (both in model space) is fixed, so bone(t) = node(t) @ offset. Rest frames come from the
# GLB's own node TRS (the importer may already have moved the empties).
# Our own code: MIT.

import json
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

# glTF (Y up) -> Blender (Z up), the importer's conversion
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def glb_nodes(path):
    with open(path, "rb") as fh:
        fh.read(12)
        n, kind = struct.unpack("<I4s", fh.read(8))
        assert kind == b"JSON"
        return json.loads(fh.read(n))["nodes"]


def rest_world(path):
    """Joint name -> rest matrix in Blender model space, from the GLB's node TRS."""
    nodes = glb_nodes(path)
    parent = {c: i for i, nd in enumerate(nodes) for c in nd.get("children", [])}
    local = []
    for nd in nodes:
        t = Vector(nd.get("translation", (0, 0, 0)))
        x, y, z, w = nd.get("rotation", (0, 0, 0, 1))
        s = nd.get("scale", (1, 1, 1))
        S = Matrix.Diagonal((*s, 1))
        local.append(Matrix.Translation(t) @ Quaternion((w, x, y, z)).to_matrix().to_4x4() @ S)
    out = {}
    for i, nd in enumerate(nodes):
        m, j = local[i], i
        while j in parent:
            j = parent[j]
            m = local[j] @ m
        out[nd.get("name", str(i))] = C @ m @ C.inverted()
    return out


class Clips:
    def __init__(self, path):
        sc = bpy.context.scene
        sc.render.fps, sc.render.fps_base = 30, 1.0  # clip frames are 30 fps, like the characters' pipeline
        before, acts_before = set(bpy.data.objects), set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=path)
        self.empties = {o.name: o for o in set(bpy.data.objects) - before if o.type == "EMPTY"}
        self.actions = {a.name: a for a in set(bpy.data.actions) - acts_before}
        self.rest = rest_world(path)
        # rest_world() and the empties share the file's node tree (its root node has no transform), so
        # node(t) and rest are in the same space
        self.clip = None

    def frames(self, clip):
        a = self.actions[clip]
        return int(round(a.frame_range[0])), int(round(a.frame_range[1]))

    def set_clip(self, clip):
        if clip == self.clip:
            return
        act = self.actions[clip]
        for name, o in self.empties.items():
            slot = act.slots.get("OB" + name)
            o.animation_data_create()
            o.animation_data.action = act if slot else None
            if slot:
                o.animation_data.action_slot = slot
        self.clip = clip

    def pose(self, arms, clip, frame):
        """Pose every armature in arms at this clip frame (call scene updates after)."""
        self.set_clip(clip)
        sc = bpy.context.scene
        sc.frame_set(frame)
        bpy.context.view_layer.update()
        node = {n: o.matrix_world.copy() for n, o in self.empties.items()}
        for arm in arms:
            bones = arm.data.bones
            target = {}
            for b in sorted(bones, key=lambda b: len(b.parent_recursive)):
                if b.name not in node or b.name not in self.rest:
                    continue
                off = self.rest[b.name].inverted() @ b.matrix_local
                T = node[b.name] @ off
                target[b.name] = T
                pb = arm.pose.bones[b.name]
                if b.parent and b.parent.name in target:
                    P = target[b.parent.name] @ b.parent.matrix_local.inverted() @ b.matrix_local
                else:
                    P = b.matrix_local
                pb.matrix_basis = P.inverted() @ T
        bpy.context.view_layer.update()
