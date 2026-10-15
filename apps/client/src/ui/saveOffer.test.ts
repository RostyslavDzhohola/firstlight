import { describe, expect, it } from "vitest";
import { codeFromText, firstSaveStep, mayOpenSaveCard, NUDGE_DELAY_MS, offerNudge, offersSave, saveReady, saveStatusOf, SaveNudge, sendCodeFailure } from "./saveOffer.ts";

describe("the 'Progress not saved' toast", () => {
  /** Poll frames at 16 ms from `t` until the toast is due (or `max` frames). */
  const run = (n: SaveNudge, held: boolean, t: number, max = 200) => {
    for (let i = 0; i < max; i++) if (n.poll(held, t + i * 16)) return t + i * 16;
    return -1;
  };

  it("is due once, NUDGE_DELAY_MS after the first level-up to 2+", () => {
    const n = new SaveNudge();
    expect(run(n, false, 0)).toBe(-1);
    n.levelUp(2, 1);
    const due = run(n, false, 1000);
    expect(due).toBeGreaterThanOrEqual(1000 + NUDGE_DELAY_MS);
    n.shownNow();
    n.levelUp(3, 2);
    expect(run(n, false, 5000)).toBe(-1);
  });

  it("ignores the first `you` and anything that isn't a rise to level 2+", () => {
    const n = new SaveNudge();
    n.levelUp(1, 1);
    n.levelUp(5, 5); // joining at level 5: not a level-up
    n.levelUp(1, 0);
    expect(run(n, false, 0)).toBe(-1);
  });

  it("waits while held (the tutorial, a menu, the death screen), and the delay starts over once free", () => {
    const n = new SaveNudge();
    n.levelUp(2, 1); // the dummies paid level 2
    expect(run(n, true, 0, 600)).toBe(-1); // tips, then the "Tutorial complete" card
    expect(n.poll(false, 20_000)).toBe(false); // free again: the wait starts now
    expect(n.poll(false, 20_000 + NUDGE_DELAY_MS - 1)).toBe(false);
    expect(n.poll(true, 20_000 + NUDGE_DELAY_MS)).toBe(false); // Esc just before it was due
    expect(n.poll(false, 30_000)).toBe(false);
    expect(n.poll(false, 30_000 + NUDGE_DELAY_MS)).toBe(true);
  });

  it("doesn't nag again after a reload in the same tab", () => {
    const n = new SaveNudge(true);
    n.levelUp(2, 1);
    expect(run(n, false, 0)).toBe(-1);
  });

  it("remembers the best level seen (a rebirth drops to 1; saving stays unlocked)", () => {
    const n = new SaveNudge();
    n.levelUp(3, 3);
    n.levelUp(1, 3);
    expect(n.best).toBe(3);
    expect(saveReady(n.best)).toBe(true);
  });
});

describe("the toast's caller (Codex review: the delay must not bypass the hold)", () => {
  function due() {
    const n = new SaveNudge(false, 0);
    n.levelUp(2, 1);
    expect(n.poll(false, 0)).toBe(true);
    return n;
  }

  it("a guest who is still playing gets it, once", async () => {
    const n = due();
    let shown = 0;
    await offerNudge(n, { status: async () => "guest", held: () => false, show: () => shown++ });
    expect(shown).toBe(1);
    expect(n.poll(false, 100)).toBe(false);
  });

  it("Esc, a death or a travel during the eligibility check keeps it pending instead of showing it behind", async () => {
    const n = due();
    let shown = 0;
    let held = false;
    await offerNudge(n, {
      status: async () => {
        held = true; // the player opened Esc while we asked
        return "guest";
      },
      held: () => held,
      show: () => shown++,
    });
    expect(shown).toBe(0);
    expect(n.poll(true, 10)).toBe(false); // still held
    expect(n.poll(false, 20)).toBe(true); // free again: due again (delay 0 here)
    await offerNudge(n, { status: async () => "guest", held: () => false, show: () => shown++ });
    expect(shown).toBe(1);
  });

  it("saved players never get it; a failed check tries again later", async () => {
    const saved = due();
    let shown = 0;
    await offerNudge(saved, { status: async () => "saved", held: () => false, show: () => shown++ });
    expect(saved.poll(false, 100)).toBe(false);
    const flaky = due();
    await offerNudge(flaky, { status: async () => Promise.reject(new Error("offline")), held: () => false, show: () => shown++ });
    expect(flaky.poll(false, 100)).toBe(true);
    expect(shown).toBe(0);
  });

  it("only one check runs at a time", () => {
    const n = due();
    expect(n.poll(false, 50)).toBe(false); // checking
  });
});

