#!/usr/bin/env bash
# Rebuild the sculpted starter characters (headless; no GUI) and install them for the client.
#
#   tools/blender/chars3d/build.sh                     # fetch the CC0 rig + clips, build all five, install
#   SRC=/tmp/fl-src tools/blender/chars3d/build.sh     # reuse downloaded archives (hashes are re-checked)
#   CHARS="hexwick ninja" tools/blender/chars3d/build.sh   # only some starters
#   JOBS=1 tools/blender/chars3d/build.sh              # parallel Blender processes (default 1)
#
# 1. Downloads the Quaternius Universal Animation Library 1 + 2 (CC0; rig and clips only, read as glTF
#    by Blender with autoexec off) into new empty folders, checks the archive hashes (docs/ASSETS.md),
#    and extracts each verified archive into a fresh folder (a reused extraction is never trusted).
# 2. build.py per starter: SDF sculpt -> game mesh -> skin -> UVs -> textures (see build.py).
# 3. build_anims.py (tools/blender/characters) for the shared clips.
# 4. Hero renders (every palette) and portraits for the UI (render.py).
# 5. Textures and renders to WebP, GLBs through @gltf-transform/cli 4.5.1 (meshopt + quantisation),
#    all staged and checked against the expected file list before anything is copied into
#    apps/client/public/assets-dev/characters/.
# Every Blender run uses --python-exit-code 1, so a Python exception fails the build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
GLTF="pnpm dlx @gltf-transform/cli@4.5.1"
OUT_DEV="$ROOT/apps/client/public/assets-dev/characters"
WORK="${WORK:-$(mktemp -d /tmp/fl-chars3d.XXXXXX)}"
CHARS="${CHARS:-hexwick ash kappa unit7 ninja}"
JOBS="${JOBS:-1}"
BL=("$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1)

SHA_UAL1="cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724"
SHA_UAL2="4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68"

# itch_dl() from the first character pipeline (downloads only; it runs nothing it fetched)
eval "$(sed -n '/^itch_dl()/,/^}/p' "$HERE/../characters/build.sh")"

fetch() { # <dir> <game url> <sha> -> echoes a fresh extraction folder of the verified archive
  local dir="$1" game="$2" sha="$3" x
  if [ ! -f "$dir/download.zip" ]; then itch_dl "$game" "Standard" "$dir" >&2; fi
  echo "$sha  $dir/download.zip" | shasum -a 256 -c - >/dev/null || { echo "hash mismatch: $dir" >&2; exit 1; }
  x="$(mktemp -d "$WORK/src.XXXXXX")"
  unzip -q -o "$dir/download.zip" -d "$x"
  echo "$x"
}

SRC="${SRC:-$(mktemp -d /tmp/fl-chars-src.XXXXXX)}"
X1="$(fetch "$SRC/ual1" https://quaternius.itch.io/universal-animation-library "$SHA_UAL1")"
X2="$(fetch "$SRC/ual2" https://quaternius.itch.io/universal-animation-library-2 "$SHA_UAL2")"
UAL1="$(find "$X1" -name 'UAL1_Standard.glb' | head -1)"
UAL2="$(find "$X2" -name 'UAL2_Standard.glb' | head -1)"
[ -n "$UAL1" ] && [ -n "$UAL2" ] || { echo "UAL archives lack the expected GLBs" >&2; exit 1; }

mkdir -p "$WORK/raw" "$WORK/ui" "$WORK/stage"
run_char() {
  "${BL[@]}" --python "$HERE/build.py" -- --char "$1" --ual1 "$UAL1" --out "$WORK/raw" > "$WORK/build_$1.log" 2>&1 \
    || { tail -30 "$WORK/build_$1.log" >&2; return 1; }
  # build.py prints DONE only after the textures and the GLB are written
  grep -E "^CHAR3D DONE $1:" "$WORK/build_$1.log" || { echo "no DONE marker for $1" >&2; return 1; }
}
PIDS=()
for c in $CHARS; do
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$JOBS" ]; do sleep 5; done
  run_char "$c" &
  PIDS+=("$!")
done
FAILED=0
for pid in "${PIDS[@]}"; do wait "$pid" || FAILED=1; done
[ "$FAILED" = 0 ] || { echo "a character build failed (logs in $WORK)" >&2; exit 1; }
"${BL[@]}" --python "$HERE/../characters/build_anims.py" -- \
  --ual1 "$UAL1" --ual2 "$UAL2" --out "$WORK/raw/starters_anims.glb" | grep -E "^ANIMS"

# UI art: hero renders (every palette) and portraits, studio-lit for the spotlit pick screen
for c in $CHARS; do
  "${BL[@]}" --python "$HERE/render.py" -- --dir "$WORK/raw" --anims "$WORK/raw/starters_anims.glb" \
    --mode heroes --chars "$c" --look studio --out "$WORK/ui/hero" >/dev/null
  "${BL[@]}" --python "$HERE/render.py" -- --dir "$WORK/raw" --anims "$WORK/raw/starters_anims.glb" \
    --mode portraits --chars "$c" --look studio --out "$WORK/ui/portrait" >/dev/null
done

# stage: WebP textures and renders, compressed GLBs
python3 -I "$HERE/webp.py" "$WORK/raw" "$WORK/stage" $CHARS
python3 -I "$HERE/webp.py" --ui "$WORK/ui" "$WORK/stage"
for f in $CHARS starters_anims; do
  $GLTF optimize "$WORK/raw/$f.glb" "$WORK/stage/$f.glb" --compress meshopt --simplify false --flatten false \
    --join false --instance false --palette false --texture-compress false --prune-attributes false \
    --resample true --weld false >/dev/null
done

# check the full output list before installing anything
MISSING=0
need() { [ -s "$WORK/stage/$1" ] || { echo "missing or empty: $1" >&2; MISSING=1; }; }
need starters_anims.glb
for c in $CHARS; do
  need "$c.glb"
  for k in albedo normal; do need "${c}_$k.webp"; need "${c}_${k}_512.webp"; done
  need "portrait_$c.webp"
  for p in 0 1 2 3 4 5; do need "hero_${c}_$p.webp"; done
done
[ "$MISSING" = 0 ] || { echo "not installing: the output is incomplete (work dir $WORK)" >&2; exit 1; }

mkdir -p "$OUT_DEV"
cp "$WORK"/stage/* "$OUT_DEV/"
rm -f "$OUT_DEV/starters_atlas.png"
ls -l "$OUT_DEV"
echo "work dir: $WORK"
