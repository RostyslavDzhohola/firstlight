import { describe, expect, it, vi } from "vitest";
import { SIGN_OUT_OFFLINE, SIGN_OUT_REFUSED, signOutSession } from "./signOut.ts";

const client = (signOut: () => Promise<unknown>, getSession: () => Promise<unknown> = async () => ({ data: null, error: null })) => ({
  signOut: vi.fn(signOut),
  getSession: vi.fn(getSession),
});

describe("sign out", () => {
  it("succeeds only when the server accepts it and the session is gone", async () => {
    const c = client(async () => ({ data: { success: true }, error: null }));
    expect(await signOutSession(c)).toEqual({ ok: true });
    expect(c.getSession).toHaveBeenCalledTimes(1);
  });

  it("fails on a transport error (the request rejects)", async () => {
    const c = client(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await signOutSession(c)).toEqual({ ok: false, message: SIGN_OUT_OFFLINE });
    expect(c.getSession).not.toHaveBeenCalled();
  });

  it("fails on an API error (Better Auth returns { error })", async () => {
    const c = client(async () => ({ data: null, error: { status: 500, message: "Internal Server Error" } }));
    expect(await signOutSession(c)).toEqual({ ok: false, message: SIGN_OUT_REFUSED });
  });

  it("fails when the session is still there afterwards", async () => {
    const c = client(async () => ({ data: { success: true }, error: null }), async () => ({ data: { user: { id: "u1" } }, error: null }));
    expect(await signOutSession(c)).toEqual({ ok: false, message: SIGN_OUT_REFUSED });
  });

  it("counts an accepted sign-out even if the check afterwards can't be made", async () => {
    const c = client(async () => ({ data: { success: true }, error: null }), async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await signOutSession(c)).toEqual({ ok: true });
  });
});
