#!/usr/bin/env bash
# Pad platforms and pad-0 outposts (Arcadia, Hollowmere, Meridian): offline rebuild of the shipped assets
# from the already-downloaded CC0 kits. Never downloads anything and never runs code from the kits: the
# archives are checked against their SHA-256, only their glTF folders, textures and licence texts are
# extracted (data only) into a fresh temporary folder, and Blender reads them as glTF/PNG data with
# autoexec disabled.
#
#   tools/blender/pads/build.sh        # writes apps/client/public/assets-dev/outposts/<body>/* and
#                                      # packages/shared/src/content/padOutposts.ts
#
# Env: VILLAGE_ZIP, NATURE_ZIP, SCIFI_ZIP (kit archives), BLENDER, GLTF_CLI (pinned gltf-transform 4.5.1),
#      KEEP_WORK=1 (keep the temporary folder: site data, design builds, packed raw output, logs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
VILLAGE_ZIP="${VILLAGE_ZIP:-/tmp/fl-art-src/village/download.zip}"
NATURE_ZIP="${NATURE_ZIP:-/tmp/fl-art-src/nature/download.zip}"
SCIFI_ZIP="${SCIFI_ZIP:-/tmp/fl-art-src/scifi-megakit/download.zip}"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
OUT="$ROOT/apps/client/public/assets-dev/outposts"
PORTUS="$ROOT/apps/client/public/assets-dev/portus"
TS="$ROOT/packages/shared/src/content/padOutposts.ts"
WORK="$(mktemp -d /tmp/fl-outposts-build.XXXXXX)"
if [ "${KEEP_WORK:-0}" = "1" ]; then echo "work folder: $WORK"; else trap 'chmod -R u+rwX "$WORK"; rm -rf "$WORK"' EXIT; fi

# Medieval Village MegaKit, Stylized Nature MegaKit and Modular SciFi MegaKit [Standard] (Quaternius, CC0).
printf '%s  %s\n' e60dea67c10f30dccccfbff92a7933f5ea5cfe99be0e2a0fa5118cceabeec5c4 "$VILLAGE_ZIP" | shasum -a 256 -c - >/dev/null
printf '%s  %s\n' 298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9 "$NATURE_ZIP" | shasum -a 256 -c - >/dev/null
printf '%s  %s\n' 6fae60cf5189e44dff0bd91097f094a765acc6d57d64a85a0cc0dd56e03035e3 "$SCIFI_ZIP" | shasum -a 256 -c - >/dev/null
mkdir "$WORK/village" "$WORK/nature" "$WORK/scifi" "$WORK/data" "$WORK/packed" "$WORK/ship"
(cd "$HERE" && python3 -I "$HERE/../portus/extract.py" "$VILLAGE_ZIP" "Medieval Village MegaKit[Standard]/" "$WORK/village")
(cd "$HERE" && python3 -I "$HERE/../portus/extract.py" "$NATURE_ZIP" "" "$WORK/nature")
(cd "$HERE" && python3 -I "$HERE/extract_kit.py" "$SCIFI_ZIP" "Modular SciFi MegaKit[Standard]/" "$WORK/scifi" glTF Textures)

# 0. The sites as the game sees them (ground heights, breakables, props, portal, guide) from the shared code.
(cd "$ROOT" && node "$HERE/site_data.mjs" "$ROOT" "$WORK/data") > "$WORK/site_data.log" 2>&1 || { cat "$WORK/site_data.log"; exit 1; }

for BODY in arcadia hollowmere meridian; do
  # 1. The design build: prefabs (GLB) and the validated layout (about 5 s per body).
  mkdir "$WORK/design_$BODY"
  (cd "$HERE" && "$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1 --python "$HERE/design.py" -- \
    --body "$BODY" --site "$WORK/data/site_$BODY.json" --village "$WORK/village/glTF" --nature "$WORK/nature/glTF" \
    --scifi "$WORK/scifi" --out "$WORK/design_$BODY" --export-dir "$WORK/design_$BODY/prefabs" --export-only) \
    > "$WORK/design_$BODY.log" 2>&1 || { tail -40 "$WORK/design_$BODY.log"; exit 1; }
  grep -q "validation: 0 problems" "$WORK/design_$BODY.log" || { grep -i "problem" "$WORK/design_$BODY.log"; echo "$BODY: layout validation failed"; exit 1; }
  # 2. Pack: one GLB (one node per prefab and LOD, two materials) and, for Meridian, its layer strips.
  mkdir -p "$WORK/packed/$BODY" "$WORK/ship/$BODY"
  (cd "$HERE" && "$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1 --python "$HERE/pack.py" -- \
    --body "$BODY" --design "$WORK/design_$BODY" --out "$WORK/packed/$BODY") > "$WORK/pack_$BODY.log" 2>&1 \
    || { tail -40 "$WORK/pack_$BODY.log"; exit 1; }
done

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
for BODY in arcadia hollowmere meridian; do
  (cd "$ROOT" && pnpm exec node "$GLTF_CLI" meshopt "$WORK/packed/$BODY/${BODY}_raw.glb" "$WORK/ship/$BODY/$BODY.glb" \
    --level high --quantize-position 16 --quantize-normal 10 --quantize-texcoord 12 --quantize-color 8) > "$WORK/meshopt_$BODY.log" 2>&1 \
    || { cat "$WORK/meshopt_$BODY.log"; exit 1; }
  if [ -f "$WORK/packed/$BODY/${BODY}_color.webp" ]; then cp "$WORK/packed/$BODY/${BODY}_color.webp" "$WORK/packed/$BODY/${BODY}_normal.webp" "$WORK/ship/$BODY/"; fi
done

# 4. Shared data + manifests (Arcadia and Hollowmere reference the shipped Portus strips), then install.
python3 -I "$HERE/gen_outposts.py" "$WORK/packed" "$WORK/ship" "$TS" "$PORTUS"
for BODY in arcadia hollowmere meridian; do
  mkdir -p "$OUT/$BODY"
  rm -f "$OUT/$BODY"/*
  cp "$WORK/ship/$BODY/"* "$OUT/$BODY/"
done
python3 -I - "$OUT" <<'PY'
from pathlib import Path
import sys
for d in sorted(Path(sys.argv[1]).iterdir()):
    size = sum(p.stat().st_size for p in d.iterdir())
    assert size <= 2_000_000, f'{d.name} outpost exceeds 2 MB: {size}'
    print(f'OUTPOST {d.name} shipped bytes (own files): {size}')
PY
