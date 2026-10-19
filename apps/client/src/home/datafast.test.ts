import { describe, expect, it } from "vitest";
import { DATAFAST_GUARD, dataFastNote, dataFastScript } from "./datafast.ts";

describe("DataFast script", () => {
  it("is absent unless both the website id and the domain are set", () => {
    expect(dataFastScript({})).toBeNull();
    expect(dataFastScript({ VITE_DATAFAST_WEBSITE_ID: "dfid_abc123" })).toBeNull();
    expect(dataFastScript({ VITE_DATAFAST_DOMAIN: "firstlight.one4all.dev" })).toBeNull();
  });

  it("refuses values that could break out of the attribute", () => {
    expect(dataFastScript({ VITE_DATAFAST_WEBSITE_ID: 'x" onload="alert(1)', VITE_DATAFAST_DOMAIN: "one4all.dev" })).toBeNull();
    expect(dataFastScript({ VITE_DATAFAST_WEBSITE_ID: "dfid_abc123", VITE_DATAFAST_DOMAIN: "evil.dev/<script>" })).toBeNull();
  });

  it("uses the cookieless script unless told otherwise", () => {
    expect(dataFastScript({ VITE_DATAFAST_WEBSITE_ID: " dfid_abc123 ", VITE_DATAFAST_DOMAIN: "FirstLight.one4all.dev" })).toEqual({
      src: "https://datafa.st/js/script.cookieless.js",
      websiteId: "dfid_abc123",
      domain: "firstlight.one4all.dev",
      cookieless: true,
    });
    expect(dataFastScript({ VITE_DATAFAST_WEBSITE_ID: "dfid_abc123", VITE_DATAFAST_DOMAIN: "one4all.dev", VITE_DATAFAST_COOKIELESS: "false" })?.src).toBe("https://datafa.st/js/script.js");
  });

  it("claims cookieless only for the cookieless script", () => {
    const env = { VITE_DATAFAST_WEBSITE_ID: "dfid_abc123", VITE_DATAFAST_DOMAIN: "one4all.dev" };
    expect(dataFastNote(dataFastScript({}))).toBeNull();
    expect(dataFastNote(dataFastScript(env))).toBe("Cookieless analytics by DataFast");
    expect(dataFastNote(dataFastScript({ ...env, VITE_DATAFAST_COOKIELESS: "false" }))).toBe("Analytics by DataFast, which sets cookies");
  });
});

describe("DataFast guard", () => {
  /** One page load in a browser whose localStorage is `store`. */
  function visit(store: Map<string, string>, webdriver: boolean, search: string): string | null {
    const localStorage = { setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
    new Function("navigator", "location", "localStorage", DATAFAST_GUARD)({ webdriver }, { search }, localStorage);
    return store.get("datafast_ignore") ?? null;
  }
  const run = (webdriver: boolean, search: string) => visit(new Map(), webdriver, search);

  it("opts automated browsers and test URLs out, and leaves players alone", () => {
    expect(run(true, "")).toBe("true");
    expect(run(false, "?e2e")).toBe("true");
    expect(run(false, "?autoplay&bench=g1")).toBe("true");
    expect(run(false, "?offline=1")).toBe("true");
    expect(run(false, "")).toBeNull();
    expect(run(false, "?autoplay")).toBeNull();
    expect(run(false, "?benchmark")).toBeNull();
  });

  it("counts the browser again on the next normal visit after a test visit (#44)", () => {
    const store = new Map<string, string>();
    expect(visit(store, false, "?e2e")).toBe("true");
    expect(visit(store, false, "")).toBeNull();
    expect(visit(store, false, "?bench=g1")).toBe("true");
    expect(visit(store, false, "?autoplay")).toBeNull();
  });

  it("keeps automated browsers out on every visit, whatever the URL", () => {
    const store = new Map<string, string>();
    expect(visit(store, true, "")).toBe("true");
    expect(visit(store, true, "?autoplay")).toBe("true");
  });
});
