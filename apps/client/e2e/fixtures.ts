// Test fixtures for the journeys: a verified headless + muted browser, the renderer under test
// (project metadata `gfx`), and a `player` that drives the page like a person (real mouse and keys).

import { test as base, expect } from "@playwright/test";
import { Player, type Gfx } from "./player.ts";
import { markToolRequests } from "./stack.ts";

export { expect };

interface Fixtures {
  gfx: Gfx;
  player: Player;
  /** Console errors and uncaught page errors seen during the test (attached to the report). */
  consoleErrors: string[];
}

interface WorkerFixtures {
  flagsVerified: string[];
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  // Owner rule: browsers are headless AND muted. Checked on the real command line before any page loads.
  flagsVerified: [
    async ({ browser }, use) => {
      const cdp = await browser.newBrowserCDPSession();
      const { arguments: args } = (await cdp.send("Browser.getBrowserCommandLine")) as { arguments: string[] };
      await cdp.detach();
      const headless = args.some((a) => a === "--headless" || a.startsWith("--headless="));
      const muted = args.includes("--mute-audio");
      if (!headless || !muted) throw new Error(`refusing to run: headless=${headless} muted=${muted} (${args.join(" ")})`);
      await use(args.filter((a) => a.startsWith("--headless") || a === "--mute-audio"));
    },
    { scope: "worker", auto: true },
  ],
  // Every guest a journey creates is flagged as one of our test accounts (D-home-6, stack.ts).
  context: async ({ context }, use) => {
    await markToolRequests(context);
    // Test runs never count as DataFast visits (its documented opt-out flag; the page's guard also catches webdriver).
    await context.addInitScript(() => {
      try {
        localStorage.setItem("datafast_ignore", "true");
      } catch {}
    });
    await use(context);
  },
  gfx: async ({}, use, info) => {
    await use((info.project.metadata as { gfx?: Gfx }).gfx ?? "webgl");
  },
  consoleErrors: async ({ page }, use, info) => {
    const errors: string[] = [];
    const lines: string[] = [];
    const t0 = Date.now();
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() === "error") errors.push(text.slice(0, 400));
      if (lines.length < 800 && (m.type() !== "log" || /^\[/.test(text))) lines.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m.type()} ${text.slice(0, 300)}`);
    });
    page.on("pageerror", (e) => {
      errors.push(`pageerror: ${e.message.slice(0, 400)}`);
      lines.push(`${((Date.now() - t0) / 1000).toFixed(1)}s pageerror ${e.message.slice(0, 300)}`);
    });
    await use(errors);
    if (lines.length) await info.attach("console.txt", { body: lines.join("\n"), contentType: "text/plain" });
    if (errors.length) await info.attach("console-errors.txt", { body: errors.join("\n"), contentType: "text/plain" });
  },
  player: async ({ page, gfx, consoleErrors }, use, info) => {
    void consoleErrors;
    const p = new Player(page, info, gfx);
    await use(p);
    // A last look at the screen and the hook state for every test, pass or fail.
    await p.shot("end").catch(() => {});
    const snap = await p.snap().catch(() => null);
    if (snap) await info.attach("final-snapshot.json", { body: JSON.stringify(snap, null, 2), contentType: "application/json" });
    const events = await p.events().catch(() => null);
    if (events) await info.attach("events.json", { body: JSON.stringify(events.slice(-300), null, 1), contentType: "application/json" });
  },
});
