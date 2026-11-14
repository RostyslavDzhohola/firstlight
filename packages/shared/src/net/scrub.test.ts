import { describe, expect, it } from "vitest";
import { describeThrown, scrubReport, scrubStack, scrubText } from "./scrub.ts";

describe("error report scrubbing (review 2026-11-13 ship #3)", () => {
  it("a URL keeps its origin and, for a script, its file and position; never its query, fragment, path token or credentials", () => {
    expect(scrubText("GET https://firstlight.test/reset-password/Zq81mK0pLx7vT3sYw9aBcD4e?token=abc123secret#x failed")).toBe("GET https://firstlight.test/… failed");
    expect(scrubText("at https://user:pw@cdn.test/assets/Game-Dw_HINW9.js?v=1:12:34")).toBe("at https://cdn.test/…/Game-Dw_HINW9.js:12:34");
    expect(scrubText("see https://firstlight.test/")).toBe("see https://firstlight.test");
  });

  it("relative paths lose their query and whatever follows a sensitive segment", () => {
    expect(scrubText("fetch /api/auth/verify/Zq81mK0pLx7vT3sYw9aBcD4e?x=1 failed")).toBe("fetch /api/auth/[redacted]/[redacted] failed");
    expect(scrubText("load /assets/a.js?token=t0ps3cret")).toBe("load /assets/a.js");
  });

  it("emails, plain or percent-encoded; JWTs, bearers, key=value secrets and long tokens", () => {
    expect(scrubText("no account for player%40example.com or a%2Bb%40c.org")).toBe("no account for [email] or [email]");
    expect(scrubText("Bearer eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl")).toBe("Bearer [redacted]");
    expect(scrubText("token=Zq81mK0pLx7v password: hunter2hunter2")).toBe("token=[redacted] password: [redacted]");
    expect(scrubText("id abcDEF1234567890ghijKLMN end")).toBe("id [token] end");
    expect(scrubText("close code: 1006")).toBe("close code: 1006"); // short numbers stay
  });

  it("a stack keeps at most five frames, each function plus file and position", () => {
    const stack = ["TypeError: boom for a@b.io", "    at tick (https://x.test/assets/Game-abc.js?t=Zq81mK0pLx7vT3sYw9aBcD4e:1:2)", "    at https://x.test/invite/Zq81mK0pLx7vT3sYw9aBcD4e:3:4", "loop@https://x.test/assets/b.js:5:6", ...Array.from({ length: 6 }, (_, i) => `    at f${i} (https://x.test/c.js:${i}:1)`)].join("\n");
    const s = scrubStack(stack);
    expect(s.split("\n")).toEqual(["at tick (https://x.test/…/Game-abc.js:1:2)", "at https://x.test/…", "at loop (https://x.test/…/b.js:5:6)", "at f0 (https://x.test/…/c.js:0:1)", "at f1 (https://x.test/…/c.js:1:1)"]);
  });

  it("never serialises what a promise was rejected with", () => {
    expect(describeThrown({ email: "who@example.com", token: "abc" }).message).toBe("Unhandled rejection (Object)");
    expect(describeThrown(null).message).toBe("Unhandled rejection (null)");
    expect(describeThrown(42).message).toBe("Unhandled rejection (number)");
    expect(describeThrown(Object.assign(new RangeError("bad"), { stack: "x" }))).toEqual({ message: "RangeError: bad", stack: "x" });
    expect(scrubReport("x".repeat(1000), "").message).toHaveLength(300);
  });
});
