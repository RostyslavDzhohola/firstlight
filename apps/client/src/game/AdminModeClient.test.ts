import { describe, expect, it, vi } from "vitest";

// config.ts reads the URL at import time.
vi.stubGlobal("location", { search: "", hostname: "localhost" });

describe("admin badge", () => {
  it("says what is on, so screenshots in admin mode are honest; nothing when nothing is", async () => {
    const { adminBadge } = await import("./AdminModeClient.ts");
    expect(adminBadge(undefined)).toBeNull();
    expect(adminBadge({ fly: false, god: false, speed: false, session: false })).toBeNull();
    expect(adminBadge({ fly: true, god: true, speed: true, session: true })).toBe("ADMIN TEST · FLY · GOD · ×2");
    expect(adminBadge({ fly: false, god: false, speed: false, session: true })).toBe("ADMIN TEST");
  });
});
