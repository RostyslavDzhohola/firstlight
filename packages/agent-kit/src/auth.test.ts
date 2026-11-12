// The session file is the character's key (review 2026-11-12 agent kit #6): private whatever was
// there before, never written or read through a symlink, replaced in one step.

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSession, writeSession } from "./auth.ts";

const AUTH = "http://localhost:2567";
const dir = () => mkdtempSync(join(tmpdir(), "fl-kit-session-"));
const mode = (f: string) => statSync(f).mode & 0o777;
const posix = process.platform !== "win32";

describe("the session file", () => {
  it("a new file is private, and nothing else is left in its folder", () => {
    const d = dir();
    const file = join(d, "nested", "session.json");
    expect(writeSession(file, { authUrl: AUTH, cookie: "a=1" })).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ authUrl: AUTH, cookie: "a=1" });
    if (posix) expect(mode(file)).toBe(0o600);
    expect(readdirSync(join(d, "nested"))).toEqual(["session.json"]);
    expect(readSession(file, AUTH)).toBe("a=1");
    expect(readSession(file, "http://elsewhere")).toBeNull();
  });

  it.runIf(posix)("a file that was readable by others is private once the cookie is in it", () => {
    const file = join(dir(), "session.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(writeSession(file, { authUrl: AUTH, cookie: "b=2" })).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(readSession(file, AUTH)).toBe("b=2");
    // Loosened by hand afterwards: reading it tightens it again.
    chmodSync(file, 0o664);
    expect(readSession(file, AUTH)).toBe("b=2");
    expect(mode(file)).toBe(0o600);
  });

  it.runIf(posix)("a symlink is refused: nothing is written through it, nothing is read through it", () => {
    const d = dir();
    const target = join(d, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ authUrl: AUTH, cookie: "theirs=1" }), { mode: 0o644 });
    const file = join(d, "session.json");
    symlinkSync(target, file);
    expect(writeSession(file, { authUrl: AUTH, cookie: "mine=1" })).toBe(false);
    expect(JSON.parse(readFileSync(target, "utf8")).cookie).toBe("theirs=1");
    expect(mode(target)).toBe(0o644);
    expect(readSession(file, AUTH)).toBeNull();
    expect(readdirSync(d).sort()).toEqual(["elsewhere.json", "session.json"]); // no temp file left behind
    // A dangling link is no better.
    const dangling = join(d, "dangling.json");
    symlinkSync(join(d, "nowhere.json"), dangling);
    expect(writeSession(dangling, { authUrl: AUTH, cookie: "mine=1" })).toBe(false);
    expect(existsSync(join(d, "nowhere.json"))).toBe(false);
  });

  it("no file asked for, or a folder in its place: not saved, and that is all", () => {
    expect(writeSession(undefined, { authUrl: AUTH, cookie: "c=3" })).toBe(false);
    const d = dir();
    expect(writeSession(d, { authUrl: AUTH, cookie: "c=3" })).toBe(false);
    expect(readSession(d, AUTH)).toBeNull();
    expect(readSession(join(d, "missing.json"), AUTH)).toBeNull();
  });
});
