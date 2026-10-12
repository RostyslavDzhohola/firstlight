// The persistence API rooms call. Every function takes the game.db handle first (`gameDb()` after
// boot) and is synchronous (better-sqlite3); multi-step writes run in one transaction.

export { gameDb, openGameDb, setGameDb, type Db } from "./game-db.ts";
export * from "./accounts.ts";
export * from "./characters.ts";
export * from "./piles.ts";
export * from "./sessions.ts";
export { linkAccounts, type LinkResult } from "./link.ts";
export { displayNameProblem, isOffensiveName, NAME_MESSAGES, type NameProblem } from "./names.ts";
