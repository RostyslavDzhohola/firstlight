# Wild sites on the combat planets (lane `world`, 2026-11-13): headless Blender build of the prefabs
# the shared code places away from the pads (packages/shared/src/content/wildSites.ts). Every mesh is
# built here from primitives (our own work, CC BY 4.0; no kit, no download):
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python build_sites.py -- \
#     --out <dir> [--renders all|none|<name,name>] [--samples 24]
#
# Writes <dir>/sites_<body>.glb (per prefab: `<name>` LOD0, `<name>_lod1`, and `<name>_glow` for emissive bits),
# <dir>/sites.json (per prefab: collider solids, chest spot, guard spots, lookout, size, triangles) and
# <dir>/render_<name>.png (each prefab alone, labelled) for the contact sheet (build.sh).
#
# Frame: Blender X = right (east at yaw 0), Y = back (north), Z = up, base at Z = 0; the prefab's front
# (-Y) faces south at yaw 0, like the outpost prefabs. Solids use the TownSolid format of
# content/portusTown.ts: [shape 0 box | 1 cylinder, cx, cz, hx, hz, y0, y1, yaw°] in the prefab frame
# (x right, z front = -Y, y up). Spots are [x, z] in that frame too. Vertex colours carry the look
# (one opaque material on the client); `_glow` meshes are drawn with an emissive one.
import bpy, bmesh, sys, os, math, json, random
from mathutils import Vector, Matrix, noise

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def opt(name, default=None):
    if name in ARGV:
        i = ARGV.index(name)
        return ARGV[i + 1] if i + 1 < len(ARGV) else True
    return default

OUT = os.path.abspath(str(opt("--out", "/tmp/fl-sites")))
RENDERS = str(opt("--renders", "all"))
SAMPLES = int(opt("--samples", 24))
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------------------------------------ palettes
PAL = {
    # Arcadia: sunlit limestone, terracotta, oak timber, moss, brass; the Brightbits' teal glow.
    "lime": (0.74, 0.70, 0.60), "lime_dk": (0.58, 0.55, 0.48), "moss": (0.36, 0.50, 0.20), "grass": (0.40, 0.58, 0.22),
    "oak": (0.42, 0.28, 0.16), "oak_dk": (0.28, 0.19, 0.11), "terra": (0.70, 0.33, 0.20), "brass": (0.78, 0.58, 0.24),
    "cloth_red": (0.78, 0.18, 0.16), "rock_a": (0.62, 0.58, 0.52), "rock_a_dk": (0.48, 0.45, 0.41), "teal": (0.25, 0.85, 0.85),
    # Hollowmere: wet slate, black oak, bone, lichen, iron; green lantern light.
    "slate": (0.27, 0.28, 0.30), "slate_lt": (0.38, 0.39, 0.41), "blackoak": (0.17, 0.13, 0.10), "bone": (0.80, 0.77, 0.68),
    "lichen": (0.36, 0.44, 0.28), "iron": (0.18, 0.18, 0.20), "bark": (0.24, 0.20, 0.17), "bark_dk": (0.15, 0.12, 0.10),
    "fen": (0.45, 1.0, 0.55), "moss_dk": (0.22, 0.30, 0.16),
    # Meridian: sandstone, poured concrete, rust, brushed steel, hazard yellow; amber beacons.
    "sand": (0.80, 0.60, 0.42), "sand_dk": (0.62, 0.45, 0.31), "concrete": (0.60, 0.58, 0.54), "concrete_dk": (0.44, 0.42, 0.40),
    "rust": (0.52, 0.27, 0.14), "steel": (0.50, 0.52, 0.55), "steel_dk": (0.30, 0.31, 0.33), "hazard": (0.86, 0.68, 0.10),
    "amber": (1.0, 0.62, 0.12), "hull": (0.43, 0.46, 0.50), "hull_dk": (0.28, 0.30, 0.33), "cream": (0.82, 0.78, 0.68),
    "chest_wood": (0.40, 0.24, 0.12), "chest_band": (0.72, 0.56, 0.22),
}

def jitter_col(c, rng, amt=0.10):
    k = 1.0 + (rng.random() * 2 - 1) * amt
    return tuple(max(0.0, min(1.0, x * k)) for x in c)

