import { describe, expect, it } from "vitest";
import { homeUrl } from "./leave.ts";

describe("leaving for the home page", () => {
  it("drops ?autoplay and the hash, keeping the other flags as they were", () => {
    expect(homeUrl("https://firstlight.one4all.dev/?autoplay&webgl#x")).toBe("https://firstlight.one4all.dev/?webgl");
    expect(homeUrl("http://127.0.0.1:5207/?devguest&autoplay=1&tier=low")).toBe("http://127.0.0.1:5207/?devguest&tier=low");
    expect(homeUrl("https://firstlight.one4all.dev/?autoplay")).toBe("https://firstlight.one4all.dev/");
    expect(homeUrl("https://firstlight.one4all.dev/")).toBe("https://firstlight.one4all.dev/");
  });
});
