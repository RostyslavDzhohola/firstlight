import { describe, expect, it } from "vitest";
import { bossLineUrl } from "./bossLines.ts";

describe("boss line URLs", () => {
  it("live under the build's asset base like every other asset (no second /v/ segment)", () => {
    // SPEC §10.1: VITE_ASSET_BASE = https://firstlight-assets.<acct>.workers.dev/v/<buildId>
    const base = "https://firstlight-assets.example.workers.dev/v/b42";
    expect(bossLineUrl("tidewrath", "engage", base)).toBe(`${base}/voice/tidewrath-engage.mp3`);
    expect(bossLineUrl("receiver", "defeat", `${base}/`)).toBe(`${base}/voice/receiver-defeat.mp3`);
    expect(bossLineUrl("hollowking", "phase2", base).match(/\/v\//g)).toHaveLength(1);
  });

  it("defaults to the same base as the characters (config.assetBase)", () => {
    expect(bossLineUrl("tidewrath", "phase2")).toBe("/assets-dev/voice/tidewrath-phase2.mp3");
  });
});
