// @vitest-environment happy-dom
// The home page's "Save your progress" follows other tabs (Codex review round 2, should-fix 3): with
// the page open on a guest, another tab saving repaints it from a fresh session lookup: no Save button,
// Sign out instead of Sign in.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as AuthT from "../net/auth.ts";

type Listener = Parameters<typeof AuthT.onAccountChange>[0];
const listeners = new Set<Listener>();

vi.mock("../net/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof AuthT>();
  return {
    ...real,
    isDevGuest: () => false,
    saveStatus: vi.fn(async () => "guest"),
    getAccountInfo: vi.fn(),
    onAccountChange: vi.fn((fn: Listener) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
  };
});

const ME = { userId: "g", name: "Wren_07", displayName: "Wren_07", guest: true, admin: false, titleMedal: null, character: { level: 3, xp: 0, coins: 0, starter: 1, palette: 0, body: "portus" }, medals: [], pads: [], saveReady: true, playMs: 0 };

const MARKUP = `
    <section id="landing" data-e2e="home">
      <span id="home-who" hidden></span>
      <button id="signin" data-e2e="signin">Sign in</button>
      <button id="signout" hidden>Sign out</button>
      <div id="home-notice" hidden></div>
      <button id="play"><span id="play-label">Play</span></button>
      <button id="home-save" hidden>Save your progress</button>
      <section id="home-progress"></section>
    </section>`;

let auth: typeof AuthT;
beforeAll(async () => {
  history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 }))); // /api/home: down, irrelevant here
  document.body.innerHTML = MARKUP;
  auth = await import("../net/auth.ts");
});
afterAll(() => vi.unstubAllGlobals());

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  return cond();
};

describe("the home page after another tab saves", () => {
  it("hides 'Save your progress' and shows Sign out", async () => {
    vi.mocked(auth.getAccountInfo).mockResolvedValue(ME as never);
    const { initHome } = await import("./home.ts");
    await initHome();
    const save = document.getElementById("home-save")!;
    expect(save.hidden).toBe(false);
    vi.mocked(auth.saveStatus).mockResolvedValue("saved");
    vi.mocked(auth.getAccountInfo).mockResolvedValue({ ...ME, userId: "a", guest: false, saveReady: false } as never);
    for (const fn of [...listeners]) fn(null, { elsewhere: true });
    expect(await until(() => save.hidden === true)).toBe(true);
    expect(document.getElementById("signout")!.hidden).toBe(false);
    expect(document.getElementById("signin")!.hidden).toBe(true);
  });

  it("a change while the first lookup runs is seen, and the slower, older answer doesn't overwrite it", async () => {
    listeners.clear();
    document.body.innerHTML = MARKUP;
    let releaseSlow: () => void = () => {};
    vi.mocked(auth.saveStatus).mockResolvedValue("guest");
    vi.mocked(auth.getAccountInfo)
      .mockReset()
      .mockImplementationOnce(() => new Promise((ok) => (releaseSlow = () => ok(ME as never)))) // the first load: slow, a guest
      .mockResolvedValue({ ...ME, userId: "a", guest: false, saveReady: false } as never); // after the other tab saved
    const { initHome } = await import("./home.ts");
    const init = initHome();
    expect(await until(() => listeners.size > 0)).toBe(true); // listening before the first answer
    vi.mocked(auth.saveStatus).mockResolvedValue("saved");
    for (const fn of [...listeners]) fn(null, { elsewhere: true });
    expect(await until(() => document.getElementById("signout")!.hidden === false)).toBe(true);
    releaseSlow();
    await init;
    expect(document.getElementById("home-save")!.hidden).toBe(true);
    expect(document.getElementById("signout")!.hidden).toBe(false);
  });
});
