import { describe, expect, it } from "vitest";
import { dataFastNote, dataFastScript } from "./datafast.ts";

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
