import { describe, expect, it } from "vitest";
import { TravelQueue } from "./travelQueue.ts";

describe("a server-ordered move during another transition", () => {
  it("rebirth during the account's rejoin: queued, then made when the rejoin ends", () => {
    const q = new TravelQueue<"portus" | "arcadia">();
    expect(q.ask("portus", true, true)).toBe("queued"); // reborn arrives while reconnect() is arriving
    expect(q.take(false)).toBe("portus"); // reconnect finished: travel to Portus now
    expect(q.take(false)).toBeNull(); // once
  });

  it("nothing waits when no transition runs, and player moves stay droppable", () => {
    const q = new TravelQueue<"portus" | "arcadia">();
    expect(q.ask("portus", false, true)).toBe("go");
    expect(q.ask("arcadia", true, false)).toBe("dropped");
    expect(q.take(false)).toBeNull();
  });

  it("the last order wins; a stopped game (connection lost, removed) makes none", () => {
    const q = new TravelQueue<"portus" | "arcadia">();
    q.ask("arcadia", true, true);
    q.ask("portus", true, true);
    expect(q.take(true)).toBeNull();
    expect(q.take(false)).toBeNull();
  });
});
