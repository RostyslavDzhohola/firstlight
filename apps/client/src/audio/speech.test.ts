import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SPOKEN_LINES, textKey } from "@firstlight/shared/content/dialogue";
import manifest from "./voiceLines.json";
import { hasVoice, SPEECH_CACHE_BYTES, SpeechPlayer, subtitleMs, voiceUrl } from "./speech.ts";

const lines = manifest.lines as Record<string, { k: string; ms: number }>;
const file = (id: string) => fileURLToPath(new URL(`../../public/voice/${id}.mp3`, import.meta.url));

describe("spoken lines", () => {
  it("every spoken line has a recording made from its current words (tools/voice/generate.ts)", () => {
    const missing = SPOKEN_LINES.filter((l) => !hasVoice(l.id)).map((l) => l.id);
    expect(missing, "run: node tools/voice/generate.ts").toEqual([]);
    for (const l of SPOKEN_LINES) expect(existsSync(file(l.id)), l.id).toBe(true);
  });

  it("the manifest lists only spoken lines, each file small", () => {
    const ids = new Set(SPOKEN_LINES.map((l) => l.id));
    let total = 0;
    for (const id of Object.keys(lines)) {
      expect(ids.has(id), id).toBe(true);
      const bytes = statSync(file(id)).size;
      expect(bytes, id).toBeLessThan(40_000);
      total += bytes;
    }
    expect(total).toBeLessThan(3.6e6); // the repo budget for model output (brief: about 3 MB)
  });

  it("plays a file only when it matches the text", () => {
    const l = SPOKEN_LINES[0]!;
    expect(hasVoice(l.id, { [l.id]: { k: textKey(l.text), ms: 1000 } })).toBe(true);
    expect(hasVoice(l.id, { [l.id]: { k: textKey(`${l.text}!`), ms: 1000 } })).toBe(false);
    expect(hasVoice("nobody.says.this", { "nobody.says.this": { k: "x", ms: 1 } })).toBe(false);
  });

  it("subtitles last at least as long as the recording, and files sit under the base path", () => {
    const l = SPOKEN_LINES[0]!;
    expect(subtitleMs(l.id, l.text, { [l.id]: { k: textKey(l.text), ms: 8000 } })).toBeGreaterThanOrEqual(8000);
    expect(subtitleMs(l.id, "Hi.", {})).toBe(2500 + 3 * 45);
    expect(voiceUrl("lark.greet.1", "/")).toBe("/voice/lark.greet.1.mp3");
    expect(voiceUrl("lark.greet.1", "/play")).toBe("/play/voice/lark.greet.1.mp3");
  });
});

// ---------------------------------------------------------------- the player (review 2026-11-13 findings 1, 2, 4)

/** A load the test resolves by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)));
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake GameAudio: sources record start/stop; a "decoded" buffer's length is its byte length / 4. */
function rig(o: { state?: string; maxBytes?: number } = {}) {
  let t = 0;
  const loads = new Map<string, ReturnType<typeof deferred<ArrayBuffer>>[]>();
  const sources: { id: string; started: boolean; stopped: boolean; end: () => void }[] = [];
  const subs: { op: "show" | "hold" | "hide"; token: number; ms?: number; text?: string }[] = [];
  let token = 0;
  const ctx = {
    state: o.state ?? "running",
    createBufferSource() {
      const s: any = { buffer: null, onended: null, connect: () => s };
      const rec = { id: "", started: false, stopped: false, end: () => s.onended?.() };
      s.start = () => {
        rec.started = true;
        rec.id = s.buffer.id;
      };
      s.stop = () => {
        if (rec.stopped) return;
        rec.stopped = true;
        queueMicrotask(() => s.onended?.()); // like the browser: ended fires after stop
      };
      sources.push(rec);
      return s;
    },
    // The "bytes" carry the line id and its length in seconds; mono at 48 kHz.
    decodeAudioData: async (b: ArrayBuffer) => {
      const { id, sec } = JSON.parse(new TextDecoder().decode(b));
      return { id, duration: sec, length: Math.round(sec * 48000), numberOfChannels: 1 };
    },
  };
  const out = { ctx, speech: {}, spatial: () => ({}), duckMusic: () => {} };
  const player = new SpeechPlayer(out as any, {
    fetchBytes: (id) => {
      const d = deferred<ArrayBuffer>();
      loads.set(id, [...(loads.get(id) ?? []), d]);
      return d.promise;
    },
    subtitle: {
      show: (_name, text, ms) => (subs.push({ op: "show", token: ++token, ms, text }), token),
      hold: (tk, ms) => void subs.push({ op: "hold", token: tk, ms }),
      hide: (tk) => void subs.push({ op: "hide", token: tk }),
    },
    subtitlesOn: () => true,
    now: () => t,
    maxBytes: o.maxBytes,
  });
  /** Finish the oldest pending load of `id` with a recording `sec` long. */
  const finish = async (id: string, sec: number) => {
    const d = loads.get(id)?.shift();
    if (!d) throw new Error(`no pending load of ${id}`);
    d.resolve(new TextEncoder().encode(JSON.stringify({ id, sec })).buffer as ArrayBuffer);
    await flush();
  };
  /** Fail the oldest pending load of `id` (a dropped connection). */
  const fail = async (id: string) => {
    loads.get(id)!.shift()!.reject(new Error("offline"));
    await flush();
  };
  return { player, ctx, sources, subs, finish, fail, advance: (ms: number) => (t += ms), pending: (id: string) => loads.get(id)?.length ?? 0 };
}

