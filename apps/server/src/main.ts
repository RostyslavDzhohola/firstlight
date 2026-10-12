// Production entry point.

import { createGame } from "./app.ts";
import { accountsConfigFromEnv, createAccounts } from "./auth/accounts.ts";
import { devVerifier } from "./auth/identity.ts";
import { env } from "./env.ts";
import { gameDb } from "./db/index.ts";
import { characterRepo } from "./world/characters.ts";
import { pileStore } from "./world/piles.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "./world/sqliteStores.ts";
import { mountOps } from "./ops/admin.ts";
import { endAllSessions } from "./social/index.ts";
import { banExplainer } from "./social/refusal.ts";

const accounts = await createAccounts({
  ...accountsConfigFromEnv(env),
  fallbackVerifier: devVerifier(env.allowDevGuests),
});

// Characters and piles live in game.db from here on (survive restarts and deploys).
characterRepo.current = new SqliteCharacterRepo(gameDb());
pileStore.current = new SqlitePileStore(gameDb());

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
  explainRefusal: banExplainer(accounts),
  mountAfterJson: (app) => {
    accounts.mountAfterJson(app);
    mountOps(app, { db: accounts.db, requireAdmin: accounts.requireAdmin, allowedOrigins: env.clientOrigins });
  },
  onShutdown: () => {
    endAllSessions();
    accounts.close();
  },
});

console.log(`FIRSTLIGHT server listening on :${game.port} (mail: ${accounts.mailer.kind})`);
