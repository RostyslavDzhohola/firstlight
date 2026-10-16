# Meridian arrival outpost "Waystation Nine": a retro-futurist roadside waystation on a red-concrete
# plinth: drum hall with a glass band and a saucer roof, a delta canopy pointing at the arrival pad,
# a chrome signal spire with a beacon, a tilted "9" pylon sign, tanks and a relay annex.
# Front faces -Y (the pad is at (0, -15)).
import math, random
from mathutils import Vector, Matrix
import bpy, bmesh
import flkit as K
from flkit import C

rng = random.Random(9)
PAL = dict(enamel=0xEFE9DE, slate=0x4A5560, chrome=0xD0D4D8, conc=0xB65A40, conc2=0x9A4834, conc3=0xC97A5A,
           teal=0x4FE0D8, amber=0xF2B544, red=0xC8402E, glass=0x18242C, white=0xFFFFFF, sage=0x7E9A6A, agave=0x6E8F78)
RD = 4.2          # drum radius
CZ = 3.62         # canopy underside at the drum
ZP = 0.5          # plinth top

def text_piece(name, txt, size, depth, col, kind='glow', glow=1.0, loc=(0, 0, 0), rot=(0, 0, 0), back=None):
    cu = bpy.data.curves.new(name + "_c", 'FONT')
    cu.body = txt
    cu.size = size
    cu.extrude = depth / 2
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.resolution_u = 2
    ob = bpy.data.objects.new(name + "_t", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    p = K.Piece(name)
    p.bm.free()
    p.bm = bmesh.new()
    p.bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    p.lc = p.bm.loops.layers.float_color.new("Col")
    p.lp = p.bm.loops.layers.float_color.new("PBR")
    bmesh.ops.triangulate(p.bm, faces=p.bm.faces[:])
    orig = p.bm.verts[:]
    if back is not None:
        d = bmesh.ops.duplicate(p.bm, geom=p.bm.verts[:] + p.bm.edges[:] + p.bm.faces[:])
        dv = [e for e in d['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.transform(p.bm, matrix=K.Piece.M(back[0], back[1]), verts=dv)
    bmesh.ops.transform(p.bm, matrix=K.Piece.M(loc, rot), verts=orig)
    p.paint(p.bm.faces[:], col, kind, glow if kind == 'glow' else None, 0)
    return p

def kit():
    P = {}
    # ---- plinth: chamfered two-tier red concrete platform with front steps
    def chamfer_rect(hx, hy, c):
        return [(-hx + c, -hy), (hx - c, -hy), (hx, -hy + c), (hx, hy - c), (hx - c, hy), (-hx + c, hy), (-hx, hy - c), (-hx, -hy + c)]
    p = K.Piece("W_plinth")
    p.prism(chamfer_rect(8.6, 6.4, 2.2), 0.26, plane='XY', loc=(0, 0.4, 0), col=PAL['conc2'], kind='stone')
    p.prism(chamfer_rect(8.0, 5.8, 1.9), 0.25, plane='XY', loc=(0, 0.4, 0.25), col=PAL['conc'], kind='stone')
    for i in range(2):
        p.box((3.6 - i * 0.4, 0.55, 0.17), (0, -6.15 - 0.5 + i * 0.5, 0.085 + i * 0.17), col=PAL['conc3'], kind='stone')
    p.box((16.2, 0.12, 0.06), (0, 0.4 - 5.86, 0.47), col=PAL['teal'], kind='glow', glow=0.5)     # front edge light
    P['plinth'] = p.mesh(sharp_deg=30)
    # ---- drum hall (10 sides): enamel base, glass band, fascia, neon line
    p = K.Piece("W_drum")
    seg = 10
    off = 0.0  # vertices at 36k deg: a flat face toward -Y
    def ring(r0, z0, r1, z1, col, kind, glow=None):
        p.lathe([(r0, z0), (r1, z1)], seg=seg, col=col, kind=kind, glow=glow, cap0=False, cap1=False, rot=(0, 0, off))
    ring(RD, ZP, RD, 1.35, PAL['enamel'], 'enamel')
    ring(RD - 0.12, 1.35, RD - 0.12, 3.05, PAL['glass'], 'glass')
    ring(RD + 0.05, 3.05, RD + 0.05, 3.9, PAL['enamel'], 'enamel')
    ring(RD + 0.07, 3.40, RD + 0.07, 3.50, PAL['teal'], 'glow', 1.0)
    p.lathe([(RD + 0.05, 3.05), (RD - 0.12, 3.05)], seg=seg, col=PAL['enamel'], kind='enamel', cap0=False, cap1=False, rot=(0, 0, off))
    p.lathe([(RD - 0.12, 1.35), (RD, 1.35)], seg=seg, col=PAL['enamel'], kind='enamel', cap0=False, cap1=False, rot=(0, 0, off))
    for k in range(seg):          # chrome mullions at the corners
        a = 2 * math.pi * k / seg + off
        p.box((0.10, 0.10, 1.7), ((RD - 0.06) * math.cos(a), (RD - 0.06) * math.sin(a), 2.2), rot=(0, 0, a), col=PAL['chrome'], kind='chrome')
    # interior glow strip behind the glass (warm, dim)
    p.lathe([(RD - 0.6, 2.85), (RD - 0.6, 3.0)], seg=seg, col=PAL['amber'], kind='glow', glow=0.6, cap0=False, cap1=False, rot=(0, 0, off))
    P['drum'] = p.mesh(sharp_deg=20)
    # ---- saucer roof: flared disc + low dome + neon rim
    p = K.Piece("W_saucer")
    p.lathe([(RD + 0.05, 3.9), (5.9, 4.32), (5.95, 4.46), (4.7, 4.76)], seg=20, col=PAL['enamel'], kind='enamel', cap0=False, cap1=False)
    p.lathe([(4.7, 4.76), (4.3, 4.84)], seg=20, col=PAL['red'], kind='enamel', cap0=False, cap1=False)
    p.lathe([(4.3, 4.84), (2.7, 5.05)], seg=20, col=PAL['enamel'], kind='enamel', cap0=False, cap1=False)
    p.lathe([(2.7, 5.05), (2.55, 5.25), (1.2, 5.45), (0.0, 5.5)], seg=20, col=PAL['slate'], kind='chrome')
    p.lathe([(2.62, 5.12), (2.62, 5.2)], seg=20, col=PAL['teal'], kind='glow', glow=0.8, cap0=False, cap1=False)
    P['saucer'] = p.mesh(sharp_deg=40)
    p = K.Piece("W_rim")
    p.lathe([(5.93, 4.31), (5.98, 4.39), (5.93, 4.47)], seg=20, col=PAL['teal'], kind='glow', glow=1.0, cap0=False, cap1=False)
    P['rim'] = p.mesh(sharp_deg=60)
    # ---- delta canopy: upswept arrowhead, red top, enamel underside band, neon edges
    p = K.Piece("W_canopy")
    pts = [(-5.3, -2.0), (-0.55, -10.2), (0.0, -10.9), (0.55, -10.2), (5.3, -2.0), (2.6, -1.2), (0.0, -2.6), (-2.6, -1.2)]
    f = p.prism(pts, 0.30, plane='XY', loc=(0, 0, 0), col=PAL['red'], kind='enamel')
    vs = {v for ff in f for v in ff.verts}
    for v in vs:
        t = max(0.0, -v.co.y - 2.6)
        v.co.z += t * 0.11 + (0.12 * (1 - min(1, t / 8.0)) if v.co.z > 0.1 else 0)
    # underside light lines along the two leading edges
    for sx in (-1, 1):
        a = Vector((sx * 5.0, -2.25, -0.03)); b = Vector((sx * 0.45, -10.15, -0.03 + 0.11 * 7.6))
        p.tube(a, b, 0.05, seg=4, col=PAL['teal'], kind='glow', glow=1.0)
    for (x, y) in ((0, -4.5), (0, -6.6), (0, -8.6), (-1.8, -4.0), (1.8, -4.0)):
        t = max(0.0, -y - 2.6)
        p.cyl(0.22, 0.04, (x, y, -0.02 + t * 0.11), seg=6, col=PAL['amber'], kind='glow', glow=0.9)
    P['canopy'] = p.mesh(sharp_deg=30)
    # ---- V strut (chrome) under the canopy tip
    p = K.Piece("W_strut")
    base = Vector((0, -8.4, 0.12))
    for sx in (-1, 1):
        top = Vector((sx * 1.55, -7.0, CZ + 0.11 * 4.4 - 0.04))
        p.tube(base, top, 0.09, seg=8, r2=0.13, col=PAL['chrome'], kind='chrome')
    p.cyl(0.42, 0.16, (0, -8.4, 0.08), seg=8, col=PAL['slate'], kind='paint')
    p.sphere(0.2, (0, -8.4, 0.22), u=8, v=4, col=PAL['chrome'], kind='chrome')
    P['strut'] = p.mesh(sharp_deg=40)
    # ---- entrance porch: chrome frame, glass doors, neon outline (front at y = 0)
    p = K.Piece("W_door")
    p.box((2.5, 0.5, 0.26), (0, -0.15, 2.85), col=PAL['chrome'], kind='chrome', bevel=0.04)
    for sx in (-1, 1):
        p.box((0.24, 0.5, 2.5), (sx * 1.13, -0.15, 1.35 + 0.15), col=PAL['chrome'], kind='chrome', bevel=0.04)
        p.box((0.98, 0.04, 2.4), (sx * 0.5, -0.05, 1.45), col=PAL['glass'], kind='glass')
        p.box((0.06, 0.03, 2.3), (sx * 0.98, -0.42, 1.45), col=PAL['teal'], kind='glow', glow=1.0)
    p.box((2.0, 0.03, 0.06), (0, -0.42, 2.66), col=PAL['teal'], kind='glow', glow=1.0)
    p.box((1.6, 0.05, 0.10), (0, -0.09, 1.2), col=PAL['chrome'], kind='chrome')
    P['door'] = p.mesh(sharp_deg=40)
    # ---- signal spire: tapered chrome mast, fins, rings, beacon
    p = K.Piece("W_spire")
    p.lathe([(0.0, 0.0), (0.75, 0.0), (0.62, 1.1), (0.36, 5.5), (0.21, 12.0), (0.09, 16.2), (0.0, 16.4)], seg=8, col=PAL['chrome'], kind='chrome')
    for k in range(3):
        a = 2 * math.pi * k / 3
        p.prism([(0.3, 0.0), (1.75, 0.0), (1.55, 0.45), (0.3, 4.6)], 0.10, plane='XZ', rot=(0, 0, a), col=PAL['red'], kind='enamel')
    for z, r in ((6.2, 0.62), (9.6, 0.50), (12.6, 0.38)):
        p.cyl(r, 0.12, (0, 0, z), seg=10, col=PAL['enamel'], kind='enamel')
        p.cyl(r + 0.02, 0.04, (0, 0, z), seg=10, col=PAL['teal'], kind='glow', glow=0.8)
    p.sphere(0.24, (0, 0, 16.55), u=8, v=5, col=PAL['amber'], kind='glow', glow=1.0)
    P['spire'] = p.mesh(sharp_deg=30)
    # ---- dish on a stem (roof)
    p = K.Piece("W_dish")
    p.cyl(0.07, 1.1, (0, 0, 0), seg=6, col=PAL['chrome'], kind='chrome', base=True)
    p.lathe([(0.0, 0.0), (0.45, 0.06), (0.85, 0.25), (0.9, 0.30)], seg=10, loc=(0, 0, 1.15), rot=(math.radians(-35), 0, 0),
            col=PAL['enamel'], kind='enamel', cap1=False)
    p.cyl(0.03, 0.55, (0, -0.15, 1.45), rot=(math.radians(-35), 0, 0), seg=4, col=PAL['chrome'], kind='chrome', base=True)
    P['dish'] = p.mesh(sharp_deg=50)
    # ---- "9" pylon sign: tilted slab, disc head with neon ring, numeral
    p = K.Piece("W_sign")
    p.box((1.1, 0.36, 6.4), (0, 0, 3.2), col=PAL['red'], kind='enamel', bevel=0.05, shear=(0.55, 0))
    p.box((0.16, 0.38, 5.8), (-0.55 + 0.28, -0.0, 3.0), col=PAL['enamel'], kind='enamel', shear=(0.5, 0))
    p.cyl(1.35, 0.30, (0.55, 0, 7.3), rot=(math.pi / 2, 0, 0), seg=20, col=PAL['enamel'], kind='enamel')
    p.torus(1.24, 0.05, seg=20, rseg=3, loc=(0.55, -0.17, 7.3), rot=(math.pi / 2, 0, 0), col=PAL['teal'], kind='glow', glow=1.0)
    p.torus(1.24, 0.05, seg=20, rseg=3, loc=(0.55, 0.17, 7.3), rot=(math.pi / 2, 0, 0), col=PAL['teal'], kind='glow', glow=1.0)
    p.box((1.5, 0.5, 0.25), (0.0, 0.0, 0.12), col=PAL['slate'], kind='paint')
    # arrow pointing toward the door (both faces), amber bulbs along it
    arrow = [(0.0, 0.0), (-1.9, 0.0), (-1.9, 0.28), (-2.5, -0.25), (-1.9, -0.78), (-1.9, -0.5), (0.0, -0.5)]
    p.prism(arrow, 0.14, plane='XZ', loc=(0.39, 0, 4.5), col=PAL['amber'], kind='enamel')
    P['sign'] = p.mesh(sharp_deg=40)
    # Round 2: a modelled numeral (a bowl and a curled tail), no font glyphs, on both faces of the disc.
    nine = K.Piece("W_nine")
    for y, mx in ((-0.18, 1.0), (0.18, -1.0)):
        cx, cz = 0.55, 7.25
        nine.torus(0.36, 0.085, seg=14, rseg=4, loc=(cx, y, cz + 0.30), rot=(math.pi / 2, 0, 0), col=PAL['teal'], kind='glow', glow=1.0)
        nine.tube((cx + mx * 0.36, y, cz + 0.30), (cx + mx * 0.33, y, cz - 0.22), 0.085, seg=5, col=PAL['teal'], kind='glow', glow=1.0)
        nine.tube((cx + mx * 0.33, y, cz - 0.22), (cx - mx * 0.12, y, cz - 0.62), 0.085, seg=5, col=PAL['teal'], kind='glow', glow=1.0)
    P['nine'] = nine.mesh(sharp_deg=30)
    # ---- tanks: two capsules on a cradle (along X)
    p = K.Piece("W_tanks")
    cap = [(0.0, -1.9), (0.55, -1.75), (0.8, -1.4), (0.85, -1.1), (0.85, 1.1), (0.8, 1.4), (0.55, 1.75), (0.0, 1.9)]
    for y in (-0.95, 0.95):
        p.lathe(cap, seg=10, loc=(0, y, 1.35), rot=(0, math.pi / 2, 0), col=PAL['enamel'], kind='enamel')
        p.cyl(0.87, 0.30, (0.6, y, 1.35), rot=(0, math.pi / 2, 0), seg=10, col=PAL['red'], kind='enamel', cap=False)
    for x in (-1.0, 1.0):
        p.box((0.22, 3.0, 0.55), (x, 0, 0.30), col=PAL['slate'], kind='paint')
    P['tanks'] = p.mesh(sharp_deg=40)
    # ---- relay annex: box with a half-barrel roof, small door, side light
    p = K.Piece("W_annex")
    p.box((4.0, 3.2, 2.5), (0, 0, 1.25), col=PAL['enamel'], kind='enamel')
    p.lathe([(1.62, 0.0), (1.62, 4.1)], seg=8, a0=math.pi / 2, a1=3 * math.pi / 2, loc=(-2.05, 0, 2.5), rot=(0, math.pi / 2, 0), col=PAL['slate'], kind='paint',
            cap0=False, cap1=False)
    p.box((4.1, 3.3, 0.14), (0, 0, 2.5), col=PAL['chrome'], kind='chrome')
    p.box((1.0, 0.06, 2.0), (0.9, -1.62, 1.0), col=PAL['slate'], kind='paint')
    p.box((1.6, 0.04, 0.10), (-0.7, -1.62, 1.9), col=PAL['teal'], kind='glow', glow=0.8)
    P['annex'] = p.mesh(sharp_deg=30)
    # ---- bollard light + planter with agave
    p = K.Piece("W_bollard")
    p.cyl(0.14, 0.9, (0, 0, 0), seg=6, col=PAL['slate'], kind='paint', base=True)
    p.cyl(0.15, 0.12, (0, 0, 0.72), seg=6, col=PAL['teal'], kind='glow', glow=0.9, base=True)
    P['bollard'] = p.mesh(sharp_deg=40)
    p = K.Piece("W_planter")
    p.cyl(0.7, 0.55, (0, 0, 0), seg=8, r2=0.78, col=PAL['conc3'], kind='stone', base=True)
    for k in range(7):
        a = 2 * math.pi * k / 7 + 0.3
        tilt = 0.55 if k else 0.0
        p.cyl(0.13, 1.0, (0.15 * math.cos(a) * (k > 0), 0.15 * math.sin(a) * (k > 0), 0.5), rot=(tilt * math.sin(a), -tilt * math.cos(a), 0),
              seg=3, r2=0.0, col=PAL['agave'], kind='leaf', base=True)
    P['planter'] = p.mesh(sharp_deg=40)
    # ---- holographic arrivals panel (M_Holo) on a chrome post
    p = K.Piece("W_holo_post")
    p.cyl(0.07, 1.4, (0, 0, 0), seg=6, col=PAL['chrome'], kind='chrome', base=True)
    p.box((1.6, 0.12, 0.10), (0, 0, 1.45), col=PAL['chrome'], kind='chrome')
    P['holo_post'] = p.mesh()
    p = K.Piece("W_holo")
    p.box((1.5, 0.01, 0.9), (0, 0, 2.0), col=PAL['teal'], kind='glow', mat=1)
    for i in range(4):
        p.box((1.1 - 0.25 * (i % 2), 0.012, 0.06), (-0.1 * (i % 2), -0.01, 2.25 - i * 0.16), col=PAL['white'], kind='glow', mat=1)
    P['holo'] = p.mesh()
    return P

def place(B, P):
    put = B.put
    put(P['plinth'])
    put(P['drum'], (0, 0.6, 0))
    put(P['saucer'], (0, 0.6, 0))
    put(P['rim'], (0, 0.6, 0))
    put(P['door'], (0, 0.6 - RD * math.cos(math.pi / 10) - 0.02, ZP))
    put(P['canopy'], (0, 0.6, CZ))
    put(P['strut'], (0, 0.6, 0.0))
    put(P['dish'], (-1.6, 1.5, 5.0))
    put(P['spire'], (-6.7, 2.6, ZP))
    put(P['sign'], (5.9, -4.6, ZP), rot=(0, 0, math.radians(-28)))
    put(P['nine'], (5.9, -4.6, ZP), rot=(0, 0, math.radians(-28)))
    put(P['tanks'], (-3.3, 5.2, ZP), rot=(0, 0, 0.0))
    put(P['annex'], (5.0, 4.0, ZP), rot=(0, 0, 0.0))
    for (x, y) in ((-7.2, -4.4), (-3.0, -5.0), (3.0, -5.0), (7.2, -4.4), (-7.6, 0.4), (7.6, 0.4)):
        put(P['bollard'], (x, y, ZP))
    put(P['planter'], (-5.6, -2.9, ZP))
    put(P['planter'], (2.9, -3.6, ZP), scale=(0.85, 0.85, 0.85))
    put(P['holo_post'], (-2.9, -4.2, ZP), rot=(0, 0, 0.25))
    put(P['holo'], (-2.9, -4.2, ZP), rot=(0, 0, 0.25))
    return B

def mat_sand(name="M_Sand", fog=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; L = nt.links
    for n in list(N):
        N.remove(n)
    out = N.new("ShaderNodeOutputMaterial")
    bs = N.new("ShaderNodeBsdfPrincipled"); bs.inputs["Roughness"].default_value = 0.95
    geo = N.new("ShaderNodeNewGeometry")
    n1 = N.new("ShaderNodeTexNoise"); n1.inputs["Scale"].default_value = 0.05; n1.inputs["Detail"].default_value = 5
    L.new(geo.outputs["Position"], n1.inputs["Vector"])
    n2 = N.new("ShaderNodeTexNoise"); n2.inputs["Scale"].default_value = 1.2; n2.inputs["Detail"].default_value = 3
    L.new(geo.outputs["Position"], n2.inputs["Vector"])
    ramp = N.new("ShaderNodeValToRGB"); cr = ramp.color_ramp
    cr.elements[0].position = 0.35; cr.elements[0].color = C(0xA9492F)
    cr.elements[1].position = 0.68; cr.elements[1].color = C(0xD99A6C)
    e = cr.elements.new(0.5); e.color = C(0xC4653F)
    mx = N.new("ShaderNodeMath"); mx.operation = 'MULTIPLY_ADD'; mx.inputs[1].default_value = 0.25; mx.inputs[2].default_value = 0.0
    L.new(n2.outputs["Fac"], mx.inputs[0])
    ad = N.new("ShaderNodeMath"); ad.operation = 'ADD'
    L.new(n1.outputs["Fac"], ad.inputs[0]); L.new(mx.outputs[0], ad.inputs[1])
    sb = N.new("ShaderNodeMath"); sb.operation = 'SUBTRACT'; sb.inputs[1].default_value = 0.12
    L.new(ad.outputs[0], sb.inputs[0])
    L.new(sb.outputs[0], ramp.inputs[0])
    L.new(ramp.outputs[0], bs.inputs["Base Color"])
    bump = N.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.25
    L.new(n2.outputs["Fac"], bump.inputs["Height"]); L.new(bump.outputs[0], bs.inputs["Normal"])
    L.new(bs.outputs[0], out.inputs[0])
    if fog:
        K.fog_wrap(m, *fog)
    return m

def mat_mesa(name="M_Mesa", fog=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; L = nt.links
    for n in list(N):
        N.remove(n)
    out = N.new("ShaderNodeOutputMaterial")
    bs = N.new("ShaderNodeBsdfPrincipled"); bs.inputs["Roughness"].default_value = 0.92
    geo = N.new("ShaderNodeNewGeometry")
    nz = N.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 0.04; L.new(geo.outputs["Position"], nz.inputs["Vector"])
    sep = N.new("ShaderNodeSeparateXYZ"); L.new(geo.outputs["Position"], sep.inputs[0])
    ad = N.new("ShaderNodeMath"); ad.operation = 'MULTIPLY_ADD'; ad.inputs[1].default_value = 6.0
    L.new(nz.outputs["Fac"], ad.inputs[0]); L.new(sep.outputs["Z"], ad.inputs[2])
    wv = N.new("ShaderNodeMath"); wv.operation = 'MULTIPLY'; wv.inputs[1].default_value = 0.16
    L.new(ad.outputs[0], wv.inputs[0])
    fr = N.new("ShaderNodeMath"); fr.operation = 'FRACT'; L.new(wv.outputs[0], fr.inputs[0])
    ramp = N.new("ShaderNodeValToRGB"); cr = ramp.color_ramp; cr.interpolation = 'CONSTANT'
    cols = [(0.0, 0xB4553A), (0.22, 0xD07A52), (0.38, 0xA4472F), (0.55, 0xE0A57A), (0.63, 0xB95E3E), (0.82, 0x93402B)]
    cr.elements[0].position = cols[0][0]; cr.elements[0].color = C(cols[0][1])
    cr.elements[1].position = cols[-1][0]; cr.elements[1].color = C(cols[-1][1])
    for p_, c_ in cols[1:-1]:
        e = cr.elements.new(p_); e.color = C(c_)
    L.new(fr.outputs[0], ramp.inputs[0])
    L.new(ramp.outputs[0], bs.inputs["Base Color"])
    L.new(bs.outputs[0], out.inputs[0])
    if fog:
        K.fog_wrap(m, *fog)
    return m

def mesas(R, mat, rng):
    """Background mesas and buttes on the curved ground (context, far away)."""
    obs = []
    spots = [(-160, 260, 70, 55), (40, 420, 110, 95), (230, 300, 80, 70), (-330, 120, 60, 85), (330, 60, 55, 60),
             (-60, 600, 140, 120), (150, 700, 110, 140), (-420, 420, 120, 90), (480, 380, 90, 110), (-250, -120, 50, 60),
             (260, -200, 60, 70), (90, 190, 20, 48)]
    for i, (x, y, rad, h) in enumerate(spots):
        h *= 1.25
        n = 9
        pts = []
        for k in range(n):
            a = 2 * math.pi * k / n + rng.uniform(-0.2, 0.2)
            rr = rad * rng.uniform(0.7, 1.15)
            pts.append((rr * math.cos(a), rr * math.sin(a)))
        p = K.Piece(f"mesa{i}")
        # base skirt + body (slightly tapered) + cap ledge
        p.prism([(u * 1.25, v * 1.25) for u, v in pts], h * 0.35, plane='XY', loc=(0, 0, -h * 0.3), col=0xFFFFFF, kind='stone')
        f = p.prism(pts, h, plane='XY', loc=(0, 0, -h * 0.1), col=0xFFFFFF, kind='stone')
        for v in {v for ff in f for v in ff.verts}:
            if v.co.z > 0:
                v.co.x *= 0.88; v.co.y *= 0.88
        me = p.mesh(sharp_deg=30)
        me.materials.append(mat)
        ob = bpy.data.objects.new(f"mesa{i}", me)
        ob.matrix_world = K.on_planet(R, x, y, rng.uniform(0, 6))
        bpy.context.scene.collection.objects.link(ob)
        obs.append(ob)
    return obs

def scene(VIEWS, out, SAMPLES):
    look = K.LOOKS['meridian']; R = look['R']
    K.world_sky('meridian', sun_az_deg=232, sky_light=1.0)
    fog = (mixc(look['horizon'], look['mid'], 0.25), 0.0026, 60.0)
    m_kit, m_holo = K.mat_kit(grit=0.8), K.mat_holo(strength=1.6)
    K.planet_ground(R, mat_sand(fog=fog), subdiv=7)
    mesas(R, mat_mesa(fog=fog), random.Random(3))
    P = kit()
    B = K.Building("outpost", [m_kit, m_holo], origin=K.on_planet(R, 0, 0))
    place(B, P)
    B.report(out('budget').replace('.png', '.txt'))
    K.export_glb(B, out('glb').replace('_glb', '').replace('.png', '.glb'))
    # arrival pad stand-in (context, not counted)
    pad = K.Piece("X_pad")
    pad.cyl(5.4, 0.22, (0, 0, 0.0), seg=32, col=0x6E7680, kind='paint', base=True)
    pad.lathe([(4.6, 0.225), (4.9, 0.225)], seg=40, col=PAL['teal'], kind='glow', glow=0.7, cap0=False, cap1=False)
    pad.lathe([(1.5, 0.225), (1.65, 0.225)], seg=24, col=PAL['amber'], kind='glow', glow=0.5, cap0=False, cap1=False)
    for k in range(12):
        a = 2 * math.pi * k / 12
        pad.box((0.5, 0.22, 0.01), (5.1 * math.cos(a), 5.1 * math.sin(a), 0.225), rot=(0, 0, a + math.pi / 2), col=PAL['amber'], kind='paint')
    padme = pad.mesh()
    ctx = K.Building("ctx", [m_kit, m_holo], origin=K.on_planet(R, 0, -15.5))
    ctx.put(padme, count=False)
    import props
    fig = props.figure(col_body=0x3F5F9A)
    ctx.origin = K.on_planet(R, -1.2, -13.6, 0.4)
    ctx.put(fig, count=False)
    # a few desert rocks
    rr = random.Random(2)
    for i, (x, y, s) in enumerate(((-13, -6, 1.6), (-11, 8, 2.2), (14, -9, 1.3), (12.5, 10, 2.5), (-20, -18, 3.0), (22, -16, 2.0), (-4, 15, 1.8))):
        rp = K.Piece(f"X_rock{i}")
        rp.sphere(1.0, (0, 0, 0.2), scale=(s, s * 0.8, s * 0.6), ico=1, noise=0.18, rng=rr, col=0xA8533A, kind='stone')
        rme = rp.mesh(sharp_deg=30)
        ctx.origin = K.on_planet(R, x, y, rr.uniform(0, 6))
        ctx.put(rme, count=False)
    if 'hero' in VIEWS:
        g = K.on_planet(R, 4.6, -17.2) @ Vector((0, 0, 1.65))
        cam = K.camera("cam_hero", g, (-0.4, -2.0, 4.6), lens=22)
        K.render(cam, out('hero_eye'))
    if 'aerial' in VIEWS:
        cam = K.camera("cam_aerial", (-21.0, -24.5, 17.5), (0.3, -3.2, 2.2), lens=32)
        K.render(cam, out('aerial_34'))

def mixc(a, b, t):
    return K.mixc(a, b, t)
