// Seam 1 helpers: run the real server in-process and drive it with SDK bot clients.

import { Client, type Room } from "@colyseus/sdk";
import type { PlayResponse } from "@firstlight/shared/net/protocol";
import { createGame, type Game } from "../src/app.ts";
import { chainVerifiers, devVerifier } from "../src/auth/identity.ts";
import { characterRepo, MemoryCharacterRepo } from "../src/world/characters.ts";
import { MemoryPileStore, pileStore } from "../src/world/piles.ts";

export async function startServer(limits: Partial<{ maxClients: number; soloFillLimit: number; maxCopiesPerBody: number; globalCap: number }> = {}): Promise<Game> {
  characterRepo.current = new MemoryCharacterRepo();
  pileStore.current = new MemoryPileStore();
  return createGame({
    port: 0,
    verify: chainVerifiers(devVerifier(true)),
    limits: { maxClients: 40, soloFillLimit: 36, maxCopiesPerBody: 2, globalCap: 320, ...limits },
    allowedOrigins: ["http://localhost:5173"],
  });
}

export async function playRequest(game: Game, token: string, body: Record<string, unknown>): Promise<PlayResponse> {
  const res = await fetch(`http://127.0.0.1:${game.port}/api/play`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as PlayResponse;
}

export async function joinAs(game: Game, userId: string, body = "arcadia", extra: Record<string, unknown> = {}, role = ""): Promise<Room> {
  const r = await playRequest(game, `dev:${userId}:${userId}${role ? `:${role}` : ""}`, { body, ...extra });
  if (!r.ok) throw new Error(`play refused: ${JSON.stringify(r)}`);
  const client = new Client(`http://127.0.0.1:${game.port}`);
  return client.consumeSeatReservation(r.reservation as never);
}

export function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error("waitFor timed out"));
      }
    }, 20);
  });
}

/** Leave a room without hanging if it is already closed. */
export async function safeLeave(r: Room): Promise<void> {
  await Promise.race([r.leave().catch(() => {}), new Promise((ok) => setTimeout(ok, 500))]);
}
