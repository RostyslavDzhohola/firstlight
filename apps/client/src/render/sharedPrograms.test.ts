import { describe, expect, it } from "vitest";
import { shareInstancingPrograms } from "./sharedPrograms.ts";

describe("shareInstancingPrograms (D-perf-4)", () => {
  it("drops the backend's uniform-buffer limit to 0, so instancing and skinning take the shared paths", () => {
    const caps = { getUniformBufferLimit: () => 65536 };
    expect(shareInstancingPrograms({ backend: { capabilities: caps } })).toBe(true);
    // Instance.js and Skinning.js compare count × 64 bytes against it: any count is over the limit.
    expect(64 <= caps.getUniformBufferLimit()).toBe(false);
  });

  it("leaves a backend without capabilities alone", () => {
    expect(shareInstancingPrograms({ backend: {} })).toBe(false);
  });
});
