// SQLite-backed character and pile stores (the persistence API in src/db), adapted to the room's
// CharacterRepo and PileStore interfaces.

import type { BodyId } from "@firstlight/shared";
import { BACKPACK_SLOTS, type CharacterData, type LifeProgress } from "@firstlight/shared/content/character";
import { STARTERS } from "@firstlight/shared/content/weapons";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { dropPile, ensureAccount, getPile, listPiles, loadCharacter, saveCharacter, takeAll, takeItem, type Db } from "../db/index.ts";
import type { Pile } from "../db/piles.ts";
import type { CharacterRepo } from "./characters.ts";
import type { PileData, PileStore } from "./piles.ts";

interface StoredInventory {
  hotbar: (InvItem | null)[];
  backpack: (InvItem | null)[];
  selected: number;
  deaths: number;
  dead: boolean;
  worn?: CharacterData["worn"];
}

/** mission_state_json: the accepted missions plus per-life quest progress (older rows: a bare array). */
interface StoredMissions {
  list: CharacterData["missions"];
  life: LifeProgress | null;
}

export class SqliteCharacterRepo implements CharacterRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  load(userId: string): CharacterData | null {
    const c = loadCharacter<StoredInventory, CharacterData["missions"] | StoredMissions>(this.db, userId);
    if (!c) return null;
    const starterIndex = Math.max(0, STARTERS.findIndex((s) => s.id === c.starter));
    const inv = c.inventory ?? ({} as StoredInventory);
    const hasPos = c.x !== 0 || c.y !== 0 || c.z !== 0;
    const ms = c.missionState;
    const missions = Array.isArray(ms) ? ms : Array.isArray(ms?.list) ? ms.list : [];
    const life = !Array.isArray(ms) && ms?.life ? ms.life : undefined;
    return {
      starter: starterIndex,
      palette: c.palette,
      level: c.level,
      xp: c.xp,
      coins: c.coins,
      hp: c.hp,
      body: c.body as BodyId,
      pos: hasPos ? [c.x, c.y, c.z] : null,
      hotbar: inv.hotbar ?? [null, null, null, null],
      backpack: inv.backpack ?? Array.from({ length: BACKPACK_SLOTS }, () => null),
      selected: inv.selected ?? 0,
      missions,
      lifeStartedAt: c.lifeStartedAt,
      deaths: inv.deaths ?? 0,
      dead: !!inv.dead,
      ...(inv.worn ? { worn: inv.worn } : {}),
      ...(life ? { life } : {}),
    };
  }

  save(userId: string, d: CharacterData): void {
    ensureAccount(this.db, userId);
    saveCharacter(this.db, userId, {
      starter: STARTERS[d.starter]?.id ?? STARTERS[0].id,
      palette: d.palette,
      level: d.level,
      xp: d.xp,
      coins: d.coins,
      hp: d.hp,
      body: d.body,
      copyHint: null,
      x: d.pos?.[0] ?? 0,
      y: d.pos?.[1] ?? 0,
      z: d.pos?.[2] ?? 0,
      heading: 0,
      inventory: { hotbar: d.hotbar, backpack: d.backpack, selected: d.selected, deaths: d.deaths, dead: !!d.dead, worn: d.worn ?? {} } satisfies StoredInventory,
      missionState: { list: d.missions, life: d.life ?? null } satisfies StoredMissions,
      lifeStartedAt: d.lifeStartedAt,
      protectedUntil: 0,
    });
  }
}

function toPileData(p: Pile<InvItem>): PileData {
  return {
    id: String(p.id),
    body: p.body as BodyId,
    x: p.x,
    y: p.y,
    z: p.z,
    owner: p.ownerName,
    ownerUserId: p.ownerId ?? "",
    createdAt: p.createdAt,
    items: p.items.map((e) => e.item),
    coins: p.coins,
  };
}

export class SqlitePileStore implements PileStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(body: BodyId): PileData[] {
    return listPiles<InvItem>(this.db, body).map(toPileData);
  }

  get(id: string): PileData | undefined {
    const p = getPile<InvItem>(this.db, Number(id));
    return p ? toPileData(p) : undefined;
  }

  add(input: Omit<PileData, "id">): { pile: PileData; evicted: string[] } {
    const { pile, evicted } = dropPile<InvItem>(this.db, {
      body: input.body,
      x: input.x,
      y: input.y,
      z: input.z,
      items: input.items,
      coins: input.coins,
      ownerId: input.ownerUserId || null,
      ownerName: input.owner,
      now: input.createdAt,
    });
    return { pile: toPileData(pile), evicted: evicted.map(String) };
  }

  take(id: string, index?: number) {
    const pileId = Number(id);
    let r;
    if (index === undefined) r = takeAll<InvItem>(this.db, pileId);
    else {
      const p = getPile<InvItem>(this.db, pileId);
      const entry = p?.items[index];
      if (!entry) return null;
      r = takeItem<InvItem>(this.db, pileId, entry.key);
    }
    if (!r.ok) return null;
    return { items: r.items, coins: r.coins, pile: r.pile ? toPileData(r.pile) : null };
  }
}
