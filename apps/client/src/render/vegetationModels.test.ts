import { describe, expect, it } from "vitest";
import { BODY_IDS, PROP_KINDS } from "@firstlight/shared";
import { vegetationModels, vegetationVariant } from "./vegetationModels.ts";

describe("vegetation models", () => {
  it("maps every kind on every body and keeps Meridian spires procedural", () => {
    for (const body of BODY_IDS) for (const kind of PROP_KINDS) {
      const models = vegetationModels(body, kind);
      expect(models.length).toBeGreaterThan(0);
      expect(new Set(models).size).toBe(models.length);
    }
    expect(vegetationModels("meridian", "spire")).toEqual([null]);
    expect(vegetationModels("hollowmere", "oak")).toEqual(["TwistedTree_1", "TwistedTree_2", "TwistedTree_3"]);
  });

  it("chooses the same variant from packed Float32 yaw on every client", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const yaw = Math.fround(i * 0.0314159);
      const v = vegetationVariant("arcadia", "oak", yaw);
      expect(vegetationVariant("arcadia", "oak", new Float32Array([yaw])[0]!)).toBe(v);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });
});
