// Better Auth turns its Origin and CSRF checks off by default whenever it detects a test
// environment (a TEST variable is enough), so production pins them on explicitly.

import { describe, expect, it } from "vitest";
import { authOptions, type AuthDeps } from "../src/auth/better-auth.ts";

const deps = (strictOrigin: boolean) => ({ authDb: {}, baseURL: "http://x", secret: "s".repeat(40), trustedOrigins: [], rateLimit: true, strictOrigin }) as unknown as AuthDeps;

describe("Better Auth origin checks", () => {
  it("are pinned on in production, whatever the environment says", () => {
    const a = authOptions(deps(true)).advanced as Record<string, unknown>;
    expect(a.disableOriginCheck).toBe(false);
    expect(a.disableCSRFCheck).toBe(false);
  });

  it("keep Better Auth's own default outside production (the auth tests rely on it)", () => {
    const a = authOptions(deps(false)).advanced as Record<string, unknown>;
    expect(a.disableOriginCheck).toBeUndefined();
    expect(a.disableCSRFCheck).toBeUndefined();
  });
});
