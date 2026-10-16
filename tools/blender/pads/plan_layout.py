# Top-down clearance plan of a pad-0 outpost: ground (water, contours), breakable footprints with
# their 2 m walkable-gap rings, the outpost's collider solids, paths, the pad, safe ring, portal and
# guide, the 40/45 m NPC rings, and the smallest gap from each structure to any breakable.
#   python3 -I plan_layout.py <site json> <body>_layout.json <out png> [half extent m]
import json, math, sys
from PIL import Image, ImageDraw, ImageFont

site = json.load(open(sys.argv[1])); lay = json.load(open(sys.argv[2])); out = sys.argv[3]
V = float(sys.argv[4]) if len(sys.argv) > 4 else 50.0
g = site["grid"]; L, st, n, H = g["L"], g["step"], g["n"], g["heights"]; padH = site["padH"]; water = site["waterLevel"]
PX = 16
W = int(2 * V * PX)
img = Image.new("RGB", (W, W)); px = img.load()
def gh(e, nn):
    i = (e + L) / st; j = (nn + L) / st; i0 = int(math.floor(i)); j0 = int(math.floor(j)); fi, fj = i - i0, j - j0
    a = H[j0*n+i0]; b = H[j0*n+i0+1]; c = H[(j0+1)*n+i0]; d = H[(j0+1)*n+i0+1]
    return a*(1-fi)*(1-fj)+b*fi*(1-fj)+c*(1-fi)*fj+d*fi*fj
for y in range(W):
    for x in range(W):
        e = x / PX - V; nn = V - y / PX; h = gh(e, nn)
        if h < water:
            k = min(1.0, (water - h) / 4); px[x, y] = (int(70 - 40*k), int(130 - 50*k), int(160 - 30*k))
        else:
            t = max(-1.0, min(1.0, (h - padH) / 8)); base = (150 + int(50*t), 160 + int(30*t), 130 + int(20*t))
            if (h - padH) - math.floor(h - padH) < 0.05: base = tuple(int(c * 0.8) for c in base)
            px[x, y] = base
d = ImageDraw.Draw(img, "RGBA")
try:
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
    fsm = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 12)
    fbig = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 20)
except Exception:
    font = fsm = fbig = ImageFont.load_default()
P = lambda e, nn: ((e + V) * PX, (V - nn) * PX)
def circle(e, nn, r, **kw):
    x, y = P(e, nn); d.ellipse([x - r*PX, y - r*PX, x + r*PX, y + r*PX], **kw)
