#!/usr/bin/env bash
# FIRSTLIGHT sculpted props: the reference folder the props tools read (#57), rebuilt from the repo.
#
#   tools/blender/props3d/ref.sh [<dir>]        default /tmp/fl-props/ref (the tools' --chars default)
#
# <dir>: the shipped characters (GLB, albedo/normal as PNG), starters_anims.glb, and
# today_weapons.json: today's code-built held items (apps/client/src/render/avatars/weapons.ts), dumped
# by a client test. Blender reads the shipped meshopt GLBs as they are. Our own code: MIT.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REF="${1:-/tmp/fl-props/ref}"
CH="$ROOT/apps/client/public/assets-dev/characters"
mkdir -p "$REF"
cp "$CH"/starters_anims.glb "$REF/"
for n in hexwick ash kappa unit7 ninja; do
  cp "$CH/$n.glb" "$REF/"
  python3 -I -c 'import sys; from PIL import Image
for k in ("albedo", "normal"):
    im = Image.open(f"{sys.argv[1]}/{sys.argv[3]}_{k}.webp")
    im.convert("RGBA" if k == "albedo" else "RGB").save(f"{sys.argv[2]}/{sys.argv[3]}_{k}.png")' "$CH" "$REF" "$n"
done
(cd "$ROOT" && FL_DUMP_WEAPONS="$REF/today_weapons.json" pnpm vitest run apps/client/src/render/avatars/weapons.test.ts >/dev/null)
ls "$REF"
