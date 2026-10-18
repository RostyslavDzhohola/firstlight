// D-ui-1: no live backdrop blur by default. In Chrome on macOS a blurred see-through panel was where a
// presented frame stopped (every layer drawn after it went missing for 1–4 frames), so by default no
// surface blurs what is behind it. This reads every stylesheet the client ships: a blurring backdrop
// filter may come only from the ?blur=1 look (`.fl-blur`, the A/B switch) or the death drain (a
// full-screen grayscale pass that stays for now). The low-health vignette never blurred.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
  );
}

interface Rule {
  file: string;
  selector: string;
  decls: [prop: string, value: string][];
}

/** Innermost `selector { declarations }` blocks (rules inside @media come out with their own selector). */
function rules(file: string): Rule[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    file: relative(SRC, file),
    selector: m[1]!.replace(/@import[^;]*;/g, "").trim(),
    decls: m[2]!
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.includes(":"))
      .map((d) => [d.slice(0, d.indexOf(":")).trim().toLowerCase(), d.slice(d.indexOf(":") + 1).trim()] as [string, string]),
  }));
}

const ALL = cssFiles(SRC).flatMap(rules);
const isBackdrop = (p: string) => p === "backdrop-filter" || p === "-webkit-backdrop-filter";
const blurLook = (r: Rule) => /\.fl-blur\b/.test(r.selector);
const deathDrain = (r: Rule) => r.selector === ".fl-death__drain";

describe("the flat look (D-ui-1)", () => {
  it("reads the client's stylesheets", () => {
    expect(ALL.some((r) => r.file.endsWith("components.css") && r.selector === ".fl-panel")).toBe(true);
  });

  it("no rule blurs the backdrop outside the ?blur=1 look, except the death drain", () => {
    const offenders = ALL.flatMap((r) =>
      r.decls
        .filter(([p, v]) => isBackdrop(p) && /blur\(/.test(v) && !blurLook(r) && !deathDrain(r))
        .map(([p, v]) => `${r.file} ${r.selector} { ${p}: ${v} }`),
    );
    expect(offenders).toEqual([]);
  });

  it("blurred token values live only in the ?blur=1 look", () => {
    const offenders = ALL.flatMap((r) =>
      r.decls.filter(([p, v]) => p.startsWith("--") && /blur\(/.test(v) && !blurLook(r)).map(([p, v]) => `${r.file} ${r.selector} { ${p}: ${v} }`),
    );
    expect(offenders).toEqual([]);
  });

  it("every token a backdrop filter reads defaults to none, and ?blur=1 sets each one", () => {
    const tokens = new Set(ALL.flatMap((r) => r.decls.filter(([p]) => isBackdrop(p)).flatMap(([, v]) => [...v.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!))));
    expect(tokens.size).toBeGreaterThan(0);
    const root = ALL.find((r) => r.file.endsWith("tokens.css") && /^:root,\s*\.fl-ui$/.test(r.selector))!;
    const blur = ALL.find((r) => r.file.endsWith("tokens.css") && blurLook(r))!;
    const value = (r: Rule, name: string) => r.decls.find(([p]) => p === name)?.[1];
    for (const t of tokens) {
      expect(value(root, t), `${t} by default`).toBe("none");
      expect(value(blur, t), `${t} with ?blur=1`).toMatch(/blur\(/);
    }
  });
});
