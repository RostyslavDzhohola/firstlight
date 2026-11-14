// @vitest-environment happy-dom
// #80, the careful version: the plain Traveller is listed first and picked for a new player; a stored
// pick still comes back, and the five other starters are all offered.

import { afterEach, describe, expect, it } from "vitest";
import { cancelCharacterPick, showCharacterPick } from "./characterPick.ts";

const names = () => [...document.querySelectorAll(".fl-starter .fl-starter__name")].map((e) => e.textContent);
const picked = () => document.querySelector(".fl-starter.is-on .fl-starter__name")?.textContent;

afterEach(() => {
  cancelCharacterPick();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("the starter pick (#80)", () => {
  it("lists the Traveller first and picks it for a new player", async () => {
    void showCharacterPick();
    expect(names()).toEqual(["Traveller", "Hexwick", "Brother Ash", "Kappa", "Unit 7", "Hinoko"]);
    expect(picked()).toBe("Traveller");
  });

  it("brings back a stored pick", async () => {
    localStorage.setItem("fl.starter", "2");
    void showCharacterPick();
    expect(picked()).toBe("Kappa");
  });
});
