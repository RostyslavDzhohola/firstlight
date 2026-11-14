// The held items sculpted as code (tools/blender/props3d, #54): each has a GLB and textures under
// `<assetBase>/weapons/` (render/avatars/sculpted.ts draws them) and a rendered inventory icon there
// (ui/sprites.ts). No three here: the HUD imports it.

/** Weapon ids with a sculpted model and a rendered icon (`weapons/<id>.glb`, `weapons/icon_<id>.webp`). */
export const SCULPTED_WEAPONS: readonly string[] = ["emberglass", "axe", "longbow", "boarspear", "crossbow", "lantern"];
