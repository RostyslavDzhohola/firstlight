import { describe, expect, it } from "vitest";
import { banKey } from "../src/auth/ip.ts";

describe("banKey", () => {
  it("keeps IPv4 addresses (including v4-mapped v6) as they are", () => {
    expect(banKey("203.0.113.7")).toBe("203.0.113.7");
    expect(banKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("bans IPv6 by /64, whatever the notation", () => {
    const k = banKey("2001:db8:85a3:0042:1000:8a2e:0370:7334");
    expect(k).toBe("2001:db8:85a3:42::/64");
    expect(banKey("2001:0db8:85a3:42::1")).toBe(k);
    expect(banKey("2001:DB8:85A3:42:ffff::")).toBe(k);
    expect(banKey("2001:db8:85a3:43::1")).not.toBe(k);
    expect(banKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(banKey("::1")).toBe("0:0:0:0::/64");
  });
});
