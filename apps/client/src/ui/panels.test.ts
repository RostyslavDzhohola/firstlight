import { describe, expect, it } from "vitest";
import { parseAdminLine } from "./panels.ts";

describe("admin console parser", () => {
  it("turns console lines into admin messages", () => {
    expect(parseAdminLine("stage 3")).toEqual({ cmd: "stage", args: { n: 3, all: false } });
    expect(parseAdminLine("stage 4 all")).toEqual({ cmd: "stage", args: { n: 4, all: true } });
    expect(parseAdminLine("give stillshot 3")).toEqual({ cmd: "give", args: { id: "stillshot", tier: 3, qty: 1 } });
    expect(parseAdminLine("egg E3 burrow")).toEqual({ cmd: "egg", args: { id: "E3", step: "burrow" } });
    expect(parseAdminLine("announce Boss at Gull Point")).toEqual({ cmd: "announce", args: { text: "Boss at Gull Point" } });
    expect(parseAdminLine("   ")).toBeNull();
  });
});