const [A, B, C] = SPOKEN_LINES.slice(0, 3).map((l) => l.id) as [string, string, string];
const textOf = (id: string) => SPOKEN_LINES.find((l) => l.id === id)!.text;

describe("speech player: ordering (finding 1)", () => {
  it("request A, request B, B resolves first: B plays, A never plays nor touches the subtitle", async () => {
    const r = rig();
    r.player.say(A, { name: "Lark", key: "lark" });
    r.player.say(B, { name: "Lark", key: "lark" });
    await r.finish(B, 2);
    await r.finish(A, 3);
    expect(r.sources.filter((s) => s.started).map((s) => s.id)).toEqual([B]);
    expect(r.sources.some((s) => s.stopped)).toBe(false);
    const [sa, sb] = r.subs.filter((s) => s.op === "show");
    expect(sa!.text).toBe(textOf(A));
    expect(sb!.text).toBe(textOf(B));
    expect(r.subs.filter((s) => s.token === sa!.token && s.op !== "show")).toEqual([]);
  });

  it("A resolves first and plays; B then cuts it (the latest request per speaker wins)", async () => {
    const r = rig();
    r.player.say(A, { name: "Lark", key: "lark" });
    await r.finish(A, 3);
    r.player.say(B, { name: "Lark", key: "lark" });
    expect(r.sources[0]!.stopped).toBe(true); // the old line stops as the new one is asked for
    await r.finish(B, 2);
    expect(r.sources.filter((s) => s.started).map((s) => s.id)).toEqual([A, B]);
    expect(r.sources[1]!.stopped).toBe(false);
  });

  it("two speakers never cancel each other", async () => {
    const r = rig();
    r.player.say(A, { name: "Lark", key: "lark" });
    r.player.say(B, { name: "Juno", key: "juno" });
    await r.finish(B, 2);
    await r.finish(A, 2);
    expect(r.sources.filter((s) => s.started && !s.stopped).map((s) => s.id).sort()).toEqual([A, B].sort());
  });

  it("leaving the body (stopAll) stops what plays, forgets what loads and takes the subtitle down", async () => {
    const r = rig();
    r.player.say(A, { name: "Lark", key: "lark" });
    await r.finish(A, 3);
    r.player.say(B, { name: "Juno", key: "juno" });
    r.player.stopAll();
    expect(r.sources[0]!.stopped).toBe(true);
    await r.finish(B, 2);
    expect(r.sources.filter((s) => s.started).map((s) => s.id)).toEqual([A]);
    // Both lines are taken down (subtitle.ts ignores a token that is no longer the line on screen).
    expect(r.subs.filter((s) => s.op === "hide").map((s) => s.token)).toEqual([1, 2]);
    expect(r.player.busy("lark")).toBe(false);
    expect(r.player.busy("juno")).toBe(false);
  });

  it("one speaker can be stopped alone (their system is disposed)", async () => {
    const r = rig();
    r.player.say(A, { name: "Lark", key: "lark" });
    r.player.say(B, { name: "Juno", key: "juno" });
    r.player.stop("lark");
    await r.finish(A, 2);
    await r.finish(B, 2);
    expect(r.sources.filter((s) => s.started).map((s) => s.id)).toEqual([B]);
  });
});

