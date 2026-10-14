#!/usr/bin/env bash
# Portus town: offline rebuild of the shipped town from the already-downloaded CC0 kits.
# Never downloads anything and never runs code from the kits: the archives are checked against
# their SHA-256, only their glTF folders and licence texts are extracted (extract.py, data only)
# into a fresh temporary folder, and Blender reads them as glTF/PNG data with autoexec disabled.
#
#   tools/blender/portus/build.sh            # writes apps/client/public/assets-dev/portus/* and
#                                            # packages/shared/src/content/portusTown.ts
#
# Env: VILLAGE_ZIP, NATURE_ZIP (kit archives), BLENDER, GLTF_CLI (pinned gltf-transform 4.5.1),
#      KEEP_WORK=1 (keep the temporary folder: design build, packed raw output, logs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
VILLAGE_ZIP="${VILLAGE_ZIP:-/tmp/fl-art-src/village/download.zip}"
NATURE_ZIP="${NATURE_ZIP:-/tmp/fl-art-src/nature/download.zip}"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
OUT="$ROOT/apps/client/public/assets-dev/portus"
TS="$ROOT/packages/shared/src/content/portusTown.ts"
WORK="$(mktemp -d /tmp/fl-portus-build.XXXXXX)"
if [ "${KEEP_WORK:-0}" = "1" ]; then echo "work folder: $WORK"; else trap 'chmod -R u+rwX "$WORK"; rm -rf "$WORK"' EXIT; fi

# Medieval Village MegaKit [Standard] and Stylized Nature MegaKit [Standard] (Quaternius, CC0).
printf '%s  %s\n' e60dea67c10f30dccccfbff92a7933f5ea5cfe99be0e2a0fa5118cceabeec5c4 "$VILLAGE_ZIP" | shasum -a 256 -c - >/dev/null
printf '%s  %s\n' 298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9 "$NATURE_ZIP" | shasum -a 256 -c - >/dev/null
mkdir "$WORK/village" "$WORK/nature" "$WORK/design" "$WORK/packed" "$WORK/ship"
(cd "$HERE" && python3 -I "$HERE/extract.py" "$VILLAGE_ZIP" "Medieval Village MegaKit[Standard]/" "$WORK/village")
(cd "$HERE" && python3 -I "$HERE/extract.py" "$NATURE_ZIP" "" "$WORK/nature")

# 1. The design build: prefabs, layout, ground features (about 10 s).
(cd "$HERE" && "$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1 --python "$HERE/build.py" -- \
  --village "$WORK/village/glTF" --nature "$WORK/nature/glTF" --out "$WORK/design" --renders none) > "$WORK/build.log" 2>&1 \
  || { tail -40 "$WORK/build.log"; exit 1; }
grep -q "validation: 0 problem" "$WORK/build.log" || { grep -i "problem" "$WORK/build.log"; echo "layout validation failed"; exit 1; }

# 2. Pack: one GLB (one node per prefab and LOD, two materials), two WebP layer strips, town.json
#    (about 3 min: Cycles renders the four tree impostors).
(cd "$HERE" && "$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1 --python "$HERE/pack.py" -- \
  --design "$WORK/design" --out "$WORK/packed") > "$WORK/pack.log" 2>&1 || { tail -40 "$WORK/pack.log"; exit 1; }

# 3. Meshopt compression with the pinned gltf-transform from the pnpm dlx cache (no registry access).
GLTF_CLI="${GLTF_CLI:-$(python3 -I - <<'PY'
from pathlib import Path
for path in (Path.home() / 'Library/Caches/pnpm/dlx').glob('*/**/@gltf-transform/cli/bin/cli.js'):
    if '@gltf-transform+cli@4.5.1' in str(path):
        print(path)
        break
else:
    raise SystemExit('Pinned gltf-transform 4.5.1 missing from the pnpm cache; supply GLTF_CLI')
PY
)}"
# 16-bit positions: the paving decal spans 170 m and lies 2-7.5 cm above the ground.
(cd "$ROOT" && pnpm exec node "$GLTF_CLI" meshopt "$WORK/packed/portus_raw.glb" "$WORK/ship/portus.glb" \
  --level high --quantize-position 16 --quantize-normal 10 --quantize-texcoord 12 --quantize-color 8) > "$WORK/meshopt.log" 2>&1 \
  || { cat "$WORK/meshopt.log"; exit 1; }
cp "$WORK/packed/portus_color.webp" "$WORK/packed/portus_normal.webp" "$WORK/ship/"

# 4. Shared data + manifest, then install.
python3 -I "$HERE/gen_town.py" "$WORK/packed" "$WORK/ship" "$TS"
mkdir -p "$OUT"
rm -f "$OUT"/*
cp "$WORK/ship/"* "$OUT/"
python3 -I - "$OUT" <<'PY'
from pathlib import Path
import sys
size = sum(p.stat().st_size for p in Path(sys.argv[1]).iterdir())
assert size <= 6_000_000, f'Portus town exceeds 6 MB: {size}'
print(f'PORTUS shipped bytes: {size}')
PY
