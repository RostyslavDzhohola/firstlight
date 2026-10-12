// Seam 1 helpers: run the real server in-process and drive it with SDK bot clients.

import { Client, type Room } from "@colyseus/sdk";
import type { PlayResponse } from "@firstlight/shared/net/protocol";
import { createGame, type Game } from "../src/app.ts";
import { chainVerifiers, devVerifier } from "../src/auth/identity.ts";
import { characterRepo, MemoryCharacterRepo } from "../src/world/characters.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { MemoryPileStore, pileStore } from "../src/world/piles.ts";
import { MemoryProgressStore, progressStore } from "../src/world/quests/store.ts";
import { hub } from "../src/world/hub.ts";
import type { BodyId } from "@firstlight/shared";
import { newCharacter } from "@firstlight/shared/content/character";

export async function startServer(limits: Partial<{ maxClients: number; soloFillLimit: number; maxCopiesPerBody: number; globalCap: number }> = {}): Promise<Game> {
  characterRepo.current = new MemoryCharacterRepo();
  pileStore.current = new MemoryPileStore();
  progressStore.current = new MemoryProgressStore();
  // Quiet worlds by default: tests that need ambient enemies or bosses opt in via NPC_TUNING.
  resetTuning();
  NPC_TUNING.ambient = false;
  NPC_TUNING.bosses = false;
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

/**
 * Give a user a travel ticket to `body` (tests hop bodies without walking to a portal). A user with
 * no character yet gets one (with `starter`/`palette`), since new characters start in Portus.
 */
export function grantTravel(userId: string, body: string, choice: { starter?: unknown; palette?: unknown } = {}): void {
  const until = Date.now() + 60_000;
  const live = hub.get(userId)?.actor.char;
  if (live) {
    live.travelTo = body as BodyId;
    live.travelUntil = until;
    return;
  }
  let c = characterRepo.current.load(userId);
  if (!c && body !== "portus") c = newCharacter(Number(choice.starter ?? 0), Number(choice.palette ?? 0));
  if (c && c.body !== body) {
    c.travelTo = body as BodyId;
    c.travelUntil = until;
    characterRepo.current.save(userId, c);
  }
}

/** Join `body` as a dev identity. Grants a travel ticket first unless `ticket: false`. */
export async function joinAs(game: Game, userId: string, body = "arcadia", extra: Record<string, unknown> = {}, role = "", ticket = true): Promise<Room> {
  if (ticket) grantTravel(userId, body, extra);
  const r = await playRequest(game, `dev:${userId}:${userId}${role ? `:${role}` : ""}`, { body, ...extra });
  if (!r.ok) throw new Error(`play refused: ${JSON.stringify(r)}`);
  const client = new Client(`http://127.0.0.1:${game.port}`);
  return client.consumeSeatReservation(r.reservation as never);
}

/** Poll until `cond` holds. 6 s default: the suite shares the machine with builds and other agents. */
export function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
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
