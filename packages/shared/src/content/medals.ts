// Medals (docs/content.md §7): 20 medals plus 9 hidden Easter-egg medals. Medals are account-bound
// and survive death; one can be worn as a title. "life" scope = the condition must be met within
// one life (since the last rebirth); "account" = cumulative. The server checks every condition.

export type MedalType = "progress" | "feat" | "survival" | "joke" | "hidden";
export type MedalScope = "life" | "account";

export interface MedalDef {
  id: string;
  /** Row in content.md §7 (1–20) or the egg id (E1–E9) for hidden medals. */
  ref: string;
  name: string;
  type: MedalType;
  condition: string;
  scope: MedalScope;
  /** Worn under your name. */
  title: string;
  hidden: boolean;
}

const M = (ref: string, id: string, name: string, type: MedalType, condition: string, scope: MedalScope, title: string): MedalDef => ({
  id, ref, name, type, condition, scope, title, hidden: type === "hidden",
});

export const MEDALS: readonly MedalDef[] = [
  M("1", "spark", "Spark", "progress", "Finish onboarding", "account", "Newcomer"),
  M("2", "ten_down", "Ten Down", "progress", "Reach level 10", "life", "Seasoned"),
  M("3", "firstlight", "Firstlight", "progress", "Reach level 20", "life", "Firstlighter"),
  M("4", "grand_tour", "Grand Tour", "progress", "Set foot on Arcadia, Hollowmere and Meridian", "life", "Wanderer"),
  M("5", "cartographer", "Cartographer", "progress", "Use every fast-travel pad on one planet (12 / 12 / 20)", "life", "Cartographer"),
  M("6", "errand_runner", "Errand Runner", "progress", "Complete all 9 missions", "life", "Reliable"),
  M("7", "tide_turner", "Tide Turner", "feat", "Loot-eligible on a Tidewrath kill", "account", "Tide Turner"),
  M("8", "regicide", "Regicide", "feat", "Loot-eligible on a Hollow King kill", "account", "Regicide"),
  M("9", "decommissioned", "Decommissioned", "feat", "Loot-eligible on a Receiver kill", "account", "Decommissioner"),
  M("10", "triple_crown", "Triple Crown", "feat", "Loot-eligible on all three bosses", "life", "Triple Crown"),
  M("11", "demolition_crew", "Demolition Crew", "feat", "Break 200 props", "account", "Wrecker"),
  M("12", "arc_welder", "Arc Welder", "feat", "One Stormcoil cast damages 4 different entities (needs T2+)", "account", "Conductor"),
  M("13", "long_shot", "Long Shot", "feat", "Kill a player or enemy with the Stillshot Rifle at 120 m or more", "account", "Farshot"),
  M("14", "back_for_my_stuff", "Back For My Stuff", "survival", "After a rebirth, pick up at least 1 item from the pile your previous life dropped", "account", "Persistent"),
  M("15", "untouchable", "Untouchable", "survival", "Loot-eligible on a boss kill having taken 0 damage from that boss, from your first hit to the kill", "account", "Untouchable"),
  M("16", "old_timer", "Old Timer", "survival", "3 h of online playtime in one life", "life", "Old Timer"),
  M("17", "by_a_thread", "By a Thread", "survival", "Drop to 5% max HP or less, then still be alive 60 s later", "account", "Lucky"),
  M("18", "killed_by_a_woolback", "Killed by a Woolback", "joke", "Die to a Woolback buck, or to fall damage within 5 s of a Woolback's knockback", "account", "Fleeced"),
  M("19", "with_friends_like_these", "With Friends Like These", "joke", "Be killed by a member of your current party", "account", "Trusting"),
  M("20", "own_goal", "Own Goal", "joke", "Die to your own Comet rocket, Scrapburst or Emberglass splash", "account", "Self-Starter"),
  M("E1", "behind_the_curtain", "Behind the Curtain", "hidden", "Claim the Lantern of Lacefall", "account", "Behind the Curtain"),
  M("E2", "new_high_score", "New High Score", "hidden", "Claim the Pixel Halo", "account", "New High Score"),
  M("E3", "follow_the_gold", "Follow the Gold", "hidden", "Claim the Golden Hopbit", "account", "Follow the Gold"),
  M("E4", "paid_the_ferryman", "Paid the Ferryman", "hidden", "Claim the Ferryman's Oar", "account", "Paid the Ferryman"),
  M("E5", "bellringer", "Bellringer", "hidden", "Claim the Candle Crown", "account", "Bellringer"),
  M("E6", "down_the_well", "Down the Well", "hidden", "Claim the Bone Bell", "account", "Down the Well"),
  M("E7", "employee_of_the_month", "Employee of the Month", "hidden", "Claim the Executive Visor", "account", "Employee of the Month"),
  M("E8", "lights_out", "Lights Out", "hidden", "Claim the Static Cloak", "account", "Lights Out"),
  M("E9", "not_a_clone", "Not a Clone", "hidden", "Claim the Ticket #000 Helmet", "account", "Not a Clone"),
];

export const MEDAL_BY_ID: ReadonlyMap<string, MedalDef> = new Map(MEDALS.map((m) => [m.id, m]));

/** Thresholds used by the server checks (content.md §7). */
export const MEDAL_RULES = {
  TEN_DOWN_LEVEL: 10,
  FIRSTLIGHT_LEVEL: 20,
  DEMOLITION_PROPS: 200,
  ARC_WELDER_TARGETS: 4,
  ARC_WELDER_MIN_TIER: 2,
  LONG_SHOT_METRES: 120,
  OLD_TIMER_MS: 3 * 60 * 60 * 1000,
  BY_A_THREAD_FRACTION: 0.05,
  BY_A_THREAD_MS: 60_000,
  WOOLBACK_FALL_WINDOW_MS: 5_000,
} as const;
