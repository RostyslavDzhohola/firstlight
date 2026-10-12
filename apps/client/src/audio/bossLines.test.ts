import { describe, expect, it } from "vitest";
import { bossLineUrl } from "./bossLines.ts";

describe("boss line URLs", () => {
  it("join the voice base and the clip name once (no doubled /v/ segment)", () => {
    const base = "https://firstlight-assets.example.workers.dev/v/voice-1";
    expect(bossLineUrl("tidewrath", "engage", base)).toBe(`${base}/tidewrath-engage.mp3`);
    expect(bossLineUrl("receiver", "defeat", `${base}/`)).toBe(`${base}/receiver-defeat.mp3`);
    expect(bossLineUrl("hollowking", "phase2", base).match(/\/v\//g)).toHaveLength(1);
  });

  it("default to the asset Worker's voice set, which production serves (the clips are never in the repo)", () => {
    expect(bossLineUrl("tidewrath", "phase2")).toBe("https://firstlight-assets.rosty-build.workers.dev/v/voice-1/tidewrath-phase2.mp3");
  });
});
