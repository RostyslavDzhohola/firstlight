// @vitest-environment happy-dom
// The home page's visits line (#12, owner 2026-10-18): only who's online now, no analytics note;
// total visits apart in the footer; the Privacy link always (our own funnel is disclosed either way).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../net/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../net/auth.ts")>();
  return { ...real, isDevGuest: () => false, saveStatus: vi.fn(async () => "none"), onAccountChange: vi.fn(() => () => {}) };
});

const { config } = await import("../config.ts");
const { renderVisits } = await import("./home.ts");

const MARKUP = `<footer class="fl-home__foot"><div id="home-visits" hidden></div><div class="fl-landing__credit fl-home__credit"><span>Open source.</span></div></footer>`;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});

describe("the home page's visits line (#12)", () => {
  it("says only how many are online now; total visits sit apart; no cookie sentence", () => {
    renderVisits({ online: 4, total: 12345 }, 2);
    const box = document.getElementById("home-visits")!;
    expect(box.hidden).toBe(false);
    expect(box.textContent).toBe("4 online now");
    expect(document.getElementById("home-total")!.textContent).toBe("Total visits 12,345");
    expect(document.body.textContent).not.toMatch(/cookie|Analytics/i);
  });

  it("without DataFast: our own count, no total, and still the Privacy link (our own funnel, review ship #6)", () => {
    const was = config.datafast;
    (config as { datafast: unknown }).datafast = null;
    try {
      renderVisits(null, 3);
      expect(document.getElementById("home-visits")!.textContent).toBe("3 online now");
      expect(document.getElementById("home-total")).toBeNull();
      expect(document.querySelector(".fl-home__credit #home-privacy")!.textContent).toBe("Privacy");
    } finally {
      (config as { datafast: unknown }).datafast = was;
    }
  });

  it("with DataFast in the page: one Privacy link in the footer", () => {
    const was = config.datafast;
    (config as { datafast: unknown }).datafast = { src: "https://datafa.st/js/script.js", websiteId: "dfid_x", domain: "one4all.dev", cookieless: false };
    try {
      renderVisits({ online: 1, total: 9 }, 1);
      renderVisits({ online: 2, total: 9 }, 1);
      expect(document.querySelectorAll("#home-privacy")).toHaveLength(1);
      expect(document.querySelector(".fl-home__credit #home-privacy")!.textContent).toBe("Privacy");
    } finally {
      (config as { datafast: unknown }).datafast = was;
    }
  });
});