describe("who is offered saving", () => {
  it("only a real guest session; never a saved player", () => {
    expect(offersSave(saveStatusOf({ devGuest: false, offline: false, guest: true }))).toBe(true);
    expect(offersSave(saveStatusOf({ devGuest: false, offline: false, guest: false }))).toBe(false);
  });

  it("nothing for dev guest tokens, ?offline/?bench runs, or a browser with no session yet", () => {
    expect(saveStatusOf({ devGuest: true, offline: false, guest: true })).toBe("none");
    expect(saveStatusOf({ devGuest: false, offline: true, guest: true })).toBe("none");
    expect(saveStatusOf({ devGuest: false, offline: false, guest: null })).toBe("none");
    expect(offersSave("none")).toBe(false);
  });

  it("the server emails a new address only from level 2 (D34)", () => {
    expect(saveReady(1)).toBe(false);
    expect(saveReady(2)).toBe(true);
  });
});

describe("the save card", () => {
  it("never opens while the game holds the pointer (it needs the mouse)", () => {
    expect(mayOpenSaveCard({ pointerLocked: true })).toBe(false);
    expect(mayOpenSaveCard({ pointerLocked: false })).toBe(true);
  });

  it("says 'unavailable', 'busy' or 'not yet' before the player types an address", () => {
    expect(firstSaveStep({ saving: "unavailable", saveReady: true })).toBe("unavailable");
    expect(firstSaveStep({ saving: "busy", saveReady: true })).toBe("busy");
    expect(firstSaveStep({ saving: "ok", saveReady: false })).toBe("locked");
    expect(firstSaveStep({ saving: "ok", saveReady: true })).toBe("email");
    expect(firstSaveStep({ saving: "ok", saveReady: undefined })).toBe("email"); // an older server: just try
  });

  it("takes a pasted code in any common shape", () => {
    expect(codeFromText("123456")).toBe("123456");
    expect(codeFromText(" 123 456 ")).toBe("123456");
    expect(codeFromText("123-456")).toBe("123456");
    expect(codeFromText("Your FIRSTLIGHT code is 482913.")).toBe("482913");
    expect(codeFromText("482913 is your FIRSTLIGHT code")).toBe("482913");
    expect(codeFromText("12")).toBe("12");
  });
});

describe("when a code can't be sent", () => {
  it("maps the server's codes: unavailable is its own state, not a dead end", () => {
    expect(sendCodeFailure({ status: 503, code: "SAVING_UNAVAILABLE" })).toBe("unavailable");
    expect(sendCodeFailure({ status: 503, code: "SAVING_BUSY" })).toBe("busy"); // the provider's quota
    expect(sendCodeFailure({ status: 429, code: "SAVING_BUSY" })).toBe("busy"); // our budget
    expect(sendCodeFailure({ status: 429 })).toBe("busy"); // Better Auth's rate limit
    expect(sendCodeFailure({ status: 400, code: "EMAIL_REJECTED" })).toBe("rejected");
    expect(sendCodeFailure({ status: 400, code: "VALIDATION_ERROR" })).toBe("rejected");
    expect(sendCodeFailure({ status: 503 })).toBe("unavailable");
    expect(sendCodeFailure({ status: 500 })).toBe("retry");
    expect(sendCodeFailure({})).toBe("retry");
  });
});
