// Photo mode (SPEC §6.13, F9): hides the HUD and flies a free camera on the sphere. WASD move,
// mouse look, Q/E down/up, Shift fast, wheel FOV, [ ] focus distance, - = aperture, , . exposure,
// G grade filter, K/L time of day, U live sky, O weather, H hides the panel. Time and weather are
// local overrides (only this screen changes) and reset on exit. The player's body stays in the
// world (it can still die).

import * as THREE from "three/webgpu";
import type { Terrain, Weather } from "@firstlight/shared";
import { MENU_GRADE, NEUTRAL_GRADE, type GradeParams } from "../render/post.ts";
import type { RenderCtx } from "../render/renderer.ts";
import type { Input } from "./input.ts";
import "./photo.css";

/** How far the camera may roam from the body (keeps the streamed terrain around it). */
export const PHOTO_MAX_DISTANCE = 180;
/** Minimum clearance above the ground. */
export const PHOTO_MIN_CLEARANCE = 0.4;

export interface PhotoFilter {
  name: string;
  /** null = the planet's own grade. */
  grade: GradeParams | null;
}

export const PHOTO_FILTERS: PhotoFilter[] = [
  { name: "Planet", grade: null },
  { name: "Neutral", grade: NEUTRAL_GRADE },
  { name: "Muted", grade: MENU_GRADE },
  { name: "Noir", grade: { slope: [1.08, 1.08, 1.08], offset: [-0.01, -0.01, -0.01], power: [1.12, 1.12, 1.12], saturation: 0, hue: 0 } },
  { name: "Golden hour", grade: { slope: [1.1, 1.0, 0.86], offset: [0.02, 0.01, 0], power: [0.95, 1, 1.08], saturation: 1.15, hue: -0.03 } },
  { name: "Cold dawn", grade: { slope: [0.92, 1.0, 1.1], offset: [0, 0.005, 0.02], power: [1.05, 1, 0.95], saturation: 0.85, hue: 0.02 } },
];

/**
 * Keep a free-camera position legal: above the ground by `clearance` and within `maxDist` of the
 * anchor (the player's body). Mutates and returns `pos`.
 */
export function clampPhotoCamera(pos: THREE.Vector3, anchor: THREE.Vector3, terrain: Terrain, maxDist = PHOTO_MAX_DISTANCE, clearance = PHOTO_MIN_CLEARANCE): THREE.Vector3 {
  const off = pos.clone().sub(anchor);
  if (off.length() > maxDist) pos.copy(anchor).addScaledVector(off.normalize(), maxDist);
  const l = pos.length();
  const g = terrain.body.radius + terrain.groundHeight(pos.x / l, pos.y / l, pos.z / l) + clearance;
  if (l < g) pos.multiplyScalar(g / l);
  return pos;
}

/** What photo mode needs from the day/night + weather environment (render/environment.ts). */
export interface PhotoEnv {
  photoGrade: GradeParams | null;
  photoExposure: number;
  readonly dayT: number;
  readonly weather: Weather;
  setOverrides(time: number | null, weather: { weather: Weather; intensity: number } | null): void;
}

/** Weather choices cycled with O ("planet" = the live sky). */
export const PHOTO_WEATHERS: (Weather | null)[] = [null, "clear", "rain", "storm", "drizzle", "fog", "dust"];

/** Step a time of day by `delta` (wraps 0..1). */
export function stepTime(t: number, delta: number): number {
  return (((t + delta) % 1) + 1) % 1;
}

export interface PhotoHost {
  ctx: RenderCtx;
  input: Input;
  /** The planet's own grade (restored on exit and used by the "Planet" filter). */
  planetGrade(): GradeParams;
  terrain(): Terrain;
  /** The player's body position (anchor). */
  anchor(): THREE.Vector3;
  /** Day/night + weather environment (optional: without it, time/weather keys do nothing). */
  env?(): PhotoEnv;
}