# ------------------------------------------------------------------------------------------ mesh kit
class Kit:
    """One prefab under construction: a bmesh with per-corner colours, its glow bmesh, solids and spots."""

    def __init__(self, name, seed, wear=None):
        self.name = name
        self.rng = random.Random(seed)
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new("Col")
        self.gbm = bmesh.new()
        self.gcol = self.gbm.loops.layers.color.new("Col")
        self.solids = []
        self.chest = None
        self.guards = []
        self.lookout = None
        # Wear: (moss colour, top-face threshold, chance) and grime near the ground.
        self.wear = wear

    # Geometry ------------------------------------------------------------------------------
    def _add(self, verts, faces, color, glow=False, wear=True, amt=0.08):
        bm, col = (self.gbm, self.gcol) if glow else (self.bm, self.col)
        vs = [bm.verts.new(v) for v in verts]
        out = []
        for f in faces:
            try:
                face = bm.faces.new([vs[i] for i in f])
            except ValueError:
                continue
            out.append(face)
        bm.normal_update()
        for face in out:
            c = jitter_col(PAL[color] if isinstance(color, str) else color, self.rng, amt)
            if wear and not glow:
                c = self._weathered(face, c)
            for loop in face.loops:
                z = loop.vert.co.z
                k = 1.0
                if not glow and wear:
                    # Grime: darker toward the ground, a touch lighter on high edges.
                    k = 0.72 + 0.28 * min(1.0, max(0.0, (z + 0.2) / 1.6))
                loop[col] = (c[0] * k, c[1] * k, c[2] * k, 1.0)
        return out

    def _weathered(self, face, c):
        if not self.wear:
            return c
        moss, thresh, chance = self.wear
        n = face.normal
        ctr = face.calc_center_median()
        nz = noise.noise(Vector((ctr.x * 0.35, ctr.y * 0.35, ctr.z * 0.35)))
        if n.z > thresh and self.rng.random() < chance + 0.3 * nz:
            m = PAL[moss]
            t = 0.55 + 0.4 * self.rng.random()
            return tuple(c[i] * (1 - t) + m[i] * t for i in range(3))
        # Streaks on walls: a darker band where water runs.
        if abs(n.z) < 0.3 and nz > 0.25:
            return tuple(x * 0.82 for x in c)
        return c

    def box(self, ctr, size, color, rz=0.0, rx=0.0, ry=0.0, glow=False, wear=True, taper=1.0, amt=0.08):
        """Box centred at ctr (x, y, z), size (sx, sy, sz), rotations in degrees; taper scales the top face."""
        sx, sy, sz = (s / 2 for s in size)
        vs = []
        for z, t in ((-sz, 1.0), (sz, taper)):
            for x, y in ((-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)):
                vs.append(Vector((x * t, y * t, z)))
        m = Matrix.Translation(Vector(ctr)) @ Matrix.Rotation(math.radians(rz), 4, "Z") @ Matrix.Rotation(math.radians(ry), 4, "Y") @ Matrix.Rotation(math.radians(rx), 4, "X")
        vs = [m @ v for v in vs]
        faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        return self._add(vs, faces, color, glow, wear, amt)

    def cyl(self, ctr, r, h, color, segs=10, r2=None, rz=0.0, rx=0.0, ry=0.0, glow=False, wear=True, cap=True):
        """Cylinder (frustum with r2) standing on ctr (base centre)."""
        r2 = r if r2 is None else r2
        vs = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            vs.append(Vector((math.cos(a) * r, math.sin(a) * r, 0)))
        for i in range(segs):
            a = 2 * math.pi * i / segs
            vs.append(Vector((math.cos(a) * r2, math.sin(a) * r2, h)))
        m = Matrix.Translation(Vector(ctr)) @ Matrix.Rotation(math.radians(rz), 4, "Z") @ Matrix.Rotation(math.radians(ry), 4, "Y") @ Matrix.Rotation(math.radians(rx), 4, "X")
        vs = [m @ v for v in vs]
        faces = [(i, (i + 1) % segs, segs + (i + 1) % segs, segs + i) for i in range(segs)]
        if cap:
            faces.append(tuple(range(segs - 1, -1, -1)))
            faces.append(tuple(range(segs, 2 * segs)))
        return self._add(vs, faces, color, glow, wear)

    def limb(self, a, b, r1, r2, color, segs=7, wear=True):
        """Tapered cylinder from point a to point b (branches, roots, struts)."""
        a, b = Vector(a), Vector(b)
        d = b - a
        L = d.length
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        vs = []
        for rr, z in ((r1, 0.0), (r2, L)):
            for i in range(segs):
                ang = 2 * math.pi * i / segs
                vs.append(Vector((math.cos(ang) * rr, math.sin(ang) * rr, z)))
        m = Matrix.Translation(a) @ q.to_matrix().to_4x4()
        vs = [m @ v for v in vs]
        faces = [(i, (i + 1) % segs, segs + (i + 1) % segs, segs + i) for i in range(segs)]
        faces.append(tuple(range(segs - 1, -1, -1)))
        faces.append(tuple(range(segs, 2 * segs)))
        return self._add(vs, faces, color, False, wear)

    def rock(self, ctr, size, color, sub=1, rough=0.28, rz=0.0, seed=0, flat_bottom=True, glow=False):
        """A boulder: an icosphere displaced by noise, scaled to `size` (sx, sy, sz)."""
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=sub, radius=1.0)
        off = Vector((seed * 3.1, seed * 1.7, seed * 2.3))
        for v in tmp.verts:
            n = noise.noise(v.co * 1.3 + off)
            v.co *= 1.0 + rough * n
            if flat_bottom and v.co.z < -0.55:
                v.co.z = -0.55
        m = Matrix.Translation(Vector(ctr)) @ Matrix.Rotation(math.radians(rz), 4, "Z") @ Matrix.Diagonal(Vector((size[0] / 2, size[1] / 2, size[2] / 2, 1.0)))
        verts = [m @ v.co for v in tmp.verts]
        idx = {v: i for i, v in enumerate(tmp.verts)}
        faces = [tuple(idx[v] for v in f.verts) for f in tmp.faces]
        tmp.free()
        return self._add(verts, faces, color, glow, True, 0.12)

    def stone_wall(self, p0, p1, h, thick, color, top=None, course=0.55, block=1.1, base=-1.0, color2=None):
        """A masonry wall from p0 to p1 (x, y): courses of jittered blocks; `top(t)` gives the broken
        height along it (0..1), else flat at h. Blocks hang down to `base` under the ground."""
        p0, p1 = Vector((p0[0], p0[1], 0)), Vector((p1[0], p1[1], 0))
        d = p1 - p0
        L = d.length
        ang = math.degrees(math.atan2(d.y, d.x))
        u = d.normalized()
        rows = max(1, int(math.ceil((h - base) / course)))
        for r in range(rows):
            z0 = base + r * course
            off = (r % 2) * block * 0.5
            x = -off
            while x < L:
                bw = block * (0.75 + 0.5 * self.rng.random())
                xa, xb = max(0.0, x), min(L, x + bw)
                x += bw
                if xb - xa < 0.15:
                    continue
                tm = (xa + xb) / 2 / L
                hh = top(tm) if top else h
                if z0 >= hh:
                    continue
                zt = min(z0 + course, hh)
                c = p0 + u * ((xa + xb) / 2)
                inset = (self.rng.random() - 0.5) * 0.08
                nrm = Vector((-u.y, u.x, 0))
                c = c + nrm * inset
                col = color2 if (color2 and self.rng.random() < 0.25) else color
                self.box((c.x, c.y, (z0 + zt) / 2), (xb - xa - 0.04, thick * (0.94 + 0.08 * self.rng.random()), zt - z0 - 0.03), col, rz=ang + (self.rng.random() - 0.5) * 1.5)

    def chest_at(self, x, y, rz=0.0, pal=("chest_wood", "chest_band")):
        """The site's loot chest (closed; the loot pile lands on it when the guardian falls)."""
        w, dpt, h = 1.1, 0.7, 0.55
        m = Matrix.Rotation(math.radians(rz), 4, "Z")
        def P(px, py, pz):
            v = m @ Vector((px, py, pz))
            return (x + v.x, y + v.y, v.z)
        self.box(P(0, 0, h / 2), (w, dpt, h), pal[0], rz=rz, wear=False)
        self.box(P(0, 0, h + 0.12), (w, dpt * 0.9, 0.24), pal[0], rz=rz, wear=False, taper=0.85)
        for bx in (-0.38, 0.38):
            self.box(P(bx, 0, h / 2 + 0.06), (0.08, dpt + 0.03, h + 0.14), pal[1], rz=rz, wear=False)
        self.box(P(0, -dpt / 2 - 0.02, h - 0.02), (0.16, 0.05, 0.2), pal[1], rz=rz, wear=False)
        self.chest = [round(x, 3), round(-y, 3)]

    # Colliders and spots ------------------------------------------------------------------
    def sbox(self, x, y, hx, hy, y0, y1, rz=0.0):
        """Box solid in Blender coordinates (centre x, y; half sizes along its own x, y; rz degrees)."""
        self.solids.append([0, round(x, 3), round(-y, 3), round(hx, 3), round(hy, 3), round(y0, 3), round(y1, 3), round(rz, 2)])

    def scyl(self, x, y, r, y0, y1):
        self.solids.append([1, round(x, 3), round(-y, 3), round(r, 3), round(r, 3), round(y0, 3), round(y1, 3), 0])

    def guard(self, x, y):
        self.guards.append([round(x, 3), round(-y, 3)])

# ------------------------------------------------------------------------------------------ shared parts
def wrap_stairs(k, half, top, width, step_col, gap, rise=0.3, tread=0.45, solid_base=-2.0):
    """Steps climbing round a square core (half size `half`) from the ground to `top`: along the south
    face going east, a landing at the SE corner, up the east face going north, the NE landing, then
    westward along the north face. Once a step is one rise below the top the rest stay at that height:
    a walkway along the north face that runs past the deck rail's gap (`gap` = (x0, x1) on the north
    face, west end first), where the player steps south onto the core (review 2026-11-13, finding 1:
    the old last tread met the rail or a corner post). Each step is a box down to the ground and its
    own collider; the walkway is one."""
    run = int(round(2 * half / tread))
    t = 2 * half / run
    c = half + width / 2
    head = top - rise
    slots = [(-half + t * (i + 0.5), -c, t, width) for i in range(run)]  # south face, west -> east
    slots.append((c, -c, width, width))  # SE landing
    slots += [(c, -half + t * (j + 0.5), width, t) for j in range(run)]  # east face, south -> north
    slots.append((c, c, width, width))  # NE landing
    slots += [(half - t * (i + 0.5), c, t, width) for i in range(run)]  # north face, east -> west
    steps = []
    z = 0.0
    for (x, y, sx, sy) in slots:
        z = min(z + rise, head)
        steps.append((x, y, sx, sy, z))
        # Done once the walkway at the head height reaches past the gap's west end.
        if z >= head - 1e-6 and y == c and sx < sy and x - sx / 2 <= gap[0] + 1e-6:
            break
    assert steps[-1][4] >= head - 1e-6 and steps[-1][1] == c, "stair does not reach the deck"
    # The walkway (the north-face run at the head height) is one slab: one box, one collider.
    n = len(steps)
    while n > 0 and steps[n - 1][1] == c and steps[n - 1][4] >= head - 1e-6:
        n -= 1
    walk = steps[n:]
    if len(walk) > 1:
        x0 = min(x - sx / 2 for (x, _, sx, _, _) in walk)
        x1 = max(x + sx / 2 for (x, _, sx, _, _) in walk)
        steps = steps[:n] + [((x0 + x1) / 2, c, x1 - x0, width, head)]
    for (x, y, sx, sy, zt) in steps:
        k.box((x, y, (zt + solid_base) / 2), (sx - 0.02, sy - 0.02, zt - solid_base), step_col)
        k.sbox(x, y, sx / 2, sy / 2, solid_base, zt)
    return steps

