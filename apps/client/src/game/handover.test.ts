// Keys pressed on a loading screen (the first load, a trip, a re-warm) must not act when play starts:
// Game.handOver and the paused frame loop end the input frame (Input.endFrame) before the first live
// frame. Here: the real Input fed real key events, then the real controller.

import { afterAll, describe, expect, it, vi } from "vitest";
import type { Terrain } from "@firstlight/shared";
import { ANIM } from "@firstlight/shared/net/schema";
import { Input } from "./input.ts";
import { PlayerController } from "./PlayerController.ts";

type Handler = (e: Partial<KeyboardEvent>) => void;
const handlers = new Map<string, Handler[]>();
const target = {
  addEventListener(type: string, h: Handler) {
    handlers.set(type, [...(handlers.get(type) ?? []), h]);
  },
};
vi.stubGlobal("window", target);
vi.stubGlobal("document", target);
afterAll(() => vi.unstubAllGlobals());

const key = (type: "keydown" | "keyup", code: string) => {
  for (const h of handlers.get(type) ?? []) h({ code, shiftKey: false, preventDefault() {} });
};

const R = 500;
const terrain = { body: { radius: R }, groundHeight: () => 0 } as unknown as Terrain;

describe("presses on a loading screen", () => {
  it("a C pressed and released during the first load doesn't roll when play starts; held W still walks", () => {
    const input = new Input(target as unknown as HTMLElement);
    const pc = new PlayerController(terrain, -100);
    pc.teleport(0, R, 0);
    // Loading: the loop isn't running yet.
    key("keydown", "KeyW");
    key("keydown", "KeyC");
    key("keyup", "KeyC");
    expect(input.pressed.has("KeyC")).toBe(true);
    input.endFrame(); // Game.handOver
    let rolled = false;
    for (let i = 0; i < 30; i++) {
      pc.update(1 / 60, input, false);
      input.endFrame();
      rolled ||= pc.anim === ANIM.DODGE;
    }
    expect(rolled).toBe(false);
    expect(pc.pos.z).toBeGreaterThan(1); // W held through the load keeps walking
    // A fresh press in play rolls at once.
    key("keydown", "KeyC");
    pc.update(1 / 60, input, false);
    expect(pc.anim).toBe(ANIM.DODGE);
  });
});
