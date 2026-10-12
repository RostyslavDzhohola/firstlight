// Production runs the TypeScript sources with Node's type stripping, which rejects non-erasable
// syntax (enums, namespaces, parameter properties). Vitest transpiles instead, so check explicitly.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("production sources are erasable TypeScript", () => {
  const roots = [join(import.meta.dirname, "../src"), join(import.meta.dirname, "../../../packages/shared/src")];
  for (const file of roots.flatMap(tsFiles)) {
    it(file.split("/").slice(-3).join("/"), () => {
      expect(() => stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" })).not.toThrow();
    });
  }
});
