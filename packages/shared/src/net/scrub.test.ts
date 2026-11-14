import { describe, expect, it } from "vitest";
import { CREDENTIAL_KEYS, describeThrown, SCRUB_INPUT, scrubReport, scrubStack, scrubText } from "./scrub.ts";

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

  // Review round two, finding 3: a bracketed IPv6 authority slipped past the URL rule and kept its path secret.
  it("any URL shape keeps no path secret: IPv6, userinfo, ports, upper-case or unknown schemes, percent-encoding", () => {
    expect(scrubText("https://[::1]/reset/shortsecret?token=secret")).toBe("https://[::1]/…");
    expect(scrubText("GET https://[2001:db8::7]:8443/invite/abc123 failed")).toBe("GET https://[2001:db8::7]:8443/… failed");
    expect(scrubText("at https://[::1]:5173/assets/main-abc.js:1:2")).toBe("at https://[::1]:5173/…/main-abc.js:1:2");
    expect(scrubText("HTTPS://User:Pw@Host.Test/Reset/abc")).toBe("https://host.test/…");
    expect(scrubText("https://alice:hunter2@x.test:444/reset/abc")).toBe("https://x.test:444/…");
    expect(scrubText("ftp://bob:pw@files.test/token/abc and chrome-extension://abcdef/secret/x")).toBe("[url] and [url]");
    expect(scrubText("https%3A%2F%2Fx.test%2Freset%2Fsupersecret")).toBe("https://x.test/…");
    expect(scrubText("https%253A%252F%252Fx.test%252Freset%252Fsupersecret")).toBe("https://x.test/…");
    expect(scrubText("(https://x.test/reset/abc)")).toBe("(https://x.test/…)");
    expect(scrubText("[https://x.test/reset/abc]")).not.toContain("abc");
  });

  it("paths without a scheme or a leading slash lose what follows a sensitive segment too", () => {
    expect(scrubText("open x.test/reset/abc123 now")).toBe("open x.test/reset/[redacted] now");
    expect(scrubText("//x.test/invite/abc?y=1")).toBe("//x.test/invite/[redacted]");
    expect(scrubText("[::1]/reset/abc")).toBe("[::1]/reset/[redacted]");
    expect(scrubText("access_token=abc123xyz&id_token=qwe456rty")).not.toMatch(/abc123xyz|qwe456rty/);
  });

  it("text past the input bound is cut before any rule runs, with the word the cut split dropped", () => {
    const long = `${"word ".repeat(SCRUB_INPUT / 5)}alice@example.com tail`;
    const out = scrubText(long);
    expect(out.length).toBeLessThanOrEqual(SCRUB_INPUT + 2);
    expect(out).not.toMatch(/alice|exam/);
    // A cut through the middle of an email leaves no part of it.
    const cut = `${"y".repeat(SCRUB_INPUT - 8)} alice@example.com`;
    expect(scrubText(cut)).not.toMatch(/ali|@/);
  });

  // Review round three, finding 5: any word ending in a sensitive suffix counted as a credential key,
  // so diagnostic codes were erased.
  it("redacts the listed credential keys only: diagnostic codes stay readable", () => {
    expect(scrubText("HTTP status_code=INVALID_ARGUMENT")).toBe("HTTP status_code=INVALID_ARGUMENT");
    expect(scrubText("shader code: WGSLValidationError")).toBe("shader code: WGSLValidationError");
    expect(scrubText("error code: E_DEVICE_LOST, close code: 1006")).toBe("error code: E_DEVICE_LOST, close code: 1006");
    expect(scrubText("Duplicate key: playerName")).toBe("Duplicate key: playerName");
    // The listed keys, any case, with `_`, `-` or nothing between their words, `=` or `:`.
    expect(scrubText("client_secret=s3cr3tvalue X-Api-Key: abcdef123 refresh-token=qwertyuiop otp: 123456 authorization: dXNlcjpwYXNz")).toBe(
      "client_secret=[redacted] X-Api-Key: [redacted] refresh-token=[redacted] otp: [redacted] authorization: [redacted]",
    );
    expect(scrubText("SessionId=abcdefgh PASSWORD: hunter2hunter2 apikey=zzzzzzzz")).toBe("SessionId=[redacted] PASSWORD: [redacted] apikey=[redacted]");
    expect(CREDENTIAL_KEYS).not.toContain("code");
    expect(CREDENTIAL_KEYS).not.toContain("key");
  });

  // Review round three, nit 6: the URL's trailing "]" check scanned back for "[" once per bracket.
  it("trims a URL's trailing brackets in linear time", () => {
    const s = `https://x.test/a${"]".repeat(SCRUB_INPUT - 96)}`; // inside the input bound
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      expect(scrubText(s)).toBe(`https://x.test/…${"]".repeat(SCRUB_INPUT - 96)}`);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(2); // quadratic: about 5 ms
    expect(scrubText("[https://x.test/a] and (https://x.test/b])")).toBe("[https://x.test/…] and (https://x.test/…])");
  });

  // Review round two, finding 4: the email rule was quadratic on a long run without "@" (16,000
  // characters took about 780 ms), on public ingestion and on the page before truncation.
  it("finishes in a few milliseconds on a 100,000-character hostile string of every shape", () => {
    const shapes: Record<string, string> = {
      "x…": "x".repeat(100_000),
      "@…": "@".repeat(100_000),
      "a@a@a…": "a@".repeat(50_000),
      "://…": "://".repeat(33_334),
      "a.…": `a@${"a.".repeat(50_000)}`,
      "eyJ…": "eyJ".repeat(33_334),
      "%…": "%25".repeat(33_334),
      "http://….": `http://x.test/${".".repeat(100_000)}x`,
      "spaces": `at ${" ".repeat(100_000)}x`,
      "gecko": `f@${" ".repeat(100_000)}x`,
      "token=…": `token${" ".repeat(100_000)}`,
      "a-a-…": "a-".repeat(50_000),
      "?a?a…": "?a".repeat(50_000),
      "https://https://…": "https://".repeat(12_500),
      "[[[…": "https://[".repeat(11_112),
      "lines": "at f (https://x.test/a.js:1:1)\n".repeat(4000),
    };
    // Each shape through every public entry point, best of three (a busy machine adds pauses to
    // single runs; a super-linear pattern would be slow on every run: the old email rule took seconds).
    for (const [name, s] of Object.entries(shapes)) {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        scrubText(s);
        scrubStack(s);
        scrubReport(s, s);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best, name).toBeLessThan(25); // quiet machine: under 3 ms; the old email rule took seconds
    }
  });
});
