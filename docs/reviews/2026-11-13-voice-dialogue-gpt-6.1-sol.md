# Review: dialogue, voices and music lane (`night/voice` at `9bd7b332`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** Licensing is acceptable; speech ordering, subtitle timing and audio
resource bounds need fixes. No blockers.

## Findings

1. **Should-fix, `apps/client/src/audio/speech.ts:76`: asynchronous loads can reverse dialogue.** Request
   A, request B, B resolves first, then A: A stops B and plays while B's subtitle is still up. Nothing is
   cancelled on body travel or system disposal. A per-speaker request token before loading, stale
   completions rejected, pending and playing speech invalidated on leaving the body.
2. **Should-fix, `speech.ts:73`: subtitles expire independently of playback.** The subtitle timer starts
   before fetch and decode; a slow first download leaves the recording playing after its subtitle is
   gone, and `NpcTalk.busyUntil` underestimates. Keep the immediate text, refresh its duration when the
   recording starts, derive speaker availability from playback completion.
3. **Should-fix, `apps/client/src/audio/music.ts:181`: live scheduling replays an unbounded backlog.** A
   simulated ten-minute timer gap created 4,781 sources in one callback, 4,773 in the past. Skip elapsed
   steps in the live timer; schedule only the bounded future window.
4. **Should-fix, `speech.ts:34`: decoded recordings stay cached for good.** 3.2 MB compressed is about
   189 MiB as mono float PCM at 48 kHz. A byte-bounded LRU that keeps active recordings.
5. **Nit, `packages/shared/src/content/residentLines.ts:267`: the mission count is wrong** ("a guide gives
   three missions": Lark has five, Mabry four). Drop the count; regenerate `ptolemy.tip.2.mp3`.
6. **Nit, `tools/voice/generate.ts:12`: clean-machine setup is incomplete** (`$FL_VOICE_HOME` unassigned,
   a `models` directory never created; state the Python and FFmpeg prerequisites).

## Checked and sound

Shipping the generated recordings in an MIT-code, CC BY-art game is allowed: the Kokoro-82M model card
gives Apache-2.0 weights, the upstream licence and voice inventory were read, the ONNX runner is MIT; no
output restriction found; the GPL phoneme tools are generation dependencies, not shipped code. No
weights, environments or caches in git. Every new and changed line was read: no franchise reference, no
egg solution, nothing cruel; sampled prices, levels and trial numbers match `docs/content.md` apart from
finding 5. Speech stays validated authored ids with restricted slots. Recordings load on demand with
nearby greeting and farewell preloads; a missing file leaves the subtitle; suspended audio skips
playback; speech goes through the master and Voices gains. Music excerpts peak between −15.5 and
−8.1 dBFS. Tests: speech 4/4, music 3/3.

## Not checked

A browser, live listening, GC and CPU in a real browser, touch and gamepad.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
