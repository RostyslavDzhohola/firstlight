import { BODIES, createTerrain, padDirs } from "@firstlight/shared";
import { PLACES, placeDir, padName } from "@firstlight/shared/content/places";
const terr: any = {};
for (const p of PLACES) { const b = BODIES[p.body]; terr[p.body] ??= createTerrain(b); const d = placeDir(p); console.log(p.id.padEnd(22), terr[p.body].groundHeight(...d).toFixed(1)); }
for (const id of ["arcadia","hollowmere","meridian"] as const) console.log(id, padDirs(BODIES[id]).map((_,i)=>padName(id,i)).join(" | "));
