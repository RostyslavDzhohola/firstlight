# FIRSTLIGHT sculpted characters: the build's PNG textures -> WebP for the client (1024² and a 512²
# set for the Low tier). Albedo keeps its alpha (the painted accent mask). Our own code: MIT.
#
#   python3 -I webp.py <raw dir> <out dir> hexwick ash ...

import os
import sys

from PIL import Image


def main():
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
