# FIRSTLIGHT sculpted characters: extra bones a recipe adds on top of the shared 65-joint skeleton
# (hood tips, braids, cloth panels, hanging props). The shared clips never key them, so they sit at rest
# unless swing.py bakes follow-through for them. A recipe declares them as
#   EXTRA_BONES = {name: (parent, head, tail)}   # rest pose, metres, T-pose facing -Y
# Our own code: MIT.

import bpy
from mathutils import Vector


def add(rig, spec):
    """Add the bones in `spec` to the armature object `rig` (parents before children, any order given)."""
    if not spec:
        return []
    for o in bpy.context.scene.objects:
        o.select_set(False)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    inv = rig.matrix_world.inverted()  # the importer may leave the armature object scaled/rotated
    done = []
    todo = dict(spec)
    while todo:
        progressed = False
        for name, (parent, head, tail) in list(todo.items()):
            if parent not in eb:
                continue
            b = eb.new(name)
            b.head = inv @ Vector(head)
            b.tail = inv @ Vector(tail)
            b.parent = eb[parent]
            b.use_connect = False
            b.use_deform = True
            # roll so the bone's Z axis points forward-ish: keeps local swing axes predictable
            b.align_roll(inv.to_3x3() @ Vector((0, -1, 0)))
            done.append(name)
            del todo[name]
            progressed = True
        if not progressed:
            bpy.ops.object.mode_set(mode="OBJECT")
            raise ValueError(f"extra bones with unknown parents: {sorted(todo)}")
    bpy.ops.object.mode_set(mode="OBJECT")
    return done
