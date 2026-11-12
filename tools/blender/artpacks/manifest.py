# HD art pack manifest (#48, D-artpacks): lists every staged HD file with the shipped file it replaces
# and that file's SHA-256, so the client never swaps a pack file into a build of the base art it wasn't
# made for (apps/client/src/render/artpacks/catalog.ts PackManifest). Our own code: MIT.
#
#   python3 -I manifest.py <pack dir> <shipped assets dir>
#
# <pack dir> holds town/<site>_{color,normal}.webp, chars/<look>_{albedo,normal}.webp and
# vegetation/atlas.webp (any subset); writes <pack dir>/manifest.json.
import hashlib
import json
import os
import sys

from PIL import Image

pack, shipped = sys.argv[1], sys.argv[2]


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


files = {}


def add(base_key, base_file, pack_name, group, rel, extra=None):
    path = os.path.join(pack, rel)
    with Image.open(path) as im:
        w, h = im.size
    entry = dict(pack=pack_name, group=group, file=rel, bytes=os.path.getsize(path), sha256=sha(path),
                 baseSha256=sha(os.path.join(shipped, base_file)), width=w, height=h)
    if extra:
        entry.update(extra)
    files[base_key] = entry


# Town strips: the Portus kit strips (Portus, Arcadia, Hollowmere) and Meridian's.
SITES = {"portus": "portus", "meridian": "outposts/meridian"}
for site, folder in SITES.items():
    man_path = os.path.join(shipped, folder, "manifest.json")
    if not os.path.exists(os.path.join(pack, "town", f"{site}_color.webp")):
        continue
    man = json.load(open(man_path))
    layers = len(man["layers"])
    for kind in ("color", "normal"):
        rel = f"town/{site}_{kind}.webp"
        with Image.open(os.path.join(pack, rel)) as im:
            w, h = im.size
        # the grid: cols columns of square layers, ceil(layers / cols) rows
        cols = None
        for c in range(1, layers + 1):
            size = w // c
            if size * c == w and h == size * -(-layers // c):
                cols = c
                break
        if cols is None:
            raise SystemExit(f"{rel}: {w}x{h} is no grid of {layers} square layers")
        name = man["files"][kind]["name"]
        base_file = os.path.normpath(os.path.join(folder, name))
        add(base_file, base_file, "town", f"town:{site}", rel, dict(layerSize=w // cols, layers=layers, cols=cols))
        if man["files"][kind]["sha256"] != files[base_file]["baseSha256"]:
            raise SystemExit(f"{base_file}: the shipped file's hash isn't its manifest's")

# Character maps (the second looks have no normal map of their own).
chars = os.path.join(pack, "chars")
for f in sorted(os.listdir(chars)) if os.path.isdir(chars) else []:
    if not f.endswith(".webp"):
        continue
    look = f.rsplit("_", 1)[0]
    add(f"characters/{f}", os.path.join("characters", f), "chars", f"chars:{look}", f"chars/{f}")

# The vegetation mesh atlas (embedded in vegetation.glb).
if os.path.exists(os.path.join(pack, "vegetation", "atlas.webp")):
    add("vegetation/vegetation.glb#vegetation_atlas", "vegetation/vegetation.glb", "vegetation", "vegetation", "vegetation/atlas.webp")

out = dict(version=1, files=files)
with open(os.path.join(pack, "manifest.json"), "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
total = sum(e["bytes"] for e in files.values())
print(f"ARTPACKS manifest: {len(files)} files, {total} bytes")
