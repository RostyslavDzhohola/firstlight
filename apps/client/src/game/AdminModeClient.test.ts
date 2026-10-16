import { describe, expect, it, vi } from "vitest";

// config.ts reads the URL at import time.
vi.stubGlobal("location", { search: "", hostname: "localhost" });

describe("admin badge", () => {
  it("says it's the sandbox and what is on, so screenshots are honest; nothing in the real world", async () => {
    const { adminBadge } = await import("./AdminModeClient.ts");
    expect(adminBadge(undefined)).toBeNull();
    expect(adminBadge({ fly: false, god: false, speed: false, sandbox: false })).toBeNull();
    // Switches can't be on outside a sandbox; if a state said so, there is still no badge to trust.
    expect(adminBadge({ fly: true, god: true, speed: true, sandbox: false })).toBeNull();
    expect(adminBadge({ fly: true, god: true, speed: true, sandbox: true, home: "arcadia" })).toBe("SANDBOX — nothing here is saved · FLY · GOD · ×2");
    expect(adminBadge({ fly: false, god: false, speed: false, sandbox: true })).toBe("SANDBOX — nothing here is saved");
  });

  it("has a toast for each sandbox refusal /api/play can give", async () => {
    const { SANDBOX_REFUSALS } = await import("./AdminModeClient.ts");
    for (const reason of ["forbidden", "respawn first", "in combat", "no character", "sandboxes full"]) expect(SANDBOX_REFUSALS[reason]).toBeTruthy();
  });
});