# ------------------------------------------------------------------------------------------ Arcadia
def a_watchtower():
    """Bellwether Watch: a limestone watchtower you climb by its wrap-round stair, a timber lookout
    with a terracotta roof and a brass bell on top."""
    k = Kit("a_watchtower", 101, wear=("moss", 0.55, 0.45))
    half, top = 1.8, 6.0
    # Core in courses, a darker plinth band and a sealed arched door on the west face.
    for side in range(4):
        a = side * 90
        m = Matrix.Rotation(math.radians(a), 3, "Z")
        p0 = m @ Vector((-half, -half, 0)); p1 = m @ Vector((half, -half, 0))
        k.stone_wall((p0.x, p0.y), (p1.x, p1.y), top, 0.5, "lime", course=0.5, block=0.9, base=-2.0, color2="lime_dk")
    k.box((0, 0, (top - 2.0) / 2 - 1.0), (2 * half - 0.4, 2 * half - 0.4, top + 2.0 - 0.1), "lime_dk", wear=False)
    k.box((-half - 0.05, 0, 1.2), (0.12, 1.2, 2.2), "oak_dk", wear=False)
    k.cyl((-half - 0.05, 0, 2.3), 0.6, 0.12, "lime_dk", segs=10, ry=90)
    k.sbox(0, 0, half, half, -2.0, top)
    gap = (-0.2, 1.1)  # clear of the NE corner post: 1.3 m for a 0.76 m body
    wrap_stairs(k, half, top, 1.1, "lime_dk", gap)
    # Lookout deck: plank floor overhang, parapet rails with a gap at the stair head (north face).
    k.box((0, 0, top + 0.06), (2 * half + 0.5, 2 * half + 0.5, 0.14), "oak", wear=False)
    rail_h = 1.0
    for (x0, y0, x1, y1) in ((-half, -half, half, -half), (half, -half, half, half), (-half, half, gap[0], half), (gap[1], half, half, half), (-half, -half, -half, half)):
        L = math.hypot(x1 - x0, y1 - y0)
        ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        k.box((cx, cy, top + rail_h), (L, 0.1, 0.1), "oak", rz=ang)
        k.box((cx, cy, top + 0.5), (L, 0.06, 0.06), "oak", rz=ang)
        nposts = max(2, int(L / 0.9) + 1)
        for i in range(nposts):
            t = i / (nposts - 1)
            k.box((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, top + rail_h / 2), (0.1, 0.1, rail_h), "oak_dk")
        dx, dy = (y1 - y0) / L, -(x1 - x0) / L
        k.sbox(cx, cy, L / 2, 0.1, top, top + rail_h, ang)
    # Roof on four corner posts; a bell under it; a red pennant.
    ph = 2.6
    for sx in (-1, 1):
        for sy in (-1, 1):
            k.box((sx * (half - 0.1), sy * (half - 0.1), top + ph / 2), (0.22, 0.22, ph), "oak_dk")
            k.scyl(sx * (half - 0.1), sy * (half - 0.1), 0.14, top, top + ph)
    k.box((0, 0, top + ph + 0.1), (2 * half + 0.3, 2 * half + 0.3, 0.2), "oak")
    k.box((0, 0, top + ph + 1.0), (2 * half + 1.2, 2 * half + 1.2, 1.6), "terra", taper=0.08)
    for i in range(4):  # roof ridges
        a = math.radians(45 + i * 90)
        k.limb((math.cos(a) * (half + 0.85), math.sin(a) * (half + 0.85), top + ph + 0.22), (0, 0, top + ph + 1.85), 0.07, 0.05, "oak_dk", segs=5)
    k.cyl((0, 0, top + ph + 1.75), 0.08, 1.4, "oak_dk", segs=6)
    k.box((0.42, 0, top + ph + 2.85), (0.8, 0.03, 0.45), "cloth_red", wear=False, taper=1.0)
    k.cyl((0, 0, top + ph - 0.95), 0.32, 0.75, "brass", segs=12, r2=0.14, wear=False)
    k.box((0, 0, top + ph - 0.15), (0.08, 0.08, 0.3), "iron", wear=False)
    # Foot of the tower: hay, crates, a lantern post with a teal glass (Brightbit light) and the chest.
    k.cyl((-3.6, -2.6, 0), 0.8, 1.0, "grass", segs=9, r2=0.65)
    for i, (x, y, s) in enumerate(((3.6, 1.4, 0.7), (3.9, 2.3, 0.55), (-3.0, 2.6, 0.6))):
        k.box((x, y, s / 2), (s, s, s), "oak", rz=17 * i)
        k.sbox(x, y, s / 2, s / 2, -0.5, s, 17 * i)
    k.cyl((-3.2, -0.6, 0), 0.08, 2.4, "oak_dk", segs=6)
    k.box((-3.2, -0.6, 2.5), (0.3, 0.3, 0.35), "teal", glow=True)
    k.chest_at(-3.0, 1.2, rz=90)
    k.rock((4.2, -3.4, 0.2), (1.6, 1.3, 0.9), "rock_a", seed=3)
    k.scyl(4.2, -3.4, 0.7, -0.5, 0.6)
    for (x, y) in ((-5.5, -4.0), (5.0, 4.5), (-5.0, 4.5), (6.0, -1.0)):
        k.guard(x, y)
    k.lookout = [0.0, 0.0, top]
    return k

