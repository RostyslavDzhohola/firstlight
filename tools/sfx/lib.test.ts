import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CEILING, playbackGain, safeOutDir } from "./lib.ts";

const REPO = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "fl-sfx-test-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SFX output directory", () => {
  it("refuses the repo, anywhere inside it, and relative paths that land in it", () => {
    for (const p of [REPO, join(REPO, "apps/assets-worker/public/v/sfx-1"), join(REPO, "not-made-yet/deeper")]) {
      expect(() => safeOutDir(p), p).toThrow(/git/);
    }
    expect(() => safeOutDir(".", REPO)).toThrow(/git/);
    expect(existsSync(join(REPO, "not-made-yet"))).toBe(false); // the check changes nothing on disk
  });

  it("refuses a symlink that leads into the repo, also as a parent of a path not made yet", () => {
    const t = temp();
    symlinkSync(join(REPO, "apps"), join(t, "link"));
    expect(() => safeOutDir(join(t, "link"))).toThrow(/git/);
    expect(() => safeOutDir(join(t, "link", "sfx", "out"))).toThrow(/git/);
  });

  it("refuses a dangling symlink (its target could be made later anywhere)", () => {
    const t = temp();
    symlinkSync(join(t, "nowhere"), join(t, "dangling"));
    expect(() => safeOutDir(join(t, "dangling", "out"))).toThrow();
  });

  it("refuses any other git checkout too", () => {
    const t = temp();
    mkdirSync(join(t, "other", ".git"), { recursive: true });
    expect(() => safeOutDir(join(t, "other", "sfx"))).toThrow(/git/);
  });

  it("accepts a plain temp folder, resolved to its real path, without creating it", () => {
    const t = temp();
    const out = safeOutDir(join(t, "a", "b"));
    expect(out).toBe(join(realpathSync(t), "a", "b"));
    expect(existsSync(join(t, "a"))).toBe(false);
  });
});

describe("SFX playback gain", () => {
  it("never lets the loudest decoded take pass −1 dBFS at full volume", () => {
    const peaks = [10 ** (-1.1 / 20), 0.5]; // ui-5 in sfx-1 decoded at −1.10 dBFS
    const g = playbackGain(-10, -16, peaks); // wants +6 dB
    expect(Math.max(...peaks) * g).toBeLessThanOrEqual(CEILING);
    expect(g).toBeGreaterThan(0.99); // only the 0.1 dB of headroom is left
  });

  it("gives a quiet sound the gain it needs", () => {
    expect(playbackGain(-20, -23, [0.3])).toBeCloseTo(10 ** (3 / 20), 2);
    expect(playbackGain(-20, -20, [0.3])).toBe(1);
  });
});
