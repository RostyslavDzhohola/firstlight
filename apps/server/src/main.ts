// Production entry point.

import { createGame } from "./app.ts";
import { accountsConfigFromEnv, createAccounts } from "./auth/accounts.ts";
import { devVerifier } from "./auth/identity.ts";
import { env, productionConfigProblems } from "./env.ts";
import { isBanned } from "./db/index.ts";
import { bannedCheck } from "./world/BodyRoom.ts";
import { adminCheck } from "./world/adminMode.ts";
import { isAdmin } from "./db/accounts.ts";
import { gameDb } from "./db/index.ts";
import { characterRepo } from "./world/characters.ts";
import { pileStore } from "./world/piles.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "./world/sqliteStores.ts";
import { progressStore, SqliteProgressStore } from "./world/quests/store.ts";
import { copyStateStore, SqliteCopyStateStore } from "./world/copyState.ts";
import { mountOps } from "./ops/admin.ts";
import { dataFastVisits } from "./ops/datafast.ts";
import { mountHome } from "./ops/home.ts";
import { endAllSessions } from "./social/index.ts";
import { banExplainer } from "./social/refusal.ts";

// Refuse to boot an insecure production config (review): dev guests would allow impersonation, and a
// missing origin secret makes forwarded IPs spoofable.
if (env.production) {
  const problems = productionConfigProblems();
  if (problems.length) {
    for (const p of problems) console.error(`config: ${p}`);
    process.exit(1);
  }
}

const accounts = await createAccounts({
  ...accountsConfigFromEnv(env),
  fallbackVerifier: devVerifier(env.allowDevGuests),
});

// Characters, piles and quest progress (pads, medals, Hall of Firsts) live in game.db from here on (survive restarts and deploys).
characterRepo.current = new SqliteCharacterRepo(gameDb());
pileStore.current = new SqlitePileStore(gameDb());
progressStore.current = new SqliteProgressStore(gameDb());
// Boss respawn timers, cleared camps/packs and broken props per copy: rooms save them as they change
// and on dispose (graceful shutdown included, SPEC §5.1), and restore them when the copy reopens.
copyStateStore.current = new SqliteCopyStateStore(gameDb());
bannedCheck.current = (userId) => isBanned(gameDb(), userId);
// Admin rights are asked of the account table again while playing (D-admin-2): revoking one sticks.
adminCheck.current = (userId) => isAdmin(gameDb(), userId);

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
  revalidate: accounts.revalidate,
  mountAfterJson: (app) => {
    accounts.mountAfterJson(app);
    mountOps(app, { db: accounts.db, requireAdmin: accounts.requireAdmin, allowedOrigins: env.clientOrigins });
    mountHome(app, { db: accounts.db, visits: dataFastVisits({ apiKey: env.datafastApiKey }) });
  },
  onShutdown: () => {
    // Each step on its own: a failure in one must not skip closing the databases.
    for (const [what, fn] of [["end sessions", endAllSessions], ["close accounts", () => accounts.close()]] as const) {
      try {
        fn();
      } catch (err) {
        console.error(`shutdown: ${what} failed: ${(err as Error)?.message ?? err}`);
      }
    }
  },
});

console.log(`FIRSTLIGHT server listening on :${game.port} (mail: ${accounts.mailer.kind})`);
