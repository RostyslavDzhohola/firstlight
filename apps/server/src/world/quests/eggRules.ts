// The Easter eggs' rules (docs/content.md §6): symbol and rope orders, the keypad code, counts and
// windows. They are the answers, so they live here on the server only and never in packages/shared,
// which the client bundle imports (#41). The server decides every egg step (quests/eggs.ts); the
// client only draws the props (shared content/world.ts) and shows what the server answers.

/** Tuning for the egg mechanics (content.md §6): the answers. */
export const EGG_RULES = {
  E1_COST: 1,
  E2_ORDER: ["rain", "leaf", "sun", "flame"] as const,
  E2_PENALTY_HOPBITS: 3,
  E3_FOLLOW_SECONDS: 60,
  E3_FOLLOW_METRES: 15,
  E3_BURROW_OPEN_MS: 5 * 60_000,
  E4_LANTERNS: 7,
  E4_WINDOW_MS: 180_000,
  E4_FERRY_MS: 60_000,
  E5_ORDER: ["skull", "lantern", "candle"] as const,
  E5_PENALTY_BONEWALKERS: 2,
  E7_CODE: "7041",
  E8_LAMPS: 5,
  E8_WINDOW_MS: 20_000,
  E8_LAMP_RADIUS: 0.6,
  /** How long an opened passage (burrow, ferry ride, hatch, lift, well) stays valid for that player. */
  PASSAGE_MS: 5 * 60_000,
} as const;
