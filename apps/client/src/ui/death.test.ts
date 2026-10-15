// @vitest-environment happy-dom
// closeDeath() works in both phases of the death screen (Codex review round 2, should-fix 2): while it
// shows, and after "Rise again" while the rebirth picker is open. Another tab saving into an account
// whose character is alive must close whichever is up, and the screen resolves with null (no respawn).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as DeathT from "./death.ts";
import type * as PickT from "./characterPick.ts";

let death: typeof DeathT;
let pick: typeof PickT;

beforeAll(async () => {
  history.replaceState(null, "", "/?devguest");
  document.body.innerHTML = `<div id="ui"></div>`;
  death = await import("./death.ts");
  pick = await import("./characterPick.ts");
});

afterEach(() => {
  death.closeDeath();
  document.getElementById("ui")!.replaceChildren();
});

const info = { killerName: "the fall", aliveMs: 52_000, level: 2, killer: null, victim: "me", body: "arcadia" };
const ctx = () => ({ name: "Wren_07", starter: 1, lastAlive: null, pick: () => pick.showCharacterPick({ rebirth: true }) });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("closing the death screen when the character turns out to be alive", () => {
  it("while the death screen shows: resolves null", async () => {
    const done = death.showDeath(info, ctx());
    expect(document.querySelector(".fl-death")).toBeTruthy();
    death.closeDeath();
    expect(await done).toBeNull();
    expect(document.querySelector(".fl-death")).toBeNull();
  });

  it("after Rise again, with the rebirth picker open: closes the picker too and resolves null", async () => {
    const done = death.showDeath(info, ctx());
    document.querySelector<HTMLButtonElement>(".fl-death__rise")!.click();
    await tick();
    expect(document.querySelector(".fl-charpick")).toBeTruthy();
    death.closeDeath();
    expect(await done).toBeNull();
    expect(document.querySelector(".fl-charpick")).toBeNull();
    expect(document.querySelector(".fl-death")).toBeNull();
  });

  it("a pick still resolves the death screen with it", async () => {
    const done = death.showDeath(info, ctx());
    document.querySelector<HTMLButtonElement>(".fl-death__rise")!.click();
    await tick();
    document.querySelector<HTMLButtonElement>(".fl-charpick__go .fl-btn--primary")!.click();
    expect(await done).toMatchObject({ starter: expect.any(Number), palette: expect.any(Number) });
    expect(document.querySelector(".fl-charpick")).toBeNull();
  });
});
