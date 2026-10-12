// Opus parameters on a remote description. Format parameters in an SDP state what its author wants
// to receive, so adding them to the description we apply tells our own encoder how to send:
// DTX on (silence costs almost nothing), mono, in-band FEC, capped average bitrate.

import { VOICE } from "@firstlight/shared/net/voice";

const WANT: Record<string, string> = {
  usedtx: "1",
  stereo: "0",
  useinbandfec: "1",
  maxaveragebitrate: String(VOICE.OPUS_MAX),
};

export function withOpusParams(sdp: string): string {
  const nl = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(nl);
  const pts = new Set<string>();
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    if (m) pts.add(m[1]!);
  }
  if (!pts.size) return sdp;
  const out: string[] = [];
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && pts.has(f[1]!)) {
      out.push(`a=fmtp:${f[1]} ${mergeParams(f[2]!)}`);
      continue;
    }
    out.push(l);
    const r = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    if (r && !lines.some((x) => x.startsWith(`a=fmtp:${r[1]} `))) {
      out.push(`a=fmtp:${r[1]} ${mergeParams("")}`);
    }
  }
  return out.join(nl);
}

function mergeParams(params: string): string {
  const kv = new Map<string, string>();
  for (const part of params.split(";")) {
    const [k, v] = part.split("=");
    if (k && k.trim()) kv.set(k.trim(), (v ?? "").trim());
  }
  for (const [k, v] of Object.entries(WANT)) kv.set(k, v);
  return [...kv].map(([k, v]) => `${k}=${v}`).join(";");
}