describe("speech player: subtitles and busy follow playback (finding 2)", () => {
  it("a slow download: the subtitle is held from the moment the recording starts, for all of it", async () => {
    const r = rig();
    const ms = r.player.say(A, { name: "Lark", key: "lark" });
    expect(r.subs[0]).toMatchObject({ op: "show", ms });
    r.advance(20_000); // the first download took 20 s: the estimate ran out long ago
    await r.finish(A, 6.5);
    expect(r.subs[1]).toEqual({ op: "hold", token: r.subs[0]!.token, ms: 6500 + 900 });
  });

  it("a speaker is busy until playback really ends, not until a guess", async () => {
    const r = rig();
    const ms = r.player.say(A, { name: "Lark", key: "lark" });
    expect(r.player.busy("lark")).toBe(true); // loading
    r.advance(ms + 5000);
    await r.finish(A, 6.5);
    r.advance(60_000);
    expect(r.player.busy("lark")).toBe(true); // still playing (no ended event yet)
    r.sources[0]!.end();
    expect(r.player.busy("lark")).toBe(false);
  });

  it("a load that never comes stops counting as busy when its subtitle's time is up", () => {
    const r = rig();
    const ms = r.player.say(A, { name: "Lark", key: "lark" });
    r.advance(ms - 1);
    expect(r.player.busy("lark")).toBe(true);
    r.advance(1);
    expect(r.player.busy("lark")).toBe(false);
  });

  it("text only (no audio, a suspended context or a failed load) keeps the reading time", async () => {
    for (const mode of ["none", "suspended", "failed"] as const) {
      const r = mode === "none" ? null : rig({ state: mode === "suspended" ? "suspended" : "running" });
      const subs: { op: string; ms?: number }[] = [];
      let t = 0;
      const p = r?.player ?? new SpeechPlayer(null, { subtitle: { show: (_n, _t, ms) => (subs.push({ op: "show", ms }), 1), hold: () => subs.push({ op: "hold" }), hide: () => subs.push({ op: "hide" }) }, subtitlesOn: () => true, now: () => t });
      const ms = p.say(C, { name: "Lark", key: "lark" });
      expect(ms).toBe(subtitleMs(C, textOf(C)));
      if (r && mode === "suspended") await r.finish(C, 3);
      if (r && mode === "failed") await r.fail(C);
      const log = r?.subs ?? subs;
      expect(log.filter((s) => s.op !== "show")).toEqual([]);
      expect(log[0]!.ms).toBe(ms);
      if (r) {
        expect(r.sources.filter((s) => s.started)).toEqual([]);
        r.advance(ms);
        expect(r.player.busy("lark")).toBe(false);
      } else {
        expect(p.busy("lark")).toBe(true);
        t = ms;
        expect(p.busy("lark")).toBe(false);
      }
    }
  });
});

describe("speech player: decoded cache (finding 4)", () => {
  it("stays under its byte bound, least recently used out first, never one that is playing", async () => {
    const MB = 1 << 20;
    const sec = MB / 4 / 48000; // one mebibyte of mono float PCM
    const r = rig({ maxBytes: 3 * MB });
    const [d, e, f, g] = SPOKEN_LINES.slice(3, 7).map((l) => l.id) as [string, string, string, string];
    r.player.say(A, { name: "Lark", key: "lark" }); // A plays the whole time
    await r.finish(A, sec);
    for (const id of [d, e, f]) {
      r.player.preload([id]);
      await r.finish(id, sec);
      expect(r.player.cachedBytes()).toBeLessThanOrEqual(3 * MB);
    }
    expect(r.player.cached()).toEqual([e, f, A].sort()); // d, least recently used, went first; A is playing
    r.player.preload([e]); // a hit: e is now the most recent
    expect(r.pending(e)).toBe(0);
    r.player.preload([g]);
    await r.finish(g, sec);
    expect(r.player.cached()).toEqual([A, e, g].sort());
    r.sources[0]!.end(); // A ends: it may go now, but nothing forces it
    expect(r.player.cachedBytes()).toBeLessThanOrEqual(3 * MB);
  });

  it("while several play at once the bound may be passed, and is restored as they end", async () => {
    const MB = 1 << 20;
    const sec = (2 * MB) / 4 / 48000;
    const r = rig({ maxBytes: 3 * MB });
    r.player.say(A, { name: "Lark", key: "lark" });
    r.player.say(B, { name: "Juno", key: "juno" });
    await r.finish(A, sec);
    await r.finish(B, sec);
    expect(r.player.cached().sort()).toEqual([A, B].sort());
    r.sources[0]!.end();
    expect(r.player.cached()).toEqual([B]);
  });

  it("the default bound is the one DECISIONS names (32 MiB)", () => {
    expect(SPEECH_CACHE_BYTES).toBe(32 * 1024 * 1024);
  });
});
