// Production entry point.

import { createGame } from "./app.ts";
import { accountsConfigFromEnv, createAccounts } from "./auth/accounts.ts";
import { devVerifier } from "./auth/identity.ts";
import { env } from "./env.ts";

const accounts = await createAccounts({
  ...accountsConfigFromEnv(env),
  fallbackVerifier: devVerifier(env.allowDevGuests),
});

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
