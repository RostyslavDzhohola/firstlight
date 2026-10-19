// HD art packs (#48, D-artpacks): higher-resolution textures for the town and outposts, the characters
// and the vegetation, downloaded after the player is in the world and swapped into the same materials
// (render/artpacks/ArtPacks.ts). This file is the catalogue: which tiers take which pack (measured on
// the owner's M1, frame rate first), the manifest's shape and the GPU-memory arithmetic.
//
// The packs live next to the shipped art, under `${config.assetBase}/packs/hd/` (built by
// tools/blender/artpacks). Every file names the shipped file it replaces and that file's SHA-256, so a
// pack built for another build of the base art is never swapped in.

import type { Tier } from "../quality.ts";

export const PACK_IDS = ["town", "chars", "vegetation"] as const;
export type PackId = (typeof PACK_IDS)[number];

/**
 * The tiers that take each pack. Texture size costs memory and upload time, not shading time, so a
 * pack goes to every tier where it measurably costs no frame rate on the owner's M1 (both backends,
 * 60 s sustained) within the GPU-memory budget below; Low stays as shipped (D-artpacks-2).
 */
export const PACK_TIERS: Record<PackId, readonly Tier[]> = {
  town: ["medium", "high", "ultra"],
  chars: ["medium", "high", "ultra"],
  vegetation: ["medium", "high", "ultra"],
};

/**
 * The most GPU memory every pack together may add over the shipped textures (bytes, mips included,
 * HD minus the base it replaces). The M1 Air has 8 GB shared by the system, the browser and the
 * owner's own apps (D-artpacks-3).
 */
export const GPU_PACK_BUDGET_BYTES = 256 * 1024 * 1024;

/** One HD file of a pack: what it replaces and how it is laid out. */
export interface PackFile {
  pack: PackId;
  /** Files of one group swap together (a site's colour and normal strips, a look's albedo and normal map). */
  group: string;
  /** The HD file, relative to the pack folder. */
  file: string;
  bytes: number;
  sha256: string;
  /** The SHA-256 of the shipped file this one replaces (for an embedded texture, of the file holding it). */
  baseSha256: string;
  width: number;
  height: number;
  /** Layer strips (the town's array textures): layer size, layer count and grid columns (layer i at column i % cols, row ⌊i / cols⌋). */
  layerSize?: number;
  layers?: number;
  cols?: number;
}

export interface PackManifest {
  version: 1;
  /** Keyed by the shipped file it replaces, relative to the asset base ("portus/portus_color.webp"); an
   *  embedded texture by its file and name ("vegetation/vegetation.glb#vegetation_atlas"). */
  files: Record<string, PackFile>;
}

/** A manifest file with the shipped file it replaces. */
export interface PackEntry extends PackFile {
  /** The shipped file (the manifest key, relative to the asset base). */
  base: string;
}

/** The manifest's files by group, in manifest order. */
export function packGroups(m: PackManifest): Map<string, PackEntry[]> {
  const out = new Map<string, PackEntry[]>();
  for (const [base, f] of Object.entries(m.files)) {
    let g = out.get(f.group);
    if (!g) out.set(f.group, (g = []));
    g.push({ ...f, base });
  }
  return out;
}

/** The groups of `packs`, in manifest order. */
export function wantedGroups(m: PackManifest, packs: readonly PackId[]): { group: string; pack: PackId; files: PackEntry[] }[] {
  const out: { group: string; pack: PackId; files: PackEntry[] }[] = [];
  for (const [group, files] of packGroups(m)) {
    const pack = files[0]!.pack;
    if (packs.includes(pack)) out.push({ group, pack, files });
  }
  return out;
}

export interface PackChoice {
  /** auto: the tier table; on: every pack (or `only`) on any tier above Low; off: none. */
  mode: "auto" | "on" | "off";
  only?: PackId[];
}

/** `?packs` (on, or a list like `town,chars`), `?packs=off` and the `?nopacks` kill switch. */
export function parsePackFlag(value: string | null, killed: boolean): PackChoice {
  if (killed || value === "off" || value === "0") return { mode: "off" };
  if (value === null) return { mode: "auto" };
  if (value === "" || value === "on" || value === "1") return { mode: "on" };
  const only = value.split(",").filter((v): v is PackId => (PACK_IDS as readonly string[]).includes(v));
  return { mode: "on", only };
}

/** The packs a session on `tier` takes. */
export function packsFor(tier: Tier, choice: PackChoice): PackId[] {
  if (choice.mode === "off" || tier === "low") return [];
  if (choice.mode === "on") return PACK_IDS.filter((id) => !choice.only || choice.only.includes(id));
  return PACK_IDS.filter((id) => PACK_TIERS[id].includes(tier));
}

/** GPU bytes of an RGBA8 texture with its full mip chain (≈ 4/3 of the base level). */
export function textureGpuBytes(f: Pick<PackFile, "width" | "height" | "layerSize" | "layers" | "cols">): number {
  const texels = f.layers && f.layerSize ? f.layerSize * f.layerSize * f.layers : f.width * f.height;
  return Math.round((texels * 4 * 4) / 3);
}
