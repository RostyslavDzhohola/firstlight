import { describe, expect, it } from "vitest";
import { parseAdminLine } from "./panels.ts";
import { parseSkyArgs } from "./skyCommand.ts";

describe("admin console: sky", () => {
  it("reaches the server's sky command from the console line", () => {
    expect(parseAdminLine("sky storm")).toEqual({ cmd: "sky", args: { weather: "storm" } });
  });

  it("parses weather, intensity, time of day, hold, duration and reset", () => {
    expect(parseSkyArgs(["rain", "0.6", "for", "30"])).toEqual({ weather: "rain", intensity: 0.6, minutes: 30 });
    expect(parseSkyArgs(["time", "0.83", "hold"])).toEqual({ dayT: 0.83, hold: true });
    expect(parseSkyArgs(["time", "19:30"])).toEqual({ dayT: 19.5 / 24 });
    expect(parseSkyArgs(["clear"])).toEqual({ weather: "clear" });
    expect(parseSkyArgs(["reset"])).toEqual({ clear: true });
    expect(parseSkyArgs(["dust", "time", "0.5", "hold", "for", "10"])).toEqual({ weather: "dust", dayT: 0.5, hold: true, minutes: 10 });
  });

  it("ignores what it doesn't understand", () => {
    expect(parseSkyArgs(["snow", "time", "noon", "for", "x", "2"])).toEqual({});
    expect(parseSkyArgs([])).toEqual({});
  });
});