def a_ruin():
    """Emberfall Keep: a roofless limestone keep with broken walls, an arched gate, a fallen corner
    tower and toppled columns in its court."""
    k = Kit("a_ruin", 202, wear=("moss", 0.45, 0.6))
    W, D, H, T = 7.0, 6.0, 4.6, 0.9
    rng = k.rng
    def broken(seed, lo, hi):
        return lambda t: lo + (hi - lo) * (0.5 + 0.5 * noise.noise(Vector((t * 3.3 + seed, seed * 0.7, 0.3))))
    # Walls: front (south) with a 3 m gate, back with a breach, east and west.
    walls = [
        ((-W, -D), (-2.05, -D), broken(1, 2.2, H)),
        ((2.05, -D), (W, -D), broken(2, 1.2, H)),
        ((-W, D), (-1.0, D), broken(3, 1.8, H + 0.6)),
        ((2.4, D), (W, D), broken(4, 0.8, 3.0)),
        ((W, -D), (W, D), broken(5, 1.0, H)),
        ((-W, -D), (-W, D), broken(6, 2.6, H + 0.8)),
    ]
    for (p0, p1, top) in walls:
        k.stone_wall(p0, p1, H, T, "lime", top=top, course=0.55, block=1.2, base=-1.2, color2="lime_dk")
        L = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        ang = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))
        k.sbox((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, L / 2 + T / 2, T / 2, -1.2, max(top(t) for t in (0.1, 0.5, 0.9)), ang)
    # Gate: two jambs and a surviving arch of voussoirs.
    for sx in (-1, 1):
        k.box((sx * 1.85, -D, 1.6), (0.7, T + 0.25, 3.2), "lime_dk")
    for i in range(9):
        a = math.pi * i / 8
        k.box((math.cos(a) * 1.75, -D, 3.2 + math.sin(a) * 1.3), (0.5, T + 0.2, 0.42), "lime", ry=-math.degrees(a) + 90)
    # Breach rubble behind (back wall gap from -1.0 to 2.4).
    for i in range(7):
        k.rock((-0.6 + rng.random() * 3.0, D + (rng.random() - 0.3) * 1.6, 0.1), (0.7 + rng.random() * 0.8, 0.6 + rng.random() * 0.6, 0.5 + rng.random() * 0.5), "lime_dk", sub=1, seed=i + 10)
    # Fallen corner tower (NW): a broken drum and its tumbled courses.
    k.cyl((-W, D, -1.0), 2.2, 7.5, "lime", segs=12, r2=2.0)
    for i in range(10):
        a = rng.random() * 2 * math.pi
        k.box((-W + math.cos(a) * 2.0, D + math.sin(a) * 2.0, 6.6 + rng.random() * 0.4), (1.0, 0.6, 0.5), "lime_dk", rz=math.degrees(a))
    k.scyl(-W, D, 2.2, -1.0, 6.5)
    for i in range(5):
        k.box((-W - 3.2 - i * 0.9, D + 1.5 + rng.random(), 0.25), (0.9, 0.7, 0.5), "lime", rz=rng.random() * 60)
    # Court: two toppled columns, a standing stump, scattered flagstones, a cold brazier.
    for (x, y, rz) in ((-2.5, 1.5, 20), (2.8, -1.8, -35)):
        k.cyl((x, y, 0.45), 0.45, 4.2, "lime", segs=10, rz=rz, ry=90)
        k.sbox(x + math.cos(math.radians(rz)) * 2.1, y + math.sin(math.radians(rz)) * 2.1, 2.1, 0.45, -0.5, 0.9, rz)
    k.cyl((3.8, 3.2, 0), 0.5, 1.6, "lime", segs=10)
    k.scyl(3.8, 3.2, 0.5, -0.5, 1.6)
    for i in range(18):
        x, y = (rng.random() - 0.5) * 2 * (W - 1.5), (rng.random() - 0.5) * 2 * (D - 1.5)
        k.box((x, y, 0.02), (0.9 + rng.random() * 0.4, 0.7 + rng.random() * 0.4, 0.14), "lime_dk", rz=rng.random() * 20)
    k.cyl((-2.6, -2.4, 0), 0.6, 0.9, "iron", segs=8, r2=0.75, wear=False)
    k.box((-2.6, -2.4, 0.95), (0.6, 0.6, 0.12), "teal", glow=True)
    k.scyl(-2.6, -2.4, 0.7, -0.5, 1.0)
    # Ivy sheets on the inner walls (cards of moss colour).
    for (x, y, rz) in ((-W + 0.48, -2.0, 90), (W - 0.48, 1.5, 90), (-3.5, D - 0.48, 0)):
        k.box((x, y, 1.8), (2.4, 0.04, 2.6), "moss", rz=rz, wear=False, amt=0.2)
    k.chest_at(-4.6, 3.6, rz=0)
    for (x, y) in ((1.5, 4.0), (0.0, -2.5), (2.8, 0.6), (5.2, 0.8), (-4.0, -0.6), (0.0, -9.5)):
        k.guard(x, y)
    k.lookout = [-W, D, 6.5]
    return k

def a_arch():
    """Skyhook Arch: a landmark rock arch 24 m high, grassed along its crown, with a teal crystal
    seam at its foot where the Brightbits nest."""
    k = Kit("a_arch", 303, wear=("grass", 0.35, 0.85))
    rng = k.rng
    span, rise = 13.0, 21.0
    pts = []
    N = 26
    for i in range(N + 1):
        t = i / N
        a = math.pi * t
        x = -math.cos(a) * span
        z = math.sin(a) ** 0.7 * rise
        pts.append((x, z, t))
    for i, (x, z, t) in enumerate(pts):
        thick = 7.0 - 2.6 * math.sin(math.pi * t)
        k.rock((x + (rng.random() - 0.5) * 0.6, (rng.random() - 0.5) * 0.8, z), (thick * 1.3, thick * 1.1, thick * 1.1), "rock_a" if i % 3 else "rock_a_dk", sub=2, rough=0.3, seed=i, flat_bottom=False, rz=rng.random() * 180)
        if i % 2 == 0:  # a second, offset course: strata and width
            k.rock((x + (rng.random() - 0.5) * 1.2, (rng.random() - 0.5) * 2.4, z - thick * 0.25), (thick * 1.0, thick * 0.9, thick * 0.7), "rock_a_dk", sub=1, rough=0.3, seed=i + 200, flat_bottom=False, rz=rng.random() * 180)
    # Legs flare into the ground; scree around them.
    for sx in (-1, 1):
        k.rock((sx * span, 0, -0.5), (9.0, 7.5, 6.0), "rock_a_dk", sub=2, rough=0.3, seed=40 + sx)
        k.scyl(sx * span, 0, 3.6, -3.0, 9.0)
        for i in range(6):
            a = rng.random() * 2 * math.pi
            r = 5.0 + rng.random() * 3.0
            s = 0.8 + rng.random() * 1.4
            x, y = sx * span + math.cos(a) * r, math.sin(a) * r
            if abs(x) < 3.5:
                continue
            k.rock((x, y, s * 0.2), (s * 1.3, s, s * 0.8), "rock_a", seed=50 + i + sx * 7)
            if s > 1.4:
                k.scyl(x, y, s * 0.55, -0.5, s * 0.6)
    # Crystal seam at the east foot (glow) and a grass tuft cap along the crown.
    for i in range(7):
        a = rng.random() * 2 * math.pi
        x, y = span - 4.2 + math.cos(a) * 1.0, -2.6 + math.sin(a) * 1.0
        k.cyl((x, y, -0.1), 0.18 + rng.random() * 0.12, 1.0 + rng.random() * 1.4, "teal", segs=6, r2=0.02, rx=(rng.random() - 0.5) * 40, ry=(rng.random() - 0.5) * 40, glow=True)
    for i in range(10):
        t = 0.3 + 0.4 * i / 9
        x = -math.cos(math.pi * t) * span
        z = math.sin(math.pi * t) ** 0.7 * rise + 2.0
        k.cyl((x, (rng.random() - 0.5) * 1.5, z), 0.5, 0.7, "grass", segs=6, r2=0.05)
    k.chest_at(1.5, -1.0, rz=-15)
    for (x, y) in ((0, 3.0), (-4.0, -3.0), (4.5, -4.0), (0, -6.5), (-3.0, 7.5), (3.5, 7.5)):
        k.guard(x, y)
    k.lookout = [0.0, 0.0, rise]
    return k

# ------------------------------------------------------------------------------------------ Hollowmere
def h_shrine():
    """The Lantern Shrine: a ring of leaning slate stones round a stepped altar and an obelisk that
    carries a caged fen-lantern."""
    k = Kit("h_shrine", 404, wear=("lichen", 0.4, 0.55))
    rng = k.rng
    R = 7.0
    for i in range(7):
        a = 2 * math.pi * i / 7 + 0.2
        if i == 0:
            continue  # the way in, south
        x, y = math.cos(a - math.pi / 2) * R, math.sin(a - math.pi / 2) * R
        h = 2.6 + rng.random() * 1.6
        lean = (rng.random() - 0.5) * 14
        k.box((x, y, h / 2 - 0.4), (1.1, 0.6, h + 0.8), "slate" if i % 2 else "slate_lt", rz=math.degrees(a), rx=lean, taper=0.75)
        k.scyl(x, y, 0.62, -0.6, h)
        if i % 2:
            k.box((x, y, h + 0.05), (1.0, 0.5, 0.18), "lichen", rz=math.degrees(a), wear=False)
    # Altar: two steps up to a slab; the obelisk rises behind it with the lantern cage.
    k.box((0, 0.5, 0.0), (4.6, 4.0, 0.6), "slate_lt")
    k.box((0, 0.8, 0.45), (3.4, 2.8, 0.3), "slate")
    k.sbox(0, 0.5, 2.3, 2.0, -0.6, 0.3)
    k.sbox(0, 0.8, 1.7, 1.4, -0.6, 0.6)
    k.box((0, 1.4, 0.95), (1.6, 0.9, 0.7), "slate")
    k.sbox(0, 1.4, 0.8, 0.45, 0.6, 1.3)
    k.box((0, 1.9, 2.8), (0.9, 0.9, 4.6), "slate", taper=0.55)
    k.sbox(0, 1.9, 0.45, 0.45, 0.6, 5.1)
    for z in (5.25, 6.35):
        k.box((0, 1.9, z), (0.9, 0.9, 0.08), "iron", wear=False)
    for sx in (-1, 1):
        for sy in (-1, 1):
            k.box((sx * 0.42, 1.9 + sy * 0.42, 5.8), (0.06, 0.06, 1.15), "iron", wear=False)
    k.box((0, 1.9, 5.8), (0.55, 0.55, 0.9), "fen", glow=True)
    k.box((0, 1.9, 6.6), (0.4, 0.4, 0.5), "iron", taper=0.2, wear=False)
    # Bones and skulls laid as offerings; candles; dead reeds.
    for i in range(12):
        a = rng.random() * 2 * math.pi
        r = 1.2 + rng.random() * 1.4
        k.limb((math.cos(a) * r, 0.5 + math.sin(a) * r, 0.65), (math.cos(a) * r + 0.4, 0.5 + math.sin(a) * r + 0.2, 0.68), 0.05, 0.04, "bone", segs=5, wear=False)
    for (x, y) in ((-1.2, 0.0), (1.1, 0.2), (0.6, -0.3)):
        k.rock((x, y, 0.75), (0.32, 0.36, 0.3), "bone", sub=1, rough=0.15, seed=int(x * 10))
    for (x, y) in ((-1.4, 1.6), (1.4, 1.6), (-0.9, -0.6), (0.9, -0.6)):
        k.cyl((x, y, 0.6), 0.06, 0.25, "bone", segs=6, wear=False)
        k.box((x, y, 0.9), (0.06, 0.06, 0.1), "fen", glow=True)
    for i in range(14):
        a = rng.random() * 2 * math.pi
        r = R + 1.5 + rng.random() * 2.5
        k.limb((math.cos(a) * r, math.sin(a) * r, 0), (math.cos(a) * r + (rng.random() - 0.5), math.sin(a) * r + (rng.random() - 0.5), 1.2 + rng.random()), 0.04, 0.01, "moss_dk", segs=4, wear=False)
    k.chest_at(-3.5, 2.7, rz=20, pal=("blackoak", "iron"))
    for (x, y) in ((0, -3.5), (-4.0, 0.0), (4.0, 0.5), (0, -10.0), (-1.5, 4.8)):
        k.guard(x, y)
    k.lookout = [0.0, 0.8, 0.6]
    return k

def h_cave():
    """The Sunken Barrow: a cave mouth into a rock mound, its entrance shored with black oak and
    hung with fen-lanterns; a low chamber inside with glowing caps and the barrow chest at the back."""
    k = Kit("h_cave", 505, wear=("moss_dk", 0.35, 0.7))
    rng = k.rng
    Ri, Ro, Hc = 5.6, 8.8, 4.0
    gap = 1.75  # half width of the mouth (south, -Y)
    segs = 10
    for i in range(segs):
        a0 = 2 * math.pi * i / segs - math.pi / 2 + math.pi / segs
        a1 = a0 + 2 * math.pi / segs
        am = (a0 + a1) / 2
        # Skip the segment(s) over the mouth.
        if abs(math.atan2(math.sin(am + math.pi / 2), math.cos(am + math.pi / 2))) < 0.45:
            continue
        rm = (Ri + Ro) / 2
        x, y = math.cos(am) * rm, math.sin(am) * rm
        chord = 2 * Ro * math.sin(math.pi / segs) + 0.4
        k.rock((x, y, 0.8), (Ro - Ri + 1.0, chord, 6.5 + rng.random()), "slate" if i % 2 else "slate_lt", sub=2, rough=0.25, rz=math.degrees(am), seed=i, flat_bottom=True)
        k.sbox(x, y, (Ro - Ri) / 2, chord / 2 - 0.05, -2.0, Hc + 0.4, math.degrees(am))
    # Mouth cheeks: two rock buttresses either side of the 3.5 m opening, reaching out as a short tunnel.
    for sx in (-1, 1):
        x = sx * (gap + 1.3)
        k.rock((x, -Ri - 0.8, 0.8), (2.6, 4.4, 6.0), "slate_lt", sub=2, rough=0.25, seed=30 + sx)
        k.sbox(x, -Ri - 0.8, 1.3, 2.2, -2.0, Hc + 0.4)
    # Roof slabs (walk under) and the mound over everything.
    k.sbox(0, 0, Ro - 0.6, Ro - 0.6, Hc, Hc + 3.5)
    k.sbox(0, -Ri - 0.8, gap + 2.6, 2.2, Hc - 0.5, Hc + 3.0)
    k.rock((0, 0.3, Hc - 0.2), (2 * Ro - 0.4, 2 * Ro - 0.8, 8.5), "slate", sub=3, rough=0.22, seed=60, flat_bottom=True)
    k.rock((0, -Ri - 0.9, Hc + 0.2), (2 * gap + 5.5, 4.6, 2.2), "slate_lt", sub=2, rough=0.2, seed=61, flat_bottom=True)
    for i in range(8):
        a = rng.random() * 2 * math.pi
        k.rock((math.cos(a) * 5.0, math.sin(a) * 5.0 + 0.3, Hc + 3.2 + rng.random()), (2.5, 2.5, 1.6), "moss_dk", sub=1, seed=70 + i)
    # Shoring: two black-oak posts and a lintel at the mouth; lanterns either side.
    for sx in (-1, 1):
        k.box((sx * (gap - 0.05), -Ri - 2.6, 1.7), (0.3, 0.3, 3.4), "blackoak")
        k.cyl((sx * (gap + 0.4), -Ri - 3.1, 2.6), 0.05, 0.6, "iron", segs=5, wear=False)
        k.box((sx * (gap + 0.4), -Ri - 3.1, 2.4), (0.26, 0.26, 0.34), "fen", glow=True)
    k.box((0, -Ri - 2.6, 3.45), (2 * gap + 0.6, 0.34, 0.3), "blackoak")
    k.box((0, -Ri - 1.0, 3.5), (2 * gap, 0.3, 0.26), "blackoak")
    # Inside: a floor of dark silt patches, bones, glowing fen-caps, the chest against the back wall.
    for i in range(10):
        a = rng.random() * 2 * math.pi
        r = rng.random() * (Ri - 1.2)
        k.box((math.cos(a) * r, math.sin(a) * r, 0.01), (1.2, 1.0, 0.06), "bark_dk", rz=rng.random() * 90, wear=False)
    for i in range(9):
        a = 2 * math.pi * rng.random()
        r = Ri - 0.7
        x, y = math.cos(a) * r, math.sin(a) * r
        if y < -Ri + 1.6:
            continue
        k.cyl((x, y, 0), 0.05, 0.3, "bone", segs=5, wear=False)
        k.cyl((x, y, 0.28), 0.22, 0.12, "fen", segs=7, r2=0.05, glow=True)
    for i in range(8):
        a = rng.random() * 2 * math.pi
        r = 1.5 + rng.random() * 2.5
        k.limb((math.cos(a) * r, math.sin(a) * r, 0.05), (math.cos(a) * r + 0.5, math.sin(a) * r + 0.1, 0.08), 0.05, 0.04, "bone", segs=5, wear=False)
    k.rock((1.5, 2.0, 0.15), (0.35, 0.4, 0.32), "bone", rough=0.12, seed=88)
    k.chest_at(0, Ri - 1.3, rz=0, pal=("blackoak", "iron"))
    for (x, y) in ((0, 0.5), (-2.5, 1.5), (2.5, -1.0), (-3.5, -11.0), (3.5, -11.5)):
        k.guard(x, y)
    k.lookout = [0.0, 0.0, Hc + 3.0]
    return k

def h_tree():
    """The Hollow Elm: a dead giant 30 m tall on root buttresses, a hollow at its foot, cages and
    fen-lanterns hanging from its limbs. Seen from across the fen."""
    k = Kit("h_tree", 606, wear=("lichen", 0.5, 0.35))
    rng = k.rng
    # Trunk: stacked frusta with a slow twist and lean.
    z, r = -2.0, 3.4
    x = y = 0.0
    pts = []
    for i in range(9):
        h = 3.4
        r2 = r * 0.86
        k.cyl((x, y, z), r, h + 0.2, "bark" if i % 2 else "bark_dk", segs=11, r2=r2, rz=i * 13)
        pts.append((x, y, z + h, r2))
        z += h
        x += 0.25 * math.sin(i * 0.7)
        y += 0.2 * math.cos(i * 0.5)
        r = r2
    k.scyl(0, 0, 3.0, -2.0, 10.0)
    # Hollow at the foot (a dark recess on the front).
    k.box((0, -2.75, 1.4), (1.6, 0.8, 2.8), "bark_dk", wear=False, taper=0.6, amt=0.0)
    k.box((0, -3.0, 1.2), (1.2, 0.3, 2.3), (0.04, 0.03, 0.03), wear=False, taper=0.55, amt=0.0)
    # Root buttresses.
    for i in range(7):
        a = 2 * math.pi * i / 7 + 0.3
        ca, sa = math.cos(a), math.sin(a)
        k.limb((ca * 2.2, sa * 2.2, 3.0), (ca * 7.0, sa * 7.0, -0.8), 1.1, 0.35, "bark_dk", segs=7)
        k.sbox(ca * 4.5, sa * 4.5, 2.3, 0.55, -1.0, 1.4, math.degrees(a))
    # Limbs: main boughs with forks, bare and gnarled.
    def bough(p, d, L, r, depth):
        if depth == 0 or r < 0.08:
            return
        e = p + d * L
        k.limb(p, e, r, r * 0.62, "bark" if depth % 2 else "bark_dk", segs=6 if r > 0.3 else 5)
        for j in range(2 if depth > 1 else 3):
            nd = (d + Vector(((rng.random() - 0.5) * 1.1, (rng.random() - 0.5) * 1.1, 0.25 + rng.random() * 0.35))).normalized()
            bough(e, nd, L * (0.62 + rng.random() * 0.15), r * 0.6, depth - 1)
    for i, (px, py, pz, pr) in enumerate(pts[3:]):
        for j in range(2):
            a = rng.random() * 2 * math.pi
            d = Vector((math.cos(a), math.sin(a), 0.35 + rng.random() * 0.5)).normalized()
            bough(Vector((px, py, pz - 1.0)), d, 4.5 + rng.random() * 2.5, pr * 0.45, 3)
    # Hanging cages and lanterns.
    for (x, y, zt) in ((5.5, 1.5, 15.0), (-5.0, -2.5, 17.5), (2.0, -5.5, 13.5)):
        k.limb((x, y, zt), (x, y, zt - 2.2), 0.03, 0.03, "iron", segs=4, wear=False)
        k.cyl((x, y, zt - 3.4), 0.45, 1.2, "iron", segs=8, wear=False, cap=True)
        k.box((x, y, zt - 2.9), (0.3, 0.3, 0.35), "fen", glow=True)
    for (x, y) in ((-1.0, -3.3), (1.1, -3.3)):
        k.box((x, y, 2.5), (0.2, 0.2, 0.28), "fen", glow=True)
    # Ground: fallen limbs, skull cairns.
    for i in range(5):
        a = rng.random() * 2 * math.pi
        r = 8.0 + rng.random() * 4
        x, y = math.cos(a) * r, math.sin(a) * r
        k.limb((x, y, 0.2), (x + math.cos(a + 1.3) * 3.5, y + math.sin(a + 1.3) * 3.5, 0.3), 0.35, 0.2, "bark", segs=6)
        k.sbox(x + math.cos(a + 1.3) * 1.75, y + math.sin(a + 1.3) * 1.75, 1.75, 0.3, -0.3, 0.6, math.degrees(a + 1.3))
    for (x, y) in ((-3.5, -6.0), (4.0, -5.5)):
        for j in range(5):
            k.rock((x + (j % 2) * 0.3, y + (j // 2) * 0.25, 0.2 + j * 0.18), (0.35, 0.4, 0.33), "bone", rough=0.12, seed=j + int(x))
    k.chest_at(1.8, -4.4, rz=0, pal=("blackoak", "iron"))
    for (x, y) in ((-6.0, -7.0), (6.0, -7.5), (0.0, -9.5), (-9.0, 2.0), (9.0, 1.0)):
        k.guard(x, y)
    k.lookout = [0.0, 0.0, 30.0]
    return k

# ------------------------------------------------------------------------------------------ Meridian
def m_relay():
    """Relay Mast 4: a poured-concrete block you climb by its steel stair, crowned by a lattice mast
    with an amber beacon, a dish and solar wings."""
    k = Kit("m_relay", 707, wear=None)
    half, top = 2.0, 6.0
    rng = k.rng
    # Concrete core with pour lines, hazard band at the foot and a sealed blast door.
    k.box((0, 0, (top - 2.0) / 2), (2 * half, 2 * half, top + 2.0), "concrete")
    for z in (1.5, 3.0, 4.5):
        k.box((0, 0, z), (2 * half + 0.04, 2 * half + 0.04, 0.06), "concrete_dk", wear=False)
    for i in range(10):
        x = -half + 0.2 + i * 0.4
        k.box((x, -half - 0.02, 0.25), (0.2, 0.04, 0.5), "hazard" if i % 2 else "steel_dk", wear=False, rz=0)
    k.box((-half - 0.04, 0, 1.2), (0.1, 1.4, 2.4), "steel_dk", wear=False)
    k.box((-half - 0.08, 0, 2.55), (0.12, 1.6, 0.18), "hazard", wear=False)
    k.sbox(0, 0, half, half, -2.0, top)
    gap = (-1.25, 0.45)  # between the mast's north legs (x 0.8 and -1.6, 0.4 m in from the rail)
    steps = wrap_stairs(k, half, top, 1.1, "steel_dk", gap)
    # Stair rails (steel) along the outer edge.
    for (x, y, sx, sy, zt) in steps:
        k.box((x + (0.53 if sx < sy else 0), y - (0.53 if sx >= sy else 0), zt + 0.5), (0.05, 0.05, 1.0), "steel", wear=False)
    # Deck rails with a gap at the stair head (north face), like the watchtower.
    for (x0, y0, x1, y1) in ((-half, -half, half, -half), (half, -half, half, half), (-half, half, gap[0], half), (gap[1], half, half, half), (-half, -half, -half, half)):
        L = math.hypot(x1 - x0, y1 - y0)
        ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        k.box((cx, cy, top + 1.0), (L, 0.06, 0.06), "hazard", rz=ang, wear=False)
        for i in range(max(2, int(L / 1.0) + 1)):
            t = i / max(1, int(L / 1.0))
            k.box((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, top + 0.5), (0.06, 0.06, 1.0), "steel", wear=False)
        k.sbox(cx, cy, L / 2, 0.08, top, top + 1.0, ang)
    # Lattice mast: four legs tapering to 19 m with cross braces.
    base_h, mast_h = top, 13.0
    def leg(t, sx, sy):
        w = 1.2 * (1 - t) + 0.35 * t
        return Vector((sx * w - 0.4, sy * w + 0.4, base_h + mast_h * t))
    for sx in (-1, 1):
        for sy in (-1, 1):
            k.limb(leg(0, sx, sy), leg(1, sx, sy), 0.07, 0.05, "steel", segs=5, wear=False)
            b = leg(0, sx, sy)
            k.scyl(b.x, b.y, 0.12, top, top + 2.0)  # the legs block on the deck, not only the core
    for i in range(7):
        t0, t1 = i / 7, (i + 1) / 7
        for (ax, ay, bx, by) in ((-1, -1, 1, -1), (1, -1, 1, 1), (1, 1, -1, 1), (-1, 1, -1, -1)):
            k.limb(leg(t0, ax, ay), leg(t1, bx, by), 0.03, 0.03, "steel_dk", segs=4, wear=False)
            k.limb(leg(t1, ax, ay), leg(t1, bx, by), 0.03, 0.03, "steel", segs=4, wear=False)
    k.scyl(-0.4, 0.4, 0.5, top, top + 2.5)
    k.box((-0.4, 0.4, base_h + mast_h + 0.3), (0.35, 0.35, 0.35), "amber", glow=True)
    k.box((-0.4, 0.4, base_h + mast_h * 0.55), (0.25, 0.25, 0.25), "amber", glow=True)
    # Dish on the mast and solar wings on the deck.
    k.cyl((0.6, 0.6, base_h + 8.0), 1.3, 0.5, "cream", segs=14, r2=0.2, ry=70, rz=-35, wear=False)
    k.limb((0.0, 0.6, base_h + 8.0), (0.7, 0.4, base_h + 8.1), 0.06, 0.06, "steel", segs=4, wear=False)
    for sx in (-1, 1):
        k.box((sx * 1.3, -1.2, top + 0.5), (1.2, 0.8, 0.05), (0.12, 0.16, 0.30), rx=-30, wear=False)
        k.box((sx * 1.3, -1.2, top + 0.25), (0.06, 0.06, 0.5), "steel", wear=False)
    # Yard: crates, a cable drum, warning posts, the lockbox.
    for i, (x, y, s) in enumerate(((3.8, 2.0, 1.0), (4.6, 0.7, 0.8), (-3.6, 3.0, 1.0))):
        k.box((x, y, s / 2), (s, s * 1.4, s), "rust" if i % 2 else "steel_dk", rz=8 * i)
        k.box((x, y, s + 0.01), (s * 0.9, s * 1.3, 0.04), "hazard", rz=8 * i, wear=False)
        k.sbox(x, y, s / 2, s * 0.7, -0.5, s, 8 * i)
    k.cyl((-4.0, -2.8, 0.7), 0.7, 1.2, "oak", segs=12, rx=90)
    k.scyl(-4.0, -2.8, 0.7, -0.5, 1.4)
    for (x, y) in ((5.5, -4.0), (-5.5, -4.5), (5.5, 4.5)):
        k.cyl((x, y, 0), 0.08, 1.4, "hazard", segs=6, wear=False)
    k.chest_at(-3.2, 1.0, rz=90, pal=("steel_dk", "hazard"))
    for (x, y) in ((-6.0, -1.0), (6.5, -1.5), (0.0, -7.0), (2.0, 6.5), (-5.0, 6.0)):
        k.guard(x, y)
    k.lookout = [1.2, 0.6, top]  # on the deck, clear of the mast core and its legs
    return k

def m_depot():
    """The Foreclosed Depot: an Oversight freight depot gone to ruin: broken concrete walls, a gate
    booth, two rusted freight boxes, a fallen gantry beam and a dead floodlight."""
    k = Kit("m_depot", 808, wear=None)
    rng = k.rng
    W, D, H, T = 8.5, 6.5, 3.6, 0.5
    def broken(seed, lo, hi):
        return lambda t: lo + (hi - lo) * max(0.0, min(1.0, 0.5 + 0.9 * noise.noise(Vector((t * 2.7 + seed, seed, 0.1)))))
    walls = [
        ((-W, -D), (-2.2, -D), broken(1, 1.4, H)),
        ((2.2, -D), (W, -D), broken(2, 0.6, H)),
        ((-W, D), (W, D), broken(3, 1.6, H + 0.5)),
        ((W, -D), (W, 0.5), broken(4, 0.7, H)),
        ((W, 3.5), (W, D), broken(8, 1.2, H)),
        ((-W, -D), (-W, D), broken(5, 1.8, H)),
    ]
    for (p0, p1, top) in walls:
        L = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        ang = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))
        u = ((p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L)
        n = int(L / 2.0)
        for i in range(n):  # poured panels of 2 m with broken tops and rebar stubs
            t0, t1 = i / n, (i + 1) / n
            h = top((t0 + t1) / 2)
            cx, cy = p0[0] + u[0] * L * (t0 + t1) / 2, p0[1] + u[1] * L * (t0 + t1) / 2
            k.box((cx, cy, (h - 1.0) / 2), (L / n - 0.06, T, h + 1.0), "concrete" if i % 3 else "concrete_dk", rz=ang)
            k.box((cx, cy, 0.2), (L / n - 0.02, T + 0.04, 0.4), "sand_dk", rz=ang, wear=False)
            if h < H - 0.6:
                for j in range(3):
                    off = (j - 1) * 0.5
                    k.limb((cx + u[0] * off, cy + u[1] * off, h - 0.05), (cx + u[0] * off + (rng.random() - 0.5) * 0.2, cy + u[1] * off, h + 0.4 + rng.random() * 0.3), 0.025, 0.02, "rust", segs=4, wear=False)
        k.sbox((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, L / 2 + T / 2, T / 2, -1.0, max(top(t) for t in (0.1, 0.5, 0.9)), ang)
    # Gate booth by the south gap; barrier arm (hazard striped) lying broken.
    k.box((-3.4, -D - 1.6, 1.3), (1.8, 1.8, 2.6), "concrete")
    k.box((-3.4, -D - 1.6, 2.7), (2.1, 2.1, 0.2), "steel_dk", wear=False)
    k.box((-3.4, -D - 2.52, 1.6), (1.2, 0.04, 0.8), (0.10, 0.12, 0.14), wear=False)
    k.sbox(-3.4, -D - 1.6, 0.9, 0.9, -0.5, 2.8)
    for i in range(6):
        k.box((-1.2 + i * 0.6, -D - 1.0, 0.15), (0.6, 0.12, 0.12), "hazard" if i % 2 else "cream", rz=4, wear=False)
    # Freight boxes, rusted, one tipped on its side.
    for (x, y, rz, tip) in ((4.0, 2.5, 8, False), (-4.5, 1.8, -80, True)):
        sx, sy, sz = (6.0, 2.4, 2.6) if not tip else (6.0, 2.6, 2.4)
        k.box((x, y, sz / 2), (sx, sy, sz), "rust", rz=rz)
        for j in range(9):
            t = (j - 4) / 4.5
            k.box((x + math.cos(math.radians(rz)) * t * sx / 2, y + math.sin(math.radians(rz)) * t * sx / 2, sz / 2), (0.08, sy + 0.04, sz - 0.1), "sand_dk", rz=rz, wear=False)
        k.sbox(x, y, sx / 2, sy / 2, -0.5, sz, rz)
    # Fallen gantry beam across the court and a dead floodlight mast.
    k.box((0.5, -1.5, 0.45), (11.0, 0.6, 0.9), "hazard", rz=-18)
    k.box((0.5, -1.5, 0.92), (11.0, 0.2, 0.06), "steel_dk", rz=-18, wear=False)
    k.sbox(0.5, -1.5, 5.5, 0.3, -0.5, 0.9, -18)
    k.cyl((6.8, -4.6, 0), 0.18, 7.0, "steel", segs=8, wear=False)
    k.box((6.8, -4.9, 7.0), (1.4, 0.4, 0.6), "steel_dk", wear=False)
    k.box((6.8, -5.1, 7.0), (1.2, 0.05, 0.4), "amber", glow=True)
    k.scyl(6.8, -4.6, 0.25, -0.5, 7.0)
    # Sand drifts against the walls.
    for i in range(8):
        a = rng.random() * 2 * math.pi
        k.rock((math.cos(a) * (W - 1.2), math.sin(a) * (D - 1.2), -0.1), (2.6, 1.6, 0.6), "sand", rough=0.2, seed=i + 90)
    k.chest_at(0.0, D - 1.4, rz=0, pal=("steel_dk", "hazard"))
    for (x, y) in ((0, 0.5), (-3.0, -3.0), (3.0, -4.0), (-5.5, -4.5), (6.5, -0.5), (0, -9.5)):
        k.guard(x, y)
    k.lookout = [4.0, 2.5, 2.6]
    return k

def m_hull():
    """The Long Haul wreck: a freighter hull 40 m long, broken in two and ploughed nose-first into the
    salt, its engines up in the air. The landmark of Meridian's far side."""
    k = Kit("m_hull", 909, wear=None)
    rng = k.rng
    # Hull: an octagonal tube in rings along X, the aft half (+X) tilted up, the bow (-X) half buried.
    def tube(x0, x1, r0, r1, z0, z1, rot, col_a, col_b, n=6):
        for i in range(n):
            t0, t1 = i / n, (i + 1) / n
            xa, xb = x0 + (x1 - x0) * t0, x0 + (x1 - x0) * t1
            ra, rb = r0 + (r1 - r0) * t0, r0 + (r1 - r0) * t1
            za, zb = z0 + (z1 - z0) * t0, z0 + (z1 - z0) * t1
            k.limb((xa, 0, za), (xb, 0, zb), ra, rb, col_a if i % 2 else col_b, segs=8)
            # Plate seams.
            k.limb((xb - 0.05, 0, zb), (xb + 0.05, 0, zb), rb + 0.06, rb + 0.06, "hull_dk", segs=8, wear=False)
    tube(-20.0, -2.0, 2.0, 4.4, -1.2, 2.6, 0, "hull", "hull_dk", n=6)       # bow half, nose buried
    tube(1.5, 18.0, 4.4, 3.6, 3.2, 7.4, 0, "hull", "hull_dk", n=6)           # aft half, raised
    # Torn edges at the break: jagged plates.
    for i in range(10):
        a = 2 * math.pi * i / 10
        for (x, z, r) in ((-1.6, 2.6, 4.4), (1.2, 3.2, 4.4)):
            k.box((x, math.cos(a) * r, z + math.sin(a) * r), (0.9 + rng.random(), 0.08, 1.2 + rng.random()), "rust", rx=math.degrees(a), rz=(rng.random() - 0.5) * 30, wear=False)
    # Engines and fins on the aft.
    for (y, z) in ((-2.0, 9.0), (2.0, 9.0), (0.0, 5.2)):
        k.limb((17.0, y, z), (21.5, y, z + 0.9), 1.3, 1.6, "steel_dk", segs=10, wear=False)
        k.limb((21.4, y, z + 0.88), (21.7, y, z + 0.95), 1.0, 1.0, (0.06, 0.05, 0.05), segs=10, wear=False)
    for (y, zt) in ((-1, 11.5), (1, 11.5)):
        k.box((13.0, y * 3.6, 8.5 + (zt - 8.5) / 2), (5.0, 0.3, 3.2), "hull", rx=y * 25, wear=False, taper=0.6)
    k.box((10.0, 0, 12.2), (4.0, 0.3, 2.6), "hull_dk", wear=False, taper=0.5)
    # Paint: an Oversight-grey band and a faded registry stripe.
    k.limb((6.0, 0, 5.21), (7.2, 0, 5.52), 4.32, 4.28, "hazard", segs=8, wear=False)
    k.limb((-9.0, 0, 0.95), (-8.0, 0, 1.15), 3.18, 3.25, "cream", segs=8, wear=False)
    # Ploughed salt and wreckage around it.
    k.rock((-22.0, 0, -0.4), (7.0, 9.0, 2.6), "sand", rough=0.25, seed=5)
    for i in range(14):
        x = -14 + rng.random() * 34
        y = (rng.random() - 0.5) * 18
        if abs(y) < 5.2:
            y += 5.2 * (1 if y >= 0 else -1)
        s = 0.6 + rng.random() * 1.6
        k.box((x, y, s * 0.2), (s * 1.6, s, 0.25), "rust" if i % 2 else "hull_dk", rz=rng.random() * 180, rx=(rng.random() - 0.5) * 30, wear=False)
    # Colliders: the bow and aft as stepped boxes following the hull (upright solids under the tube).
    for i in range(5):
        t = (i + 0.5) / 5
        x = -20.0 + 18.0 * t
        r = 2.0 + 2.4 * t
        zc = -1.2 + 3.8 * t
        k.sbox(x, 0, 18.0 / 10, r * 0.95, -2.0, zc + r * 0.9)
    for i in range(5):
        t = (i + 0.5) / 5
        x = 1.5 + 16.5 * t
        r = 4.4 - 0.8 * t
        zc = 3.2 + 4.2 * t
        k.sbox(x, 0, 16.5 / 10, r * 0.95, -2.0, zc + r * 0.9)
    k.sbox(-22.0, 0, 3.0, 4.0, -1.0, 0.8)
    # The chest sits in the break between the halves; guard spots round it.
    k.chest_at(-0.2, -1.2, rz=90, pal=("steel_dk", "hazard"))
    for (x, y) in ((0, -7.0), (-6.0, -7.5), (6.0, -7.0), (0.0, 7.5), (-8.0, 7.0), (8.0, 7.5)):
        k.guard(x, y)
    k.lookout = [8.0, 0.0, 11.0]
    return k

BUILDERS = [a_watchtower, a_ruin, a_arch, h_shrine, h_cave, h_tree, m_relay, m_depot, m_hull]

# ------------------------------------------------------------------------------------------ scene
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def to_object(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    me.update()
    for p in me.polygons:
        p.use_smooth = False
    # The exporter writes the active colour attribute as COLOR_0 (export_vertex_color="ACTIVE").
    col = me.color_attributes.get("Col")
    if col:
        me.color_attributes.active_color = col
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    obj = bpy.data.objects.new(name, me)
    scene.collection.objects.link(obj)
    return obj

def material_for(obj, glow=False):
    mat = bpy.data.materials.new(obj.name + "_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    if glow:
        nt.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 6.0
    obj.data.materials.append(mat)

def tris_of(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)

def lod1_of(obj, ratio):
    me = obj.data.copy()
    o = bpy.data.objects.new(obj.name + "_lod1", me)
    scene.collection.objects.link(o)
    mod = o.modifiers.new("dec", "DECIMATE")
    mod.ratio = ratio
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me2 = bpy.data.meshes.new_from_object(ev)
    col = me2.color_attributes.get("Col")
    if col:
        me2.color_attributes.active_color = col
        me2.color_attributes.render_color_index = me2.color_attributes.active_color_index
    o.modifiers.clear()
    o.data = me2
    return o

manifest = {"prefabs": []}
objects = {}
for build in BUILDERS:
    k = build()
    obj = to_object(k.name, k.bm)
    material_for(obj)
    lod = lod1_of(obj, 0.3)
    glow = to_object(k.name + "_glow", k.gbm) if len(k.gbm.faces) else None
    if glow:
        material_for(glow, True)
    xs = [v.co.x for v in obj.data.vertices]; ys = [v.co.y for v in obj.data.vertices]; zs = [v.co.z for v in obj.data.vertices]
    radius = max(math.hypot(v.co.x, v.co.y) for v in obj.data.vertices)
    # Footprint radius: how far solids reach (placement keeps sites this far apart and clear).
    foot = 0.0
    for s in k.solids:
        reach = math.hypot(s[1], s[2]) + math.hypot(s[3], s[4])
        foot = max(foot, reach)
    entry = {
        "name": k.name,
        "tris": [tris_of(obj), tris_of(lod), tris_of(glow) if glow else 0],
        "height": round(max(zs), 2),
        "radius": round(radius, 2),
        "foot": round(foot, 2),
        "solids": k.solids,
        "chest": k.chest,
        "guards": k.guards,
        "lookout": [round(k.lookout[0], 2), round(-k.lookout[1], 2), round(k.lookout[2], 2)],
    }
    manifest["prefabs"].append(entry)
    objects[k.name] = (obj, lod, glow)
    print(f"SITE {k.name}: tris {entry['tris']} height {entry['height']} radius {entry['radius']} solids {len(k.solids)}", flush=True)

json.dump(manifest, open(os.path.join(OUT, "sites.json"), "w"), indent=1)

# Export: one GLB per planet (its prefabs at the origin, one node each: LOD0, LOD1, glow). No normals:
# the client shades the faces flat from screen derivatives, which halves the bytes.
for body, prefix in (("arcadia", "a_"), ("hollowmere", "h_"), ("meridian", "m_")):
    bpy.ops.object.select_all(action="DESELECT")
    for n, objs in objects.items():
        if n.startswith(prefix):
            for o in objs:
                if o:
                    o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, f"sites_{body}.glb"), export_format="GLB", export_yup=True, export_apply=True,
        export_materials="NONE", export_vertex_color="ACTIVE", export_all_vertex_colors=False,
        export_normals=False, export_texcoords=False, export_animations=False, use_selection=True,
    )
    print("EXPORTED", body, os.path.getsize(os.path.join(OUT, f"sites_{body}.glb")), flush=True)

# ------------------------------------------------------------------------------------------ renders
if RENDERS != "none":
    want = None if RENDERS == "all" else set(RENDERS.split(","))
    scene.render.engine = "CYCLES"
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 720, 540
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.65, 0.8, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.8
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    scene.collection.objects.link(sun)
    ground_me = bpy.data.meshes.new("ground")
    gbm = bmesh.new()
    bmesh.ops.create_grid(gbm, x_segments=1, y_segments=1, size=80)
    gbm.to_mesh(ground_me)
    ground = bpy.data.objects.new("ground", ground_me)
    gm = bpy.data.materials.new("ground")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.36, 0.26, 1)
    ground_me.materials.append(gm)
    scene.collection.objects.link(ground)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    txt_curve = bpy.data.curves.new("label", "FONT")
    label = bpy.data.objects.new("label", txt_curve)
    scene.collection.objects.link(label)
    lm = bpy.data.materials.new("label")
    lm.use_nodes = True
    lm.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (1, 1, 1, 1)
    lm.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 3.0
    txt_curve.materials.append(lm)
    for e in manifest["prefabs"]:
        name = e["name"]
        if want and name not in want:
            continue
        for n, (o, l, g) in objects.items():
            show = n == name
            o.hide_render = not show
            l.hide_render = True
            if g:
                g.hide_render = not show
        r = max(e["radius"], e["height"] * 0.6)
        dist = r * 2.6 + 4
        cam.location = (dist * 0.62, -dist * 0.78, e["height"] * 0.45 + dist * 0.32)
        tgt = Vector((0, 0, e["height"] * 0.38))
        cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = 35
        txt_curve.body = f"{name}  ·  {e['tris'][0]} / {e['tris'][1]} tris"
        txt_curve.size = 0.05 * dist * 0.35
        label.parent = cam
        label.location = (-0.42 * dist * 0.35, -0.3 * dist * 0.35, -dist * 0.35)
        label.rotation_euler = (0, 0, 0)
        scene.render.filepath = os.path.join(OUT, f"render_{name}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED", scene.render.filepath, flush=True)
print("DONE", flush=True)
