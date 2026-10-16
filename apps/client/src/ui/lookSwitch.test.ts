import { describe, expect, it } from "vitest";
import { LOOK_SWITCH, LookSwitch } from "./lookSwitch.ts";

/** The server side of `look`: BodyRoom.withinRate's fixed window (2 a second), then the state echo
 *  reaches the client `lag` ms later. */
function server(start: number, lag = 80) {
  let look = start;
  let echoed = start;
  let w: { at: number; n: number } | null = null;
  const echoes: { at: number; look: number }[] = [];
  const dropped: number[] = [];
  return {
    send(l: number, now: number) {
      if (!w || now - w.at >= 1000) w = { at: now, n: 0 };
      if (w.n >= 2) {
        dropped.push(now);
        return;
      }
      w.n++;
      look = l;
      echoes.push({ at: now + lag, look: l });
    },
    /** PlayerState.look as the client sees it at `now`. */
    seen(now: number) {
      for (const e of echoes) if (e.at <= now) echoed = e.look;
      return echoed;
    },
    get look() {
      return look;
    },
    dropped,
  };
}

/** Click through `clicks` ([time, look]) and step a 4 Hz menu tick; returns what the menu showed. */
function run(sw: LookSwitch, srv: ReturnType<typeof server>, clicks: [number, number][], until: number) {
  const shown: { t: number; look: number; busy: boolean; server: number }[] = [];
  const events = [...clicks.map(([t, look]) => ({ t, look })), ...Array.from({ length: Math.ceil(until / 250) + 1 }, (_, i) => ({ t: i * 250, look: -1 }))].sort((a, b) => a.t - b.t);
  for (const e of events) {
    if (e.look >= 0 && sw.request(e.look, srv.seen(e.t), e.t)) srv.send(e.look, e.t);
    const v = sw.view(srv.seen(e.t), e.t);
    shown.push({ t: e.t, ...v, server: srv.look });
  }
  return shown;
}

describe("pause menu look switch", () => {
  it("a quick B → A → B never leaves the menu on a look the server didn't take (rate-capped requests)", () => {
    const srv = server(1);
    const sw = new LookSwitch();
    // Codex round 2: B → A → B inside a second used to leave the server on A while the menu showed B.
    const shown = run(sw, srv, [[0, 0], [120, 1], [240, 0], [360, 1], [600, 0], [700, 1], [900, 1]], 4000);
    expect(srv.dropped).toEqual([]); // the spacing keeps every request inside the server's cap
    const last = shown.at(-1)!;
    expect(last.busy).toBe(false);
    expect(last.look).toBe(srv.look); // settled on what the server holds
    expect(last.look).toBe(srv.seen(4000));
    // Whenever the menu isn't busy, it shows the server's look.
    for (const s of shown) if (!s.busy) expect(s.look, `t=${s.t}`).toBe(srv.seen(s.t));
  });

  it("disables the controls while a request is in flight and spaces the next one", () => {
    const srv = server(0);
    const sw = new LookSwitch();
    expect(sw.request(1, 0, 0)).toBe(true);
    srv.send(1, 0);
    expect(sw.view(srv.seen(10), 10)).toEqual({ look: 1, busy: true });
    expect(sw.request(0, srv.seen(50), 50)).toBe(false); // pending
    expect(sw.view(srv.seen(100), 100)).toEqual({ look: 1, busy: true }); // confirmed, but too soon to send again
    expect(sw.request(0, srv.seen(300), 300)).toBe(false);
    expect(sw.view(srv.seen(LOOK_SWITCH.minGapMs), LOOK_SWITCH.minGapMs)).toEqual({ look: 1, busy: false });
    expect(sw.request(0, 1, LOOK_SWITCH.minGapMs)).toBe(true);
  });

  it("falls back to the server's look when a request is refused or lost", () => {
    const sw = new LookSwitch();
    expect(sw.request(1, 0, 0)).toBe(true); // never answered: the server keeps 0
    expect(sw.view(0, 1000)).toEqual({ look: 1, busy: true });
    expect(sw.view(0, LOOK_SWITCH.timeoutMs + 1)).toEqual({ look: 0, busy: false });
    expect(sw.request(0, 0, 2000)).toBe(false); // already the server's look: nothing to send
  });
});
