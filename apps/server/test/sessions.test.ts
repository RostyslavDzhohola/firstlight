// One live session per character: the registry rooms use to kick the older session.

import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/auth/sessions.ts";

describe("session registry", () => {
  it("returns the previous live session to kick when the same character joins again", () => {
    const r = new SessionRegistry();
    expect(r.register("u1", "roomA", "s1", 1)).toBeNull();
    expect(r.register("u2", "roomA", "s2", 2)).toBeNull();
    expect(r.register("u1", "roomB", "s3", 3)).toEqual({ userId: "u1", roomId: "roomA", sessionId: "s1", since: 1 });
    expect(r.get("u1")).toMatchObject({ roomId: "roomB", sessionId: "s3" });
    expect(r.size).toBe(2);
  });

  it("re-registering the same session is not a conflict", () => {
    const r = new SessionRegistry();
    r.register("u1", "roomA", "s1");
    expect(r.register("u1", "roomA", "s1")).toBeNull();
  });

  it("a kicked session leaving doesn't remove its replacement", () => {
    const r = new SessionRegistry();
    r.register("u1", "roomA", "old");
    r.register("u1", "roomB", "new");
    expect(r.unregister("u1", "old")).toBe(false);
    expect(r.isLive("u1", "new")).toBe(true);
    expect(r.unregister("u1", "new")).toBe(true);
    expect(r.get("u1")).toBeNull();
  });

  it("re-keys a guest's session to the saved account and reports a displaced one", () => {
    const r = new SessionRegistry();
    r.register("guest", "roomA", "g");
    expect(r.rekey("guest", "acct")).toEqual({ moved: { userId: "acct", roomId: "roomA", sessionId: "g", since: expect.any(Number) }, displaced: null });
    expect(r.get("guest")).toBeNull();
    expect(r.isLive("acct", "g")).toBe(true);

    r.register("guest2", "roomB", "g2");
    const res = r.rekey("guest2", "acct");
    expect(res.displaced).toMatchObject({ roomId: "roomA", sessionId: "g" });
    expect(r.get("acct")).toMatchObject({ roomId: "roomB", sessionId: "g2" });
    // the displaced session leaving later is harmless
    expect(r.unregister("acct", "g")).toBe(false);
    expect(r.rekey("nobody", "acct")).toEqual({ moved: null, displaced: null });
  });
});
