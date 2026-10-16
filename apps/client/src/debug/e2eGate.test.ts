import { describe, expect, it, vi } from "vitest";
import { e2eRequested, maybeInstallE2e } from "./e2eGate.ts";

describe("e2e hook gate", () => {
  it("reads ?e2e from the query string only", () => {
    expect(e2eRequested("")).toBe(false);
    expect(e2eRequested("?webgl&autoplay")).toBe(false);
    expect(e2eRequested("?e2eish")).toBe(false);
    expect(e2eRequested("?e2e")).toBe(true);
    expect(e2eRequested("?webgl&e2e=1")).toBe(true);
  });

  it("without ?e2e: never loads the hook chunk and sets no global", async () => {
    const win: Record<string, unknown> = {};
    const load = vi.fn(async () => ({ installE2eHook: (w: Record<string, unknown>) => void (w.__fl = {}) }));
    expect(await maybeInstallE2e("?webgl&autoplay", win, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(Object.keys(win)).toEqual([]);
  });

  it("with ?e2e: loads the hook and installs it on the target", async () => {
    const win: Record<string, unknown> = {};
    const load = vi.fn(async () => ({ installE2eHook: (w: Record<string, unknown>) => void (w.__fl = { ok: true }) }));
    expect(await maybeInstallE2e("?e2e", win, load)).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(win.__fl).toEqual({ ok: true });
  });

  it("a failed chunk load never breaks the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win: Record<string, unknown> = {};
    expect(await maybeInstallE2e("?e2e", win, () => Promise.reject(new Error("offline")))).toBe(false);
    expect(win).toEqual({});
    warn.mockRestore();
  });

  it("main.ts imports the hook only through the gate (a dynamic import, its own chunk)", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/maybeInstallE2e\(location\.search, window, \(\) => import\("\.\/debug\/e2eHook\.ts"\)\)/);
    expect(main).not.toMatch(/^import .*e2eHook/m);
  });
});
