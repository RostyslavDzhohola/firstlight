import { describe, expect, it } from "vitest";
import { glSlowCalls, resetGlTrace, setGlPhase, traceGlCalls } from "./glTrace.ts";

/** A WebGL2 context stand-in on a hand-moved clock: each call costs what `cost` says (ms). */
function fakeGl(cost: Record<string, number>) {
  let clock = 0;
  const proto = {
    getProgramParameter(_p: unknown, _pname: number) {
      clock += cost.getProgramParameter ?? 0;
      return true;
    },
    getParameter(_pname: number) {
      clock += cost.getParameter ?? 0;
      return 4;
    },
    getUniformLocation(_p: unknown, _name: string) {
      clock += cost.getUniformLocation ?? 0;
      return {};
    },
    getError() {
      clock += cost.getError ?? 0;
      return 0;
    },
  };
  const gl = Object.create(proto) as typeof proto & { canvas: object };
  gl.canvas = {};
  return { gl, proto, now: () => clock, advance: (ms: number) => void (clock += ms) };
}

describe("?gltrace: the WebGL context's synchronous calls that wait", () => {
  it("logs calls over the threshold with their name, parameter, time and warm-up phase; quick ones not", () => {
    resetGlTrace();
    const f = fakeGl({ getProgramParameter: 1800, getParameter: 10, getUniformLocation: 70 });
    const release = traceGlCalls(f.gl, { now: f.now, minMs: 50 });
    setGlPhase("compile");
    expect(f.gl.getProgramParameter({}, 0x91b1)).toBe(true); // results pass through
    f.gl.getParameter(0x0d33);
    setGlPhase("drain");
    f.gl.getUniformLocation({}, "nodeUniform3");
    expect(glSlowCalls()).toEqual([
      { name: "getProgramParameter", pname: "COMPLETION_STATUS_KHR", ms: 1800, t: 0, phase: "compile" },
      { name: "getUniformLocation", pname: "nodeUniform3", ms: 70, t: 1810, phase: "drain" },
    ]);
    release();
    expect(f.gl.getProgramParameter).toBe(f.proto.getProgramParameter); // three's own methods back
    setGlPhase("init");
  });

  it("wraps once, skips what the context doesn't have, and counts every call it timed", () => {
    resetGlTrace();
    const f = fakeGl({});
    const release = traceGlCalls(f.gl, { now: f.now });
    const again = traceGlCalls(f.gl, { now: f.now });
    f.gl.getError();
    f.gl.getError();
    expect(glSlowCalls()).toEqual([]);
    again(); // the second install was a no-op
    release();
    expect(Object.prototype.hasOwnProperty.call(f.gl, "getError")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(f.gl, "texImage2D")).toBe(false); // never there
  });
});
