// @vitest-environment happy-dom
// Nameplates: characters an AI agent plays carry the "AI" chip (D-agents-1); people don't.

import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHIP } from "@firstlight/shared/net/agents";
import { Nameplates } from "./Cosmetics.ts";

describe("nameplates", () => {
  let plates: Nameplates | null = null;
  afterEach(() => {
    plates?.dispose();
    plates = null;
  });

  function camera(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    cam.position.set(0, 502, 12);
    cam.lookAt(0, 501, 0);
    cam.updateMatrixWorld(true);
    return cam;
  }

  it("shows the AI chip next to an agent's name and not next to a person's", () => {
    plates = new Nameplates();
    const me = new THREE.Vector3(0, 500, 6);
    const entries = [
      { id: "a", pos: new THREE.Vector3(-1, 500, 0), name: "Scout_7", title: "", agent: true },
      { id: "h", pos: new THREE.Vector3(1, 500, 0), name: "Mira", title: "Trailblazer", agent: false },
    ];
    plates.update(camera(), entries, me);
    const els = [...document.querySelectorAll<HTMLElement>(".fl-plate")];
    expect(els).toHaveLength(2);
    const agent = els.find((e) => e.textContent!.startsWith("Scout_7"))!;
    const human = els.find((e) => e.textContent!.startsWith("Mira"))!;
    expect(agent.querySelector(".fl-plate__ai")?.textContent).toBe(AGENT_CHIP);
    expect(AGENT_CHIP).toBe("AI");
    expect(human.querySelector(".fl-plate__ai")).toBeNull();
    expect(human.querySelector("i")?.textContent).toBe("Trailblazer");
    // The flag can change with the same name (a takeover from another client): the plate follows.
    entries[0]!.agent = false;
    plates.update(camera(), entries, me);
    expect(agent.querySelector(".fl-plate__ai")).toBeNull();
  });
});
