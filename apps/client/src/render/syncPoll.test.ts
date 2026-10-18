import { describe, expect, it } from "vitest";
import { COMPLETION_STATUS_KHR, gpuIdle, guardStatusPolls, type PollGL } from "./syncPoll.ts";

/**
 * A WebGL2 context stand-in: programs link in the GPU process (complete when `linked` says so), and
 * fences signal when the test says. Every getProgramParameter that reaches it is counted: in Chrome it
 * is a round trip that first runs everything queued in the GPU process.
 */
function fakeGl() {
  const fences: { signalled: boolean }[] = [];
  const linked = new Set<object>();
  const calls: string[] = [];
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, SIGNALED: 3,
    fenceSync() {
      const f = { signalled: false };
      fences.push(f);
      return f;
    },
    getSyncParameter: (f: { signalled: boolean }) => (f.signalled ? 3 : 0),
    deleteSync() {},
    flush() {},
    linkProgram(p: object) {
      calls.push("linkProgram");
      void p;
    },
    getProgramParameter(p: object, pname: number) {
      calls.push(`getProgramParameter:${pname.toString(16)}`);
      return pname === COMPLETION_STATUS_KHR ? linked.has(p) : true;
    },
  };
  return { gl: gl as typeof gl & PollGL, fences, linked, calls };
}

describe("guardStatusPolls (never ask the GPU process a synchronous question while it is busy)", () => {
  it("answers COMPLETION_STATUS_KHR locally until the fence issued right after the program's link has signalled", () => {
    const f = fakeGl();
    let clock = 0;
    const g = guardStatusPolls(f.gl, () => false, () => clock);
    const prog = {};
    f.gl.linkProgram(prog);
    expect(f.fences).toHaveLength(1); // a fence right after the link
    expect(f.gl.getProgramParameter(prog, COMPLETION_STATUS_KHR)).toBe(false);
    expect(f.calls.filter((c) => c.startsWith("getProgramParameter"))).toEqual([]); // no round trip
    clock = 40;
    f.fences[0]!.signalled = true;
    expect(f.gl.getProgramParameter(prog, COMPLETION_STATUS_KHR)).toBe(false); // passes through: not linked yet
    f.linked.add(prog);
    clock = 90;
    expect(f.gl.getProgramParameter(prog, COMPLETION_STATUS_KHR)).toBe(true);
    expect(f.calls.filter((c) => c.startsWith("getProgramParameter"))).toHaveLength(2);
    expect(g.linkMs(prog)).toBe(90); // link to the first poll that found it complete
    expect(g.answered()).toBe(1);
    g.release();
  });

  it("holds every poll while a first-draw batch is in flight; other parameters always pass through", () => {
    const f = fakeGl();
    let busy = true;
    const g = guardStatusPolls(f.gl, () => busy);
    const prog = {};
    f.gl.linkProgram(prog);
    f.fences[0]!.signalled = true;
    f.linked.add(prog);
    expect(f.gl.getProgramParameter(prog, COMPLETION_STATUS_KHR)).toBe(false); // the GPU process builds a Metal pipeline
    expect(f.gl.getProgramParameter(prog, 0x8b82)).toBe(true); // LINK_STATUS: three's own (after completion)
    busy = false;
    expect(f.gl.getProgramParameter(prog, COMPLETION_STATUS_KHR)).toBe(true);
    expect(f.calls).toEqual(["linkProgram", "getProgramParameter:8b82", "getProgramParameter:91b1"]);
    g.release();
  });

  it("release() puts three's methods back; without a context (WebGPU) it does nothing", () => {
    const f = fakeGl();
    const own = { link: f.gl.linkProgram, poll: f.gl.getProgramParameter };
    const g = guardStatusPolls(f.gl, () => false);
    expect(f.gl.linkProgram).not.toBe(own.link);
    g.release();
    g.release();
    expect([f.gl.linkProgram, f.gl.getProgramParameter]).toEqual([own.link, own.poll]);
    const none = guardStatusPolls(null, () => false);
    expect(none.active).toBe(false);
    expect(none.linkMs({})).toBeNull();
    none.release();
  });
});

describe("gpuIdle (wait for the GPU process to finish what is queued, without blocking)", () => {
  it("polls a fence once a frame until it signals, and says how long it took", async () => {
    const f = fakeGl();
    let clock = 0;
    let frames = 0;
    const next = async () => {
      frames++;
      clock += 16;
      if (frames === 5) f.fences[0]!.signalled = true;
    };
    expect(await gpuIdle(f.gl, next, 10_000, () => clock)).toBe(80);
    expect(frames).toBe(5);
    expect(f.calls).toEqual([]); // no synchronous call
  });

  it("gives up after the cap, and returns at once without fences", async () => {
    const f = fakeGl();
    let clock = 0;
    const next = async () => void (clock += 1000);
    expect(await gpuIdle(f.gl, next, 3000, () => clock)).toBe(3000);
    expect(await gpuIdle(null, next, 3000, () => clock)).toBe(0);
  });
});
