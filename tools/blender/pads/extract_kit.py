# Data-only extraction of chosen folders of a kit archive into a fresh, empty directory.
#   python3 -I extract_kit.py <archive.zip> <prefix inside the archive> <empty out dir> <folder>...
# Keeps members under <prefix><folder>/ for each folder, plus licence texts and preview PNGs at the
# top; only .gltf/.bin/.glb/.png/.txt; refuses absolute paths and traversal. Nothing is run.
import os, sys, zipfile
zip_path, prefix, out, folders = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
if os.path.exists(out) and os.listdir(out):
    raise SystemExit(f"extract: {out} is not empty")
os.makedirs(out, exist_ok=True)
root = os.path.realpath(out)
n = 0
with zipfile.ZipFile(zip_path) as z:
    for m in z.infolist():
        name = m.filename
        if m.is_dir() or not name.startswith(prefix):
            continue
        rel = name[len(prefix):]
        top = "/" not in rel
        if not (any(rel.startswith(f + "/") for f in folders) or (top and (rel.lower().startswith("license") or rel.lower().startswith("preview")))):
            continue
        if rel.startswith("/") or ".." in rel.split("/") or "\\" in rel:
            raise SystemExit(f"extract: unsafe member {name!r}")
        if os.path.splitext(rel)[1].lower() not in (".gltf", ".bin", ".glb", ".png", ".txt"):
            continue
        dest = os.path.realpath(os.path.join(root, rel))
        if not dest.startswith(root + os.sep):
            raise SystemExit(f"extract: unsafe member {name!r}")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with z.open(m) as src, open(dest, "wb") as dst:
            dst.write(src.read())
        n += 1
print(f"extract: {n} files from {os.path.basename(zip_path)} -> {out}")
