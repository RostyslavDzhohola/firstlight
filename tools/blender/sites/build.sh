#!/usr/bin/env bash
# Wild sites (lane world, 2026-11-13): rebuild the site prefabs from tools/blender/sites/build_sites.py.
# Nothing is downloaded and no third-party file is read: every mesh is built from primitives in the script.
#
#   tools/blender/sites/build.sh            # writes apps/client/public/assets-dev/sites/sites_<body>.glb,
#                                           # packages/shared/src/content/wildSitePrefabs.ts
#   RENDERS=all tools/blender/sites/build.sh  # also renders every prefab alone and a labelled sheet into $WORK
#
# Env: BLENDER, RENDERS (none | all | a,b), KEEP_WORK=1 (keep the temporary folder).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
OUT="$ROOT/apps/client/public/assets-dev/sites"
TS="$ROOT/packages/shared/src/content/wildSitePrefabs.ts"
WORK="$(mktemp -d /tmp/fl-sites-build.XXXXXX)"
if [ "${KEEP_WORK:-0}" = "1" ] || [ "${RENDERS:-none}" != "none" ]; then echo "work folder: $WORK"; else trap 'rm -rf "$WORK"' EXIT; fi
(cd "$HERE" && "$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1 --python "$HERE/build_sites.py" -- \
  --out "$WORK" --renders "${RENDERS:-none}") > "$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; exit 1; }
grep -E "^SITE|^EXPORTED" "$WORK/build.log"
python3 -I "$HERE/gen_sites.py" "$WORK/sites.json" "$WORK" "$TS"
mkdir -p "$OUT"
for BODY in arcadia hollowmere meridian; do cp "$WORK/sites_$BODY.glb" "$OUT/"; done
if [ "${RENDERS:-none}" != "none" ]; then
  ffmpeg -y -loglevel error -pattern_type glob -i "$WORK/render_*.png" -vf "scale=480:-1,tile=3x3" -frames:v 1 "$WORK/sheet.png"
  echo "sheet: $WORK/sheet.png"
fi
python3 -I - "$OUT" <<'PY'
from pathlib import Path
import sys
size = sum(p.stat().st_size for p in Path(sys.argv[1]).iterdir())
assert size <= 1_500_000, f'wild sites exceed 1.5 MB: {size}'
print(f'SITES shipped bytes: {size}')
PY
