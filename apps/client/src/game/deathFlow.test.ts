// Dying, saving from the death screen and rising again across the 4101 rejoin (Codex review, should-fix 1).
import { describe, expect, it } from "vitest";
import { DeathFlow, type RebirthChoice } from "./deathFlow.ts";

/** A fake client: one current room (null while rejoining), the death screen, the body's freeze. */
function harness() {
  const sent: { room: string; choice: RebirthChoice }[] = [];
  const log: string[] = [];
  let room: string | null = "guest-room";
  let pickNow: ((c: RebirthChoice | null) => void) | null = null;
  const flow = new DeathFlow<{ level: number }>({
    showScreen: () => {
      log.push("screen");
      return new Promise((ok) => (pickNow = ok));
    },
    closeScreen: () => {
      log.push("closed");
      pickNow?.(null);
    },
    freeze: (on) => log.push(on ? "frozen" : "free"),
    sendRespawn: (choice) => {
      if (!room) return false;
      sent.push({ room, choice });
      return true;
    },
    changed: () => log.push("changed"),
  });
  return {
    flow,
    sent,
    log,
    rejoin: (to: string | null) => (room = to),
    pick: (c: RebirthChoice) => pickNow?.(c),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const KAPPA = { starter: 2, palette: 1 };

describe("death and rebirth across a rejoin", () => {
  it("a plain death: the pick goes to the room, reborn unfreezes", async () => {
    const h = harness();
    void h.flow.onDeath({ level: 3 });
    expect(h.flow.dead).toBe(true);
    h.pick(KAPPA);
    await tick();
    expect(h.sent).toEqual([{ room: "guest-room", choice: KAPPA }]);
    h.flow.onReborn();
    expect(h.log.at(-1)).toBe("free");
  });

  it("saved from the death screen: the account's room re-sends death, and Rise again respawns through it", async () => {
    const h = harness();
    void h.flow.onDeath({ level: 3 });
    h.rejoin(null); // 4101: the guest room is gone
    h.rejoin("account-room");
    h.flow.onYou(true); // the moved character is dead
    void h.flow.onDeath({ level: 3 }); // re-sent on join: the screen stays as it is
    expect(h.log.filter((l) => l === "screen")).toHaveLength(1);
    h.pick(KAPPA);
    await tick();
    expect(h.sent).toEqual([{ room: "account-room", choice: KAPPA }]);
  });

  it("Rise again while the rejoin is under way: the pick is sent when the account's room re-sends death", async () => {
    const h = harness();
    void h.flow.onDeath({ level: 3 });
    h.rejoin(null);
    h.pick(KAPPA);
    await tick();
    expect(h.sent).toEqual([]);
    h.rejoin("account-room");
    void h.flow.onDeath({ level: 3 });
    expect(h.sent).toEqual([{ room: "account-room", choice: KAPPA }]);
    h.flow.onReborn();
    void h.flow.onDeath({ level: 3 }); // another re-send before `you` catches up: the server has the pick
    expect(h.sent).toHaveLength(1);
  });

  it("the account's character is alive: the screen closes, the body unfreezes, nothing is sent", async () => {
    const h = harness();
    const done = h.flow.onDeath({ level: 3 });
    h.rejoin("account-room");
    h.flow.onYou(false);
    await done;
    expect(h.flow.dead).toBe(false);
    expect(h.log).toEqual(["frozen", "screen", "closed", "free", "changed"]);
    expect(h.sent).toEqual([]);
  });

  it("a respawn the server confirms after the screen closed clears the death (D-controls-3)", async () => {
    const h = harness();
    void h.flow.onDeath({ level: 3 });
    h.pick(KAPPA);
    await tick();
    h.flow.onReborn();
    h.flow.onYou(false);
    expect(h.flow.dead).toBe(false);
    expect(h.log.at(-1)).toBe("changed");
  });
});
