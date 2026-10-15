# FIRSTLIGHT sculpted characters: a character is a list of Parts. Each part is one sculpted SDF with a
# triangle budget, a palette role, a skinning rule and a paint function.
# Our own code: MIT.

import numpy as np

ROLE_RGBA = {
    "fixed": (0.0, 0.0, 0.0, 1.0),
    "primary": (1.0, 0.0, 0.0, 1.0),
    "secondary": (0.0, 1.0, 0.0, 1.0),
    "accent": (0.0, 0.0, 1.0, 1.0),
}


class Part:
    """name: unique; field: SDF; vox: high-poly voxel size; tris: low-poly triangle budget;
    role: fixed | primary | secondary | accent (palette slot multiplied into the albedo);
    weights: ("auto", [bones]) heat weights restricted to bones | ("rigid", bone) | ("fn", f(P)->{bone: w}) |
             ("near", [bones]) nearest-segment blend;
    paint: f(ctx) -> rgb (N,3) sRGB, or (rgb, emissive mask); ctx has P, N, cav, ao, part;
    occlude: hides other parts' faces buried inside this one; cull: this part's buried faces are removed;
    texel: relative texel density (faces 2-3x, hidden-ish parts < 1);
    bbox: optional ((x0,y0,z0),(x1,y1,z1)), otherwise found by a coarse scan."""

    def __init__(self, name, field, role="fixed", vox=0.002, tris=800, weights=None, paint=None, occlude=True,
                 cull=True, texel=1.0, bbox=None, cull_eps=0.0015, uv_angle=60.0, keep=None, bump=None):
        self.name = name
        self.field = field
        self.role = role
        self.vox = vox
        self.tris = tris
        self.weights = weights
        self.paint = paint
        self.occlude = occlude
        self.cull = cull
        self.texel = texel
        self.bbox = bbox
        self.cull_eps = cull_eps
        self.uv_angle = uv_angle
        self.bump = bump  # optional f(P, N) -> N: fine relief (weave, strands) added to the normal map
        self.keep = keep  # optional f(face centres) -> bool mask of faces to keep (manual trims)


class Ctx:
    """Per-part paint context: texel samples of the high-poly surface."""

    def __init__(self, part, P, N, cav, ao, extra=None):
        self.part = part
        self.P = P
        self.N = N
        self.cav = cav
        self.ao = ao
        self.n = len(P)
        self.extra = extra or {}
