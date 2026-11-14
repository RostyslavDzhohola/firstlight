// `pnpm dev` (the root script): the game server and the Vite client together, as before, plus one
// thing only this launcher does: a fresh random key for this run, DEV_SIGNIN_KEY, handed to both
// processes through their environment. The dev client sends it when it asks the server for a sign-in
// code the dev outbox kept (#84, GET /api/account/dev-code); the server serves codes only to a holder
// of the key, and without one the route does not exist. Nothing else on the machine or the network
// has it, so a proxy, another site's page or a LAN neighbour can't read a code (review round two,
// blocker 1). Vite gives the key to the dev server's pages only, never to a build (vite.config.ts).
//
// Starting the two by hand: set the same DEV_SIGNIN_KEY (43+ random characters) for both.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** A strong enough key: as auth/crypto.ts strongSecret (43+ characters, 12+ distinct). */
const strong = (s: string | undefined): s is string => !!s && s.length >= 43 && new Set(s).size >= 12;

/** The environment both processes get: the caller's, with this run's key (a strong one already set is kept). */
export function devEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, DEV_SIGNIN_KEY: strong(base.DEV_SIGNIN_KEY) ? base.DEV_SIGNIN_KEY : randomBytes(32).toString("base64url") };
}

if (import.meta.main) {
  const child = spawn("pnpm", ["--parallel", "--filter", "@firstlight/server", "--filter", "@firstlight/client", "dev"], { stdio: "inherit", env: devEnv() });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
