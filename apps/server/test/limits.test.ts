// Per-account report limits across account merges (F12 social review 4): a guest who saves, or a
// player signing in on another browser, keeps the unexpired history of both identities.

import { beforeEach, describe, expect, it } from "vitest";
import { allowReport, clearLimits, rekeyLimits, REPORT_LIMITS } from "../src/social/limits.ts";

const T0 = 1_000_000;
const report = (reporter: string, target: string, at = T0) => allowReport(reporter, target, at);

describe("report limits across account merges", () => {
  beforeEach(() => clearLimits());

  it("the account inherits the guest's reports: the total budget and per-target slots", () => {
    for (let i = 0; i < REPORT_LIMITS.PER_WINDOW; i++) expect(report("guest", `t${i}`)).toBe(true);
    expect(report("guest", "fresh")).toBe(false);
    rekeyLimits("guest", "acct");
    expect(report("acct", "fresh", T0 + 1)).toBe(false);
    expect(report("guest", "fresh", T0 + 1)).toBe(true); // the old id holds nothing any more
    // Once the window has passed, the account can report again.
    expect(report("acct", "fresh", T0 + REPORT_LIMITS.WINDOW_MS)).toBe(true);
  });

  it("a merge never lowers an exhausted destination account, and partial histories add up", () => {
    for (let i = 0; i < REPORT_LIMITS.PER_WINDOW; i++) expect(report("acct", `t${i}`)).toBe(true);
    rekeyLimits("guest", "acct"); // the guest had none
    expect(report("acct", "fresh", T0 + 1)).toBe(false);

    clearLimits();
    for (let i = 0; i < 3; i++) expect(report("acct", `a${i}`)).toBe(true);
    for (let i = 0; i < 2; i++) expect(report("guest", `g${i}`)).toBe(true);
    rekeyLimits("guest", "acct");
    expect(report("acct", "fresh", T0 + 1)).toBe(false);
    expect(report("acct", "g0", T0 + REPORT_LIMITS.WINDOW_MS)).toBe(true);
  });

  it("reports about the guest count as reports about the account", () => {
    expect(report("rex", "guest")).toBe(true);
    expect(report("rex", "guest", T0 + 1)).toBe(false);
    rekeyLimits("guest", "acct");
    expect(report("rex", "acct", T0 + 2)).toBe(false);
    expect(report("rex", "other", T0 + 3)).toBe(true);
  });
});
