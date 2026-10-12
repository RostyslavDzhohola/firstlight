import { describe, expect, it } from "vitest";
import { withOpusParams } from "./sdp.ts";

const SDP = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111 63", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1", "a=rtpmap:63 red/48000/2", "a=fmtp:63 111/111", ""].join("\r\n");

describe("Opus parameters", () => {
  it("turns on DTX, mono and the bitrate cap on the Opus line only", () => {
    const out = withOpusParams(SDP);
    const fmtp = out.split("\r\n").find((l) => l.startsWith("a=fmtp:111 "))!;
    expect(fmtp).toContain("minptime=10");
    expect(fmtp).toContain("usedtx=1");
    expect(fmtp).toContain("stereo=0");
    expect(fmtp).toContain("useinbandfec=1");
    expect(fmtp).toContain("maxaveragebitrate=24000");
    expect(out).toContain("a=fmtp:63 111/111");
    expect(withOpusParams(out)).toBe(out); // idempotent
  });

  it("adds an fmtp line when Opus has none, and leaves SDP without Opus alone", () => {
    const bare = ["v=0", "a=rtpmap:109 opus/48000/2", ""].join("\n");
    expect(withOpusParams(bare)).toContain("a=rtpmap:109 opus/48000/2\na=fmtp:109 usedtx=1");
    const noOpus = "v=0\r\na=rtpmap:0 PCMU/8000\r\n";
    expect(withOpusParams(noOpus)).toBe(noOpus);
  });
});
