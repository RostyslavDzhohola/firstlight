import { describe, expect, it } from "vitest";
import { ANALYTICS_OPT_OUT_KEY, DATAFAST_GUARD, dataFastScript, privacyText } from "./datafast.ts";

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

  it("the Privacy card says cookies only for the cookie script (#12)", () => {
    const env = { VITE_DATAFAST_WEBSITE_ID: "dfid_abc123", VITE_DATAFAST_DOMAIN: "one4all.dev" };
    expect(privacyText(dataFastScript(env))[0]).toContain("no cookies are set");
    expect(privacyText(dataFastScript({ ...env, VITE_DATAFAST_COOKIELESS: "false" }))[0]).toContain("which sets cookies");
  });

  it("our own funnel is disclosed with or without DataFast, with its controls (review ship #6)", () => {
    const env = { VITE_DATAFAST_WEBSITE_ID: "dfid_abc123", VITE_DATAFAST_DOMAIN: "one4all.dev" };
    for (const s of [dataFastScript({}), dataFastScript(env)]) {
      const text = privacyText(s).join(" ");
      expect(text).toContain("our own server, never a third party");
      expect(text).toContain("Do Not Track or Global Privacy Control");
      expect(text).toContain("the button below");
      expect(text.includes("DataFast")).toBe(!!s);
    }
  });
});

describe("DataFast guard", () => {
  /** One page load in a browser whose localStorage is `store`. */
  function visit(store: Map<string, string>, webdriver: boolean, search: string): string | null {
    const localStorage = { setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), getItem: (k: string) => store.get(k) ?? null };
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

  it("keeps a browser that opted out on the Privacy card out on every normal visit (#12)", () => {
    const store = new Map<string, string>([[ANALYTICS_OPT_OUT_KEY, "1"]]);
    expect(visit(store, false, "")).toBe("true");
    expect(visit(store, false, "?autoplay")).toBe("true");
    store.delete(ANALYTICS_OPT_OUT_KEY);
    expect(visit(store, false, "")).toBeNull();
  });

  it("keeps automated browsers out on every visit, whatever the URL", () => {
    const store = new Map<string, string>();
    expect(visit(store, true, "")).toBe("true");
    expect(visit(store, true, "?autoplay")).toBe("true");
  });
});
