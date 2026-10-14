#!/usr/bin/env bash
# Offline rebuild from the already-downloaded Standard pack. Never downloads or runs pack code.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="${SRC:-/tmp/fl-art-src/nature}"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
WORK="$(mktemp -d /tmp/fl-vegetation.XXXXXX)"
# Pack directories can be read-only. Restore owner permissions before removing our scratch tree.
trap 'chmod -R u+rwX "$WORK"; rm -rf "$WORK"' EXIT
PACK="$WORK/pack"
OUT="$ROOT/apps/client/public/assets-dev/vegetation"
printf '%s  %s\n' 298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9 "$SRC/download.zip" | shasum -a 256 -c - >/dev/null
mkdir "$PACK"
unzip -q "$SRC/download.zip" -d "$PACK"
"$BLENDER" --python-exit-code 1 -b --disable-autoexec --factory-startup --python "$HERE/build_vegetation.py" -- --pack "$PACK" --out "$WORK"
mkdir -p "$OUT"
# Use only the pinned pnpm dlx cache. No registry access; fail if the CLI is missing.
GLTF_CLI="${GLTF_CLI:-$(python3 -I - <<'PY2'
from pathlib import Path
paths = list((Path.home() / 'Library/Caches/pnpm/dlx').glob('*/**/@gltf-transform/cli/bin/cli.js'))
for path in paths:
    if '@gltf-transform+cli@4.5.1' in str(path):
        print(path)
        break
else:
    raise SystemExit('Pinned gltf-transform 4.5.1 missing from pnpm cache; supply GLTF_CLI')
PY2
)}"
pnpm exec node "$GLTF_CLI" optimize "$WORK/vegetation.glb" "$OUT/vegetation.glb" \
  --compress meshopt --simplify false --flatten false --join false --instance false --palette false \
  --texture-compress false --prune-attributes false --weld false
cp "$WORK/manifest.json" "$OUT/manifest.json"
python3 -I - "$OUT" <<'PY'
from pathlib import Path
import sys
size = sum(p.stat().st_size for p in Path(sys.argv[1]).iterdir())
assert size <= 4_000_000, f'vegetation exceeds 4 MB: {size}'
print(f'VEGETATION shipped bytes: {size}')
PY
