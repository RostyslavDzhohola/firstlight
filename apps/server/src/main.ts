// Production entry point.

import { createGame } from "./app.ts";
import { accountsConfigFromEnv, createAccounts } from "./auth/accounts.ts";
import { devVerifier } from "./auth/identity.ts";
import { env } from "./env.ts";
import { isBanned } from "./db/index.ts";
import { bannedCheck } from "./world/BodyRoom.ts";
import { gameDb } from "./db/index.ts";
import { characterRepo } from "./world/characters.ts";
import { pileStore } from "./world/piles.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "./world/sqliteStores.ts";

// Refuse to boot an insecure production config (review): dev guests would allow impersonation, and a
// missing origin secret makes forwarded IPs spoofable.
if (env.production) {
  const problems: string[] = [];
  if (env.allowDevGuests) problems.push("ALLOW_DEV_GUESTS must not be set in production");
  if (!env.originSecret) problems.push("ORIGIN_SECRET is required in production");
  if (!process.env.BETTER_AUTH_URL) problems.push("BETTER_AUTH_URL is required in production");
  if (!process.env.CLIENT_ORIGIN) problems.push("CLIENT_ORIGIN is required in production");
  if (!process.env.BETTER_AUTH_SECRET) problems.push("BETTER_AUTH_SECRET is required in production");
  if (problems.length) {
    for (const p of problems) console.error(`config: ${p}`);
    process.exit(1);
  }
}

const accounts = await createAccounts({
  ...accountsConfigFromEnv(env),
  fallbackVerifier: devVerifier(env.allowDevGuests),
});

// Characters and piles live in game.db from here on (survive restarts and deploys).
characterRepo.current = new SqliteCharacterRepo(gameDb());
pileStore.current = new SqlitePileStore(gameDb());
bannedCheck.current = (userId) => isBanned(gameDb(), userId);

const game = await createGame({
  port: env.port,
  verify: accounts.verify,
  limits: {
    maxClients: env.maxClients,
    soloFillLimit: env.soloFillLimit,
    maxCopiesPerBody: env.maxCopiesPerBody,
    globalCap: env.globalCap,
  },
  allowedOrigins: env.clientOrigins,
  gracefulShutdown: true,
  mountBeforeJson: accounts.mountBeforeJson,
  mountAfterJson: accounts.mountAfterJson,
  onShutdown: () => accounts.close(),
});

console.log(`FIRSTLIGHT server listening on :${game.port} (mail: ${accounts.mailer.kind})`);
