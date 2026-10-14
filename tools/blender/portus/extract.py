# Extract only the glTF folder and licence text of a kit archive into a fresh, empty directory.
# Data only: members are checked for absolute paths and traversal; nothing in the archive is run.
#
#   python3 -I extract.py <archive.zip> <prefix inside the archive> <empty output dir>
import os, sys, zipfile

zip_path, prefix, out = sys.argv[1], sys.argv[2], sys.argv[3]
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
        if not (rel.startswith("glTF/") or rel.lower().startswith("license")):
            continue
        if rel.startswith("/") or ".." in rel.split("/"):
            raise SystemExit(f"extract: unsafe member {name!r}")
        ext = os.path.splitext(rel)[1].lower()
        if ext not in (".gltf", ".bin", ".png", ".txt"):
            continue
        dest = os.path.realpath(os.path.join(root, rel))
        if not dest.startswith(root + os.sep):
            raise SystemExit(f"extract: unsafe member {name!r}")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with z.open(m) as src, open(dest, "wb") as dst:
            dst.write(src.read())
        n += 1
print(f"extract: {n} files from {os.path.basename(zip_path)} -> {out}")
