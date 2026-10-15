import { describe, expect, it } from "vitest";
import { inviteMailto, SHARE_URL, xFollowUrl, xHandle } from "./shareLinks.ts";

describe("share links", () => {
  it("shows Follow on X only for a valid handle", () => {
    expect(xHandle(undefined)).toBeNull();
    expect(xHandle("")).toBeNull();
    expect(xHandle("  ")).toBeNull();
    expect(xHandle("@first_light")).toBe("first_light");
    expect(xHandle("first light")).toBeNull();
    expect(xHandle("a".repeat(16))).toBeNull();
    expect(xHandle("x\"><script>")).toBeNull();
    expect(xFollowUrl("first_light")).toBe("https://x.com/intent/follow?screen_name=first_light");
  });

  it("builds a mailto invite with the public link, encoded", () => {
    const m = inviteMailto();
    expect(m.startsWith("mailto:?subject=Play%20FIRSTLIGHT%20with%20me&body=")).toBe(true);
    expect(decodeURIComponent(m.split("body=")[1]!)).toContain(SHARE_URL);
    expect(m).not.toContain(" ");
  });
});
