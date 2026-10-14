// Model choice uses the existing packed yaw seed. The Float32 round trip is intentional:
// a worker transfer and a direct client call must select the same variant.
import { hash01, PROP_KINDS, type BodyId, type PropKind } from "@firstlight/shared";

const COMMON = ["CommonTree_1", "CommonTree_2", "CommonTree_3"];
const TWISTED = ["TwistedTree_1", "TwistedTree_2", "TwistedTree_3"];
const ROCKS = ["Rock_Medium_1", "Rock_Medium_2", "Rock_Medium_3"];
const MODELS: Record<PropKind, readonly (string | null)[]> = {
  oak: COMMON,
  pine: ["Pine_1", "Pine_2", "Pine_3"],
  bush: ["Bush_Common", "Bush_Common_Flowers"],
  rock: ROCKS,
  boulder: ROCKS,
  deadtree: ["DeadTree_1", "DeadTree_2", "DeadTree_3"],
  reed: ["Plant_1_Big", "Plant_1"],
  scrub: ["Plant_7", "Plant_7_Big"],
  spire: [null],
  blossom: COMMON,
  fern: ["Fern_1"],
  flower: ["Flower_3_Group", "Flower_4_Group"],
  mushroom: ["Mushroom_Common", "Mushroom_Laetiporus"],
};

export function vegetationModels(body: BodyId, kind: PropKind): readonly (string | null)[] {
  return body === "hollowmere" && kind === "oak" ? TWISTED : MODELS[kind];
}

export function vegetationVariant(body: BodyId, kind: PropKind, yaw: number): number {
  return Math.floor(hash01(Math.floor(Math.fround(yaw) * 1e4), PROP_KINDS.indexOf(kind), 91) * vegetationModels(body, kind).length);
}
