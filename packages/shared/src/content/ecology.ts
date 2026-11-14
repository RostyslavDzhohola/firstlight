// The food chain, first version (#15): forage → Woolbacks → Dusk Wolves, one population of each per
// region cell (planet/regions.ts) on every planet. The numbers live here (docs/content.md §ecology
// mirrors them); the server runs the model (apps/server/src/world/npc/ecology.ts) and maps it onto the
// real herds and packs near players. All rates are per second of world time.

/** The species in the chain (NPC def ids). Everything else keeps its respawn timer. */
export const ECO_GRAZER = "woolback";
export const ECO_PREDATOR = "dusk_wolf";

export const ECO = {
  /** Model step (s): the counters move this often (the NPC scan runs every 0.5 s and accumulates). */
  stepSeconds: 5,

  // ---- forage (0..1 per cell: grass worth eating)
  /** Logistic regrowth of the grass, and a trickle from seed so a grazed-bare cell always recovers. */
  forageRegrow: 1 / 400,
  forageSeed: 1 / 4000,
  /** How fast a full herd (w = k) eats the grass down. */
  graze: 1 / 600,

  // ---- grazers (Woolbacks)
  /** Births per Woolback per second at full forage in an empty field (logistic toward k). */
  birth: 1 / 150,
  /** Below this much forage the herd goes hungry and thins. */
  hungerForage: 0.25,
  starve: 1 / 200,

  // ---- predators (Dusk Wolves): Holling type II hunting, breeding toward what the prey can feed
  /** Kills per wolf per second when prey is plentiful, and the fill (w/k) at which it is half that. */
  attack: 1 / 360,
  halfFill: 0.5,
  /** Wolves breed (logistic, per second) toward kp × min(1, w/k ÷ fedFill): fewer prey, fewer wolves. */
  predBreed: 1 / 600,
  fedFill: 0.6,
  /** A kill feeds the pack: wolves gained per kill (bounded by the ceiling). */
  convert: 0.1,

  // ---- bounds and wandering in
  /** Neither population ever falls below this share of its cell's capacity: the rest wander in. */
  floor: 0.15,
  /** How fast a cell below the floor refills from wanderers (capacity per second). */
  wanderIn: 1 / 300,
  /** Pull toward the planet's mean fill (migration between regions), per second. */
  migrate: 1 / 600,
  /** No cell holds more than this many times its capacity. */
  ceiling: 1.4,

  // ---- capacity per cell
  /** Woolbacks (wolves) the cell supports per herd (pack) slot in it, and the least any cell supports. */
  kPerSlot: 1,
  minGrazers: 4,
  minPredators: 1.5,
  /** More players in a cell raise its capacity (a crowd doesn't empty a field): +25% each, up to +75%. */
  crowdStep: 0.25,
  crowdMax: 3,

  // ---- the real herds and packs near players
  /** A cleared herd or pack comes back as fast as the old timer at full fill, never while its cell is near-empty. */
  returnBelowFill: 0.2,
  /** A live herd below its cell's fill gains one member (born or wandering in) about this often (s). */
  refillSeconds: 40,
  /** Returning herds and packs walk in from this far (m), not out of thin air at their old spot. */
  arriveFrom: 22,
  /** Wolves look for prey this far (m) when nobody is near to fight, about this often per wolf (s). */
  huntRadius: 45,
  huntEverySeconds: 50,
  /** A hunt gives up after this long (s); prey bolts when a hunting wolf is this close (m). */
  huntSeconds: 25,
  preyFleeRadius: 14,
  /** A wolf that has eaten rests this long (s). */
  feedSeconds: 10,
} as const;
