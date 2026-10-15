// @vitest-environment happy-dom
// Stale save prompts (Codex review, should-fix 2): another tab saved this browser's guest, so this
// tab's cached play token is a deleted guest's. The save card must never take a failed account lookup
// as permission to ask for an email, and it closes when another tab saves meanwhile.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as AccountT from "./account.ts";
import type * as AuthT from "../net/auth.ts";

vi.mock("../net/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof AuthT>();
  return { ...real, saveStatus: vi.fn(), savingStatus: vi.fn(), getAccountInfo: vi.fn(), invalidatePlayToken: vi.fn() };
});

let account: typeof AccountT;
let auth: typeof AuthT;

beforeAll(async () => {
  history.replaceState(null, "", "/");
  auth = await import("../net/auth.ts");
  account = await import("./account.ts");
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.replaceChildren();
  vi.mocked(auth.getAccountInfo).mockReset();
  vi.mocked(auth.invalidatePlayToken).mockClear();
});

const GUEST = { userId: "g", name: "Wren_07", displayName: "Wren_07", guest: true, admin: false, titleMedal: null, character: { level: 3, xp: 0, coins: 0, starter: 1, palette: 0, body: "portus" }, medals: [], pads: [], saveReady: true };
const SAVED = { ...GUEST, userId: "a", guest: false, saveReady: false };
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

describe("the save card checks the account before it asks for an email", () => {
  it("a stale token (401): asks again with the session's; a saved account closes the card as saved", async () => {
    vi.mocked(auth.saveStatus).mockResolvedValue("guest");
    vi.mocked(auth.savingStatus).mockResolvedValue("ok");
    vi.mocked(auth.getAccountInfo).mockRejectedValueOnce(new auth.AuthError("unauthorized", 401)).mockResolvedValueOnce(SAVED);
    let sawEmail = false;
    const obs = new MutationObserver(() => (sawEmail ||= !!document.querySelector("[data-e2e=save-card] input[type=email]")));
    obs.observe(document.body, { childList: true, subtree: true });
    expect(await account.openSaveProgress()).toBe("saved");
    obs.disconnect();
    expect(auth.invalidatePlayToken).toHaveBeenCalled();
    expect(sawEmail).toBe(false);
  });

  it("a lookup that fails otherwise never becomes an email form", async () => {
    vi.mocked(auth.saveStatus).mockResolvedValue("guest");
    vi.mocked(auth.savingStatus).mockResolvedValue("ok");
    vi.mocked(auth.getAccountInfo).mockRejectedValue(new auth.AuthError("server down", 500));
    void account.openSaveProgress();
    expect(await until(() => !!document.querySelector("[data-e2e=save-card] [data-e2e=save-unavailable]"))).toBe(true);
    expect(document.querySelector("[data-e2e=save-card] input[type=email]")).toBeNull();
  });

  it("closes as saved when another tab saves while it's open", async () => {
    vi.mocked(auth.saveStatus).mockResolvedValue("guest");
    vi.mocked(auth.savingStatus).mockResolvedValue("ok");
    vi.mocked(auth.getAccountInfo).mockResolvedValue(GUEST);
    const result = account.openSaveProgress();
    expect(await until(() => !!document.querySelector("[data-e2e=save-card] input[type=email]"))).toBe(true);
    vi.mocked(auth.saveStatus).mockResolvedValue("saved");
    const otherTab = new BroadcastChannel(auth.ACCOUNT_CHANNEL);
    otherTab.postMessage("changed");
    expect(await result).toBe("saved");
    otherTab.close();
  });
});
