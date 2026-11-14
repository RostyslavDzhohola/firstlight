// @vitest-environment happy-dom
// Push to talk (K) and photo mode's K (time of day) share a key (review finding 2). With voice on and a
// live microphone, K in photo mode must never put the microphone on air or open voice setup; B (the
// radio) is off air there too. Out of photo mode K talks as before.
import { describe, expect, it, vi } from "vitest";
import type { Game } from "../game/Game.ts";
import type { Room } from "@colyseus/sdk";
import { VoiceClient, VoiceRoom } from "./VoiceClient.ts";

function setup() {
  const held = new Set<string>();
  const pressed = new Set<string>();
  const sent: { type: string; msg: unknown }[] = [];
  const me = { x: 0, y: 1000, z: 0, flags: 0, radioCh: 1 };
  const players = new Map<string, typeof me>([["s1", me]]);
  const room = {
    sessionId: "s1",
    state: { players },
    send: (type: string, msg: unknown) => void sent.push({ type, msg }),
    onMessage: () => () => {},
  };
  const toasts: string[] = [];
  const game = {
    net: { room },
    input: { pressed, down: (c: string) => held.has(c) },
    photo: { active: false },
    hud: { toast: (t: string) => void toasts.push(t) },
  };
  const vc = new VoiceClient(game as unknown as Game);
  const vr = new VoiceRoom(vc, game as unknown as Game, room as unknown as Room);
  const track = { enabled: false };
  vc.enabled = true;
  vc.micState = "live";
  vc.mic = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  vc.hasRadio = () => true;
  const keys = () => (vr as unknown as { keys(me: unknown): void }).keys(me);
  const press = (code: string) => {
    held.add(code);
    pressed.add(code);
    keys();
    pressed.clear();
  };
  return { vc, game, held, sent, track, toasts, keys, press };
}

describe("push to talk and photo mode (both on K)", () => {
  it("out of photo mode, holding K talks (voice on, microphone live)", () => {
    const s = setup();
    s.press("KeyK");
    expect(s.vc.ptt).toBe(true);
    expect(s.track.enabled).toBe(true);
    s.held.clear();
    s.keys();
    expect(s.vc.ptt).toBe(false);
    expect(s.track.enabled).toBe(false);
  });

  it("in photo mode, K (time of day) and B never put the microphone on air", () => {
    const s = setup();
    s.game.photo.active = true;
    s.press("KeyK");
    expect(s.vc.ptt).toBe(false);
    expect(s.track.enabled).toBe(false);
    s.press("KeyB");
    expect(s.vc.radioTx).toBe(false);
    expect(s.sent.filter((m) => m.type === "radio:tx")).toEqual([]);
    expect(s.track.enabled).toBe(false);
  });

  it("entering photo mode while K is held goes off air at once", () => {
    const s = setup();
    s.press("KeyK");
    expect(s.track.enabled).toBe(true);
    s.game.photo.active = true;
    s.keys();
    expect(s.vc.ptt).toBe(false);
    expect(s.track.enabled).toBe(false);
  });

  it("with voice off, K in photo mode doesn't open voice setup or ask for the microphone", () => {
    const s = setup();
    s.vc.enabled = false;
    const open = vi.spyOn(s.vc.ui, "openPanel").mockImplementation(() => {});
    const enable = vi.spyOn(s.vc, "enableFromGesture").mockImplementation(() => Promise.resolve());
    s.game.photo.active = true;
    s.press("KeyK");
    expect(open).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    s.game.photo.active = false;
    s.held.clear();
    s.press("KeyK");
    expect(open.mock.calls.length + enable.mock.calls.length).toBe(1);
  });
});
