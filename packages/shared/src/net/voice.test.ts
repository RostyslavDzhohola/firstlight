import { describe, expect, it } from "vitest";
import { filterIceServers } from "./voice.ts";

describe("ICE server filtering", () => {
  const list = [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"], username: "u", credential: "c" },
  ];

  it("relay-only drops STUN and port 53, keeps 5349", () => {
    expect(filterIceServers(list, true)).toEqual([
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"], username: "u", credential: "c" },
    ]);
  });

  it("direct mode keeps STUN but still drops port 53", () => {
    const out = filterIceServers(list, false);
    expect(out[0]!.urls).toEqual(["stun:stun.cloudflare.com:3478"]);
    expect(out[1]!.urls).toHaveLength(2);
  });
});
