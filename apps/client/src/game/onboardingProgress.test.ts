import { expect, it } from "vitest";
import { OnboardingProgress } from "./onboardingProgress.ts";

function store() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

it("resumes completed client tips on reload/travel for the same account without granting dummy completion", () => {
  const storage = store();
  const first = new OnboardingProgress("guest-a", storage);
  for (const id of ["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel", "voice", "portal"] as const) first.steps.complete(id);
  first.save();
  const back = new OnboardingProgress("guest-a", storage);
  expect(back.steps.doneCount).toBe(11);
  expect(back.steps.current?.id).toBe("attack");
  expect(back.steps.isDone("portal")).toBe(true);
  expect(new OnboardingProgress("guest-b", storage).steps.doneCount).toBe(0);
});

it("ignores corrupt, unknown-version and unrecognized progress instead of breaking play", () => {
  const storage = store();
  const key = "fl.onboarding.v1:a";
  for (const raw of ["{broken", "null", '{"v":2,"done":["jump"]}', '{"v":1,"done":true}']) {
    storage.setItem(key, raw);
    expect(new OnboardingProgress("a", storage).steps.doneCount).toBe(0);
  }
  storage.setItem(key, '{"v":1,"done":["attack","unknown","jump","jump"]}');
  const restored = new OnboardingProgress("a", storage);
  expect(restored.steps.doneCount).toBe(1);
  expect(restored.steps.current?.id).toBe("move");
});

it("works in memory when storage is unavailable, full, or no account is known", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
  for (const storage of [blocked, null]) {
    const progress = new OnboardingProgress("a", storage);
    progress.steps.complete("jump");
    expect(() => { progress.save(); progress.end(); progress.setExpanded(true); }).not.toThrow();
    expect(progress.steps.isDone("jump")).toBe(true);
  }
  const storage = store();
  const unknown = new OnboardingProgress("", storage);
  unknown.steps.complete("jump");
  unknown.save();
  unknown.setExpanded(true);
  expect(storage.data.size).toBe(0);
});

it.each(["done", "skipped"])("clears saved tips when the server says %s and never saves them again", () => {
  const storage = store();
  const progress = new OnboardingProgress("a", storage);
  progress.steps.complete("jump");
  progress.save();
  progress.end();
  progress.steps.complete("map"); // tips can continue in memory after the dummy payout
  progress.save();
  expect(storage.data.size).toBe(0);
  expect(new OnboardingProgress("a", storage).steps.doneCount).toBe(0);
});

it("starts with a collapsed checklist and remembers the choice per account separately from tips", () => {
  const storage = store();
  const first = new OnboardingProgress("a", storage);
  expect(first.expanded).toBe(false);
  first.setExpanded(true);
  first.end();
  expect(new OnboardingProgress("a", storage).expanded).toBe(true);
  expect(new OnboardingProgress("b", storage).expanded).toBe(false);
  first.setExpanded(false);
  expect(new OnboardingProgress("a", storage).expanded).toBe(false);
});
