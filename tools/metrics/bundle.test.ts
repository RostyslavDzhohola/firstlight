import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyseDist, htmlEntries, kindOf, staticImports, unhashed } from "./bundle.ts";

describe("bundle helpers", () => {
  it("strips rolldown's content hash", () => {
    expect(unhashed("assets/Game-Pl1YxGOC.js")).toBe("Game.js");
    expect(unhashed("three.tsl-BjefPv-S.js")).toBe("three.tsl.js");
    expect(unhashed("index.html")).toBe("index.html");
  });

  it("finds static imports only, minified or not", () => {
    const code = `import{a as b}from"./three.tsl-x.js";import"./side-y.js";import { c } from './c-z.js';const g=()=>import("./Game-q.js");`;
    expect(staticImports(code).sort()).toEqual(["./c-z.js", "./side-y.js", "./three.tsl-x.js"]);
  });

  it("reads index.html's module scripts and stylesheets, not third-party ones", () => {
    const html = `<script type="module" crossorigin src="/assets/index-A.js"></script><link rel="stylesheet" href="/assets/index-B.css"><script defer src="https://x.example/s.js"></script><link rel="modulepreload" href="/assets/pre-C.js">`;
    expect(htmlEntries(html)).toEqual({ scripts: ["/assets/index-A.js", "/assets/pre-C.js"], styles: ["/assets/index-B.css"] });
  });

  it("sorts files into kinds", () => {
    expect(["a.js", "b.webp", "c.glb", "d.woff2", "e.json", "f.wasm"].map(kindOf)).toEqual(["js", "image", "model", "font", "data", "other"]);
  });
});

describe("analyseDist", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fl-bundle-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), `<script type="module" src="/assets/index-AAAAAAAA.js"></script><link rel="stylesheet" href="/assets/index-BBBBBBBB.css">`);
  writeFileSync(path.join(dir, "assets/index-AAAAAAAA.js"), `import"./shared-CCCCCCCC.js";const g=()=>import("./Game-DDDDDDDD.js");`);
  writeFileSync(path.join(dir, "assets/index-BBBBBBBB.css"), "body{}");
  writeFileSync(path.join(dir, "assets/shared-CCCCCCCC.js"), "export const s=1;".repeat(50));
  writeFileSync(path.join(dir, "assets/Game-DDDDDDDD.js"), `import{s}from"./shared-CCCCCCCC.js";import"./three-EEEEEEEE.js";`);
  writeFileSync(path.join(dir, "assets/Game-FFFFFFFF.css"), "a{}");
  writeFileSync(path.join(dir, "assets/three-EEEEEEEE.js"), "x".repeat(4000));
  writeFileSync(path.join(dir, "assets/dup-GGGGGGGG.js"), "1");
  writeFileSync(path.join(dir, "assets/dup-HHHHHHHH.js"), "22");
  writeFileSync(path.join(dir, "hero.webp"), Buffer.alloc(100));

  it("follows the home page's static closure, then the Game chunk's", () => {
    const r = analyseDist(dir);
    expect(r.home.requests).toBe(4); // html, index.js, shared.js, index.css: not the lazy Game chunk
    expect(r.world.requests).toBe(7); // + Game.js, three.js, Game.css
    expect(r.world.raw).toBeGreaterThan(r.home.raw + 4000);
    expect(r.home.br).toBeLessThan(r.home.raw);
  });

  it("names chunks without hashes, duplicates by size, largest first", () => {
    const r = analyseDist(dir);
    expect(r.chunks[0]!.name).toBe("three.js");
    expect(r.chunks.map((c) => c.name)).toEqual(expect.arrayContaining(["dup.js", "dup.2.js", "Game.css", "index.css"]));
    expect(r.chunks.find((c) => c.name === "dup.js")!.raw).toBe(1);
    expect(r.kinds.image).toEqual({ files: 1, bytes: 100 });
    expect(r.files).toBe(10);
  });
});
