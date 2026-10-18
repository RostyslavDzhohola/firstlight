import { describe, expect, it } from "vitest";
import { applyUiLook, blurLook } from "./look.ts";

describe("?blur=1 (D-ui-1)", () => {
  it("asks for the old blurred look only when the URL says so", () => {
    expect(blurLook("")).toBe(false);
    expect(blurLook("?e2e&webgl")).toBe(false);
    expect(blurLook("?blur=1")).toBe(true);
    expect(blurLook("?e2e&blur=1&tier=high")).toBe(true);
    expect(blurLook("?blur")).toBe(true);
    expect(blurLook("?blur=0")).toBe(false);
  });

  it("marks the page so the stylesheets switch looks", () => {
    const cls = new Set<string>();
    const root = { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c), on) } };
    applyUiLook(root, "?blur=1");
    expect([...cls]).toEqual(["fl-blur"]);
    applyUiLook(root, "?webgl");
    expect([...cls]).toEqual([]);
  });
});
