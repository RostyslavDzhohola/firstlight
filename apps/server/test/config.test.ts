// Small server rules found in the F12 reviews: reserved display names (Opus nit) and the production
// boot check (Opus nit: database paths must point at the volume).

import { describe, expect, it } from "vitest";
import { displayNameProblem } from "../src/db/names.ts";
import { productionConfigProblems } from "../src/env.ts";

describe("reserved display names", () => {
  it("staff and game names are refused, ignoring case, underscores and digit swaps", () => {
    for (const name of ["Admin", "admin_", "ADM1N", "The_Admin", "Firstlight", "FIRST_LIGHT", "F1rstL1ght", "Moderator", "Mod", "mod_ann", "System", "Oversight", "Developer", "Staff", "GameMaster", "Official_Bob"]) {
      expect(displayNameProblem(name), name).toBe("reserved");
    }
  });

  it("…also as name parts: camelCase, digits and caps runs split a name", () => {
    for (const name of ["AdminBob", "xXAdminXx", "Admin99", "Bob_Server", "SystemOne", "Support_Desk", "OfficialNews", "Dev_Ann", "TeamLead", "5ystem", "SUPPORT"]) {
      expect(displayNameProblem(name), name).toBe("reserved");
    }
  });

  it("ordinary names that merely contain those words inside a part still pass (F12 final Sonnet S6)", () => {
    for (const name of ["Admiral", "Modesty", "Devon", "Mira_7", "Systole", "Overture", "Observer", "Badminton", "Ecosystem", "Supporter", "Unofficial", "Systemic", "Preserver"]) {
      expect(displayNameProblem(name), name).toBeNull();
    }
  });

  it("…and glued lower-case names that start or end with a staff word are reserved (F12 confirm Sonnet N-1)", () => {
    const glued = [
      "adminbob", "gameadmin", "theadmin", "serverbob", "supportteam", "systemmsg", "officialfl",
      "oversightbob", "theoversight", "sysopbob", "mysysop", "5erverbob", "supportdesk", "officialnews", "systemone", "adm1nbob",
    ];
    for (const name of glued) expect(displayNameProblem(name), name).toBe("reserved");
  });

  it("…while ordinary words and names that only share those letters still pass", () => {
    const ordinary = [
      "Badminton", "Observer", "Staffan", "Ecosystem", "Supporter", "Unofficial", "Systemic", "Preserver", "Modest", "Device", "Developers",
      "Serverus", "Supportive", "Supported", "Systematic", "Officially", "Officialdom", "Devin", "Deverell", "Moderna", "Modric", "Modular",
      "Development", "Admiral", "Systole", "Kadmina", "Overseer", "Sysy",
    ];
    for (const name of ordinary) expect(displayNameProblem(name), name).toBeNull();
  });
});

describe("production boot check", () => {
  const good = {
    NODE_ENV: "production",
    ORIGIN_SECRET: "x",
    BETTER_AUTH_URL: "https://firstlight.one4all.dev",
    CLIENT_ORIGIN: "https://firstlight.one4all.dev",
    BETTER_AUTH_SECRET: "y".repeat(40),
    AUTH_DB_PATH: "/data/auth.db",
    GAME_DB_PATH: "/data/game.db",
  };

  it("passes a complete production config", () => {
    expect(productionConfigProblems(good)).toEqual([]);
  });

  it("refuses to boot without explicit database paths (the default ./data is outside the volume)", () => {
    const { AUTH_DB_PATH: _a, GAME_DB_PATH: _g, ...rest } = good;
    const problems = productionConfigProblems(rest);
    expect(problems.some((p) => p.includes("AUTH_DB_PATH"))).toBe(true);
    expect(problems.some((p) => p.includes("GAME_DB_PATH"))).toBe(true);
  });

  it("still refuses dev guests and a missing origin secret", () => {
    expect(productionConfigProblems({ ...good, ALLOW_DEV_GUESTS: "1" }).length).toBe(1);
    expect(productionConfigProblems({ ...good, ORIGIN_SECRET: "" }).length).toBe(1);
  });
});
