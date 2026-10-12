// Production entry point.

import { createGame } from "./app.ts";
import { chainVerifiers, devVerifier } from "./auth/identity.ts";
import { env } from "./env.ts";

const game = await createGame({
  port: env.port,
  verify: chainVerifiers(devVerifier(env.allowDevGuests)),
  limits: {
    maxClients: env.maxClients,
    soloFillLimit: env.soloFillLimit,
    maxCopiesPerBody: env.maxCopiesPerBody,
    globalCap: env.globalCap,
  },
  allowedOrigins: env.clientOrigins,
  gracefulShutdown: true,
});

console.log(`FIRSTLIGHT server listening on :${game.port}`);
