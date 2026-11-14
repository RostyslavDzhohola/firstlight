#!/usr/bin/env bash
# FIRSTLIGHT sculpted props: build every prop recipe (props3d/items), then compress the GLBs and make
# WebP textures for the client.
#
#   tools/blender/props3d/build.sh [emberglass axe longbow]      WORK=<dir> keeps the outputs there
#
# $WORK/raw: GLB (weapon space, Role vertex colours), albedo/normal PNG, <prop>_stats.json;
# $WORK/stage: meshopt GLB (same gltf-transform flags as chars3d/build.sh), WebP 512² + a 256² Low set.
# Nothing is installed into the client: weapons are still drawn by apps/client/src/render/avatars/weapons.ts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BLENDER="${BLENDER:-blender}"
BL=("$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1)
GLTF="pnpm dlx @gltf-transform/cli@4.5.1"
WORK="${WORK:-$(mktemp -d /tmp/fl-props.XXXXXX)}"
PROPS="${*:-emberglass axe longbow}"
mkdir -p "$WORK/raw" "$WORK/stage"
for p in $PROPS; do
  "${BL[@]}" --python "$HERE/build_prop.py" -- --prop "$p" --out "$WORK/raw" > "$WORK/build_$p.log" 2>&1 \
    || { tail -30 "$WORK/build_$p.log" >&2; exit 1; }
  grep -E "^PROP3D DONE $p:" "$WORK/build_$p.log" || { echo "no DONE marker for $p" >&2; exit 1; }
  $GLTF optimize "$WORK/raw/$p.glb" "$WORK/stage/$p.glb" --compress meshopt --simplify false --flatten false \
    --join false --instance false --palette false --texture-compress false --prune-attributes false \
    --weld false >/dev/null
  python3 -I "$HERE/../chars3d/webp.py" "$WORK/raw" "$WORK/stage" "$p"
done
ls -l "$WORK/stage"
