import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newCharacter } from "@firstlight/shared/content/character";
import { openGameDb } from "../src/db/index.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";

function db() {
  return openGameDb(join(mkdtempSync(join(tmpdir(), "fl-store-")), "game.db"));
}

describe("SQLite stores", () => {
  it("round-trips a character, including inventory, position and death state", () => {
    const repo = new SqliteCharacterRepo(db());
    const c = newCharacter(3, 4, 1000);
    c.coins = 77;
    c.level = 5;
    c.xp = 900;
    c.pos = [1, 2, 503];
    c.backpack[2] = { id: "grenade", tier: 2, qty: 3 };
    c.dead = true;
    c.deaths = 2;
    repo.save("u1", c);
    const back = repo.load("u1")!;
    expect(back.starter).toBe(3);
    expect(back.palette).toBe(4);
    expect(back.coins).toBe(77);
    expect(back.pos).toEqual([1, 2, 503]);
    expect(back.hotbar[0]).toEqual({ id: "carbine", tier: 1, qty: 1 });
    expect(back.backpack[2]).toEqual({ id: "grenade", tier: 2, qty: 3 });
    expect(back.dead).toBe(true);
    expect(back.deaths).toBe(2);
  });

  it("piles survive a reopen and the first taker wins", () => {
    const d = db();
    const store = new SqlitePileStore(d);
    const { pile } = store.add({ body: "arcadia", x: 1, y: 2, z: 3, owner: "Ann", ownerUserId: "u1", createdAt: 5, items: [{ id: "axe", tier: 1, qty: 1 }, { id: "carbine", tier: 2, qty: 1 }], coins: 40 });
    expect(new SqlitePileStore(d).list("arcadia").map((p) => p.id)).toEqual([pile.id]);
    const one = store.take(pile.id, 1)!;
    expect(one.items).toEqual([{ id: "carbine", tier: 2, qty: 1 }]);
    const rest = store.take(pile.id)!;
    expect(rest.items).toEqual([{ id: "axe", tier: 1, qty: 1 }]);
    expect(rest.coins).toBe(40);
    expect(store.take(pile.id)).toBeNull();
  });
});