export class PhotoMode {
  active = false;
  readonly pos = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private pitch = 0;
  fov = 60;
  focus = 12;
  aperture = 6;
  bokeh = 2;
  exposure = 1;
  filter = 0;
  /** Local time-of-day override (null = live) and weather choice index into PHOTO_WEATHERS. */
  time: number | null = null;
  weatherIndex = 0;
  private savedFov = 75;
  private panel: HTMLDivElement | null = null;
  private panelHidden = false;

  constructor(private readonly host: PhotoHost) {}

  toggle(camera: THREE.PerspectiveCamera) {
    if (this.active) this.exit(camera);
    else this.enter(camera);
  }

  enter(camera: THREE.PerspectiveCamera) {
    if (this.active) return;
    this.active = true;
    this.pos.copy(camera.position);
    const up = this.pos.clone().normalize();
    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, look.dot(up))));
    this.forward.copy(look).addScaledVector(up, -look.dot(up));
    if (this.forward.lengthSq() < 1e-6) this.forward.set(1, 0, 0).addScaledVector(up, -up.x);
    this.forward.normalize();
    this.savedFov = camera.fov;
    this.fov = camera.fov;
    document.body.classList.add("fl-photo");
    this.host.ctx.setPhotoPost(true);
    this.applyLook();
    this.showPanel();
  }

  exit(camera: THREE.PerspectiveCamera) {
    if (!this.active) return;
    this.active = false;
    document.body.classList.remove("fl-photo");
    this.host.ctx.setPhotoPost(false);
    const env = this.host.env?.();
    if (env) {
      env.photoGrade = null;
      env.photoExposure = 1;
      env.setOverrides(null, null);
      this.time = null;
      this.weatherIndex = 0;
    } else {
      this.host.ctx.renderer.toneMappingExposure = 1;
    }
    this.host.ctx.setGrade(this.host.planetGrade());
    camera.fov = this.savedFov;
    camera.updateProjectionMatrix();
    this.panel?.remove();
    this.panel = null;
  }

  private applyLook() {
    const f = PHOTO_FILTERS[this.filter]!;
    const env = this.host.env?.();
    if (env) {
      // The environment owns grade/exposure every frame (day/night): hand it the photo look.
      env.photoGrade = f.grade;
      env.photoExposure = this.exposure;
      const w = PHOTO_WEATHERS[this.weatherIndex] ?? null;
      env.setOverrides(this.time, w ? { weather: w, intensity: w === "clear" ? 0 : 0.9 } : null);
    } else {
      this.host.ctx.renderer.toneMappingExposure = this.exposure;
    }
    this.host.ctx.setGrade(f.grade ?? this.host.planetGrade());
    this.host.ctx.setPhotoParams({ focus: this.focus, aperture: this.aperture, bokeh: this.bokeh });
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    if (!this.active) return;
    const input = this.host.input;
    const up = this.pos.clone().normalize();
    // Re-project the heading onto the local tangent plane as we move around the sphere.
    this.forward.addScaledVector(up, -this.forward.dot(up)).normalize();
    if (input.locked) {
      this.forward.applyAxisAngle(up, -input.mouseDX * input.sensitivity).normalize();
      this.pitch += (input.invertY ? 1 : -1) * input.mouseDY * input.sensitivity;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    }
    const right = new THREE.Vector3().crossVectors(this.forward, up).normalize();
    const look = this.forward.clone().applyAxisAngle(right, this.pitch);

    const speed = (input.down("ShiftLeft") || input.down("ShiftRight") ? 24 : 6) * dt;
    const move = new THREE.Vector3();
    if (input.down("KeyW")) move.add(look);
    if (input.down("KeyS")) move.sub(look);
    if (input.down("KeyD")) move.add(right);
    if (input.down("KeyA")) move.sub(right);
    if (input.down("KeyE")) move.add(up);
    if (input.down("KeyQ")) move.sub(up);
    if (move.lengthSq() > 0) this.pos.addScaledVector(move.normalize(), speed);
    clampPhotoCamera(this.pos, this.host.anchor(), this.host.terrain());

    let changed = false;
    if (input.wheel) {
      this.fov = Math.max(15, Math.min(100, this.fov + input.wheel * 3));
      changed = true;
    }
    // Tap to step; hold Alt to sweep continuously.
    const keys: [string, () => void][] = [
      ["BracketLeft", () => (this.focus = Math.max(0.5, this.focus / 1.15))],
      ["BracketRight", () => (this.focus = Math.min(400, this.focus * 1.15))],
      ["Minus", () => (this.aperture = Math.max(0.5, this.aperture / 1.25))],
      ["Equal", () => (this.aperture = Math.min(60, this.aperture * 1.25))],
      ["Comma", () => (this.exposure = Math.max(0.3, +(this.exposure - 0.05).toFixed(2)))],
      ["Period", () => (this.exposure = Math.min(2.5, +(this.exposure + 0.05).toFixed(2)))],
      // Time of day: 1/96 of a day per tap (15 in-game minutes).
      ["KeyK", () => (this.time = stepTime(this.time ?? this.host.env?.().dayT ?? 0.5, -1 / 96))],
      ["KeyL", () => (this.time = stepTime(this.time ?? this.host.env?.().dayT ?? 0.5, 1 / 96))],
    ];
    for (const [code, fn] of keys) {
      if (input.pressed.has(code) || (input.down(code) && input.down("AltLeft"))) {
        fn();
        changed = true;
      }
    }
    if (input.pressed.has("KeyG")) {
      this.filter = (this.filter + 1) % PHOTO_FILTERS.length;
      changed = true;
    }
    if (input.pressed.has("KeyU")) {
      this.time = null;
      changed = true;
    }
    if (input.pressed.has("KeyO")) {
      this.weatherIndex = (this.weatherIndex + 1) % PHOTO_WEATHERS.length;
      changed = true;
    }
    if (input.pressed.has("KeyH")) {
      this.panelHidden = !this.panelHidden;
      if (this.panel) this.panel.style.display = this.panelHidden ? "none" : "";
    }
    if (changed) {
      this.applyLook();
      this.renderPanel();
    }

    camera.position.copy(this.pos);
    camera.up.copy(up);
    camera.lookAt(this.pos.clone().add(look));
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  private showPanel() {
    this.panel = document.createElement("div");
    this.panel.className = "fl-photo-panel";
    if (this.panelHidden) this.panel.style.display = "none";
    document.body.appendChild(this.panel);
    this.renderPanel();
  }

  private renderPanel() {
    if (!this.panel) return;
    const rows: [string, string][] = [
      ["F9", "leave photo mode"],
      ["WASD · Q/E · Shift", "fly · down/up · fast"],
      ["Wheel", `FOV ${Math.round(this.fov)}°`],
      ["[ ]", `focus ${this.focus.toFixed(1)} m`],
      ["- =", `aperture ${this.aperture.toFixed(1)} m`],
      [", .", `exposure ${this.exposure.toFixed(2)}`],
      ["G", `filter: ${PHOTO_FILTERS[this.filter]!.name}`],
      ...(this.host.env
        ? ([
            ["K L · U", `time ${this.time === null ? "live" : clock(this.time)} · live`],
            ["O", `weather: ${PHOTO_WEATHERS[this.weatherIndex] ?? "planet"}`],
          ] as [string, string][])
        : []),
      ["H", "hide this panel"],
    ];
    this.panel.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const a = document.createElement("kbd");
        a.textContent = k;
        const b = document.createElement("span");
        b.textContent = v;
        return [a, b];
      }),
    );
  }
}

/** "06:45" for a time of day 0..1. */
export function clock(t: number): string {
  const mins = Math.floor((((t % 1) + 1) % 1) * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}
