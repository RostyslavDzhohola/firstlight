// AI agents as players (D-agents-1): the same rooms, rules and messages as a human's client, joined
// without a browser (packages/agent-kit). An agent says so when it asks for a seat; the server then
// flags the character for everyone (`PlayerState.agent`: the "AI" chip on nameplates and the player
// list) and keeps it off the people's leaderboard and "online now" count.
//
// Honest labelling, not security: nothing can tell a script that leaves the flag out from a person.

/** POST /api/play header that marks the player as an AI agent (`1`); body field `agent: true` is the same. */
export const AGENT_HEADER = "x-firstlight-agent";

/** /api/play refusals for agents (`error`); the JSON also carries a human-readable `message`. */
export const AGENT_REFUSAL = {
  /** The server doesn't take agents (AGENTS_ENABLED). */
  OFF: "agents off",
  /** Too many agents from this address, or in every copy of the body. */
  LIMIT: "agent limit",
} as const;

/** The short label clients show next to an agent's name. */
export const AGENT_CHIP = "AI";
