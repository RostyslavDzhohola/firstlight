# FIRSTLIGHT sculpted characters: PNG -> WebP for the client. Our own code: MIT.
#
#   python3 -I webp.py <raw dir> <out dir> hexwick ash ...     textures (1024² + a 512² Low set);
#                                                               albedo keeps its alpha (accent mask)
#   python3 -I webp.py --ui <render dir> <out dir>              hero_*.png / portrait_*.png renders

import os
import sys

from PIL import Image


def ui(src, out):
    os.makedirs(out, exist_ok=True)
    for f in sorted(os.listdir(src)):
        if not (f.startswith("hero_") or f.startswith("portrait_") or f.startswith("lineup")) or not f.endswith(".png"):
            continue
        im = Image.open(os.path.join(src, f)).convert("RGBA")
        path = os.path.join(out, f[:-4] + ".webp")
        im.save(path, "WEBP", quality=88, method=6)
        print("WEBP", os.path.basename(path), os.path.getsize(path))


def main():
    if sys.argv[1] == "--ui":
        return ui(sys.argv[2], sys.argv[3])
    src, out, names = sys.argv[1], sys.argv[2], sys.argv[3:]
    os.makedirs(out, exist_ok=True)
    for n in names:
        for kind, q in (("albedo", 90), ("normal", 95)):
            im = Image.open(os.path.join(src, f"{n}_{kind}.png"))
            im = im.convert("RGBA" if kind == "albedo" else "RGB")
            for size, suffix in ((im.width, ""), (im.width // 2, "_512")):
                img = im if size == im.width else im.resize((size, size), Image.LANCZOS)
                path = os.path.join(out, f"{n}_{kind}{suffix}.webp")
                img.save(path, "WEBP", quality=q, method=6, exact=True)
                print("WEBP", os.path.basename(path), os.path.getsize(path))


main()
