// #41: the Easter eggs' answers stay on the server. packages/shared is what the client bundle imports,
// so no file there may carry the rules (orders, codes, counts and windows); and no client source or
// file of the production build may hold the keypad code as text (review 2026-11-13 ship #4: the
// in-world clue is an image drawn from the server's rule, tools/eggs/mirror-clue.ts).

import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as secrets from "@firstlight/shared/content/secrets";
import { EGG_RULES } from "../src/world/quests/eggRules.ts";
import { buildClient, clientSources, leaks, ROOT, textFiles } from "../../../tools/eggs/bundle-guard.ts";

const SHARED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
}

describe("egg answers out of the shared package (#41)", () => {
  it("the shared secrets module exports no rules, and the server's module has them", () => {
    expect(Object.keys(secrets)).not.toContain("EGG_RULES");
    expect(EGG_RULES.E2_ORDER).toHaveLength(4);
  });

  it("no shared source names a rule constant or holds the keypad code", () => {
    const leaks = files(SHARED).filter((f) => /\bE\d+_(ORDER|CODE|LANTERNS|LAMPS|WINDOW_MS)\b/.test(readFileSync(f, "utf8")) || readFileSync(f, "utf8").includes(EGG_RULES.E7_CODE));
    expect(leaks.map((f) => path.relative(SHARED, f))).toEqual([]);
  });

  it("no client source holds the keypad code or names a rule constant", () => {
    const files = clientSources();
    expect(files.length).toBeGreaterThan(100);
    expect(leaks(files).map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the production bundle doesn't hold the keypad code (a fresh build)", { timeout: 300_000 }, () => {
    const out = buildClient();
    try {
      const built = textFiles(out);
      expect(built.some((f) => f.endsWith(".js"))).toBe(true);
      expect(leaks(built).map((f) => path.relative(out, f))).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("the guard finds the code where it is (so a clean result means something)", () => {
    const probe = path.join(ROOT, "apps/server/src/world/quests/eggRules.ts");
    expect(leaks([probe])).toEqual([probe]);
  });
});
