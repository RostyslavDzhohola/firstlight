import { describe, expect, it } from "vitest";
import { codeFromText, firstSaveStep, mayOpenSaveCard, offersSave, saveReady, saveStatusOf, SaveNudge, sendCodeFailure } from "./saveOffer.ts";

describe("the 'Progress not saved' toast", () => {
  it("shows once, on the first frame after the first level-up to 2+", () => {
    const n = new SaveNudge();
    expect(n.poll(false)).toBe(false);
    n.levelUp(2, 1);
    expect(n.poll(false)).toBe(true);
    expect(n.poll(false)).toBe(false);
    n.levelUp(3, 2);
    expect(n.poll(false)).toBe(false);
  });

  it("ignores the first `you` and anything that isn't a rise to level 2+", () => {
    const n = new SaveNudge();
    n.levelUp(1, 1);
    n.levelUp(5, 5); // joining at level 5: not a level-up
    n.levelUp(1, 0);
    expect(n.poll(false)).toBe(false);
  });

  it("waits while held (the tutorial, a menu, the death screen), then shows once", () => {
    const n = new SaveNudge();
    n.levelUp(2, 1); // the dummies paid level 2
    for (let i = 0; i < 600; i++) expect(n.poll(true)).toBe(false); // tips, then the "Tutorial complete" card
    expect(n.poll(false)).toBe(true);
    expect(n.poll(false)).toBe(false);
    expect(n.poll(true)).toBe(false);
  });

  it("a skipped tutorial releases it the same way, still one toast", () => {
    const n = new SaveNudge();
    n.levelUp(2, 1);
    expect(n.poll(true)).toBe(false);
    n.levelUp(3, 2);
    expect(n.poll(false)).toBe(true);
    expect(n.poll(false)).toBe(false);
  });

  it("doesn't nag again after a reload in the same tab", () => {
    const n = new SaveNudge(true);
    n.levelUp(2, 1);
    expect(n.poll(false)).toBe(false);
  });

  it("remembers the best level seen (a rebirth drops to 1; saving stays unlocked)", () => {
    const n = new SaveNudge();
    n.levelUp(3, 3);
    n.levelUp(1, 3);
    expect(n.best).toBe(3);
    expect(saveReady(n.best)).toBe(true);
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
