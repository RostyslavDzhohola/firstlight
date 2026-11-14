// Review round three, #2: the dev sign-in key could be fetched from the Vite dev server by anyone
// behind a proxy that made the request look local. Now no request returns it: Vite prints a link in
// the terminal with the key in its fragment, and the page keeps it (D-sec3-6).

import { describe, expect, it } from "vitest";
import type { Plugin, UserConfig } from "vite";
import viteConfig from "../../vite.config.ts";
import { DEV_KEY_PARAM, adoptDevKey, devKeyIn } from "./devKey.ts";

const KEY = "k".repeat(10) + "Qw3rTy7uIoP9aSdFgHjKlZxCvBnM1234567890ab";

function store() {
  const m = new Map<string, string>();
  return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
}

describe("the dev sign-in key reaches the page without a request (D-sec3-6)", () => {
  it("the printed link's fragment is kept and taken out of the address bar; other fragment parts stay", () => {
    const { s } = store();
    const urls: string[] = [];
    expect(adoptDevKey({ pathname: "/", search: "?devguest", hash: `#${DEV_KEY_PARAM}=${KEY}` }, s, (u) => urls.push(u))).toBe(KEY);
    expect(urls).toEqual(["/?devguest"]);
    expect(devKeyIn(s)).toBe(KEY);
    // A later page of this origin has it without the link; a newer run's link replaces it.
    expect(adoptDevKey({ pathname: "/", search: "", hash: "" }, s, (u) => urls.push(u))).toBe(KEY);
    expect(adoptDevKey({ pathname: "/x", search: "", hash: `#a=1&${DEV_KEY_PARAM}=newer` }, s, (u) => urls.push(u))).toBe("newer");
    expect(urls.at(-1)).toBe("/x#a=1");
    expect(devKeyIn(store().s)).toBeNull();
    expect(devKeyIn(null)).toBeNull();
  });

  it("the Vite dev server serves the key at no path (proxied or not) and prints it only in the terminal", async () => {
    const was = process.env.DEV_SIGNIN_KEY;
    process.env.DEV_SIGNIN_KEY = KEY;
    try {
      const cfg = (await (viteConfig as (env: { mode: string; command: "serve" | "build" }) => UserConfig | Promise<UserConfig>)({ mode: "development", command: "serve" })) as UserConfig;
      const plugin = (cfg.plugins as Plugin[]).find((p) => p?.name === "firstlight-dev-signin-key")!;
      expect(plugin.apply).toBe("serve");
      const mounted: unknown[] = [];
      const lines: string[] = [];
      const server = {
        printUrls: () => lines.push("urls"),
        resolvedUrls: { local: ["http://localhost:5173/"], network: [] },
        config: { server: { port: 5173 }, logger: { info: (l: string) => lines.push(l) } },
        middlewares: { use: (...a: unknown[]) => void mounted.push(a) },
      };
      (plugin.configureServer as unknown as (s: typeof server) => void)(server);
      expect(mounted).toEqual([]); // no route at all
      server.printUrls();
      expect(lines[0]).toBe("urls");
      expect(lines[1]).toContain(`http://localhost:5173/#${DEV_KEY_PARAM}=${KEY}`);
      expect(cfg.define?.__FL_DEV_CODES__).toBe("true");
    } finally {
      if (was === undefined) delete process.env.DEV_SIGNIN_KEY;
      else process.env.DEV_SIGNIN_KEY = was;
    }
  });
});