for k in range(-int(V) // 10 * 10, int(V) + 1, 10):
    d.line([P(k, -V), P(k, V)], fill=(255, 255, 255, 60)); d.line([P(-V, k), P(V, k)], fill=(255, 255, 255, 60))
    d.text((P(k, 0)[0] + 2, 4), f"{k}", fill=(40, 40, 40), font=fsm); d.text((4, P(0, k)[1] + 2), f"{k}", fill=(40, 40, 40), font=fsm)
for pa in lay["paths"]:
    d.line([P(*p) for p in pa["pts"]], fill=(150, 130, 100, 200), width=int(pa["width"] * PX))
circle(0, 0, 8.6, fill=(200, 200, 205, 255), outline=(90, 90, 90))
for r, col in ((12, (60, 220, 160, 255)), (40, (255, 140, 60, 255)), (45, (230, 40, 120, 255))):
    circle(0, 0, r, outline=col, width=3)
# natural props kept (small dots)
for p in site["props"]:
    if math.hypot(p["east"], p["north"]) <= V and p["kind"] in ("oak", "pine", "deadtree", "spire", "boulder"):
        circle(p["east"], p["north"], 0.5, fill=(40, 90, 40, 160))
def rect_poly(b):
    re = (b["right"][0], b["right"][1]); fe = (b["fwd"][0], b["fwd"][1])
    l = math.hypot(*re); re = (re[0]/l, re[1]/l); l = math.hypot(*fe); fe = (fe[0]/l, fe[1]/l)
    return [(b["east"] + sx*b["hx"]*re[0] + sz*b["hz"]*fe[0], b["north"] + sx*b["hx"]*re[1] + sz*b["hz"]*fe[1]) for sx, sz in ((-1,-1),(1,-1),(1,1),(-1,1))]
for b in site["breakables"]:
    if math.hypot(b["east"], b["north"]) > V: continue
    circle(b["east"], b["north"], b["foot"] + 2.0, outline=(255, 120, 40, 255), width=1)
    if b["shape"] == 0: d.polygon([P(*q) for q in rect_poly(b)], fill=(230, 30, 30, 255))
    else: circle(b["east"], b["north"], b["hx"], fill=(230, 30, 30, 255))
for it in lay["layout"]:
    for s_ in it["solids"]:
        d.polygon([P(*q) for q in s_["poly"]], fill=(40, 70, 220, 150), outline=(20, 30, 140, 255))
# labels for the main items, with the nearest-breakable gap
def gap(a, b):
    def seg(p, a_, b_):
        dx, dy = b_[0]-a_[0], b_[1]-a_[1]; L2 = dx*dx+dy*dy
        t = 0 if L2 == 0 else max(0, min(1, ((p[0]-a_[0])*dx+(p[1]-a_[1])*dy)/L2))
        return math.hypot(p[0]-a_[0]-t*dx, p[1]-a_[1]-t*dy)
    return min(min(seg(p, b[i], b[(i+1)%len(b)]) for i in range(len(b))) for p in a)
bpolys = []
for b in site["breakables"]:
    bpolys.append(rect_poly(b) if b["shape"] == 0 else [(b["east"] + b["hx"]*math.cos(k*math.pi/8), b["north"] + b["hx"]*math.sin(k*math.pi/8)) for k in range(16)])
seen = set()
for it in lay["layout"]:
    lab = it["label"]
    if lab in seen or any(w in lab for w in ("lamp", "lantern", "pylon", "headstone", "graveyard wall")) or it["prefab"].endswith("_pad"):
        continue
    seen.add(lab)
    gmin = min((gap(s_["poly"], bp) for s_ in it["solids"] for bp in bpolys), default=99)
    x, y = P(it["east"], it["north"])
    txt = lab + (f"  [{gmin:.1f} m]" if gmin < 8 else "")
    d.text((x + 6, y - 7), txt, fill=(10, 10, 10), font=font)
pt = site["portals"][0]; circle(pt["east"], pt["north"], 2.2, outline=(255, 210, 160, 255), width=3)
gd = next(o for o in site["objects"] if o["look"] == "guide"); circle(gd["east"], gd["north"], 0.5, fill=(255, 230, 0, 255))
d.text((10, W - 120), f"{site['body'].upper()} pad 0 outpost: N up, E right, grid 10 m. Red: breakables (wire/persistence keys, pinned) with their 2 m gap ring.", fill=(0, 0, 0), font=font)
d.text((10, W - 100), "Blue: outpost collider solids. Grey disc: the pad (r 8.6). Green: safe ring 12 m. Orange/magenta: 40 m (any NPC) / 45 m (hostile spawns).", fill=(0, 0, 0), font=font)
v = lay["validation"]["stats"]
d.text((10, W - 80), f"[x m] = smallest gap from a structure to a breakable. Min gap to breakables {v['min_gap_to_breakables']} m; between structures {v['min_gap_between_structures']} m; validation problems: {len(lay['validation']['problems'])}.", fill=(0, 0, 0), font=font)
d.text((10, 10), f"{site['body'].capitalize()}: {dict(arcadia='Dawnpad', hollowmere='Lanternfall', meridian='Waystation Nine')[site['body']]}", fill=(0, 0, 0), font=fbig)
img.save(out)
print("wrote", out)
