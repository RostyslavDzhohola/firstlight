// The real SDK client against a WebSocket that opens and then never answers (Codex finding 3): the
// join fails at the deadline and that socket is closed. Own file: the SDK captures
// globalThis.WebSocket when it loads, so the stub must be in place before anything imports it.
import { afterAll, describe, expect, it, vi } from "vitest";

const { StallSocket } = vi.hoisted(() => {
  class StallSocket {
    static all: StallSocket[] = [];
    readyState = 0;
    binaryType = "arraybuffer";
    closed = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(readonly url: string) {
      StallSocket.all.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({}); // connected… and then the server never sends the room handshake
      }, 10);
    }
    send() {}
    close() {
      this.closed++;
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code: 1000, reason: "" }), 0);
    }
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = StallSocket;
  return { StallSocket };
});

vi.mock("./auth.ts", () => ({ getPlayToken: async () => "token", invalidatePlayToken: () => {} }));

import { JOIN_TIMEOUT_MS, JoinTimeout, Net } from "./Net.ts";

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Net.join with the real SDK client", () => {
  it("closes the WebSocket that opened but never finished the handshake, and fails the join", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => ({
      status: 200,
      json: async () => ({ ok: true, reservation: { name: "body", roomId: "r1", sessionId: "s1", processId: "p" } }),
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const net = new Net();
    const caught = net.join("arcadia").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS - 100);
    expect(StallSocket.all).toHaveLength(1);
    expect(StallSocket.all[0]!.closed).toBe(0); // still waiting
    await vi.advanceTimersByTimeAsync(200);
    expect(await caught).toBeInstanceOf(JoinTimeout);
    expect(StallSocket.all[0]!.url).toContain("r1");
    expect(StallSocket.all[0]!.closed).toBe(1);
    expect(net.room).toBeNull();
    warn.mockRestore();
  });
});
