import { describe, expect, it } from "vitest";
import { huntTargets, listenHuntTargets } from "./huntTargets.ts";

/** A room stand-in that, like the SDK, drops messages with no handler. */
function fakeRoom() {
  const handlers = new Map<string, (m: any) => void>();
  return {
    onMessage(type: string, cb: (m: any) => void) {
      handlers.set(type, cb);
    },
    deliver(type: string, m: unknown) {
      handlers.get(type)?.(m);
    },
  };
}

describe("hunt targets are held from the join, not from when the pointer starts", () => {
  it("a list sent right after joining is there for a pointer built seconds later", () => {
    const room = fakeRoom();
    listenHuntTargets(room as never);
    expect(huntTargets()).toBeNull();
    room.deliver("huntTargets", { id: "A1", npcs: ["n1", "n4"] });
    // …the world builds; later the mission pointer asks:
    const t = huntTargets();
    expect(t?.id).toBe("A1");
    expect([...t!.npcs]).toEqual(["n1", "n4"]);
  });

  it("a new room starts empty (no list carried over from the last body)", () => {
    const a = fakeRoom();
    listenHuntTargets(a as never);
    a.deliver("huntTargets", { id: "A1", npcs: ["n1"] });
    const b = fakeRoom();
    listenHuntTargets(b as never);
    expect(huntTargets()).toBeNull();
    b.deliver("huntTargets", { id: "", npcs: [] });
    expect(huntTargets()).toEqual({ id: "", npcs: new Set() });
  });
});
