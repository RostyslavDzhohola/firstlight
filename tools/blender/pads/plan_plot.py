# Top-down plan of a pad-0 site: terrain, water, breakables, props, fixed features, and (optional)
# a layout's footprints. Data only.  python3 -I plan_plot.py <site json> <out png> [layout json]
import json, math, sys
from PIL import Image, ImageDraw, ImageFont
site = json.load(open(sys.argv[1])); out = sys.argv[2]
lay = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None
g = site["grid"]; L = g["L"]; n = g["n"]; H = g["heights"]; padH = site["padH"]
V = float(__import__('os').environ.get('PLAN_V', '70'))  # half-extent shown (m)
PX = 12  # pixels per metre
W = int(2 * V * PX)
img = Image.new("RGB", (W, W), (0, 0, 0))
px = img.load()
def to_px(e, nn): return ((e + V) * PX, (V - nn) * PX)
def hgt(e, nn):
    i = (e + L) / g["step"]; j = (nn + L) / g["step"]
    i0, j0 = int(math.floor(i)), int(math.floor(j)); fi, fj = i - i0, j - j0
    i0 = max(0, min(n - 2, i0)); j0 = max(0, min(n - 2, j0))
    a = H[j0 * n + i0]; b = H[j0 * n + i0 + 1]; c = H[(j0 + 1) * n + i0]; d = H[(j0 + 1) * n + i0 + 1]
    return a * (1 - fi) * (1 - fj) + b * fi * (1 - fj) + c * (1 - fi) * fj + d * fi * fj
for y in range(W):
    for x in range(W):
        e = x / PX - V; nn = V - y / PX
        h = hgt(e, nn)
        if h < site["waterLevel"]:
            k = max(0.0, min(1.0, (site["waterLevel"] - h) / 4)); px[x, y] = (int(60 - 40 * k), int(140 - 60 * k), int(170 - 40 * k))
        else:
            t = max(-1, min(1, (h - padH) / 10))
            base = (110 + int(70 * t), 140 + int(40 * t), 90 + int(30 * t)) if t >= 0 else (110 + int(30 * t), 140 + int(40 * t), 90 + int(30 * t))
            # contour every 1 m
            fr = (h - padH) - math.floor(h - padH)
            if fr < 0.06: base = tuple(int(c * 0.75) for c in base)
            px[x, y] = base
d = ImageDraw.Draw(img)
try: font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 13)
except Exception: font = ImageFont.load_default()
def circle(e, nn, r, **kw):
    x, y = to_px(e, nn); d.ellipse([x - r * PX, y - r * PX, x + r * PX, y + r * PX], **kw)
for r, col in ((8, (230, 230, 230)), (12, (114, 241, 184)), (26, (200, 200, 120)), (45, (255, 80, 80)), (40, (255, 160, 80))):
    circle(0, 0, r, outline=col, width=2)
for k in range(-int(V) // 5 * 5, int(V) + 1, 5):
    a = to_px(k, -V); b = to_px(k, V); d.line([a, b], fill=(255, 255, 255) if k % 10 == 0 else (200, 200, 200), width=1)
    a = to_px(-V, k); b = to_px(V, k); d.line([a, b], fill=(255, 255, 255) if k % 10 == 0 else (200, 200, 200), width=1)
    if k % 10 == 0:
        d.text((to_px(k, 0)[0] + 2, 2 + 14), f"{k}", fill=(255, 255, 255), font=font)
        d.text((2, to_px(0, k)[1] + 2), f"{k}", fill=(255, 255, 255), font=font)
# props
PC = {"oak": (30, 90, 30), "pine": (20, 70, 40), "deadtree": (90, 70, 80), "rock": (120, 120, 120), "boulder": (140, 140, 140), "spire": (200, 90, 50), "reed": (150, 170, 90), "scrub": (160, 140, 80), "bush": (60, 120, 50), "fern": (70, 130, 60), "flower": (230, 200, 90), "mushroom": (200, 160, 140)}
for p in site["props"]:
    rr = {"oak": 1.5, "pine": 1.2, "deadtree": 1.2, "spire": 1.8, "boulder": 1.7, "rock": 0.7}.get(p["kind"], 0.4) * p["scale"]
    circle(p["east"], p["north"], rr, fill=PC.get(p["kind"], (255, 0, 255)))
# breakables (footprints)
def rect(cx, cy, right, hx, hz, col, width=2, fill=None):
    rx, ry = right[0], right[1]; l = math.hypot(rx, ry); rx, ry = rx / l, ry / l
    fx, fy = -ry, rx
    pts = [(cx + sx * hx * rx + sz * hz * fx, cy + sx * hx * ry + sz * hz * fy) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    d.polygon([to_px(*p) for p in pts], outline=col, fill=fill, width=width)
for b in site["breakables"]:
    if b["shape"] == 0: rect(b["east"], b["north"], b["right"], b["hx"], b["hz"], (255, 40, 40), fill=(255, 120, 120))
    else: circle(b["east"], b["north"], b["hx"], outline=(255, 40, 40), fill=(255, 120, 120), width=2)
    circle(b["east"], b["north"], b["foot"] + 1.5, outline=(255, 60, 60), width=1)
# fixed features
for p in site["portals"]:
    circle(p["east"], p["north"], 3, outline=(80, 240, 255), width=3)
    x, y = to_px(p["east"], p["north"]); d.text((x + 30, y), "portal", fill=(80, 240, 255), font=font)
for o in site["objects"]:
    if "east" in o:
        circle(o["east"], o["north"], 0.6, fill=(255, 255, 0)); x, y = to_px(o["east"], o["north"]); d.text((x + 8, y), o["id"], fill=(255, 255, 0), font=font)
# layout footprints
if lay:
    for it in lay.get("items", []):
        fp = it.get("fp")
        if not fp: continue
        col = (40, 40, 220) if it.get("solid", True) else (120, 120, 255)
        d.polygon([to_px(*p) for p in fp], outline=col, width=2)
        x, y = to_px(it["east"], it["north"]); d.text((x - 10, y - 6), it.get("label", it["prefab"])[:14], fill=(255, 255, 255), font=font)
d.text((10, 10), f'{site["body"]} pad0  padH {padH}  N up, E right, {V} m half-extent; rings 8/12/26/40/45', fill=(255, 255, 255), font=font)
img.save(out)
print("wrote", out)
