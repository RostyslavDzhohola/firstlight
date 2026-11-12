// The orrery menu (D-menu-1): the game's first screen as the sky itself. A star, the hub and the
// three planets on their rings, drawn by one full-screen shader (no three.js: the page stays light
// before Play); the traveller turns the sky by hand and the world at the front is the chosen one.
// Diving into the world Play would enter is Play. Everything else the home page had (boards, news,
// sign-in) stays reachable: the account corner here drives the same buttons, and the "Almanac" link
// shows the classic page.
//
// The maths, the plate's words and the almanac are in orreryModel.ts (pure, tested). This file is
// WebGL2 + DOM. It draws only while the landing is on the page and the tab is visible.

import "../ui/styles/orrery.css";
import type { BodyId } from "@firstlight/shared/planet/bodies";
import type { HomeData } from "@firstlight/shared/net/home";
import type { MeInfo } from "./homeModel.ts";
import { almanacLines, bodyPos, enterBody, frontBody, neighbour, ORRERY_BODIES, orreryCamera, orreryPlate, pickBody, project, yawFor, type OrreryPlate } from "./orreryModel.ts";

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCam, uFwd, uRight, uUp;
uniform float uTan;
uniform vec4 uBody[4];   // centre, radius
uniform float uLights[4]; // how lit the night side is (who is there now)
uniform float uFocus[4];  // 1 for the front world
uniform float uOrbit[4];
out vec4 o;

float hash(vec3 q) { q = fract(q * 0.3183099 + 0.1); q *= 17.0; return fract(q.x * q.y * q.z * (q.x + q.y + q.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 x) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(x); x = x * 2.03 + 11.7; a *= 0.5; } return s; }
vec3 spin(vec3 n, float a) { float c = cos(a), s = sin(a); return vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z); }

// Surface colour (rgb) and how much of it glows by itself (a) for body k at surface normal n.
vec4 surface(int k, vec3 n, float day) {
  if (k == 0) { // Portus: a small green world, a walled town with its lamps and three portals
    float h = fbm(n * 3.1);
    vec3 c = mix(vec3(0.13, 0.36, 0.17), vec3(0.50, 0.44, 0.27), smoothstep(0.44, 0.64, h));
    c = mix(c, vec3(0.10, 0.38, 0.50), 1.0 - smoothstep(0.30, 0.36, h));
    vec3 town = normalize(vec3(0.30, 0.42, 0.86));
    float d = dot(n, town);
    float wall = smoothstep(0.9925, 0.9938, d) * (1.0 - smoothstep(0.9944, 0.9956, d));
    float inside = smoothstep(0.9940, 0.9952, d);
    c = mix(c, vec3(0.50, 0.42, 0.33), inside * 0.9);
    c = mix(c, vec3(0.78, 0.72, 0.62), wall);
    vec3 glow = vec3(1.0, 0.74, 0.38) * inside * (0.35 + 0.65 * step(0.5, noise(n * 300.0))) * 0.8;
    glow += vec3(0.25, 0.95, 1.0) * smoothstep(0.99975, 0.99992, dot(n, normalize(town + vec3(0.045, 0.008, -0.012))));
    glow += vec3(0.80, 0.45, 1.0) * smoothstep(0.99975, 0.99992, dot(n, normalize(town + vec3(-0.045, 0.012, 0.012))));
    glow += vec3(1.0, 0.55, 0.2) * smoothstep(0.99975, 0.99992, dot(n, normalize(town + vec3(0.0, -0.048, 0.02))));
    return vec4(c * day + glow * (1.5 - day), 1.0 - smoothstep(0.30, 0.36, h));
  }
  if (k == 1) { // Arcadia: lakes and seas, green and gold meadows, white cloud
    float h = fbm(n * 2.3 + 3.0);
    float land = smoothstep(0.47, 0.53, h);
    vec3 sea = mix(vec3(0.02, 0.13, 0.32), vec3(0.08, 0.52, 0.66), smoothstep(0.30, 0.50, h));
    vec3 ground = mix(vec3(0.16, 0.50, 0.17), vec3(0.78, 0.70, 0.30), smoothstep(0.45, 0.75, fbm(n * 6.0)));
    ground = mix(ground, vec3(0.93, 0.95, 0.97), smoothstep(0.70, 0.78, h)); // high ground
    vec3 c = mix(sea, ground, land);
    float cl = smoothstep(0.56, 0.74, fbm(n * 3.4 + vec3(uTime * 0.012, 0.0, 7.0)));
    c = mix(c, vec3(1.0), cl * 0.85);
    return vec4(c * day, 1.0 - land);
  }
  if (k == 2) { // Hollowmere: violet dusk, teal meres, bands of mist
    float h = fbm(n * 2.0 + 9.0);
    vec3 c = mix(vec3(0.035, 0.02, 0.09), vec3(0.20, 0.08, 0.32), smoothstep(0.30, 0.70, h));
    c = mix(c, vec3(0.02, 0.24, 0.24), 1.0 - smoothstep(0.33, 0.39, h));
    float mist = 0.5 + 0.5 * sin(n.y * 11.0 + fbm(n * 3.0 + uTime * 0.01) * 5.0);
    c = mix(c, vec3(0.50, 0.22, 0.52), mist * mist * 0.16);
    vec3 glow = vec3(0.35, 1.0, 0.85) * smoothstep(0.86, 0.95, noise(n * 26.0)) * 0.07; // fungi
    return vec4(c * day + glow, 1.0 - smoothstep(0.33, 0.39, h));
  }
  // Meridian: banded red canyons, pale salt flats, small mineral seas
  float band = fbm(vec3(n.x * 1.6, n.y * 6.5, n.z * 1.6) + 4.0);
  float h = fbm(n * 2.4 + 21.0);
  vec3 c = mix(vec3(0.42, 0.13, 0.06), vec3(0.80, 0.44, 0.20), smoothstep(0.30, 0.68, band));
  c = mix(c, vec3(0.86, 0.78, 0.66), smoothstep(0.60, 0.68, h));
  float sea = 1.0 - smoothstep(0.27, 0.31, h);
  c = mix(c, vec3(0.07, 0.40, 0.38), sea);
  return vec4(c * day, sea);
}

vec3 rim(int k) {
  return k == 0 ? vec3(1.0, 0.82, 0.55) : k == 1 ? vec3(0.45, 0.82, 1.0) : k == 2 ? vec3(0.78, 0.45, 1.0) : vec3(1.0, 0.62, 0.36);
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec3 rd = normalize(uFwd + uv.x * uTan * uRight + uv.y * uTan * uUp);
  vec3 ro = uCam;

  // The deep sky: a faint band of cloud and three layers of stars.
  vec3 col = vec3(0.0025, 0.0035, 0.008);
  float neb = fbm(rd * 2.2 + 5.0);
  col += vec3(0.016, 0.008, 0.034) * smoothstep(0.45, 0.9, neb) + vec3(0.0, 0.010, 0.016) * smoothstep(0.55, 0.95, fbm(rd * 3.7 - 2.0));
  for (int l = 0; l < 3; l++) {
    vec3 q = rd * (90.0 + float(l) * 70.0);
    vec3 id = floor(q);
    float h = hash(id + float(l) * 13.0);
    vec3 off = vec3(hash(id + 1.3), hash(id + 2.7), hash(id + 4.1)) - 0.5;
    float d = length(fract(q) - 0.5 - off * 0.6);
    float tw = 0.75 + 0.25 * sin(uTime * (0.6 + h * 2.0) + h * 40.0);
    col += step(0.972, h) * (1.0 - smoothstep(0.0, 0.16, d)) * tw * mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.7), hash(id + 7.0)) * (0.5 + float(l) * 0.2);
  }

  // The nearest world along the ray.
  float tHit = 1e9; int hit = -1;
  for (int k = 0; k < 4; k++) {
    vec3 oc = ro - uBody[k].xyz;
    float b = dot(oc, rd), c = dot(oc, oc) - uBody[k].w * uBody[k].w, disc = b * b - c;
    if (disc > 0.0) { float t = -b - sqrt(disc); if (t > 0.0 && t < tHit) { tHit = t; hit = k; } }
  }

  // The rings the worlds ride on (the plane of the sky), behind any world in front of them.
  if (abs(rd.y) > 1e-4) {
    float t = -ro.y / rd.y;
    if (t > 0.0 && t < tHit) {
      vec3 q = ro + rd * t;
      float rr = length(q.xz), px = t * uTan * 2.0 / uRes.y;
      float fade = 1.0 / (1.0 + t * 0.035);
      for (int k = 0; k < 4; k++) {
        float line = 1.0 - smoothstep(0.0, 1.6 * px, abs(rr - uOrbit[k]));
        // Tick marks: twelve to a ring, like an instrument.
        float ang = atan(q.z, q.x);
        float tick = (1.0 - smoothstep(0.0, 1.4 * px, abs(fract(ang * 6.0 / 3.14159265 + 0.5) - 0.5) * rr * 0.5236)) * (1.0 - smoothstep(0.0, 0.16, abs(rr - uOrbit[k])));
        col += (line * (0.16 + 0.34 * uFocus[k]) + tick * 0.12) * mix(vec3(0.62, 0.72, 0.92), rim(k), 0.35 + 0.5 * uFocus[k]) * fade;
      }
    }
  }

  // The star in the middle: the first light. Hidden behind a world that covers it.
  float tc = dot(-ro, rd);
  float dc = length(ro + rd * max(tc, 0.0));
  if (tc > 0.0 && tc < tHit) {
    float ang = dc / tc; // how far off the star this ray passes, as an angle
    float g = 0.00045 / (ang * ang + 0.00006) + 0.30 * exp(-ang * 16.0) + 0.05 * exp(-ang * 4.5);
    vec3 q = ro + rd * tc;
    float rays = 0.5 + 0.5 * sin(atan(dot(q, uUp), dot(q, uRight)) * 6.0 + uTime * 0.12);
    g += 0.06 * exp(-ang * 9.0) * rays;
    col += vec3(1.0, 0.84, 0.60) * min(g, 6.0);
  }

  // Halos round the worlds (their air catching the light), then the worlds themselves.
  for (int k = 0; k < 4; k++) {
    vec3 oc = ro - uBody[k].xyz;
    float b = dot(oc, rd);
    float d = sqrt(max(dot(oc, oc) - b * b, 0.0));
    if (b < 0.0 && (hit != k) && (-b < tHit)) {
      float a = max(d - uBody[k].w, 0.0) / uBody[k].w;
      col += rim(k) * exp(-a * 9.0) * (0.10 + 0.22 * uFocus[k]);
    }
  }
  if (hit >= 0) {
    vec3 c0 = uBody[hit].xyz; float r = uBody[hit].w;
    vec3 pos = ro + rd * tHit, nw = (pos - c0) / r;
    // Lit by the star, with a share from the viewer's side so no world shows only its night.
    vec3 l = normalize(normalize(-c0) + 0.6 * normalize(uCam - c0) + vec3(0.0, 0.22, 0.0));
    float ndl = dot(nw, l);
    float day = smoothstep(-0.12, 0.42, ndl);
    vec3 n = spin(nw, uTime * (0.03 + 0.01 * float(hit)) + float(hit) * 1.7);
    vec4 s = surface(hit, n, 0.06 + 0.94 * day);
    vec3 c = s.rgb;
    // Water catches the star.
    vec3 hv = normalize(l - rd);
    c += vec3(1.0, 0.9, 0.75) * pow(max(dot(nw, hv), 0.0), 60.0) * s.a * day * 0.8;
    // The night side: lamps where travellers are.
    vec3 cell = floor(n * 34.0);
    float lamp = step(1.0 - 0.10 * uLights[hit], hash(cell)) * (1.0 - smoothstep(0.0, 0.42, length(fract(n * 34.0) - 0.5)));
    c += vec3(1.0, 0.80, 0.48) * lamp * (1.0 - day) * 1.6;
    // Air on the limb.
    float fr = pow(1.0 - max(dot(nw, -rd), 0.0), 3.0);
    c += rim(hit) * fr * (0.25 + 0.75 * day) * 0.9;
    col = c;
  }

  // Hollowmere's broken ring.
  {
    vec3 c0 = uBody[2].xyz; float r = uBody[2].w;
    vec3 rn = normalize(vec3(0.32, 1.0, 0.18));
    float den = dot(rd, rn);
    if (abs(den) > 1e-4) {
      float t = dot(c0 - ro, rn) / den;
      if (t > 0.0 && t < tHit) {
        vec3 q = ro + rd * t - c0;
        float rr = length(q) / r;
        float ang = atan(dot(q, cross(rn, vec3(1,0,0))), dot(q, vec3(1,0,0)));
        float seg = step(0.34, noise(vec3(ang * 3.0, 2.0, 5.0))) * step(0.25, noise(vec3(ang * 11.0, 9.0, 1.0)));
        float band = smoothstep(1.46, 1.50, rr) * (1.0 - smoothstep(1.80, 1.86, rr)) * (0.45 + 0.55 * noise(vec3(rr * 60.0, 0.0, 0.0)));
        col = mix(col, vec3(0.50, 0.40, 0.70), band * seg * 0.42);
      }
    }
  }

  col = 1.0 - exp(-col * 1.35);
  col = pow(col, vec3(0.4545));
  // A soft vignette, and one step of dither so the dark sky does not band.
  col *= 1.0 - 0.22 * dot(uv * vec2(0.55, 0.8), uv * vec2(0.55, 0.8));
  col += (hash(vec3(gl_FragCoord.xy, uTime)) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

export interface Orrery {
  setData(data: HomeData | null): void;
  setMe(me: MeInfo | null): void;
  /** Draw or rest (the landing left the page, or came back). */
  setShown(shown: boolean): void;
  dispose(): void;
}

export interface OrreryHooks {
  /** Play: the same thing the home page's button does. */
  play(): void;
  signIn(): void;
  signOut(): void;
  save(): void;
}

/** Whether this visit gets the orrery: a desktop pointer, room to draw, WebGL2, and nobody asked for the classic page. */
export function wantsOrrery(search: string = location.search, mq: (q: string) => boolean = (q) => matchMedia(q).matches): boolean {
  const p = new URLSearchParams(search);
  if (p.get("menu") === "classic" || p.has("e2e") || p.has("autoplay") || p.has("gallery")) return false;
  if (p.get("menu") === "orrery") return true;
  return mq("(min-width: 900px) and (min-height: 560px) and (pointer: fine)");
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function startOrrery(landing: HTMLElement, hooks: OrreryHooks): Orrery | null {
  const canvas = el("canvas", "fl-orrery__sky");
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  } catch (err) {
    console.warn("[orrery] the sky would not compile; the classic page stays", err);
    return null;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  const u = { res: U("uRes"), time: U("uTime"), cam: U("uCam"), fwd: U("uFwd"), right: U("uRight"), up: U("uUp"), tan: U("uTan"), body: U("uBody"), lights: U("uLights"), focus: U("uFocus"), orbit: U("uOrbit") };
  gl.uniform1fv(u.orbit, ORRERY_BODIES.map((b) => b.orbit));

  // ---- the page over the sky --------------------------------------------------------------
  const root = el("div", "fl-orrery");
  root.setAttribute("data-e2e", "orrery");
  const ui = el("div", "fl-orrery__ui");
  const top = el("header", "fl-orrery__top");
  const mark = el("div", "fl-wordmark fl-wordmark--sm fl-orrery__mark");
  mark.setAttribute("aria-label", "Firstlight");
  mark.append("First", el("b", "", "light"));
  const account = el("div", "fl-orrery__account");
  const who = el("span", "fl-orrery__who");
  const signBtn = el("button", "fl-orrery__link");
  signBtn.type = "button";
  const saveBtn = el("button", "fl-orrery__link", "Save your progress");
  saveBtn.type = "button";
  saveBtn.onclick = () => hooks.save();
  account.append(who, saveBtn, signBtn);
  top.append(mark, account);

  const tags = ORRERY_BODIES.map((b, i) => {
    const t = el("button", "fl-orrery__tag");
    t.type = "button";
    t.dataset.body = b.id;
    t.append(el("span", "fl-orrery__tagname"), el("span", "fl-orrery__tagcount"));
    t.onclick = () => choose(i);
    return t;
  });
  const tagBox = el("div", "fl-orrery__tags");
  tagBox.append(...tags);

  const plate = el("section", "fl-orrery__plate");
  plate.setAttribute("aria-live", "polite");
  const kicker = el("div", "fl-orrery__kicker");
  const name = el("h1", "fl-orrery__name");
  const line = el("p", "fl-orrery__line");
  const facts = el("ul", "fl-orrery__facts");
  const act = el("div", "fl-orrery__act");
  plate.append(kicker, name, line, facts, act);

  const almanac = el("aside", "fl-orrery__almanac");
  almanac.append(el("span", "fl-orrery__almanachead", "Almanac"), el("span", "fl-orrery__almanacline"));
  const foot = el("footer", "fl-orrery__foot");
  const hint = el("span", "fl-orrery__hint");
  hint.append("Drag the sky to turn it", el("i", ""), el("kbd", "", "←"), el("kbd", "", "→"), " choose a world", el("i", ""), el("kbd", "", "Enter"), " dive in");
  const classic = el("button", "fl-orrery__link", "Open the almanac: boards, news, credits");
  classic.type = "button";
  foot.append(hint, classic);
  const flash = el("div", "fl-orrery__flash");
  ui.append(top, tagBox, plate, almanac, foot);
  root.append(canvas, ui, flash);
  landing.prepend(root);
  document.body.classList.add("fl-menu-orrery");

  // "Back to the sky" on the classic page.
  const back = el("button", "fl-btn fl-btn--sm fl-orrery__back", "Back to the sky");
  back.type = "button";
  landing.append(back);
  const setClassic = (on: boolean) => {
    document.body.classList.toggle("fl-menu-classic", on);
    if (!on) landing.scrollTop = 0;
    wake();
  };
  classic.onclick = () => setClassic(true);
  back.onclick = () => setClassic(false);

  // ---- state ----------------------------------------------------------------------------
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let data: HomeData | null = null;
  let me: MeInfo | null = null;
  let shown = true;
  let disposed = false;
  let raf = 0;
  let last = performance.now();
  let t = 0; // the sky's own clock (s); rests under reduced motion
  let yaw = 0;
  let focus = 0;
  let yawVel = 0;
  let dragging = false;
  let dragX = 0;
  let moved = 0;
  /** The traveller has turned or chosen something: the front world no longer follows their character. */
  let touched = false;
  let dive = 0; // 0 none … 1 at the surface
  let diving = false;
  let w = 1;
  let h = 1;
  let almanacAt = -1e9;
  let almanacI = 0;
  let plateFor = "";
  /** The plate's box in the menu's own pixels (measured when its words change, not per frame). */
  let plateBox = { left: 1e9, top: 0, right: 0, bottom: 0 };
  const measurePlate = () => {
    const a = plate.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    plateBox = { left: a.left - b.left, top: a.top - b.top, right: a.right - b.left, bottom: a.bottom - b.top };
  };
  // Where the camera is, eased towards where the model says it should be.
  let camP: [number, number, number] | null = null;
  let camR = 1;

  const idOf = (i: number): BodyId => ORRERY_BODIES[i]!.id;
  const indexOf = (id: BodyId) => Math.max(0, ORRERY_BODIES.findIndex((b) => b.id === id));

  function choose(i: number) {
    if (diving) return;
    if (i === focus && plateFor) {
      // The front world again: dive, if that is where Play goes.
      if (idOf(i) === enterBody(me)) startDive();
      return;
    }
    focus = i;
    touched = true;
    yawVel = 0;
    paintPlate(true);
    wake();
  }

  function startDive() {
    if (diving) return;
    diving = true;
    root.classList.add("is-diving");
    if (reduced) {
      hooks.play();
      return;
    }
    wake();
  }

  function paintPlate(force = false) {
    const id = idOf(focus);
    const p: OrreryPlate = orreryPlate(id, data?.online ?? null, me);
    const key = JSON.stringify(p);
    if (!force && key === plateFor) return;
    plateFor = key;
    plate.dataset.body = id;
    kicker.textContent = p.kicker;
    name.textContent = p.name;
    name.style.setProperty("--len", String(Math.max(6, p.name.length)));
    line.textContent = p.line;
    facts.replaceChildren(...p.facts.map((f) => el("li", "", f)));
    act.replaceChildren();
    if (p.action.kind === "dive") {
      const b = el("button", "fl-orrery__dive");
      b.type = "button";
      b.dataset.e2e = "orrery-dive";
      b.append(el("span", "fl-orrery__divering"), el("span", "fl-orrery__divelabel", p.action.label), el("kbd", "", "Enter"));
      b.onclick = () => startDive();
      act.append(b);
    } else {
      const go = p.action.go;
      const b = el("button", "fl-orrery__link fl-orrery__go", p.action.goLabel);
      b.type = "button";
      b.onclick = () => choose(indexOf(go));
      act.append(el("p", "fl-orrery__note", p.action.note), b);
    }
    // Retrigger the plate's entrance.
    plate.classList.remove("is-in");
    void plate.offsetWidth;
    plate.classList.add("is-in");
    measurePlate();
  }

  function paintTags() {
    ORRERY_BODIES.forEach((b, i) => {
      const n = data?.online.bodies[b.id]?.players ?? 0;
      const [nm, ct] = tags[i]!.children as unknown as [HTMLElement, HTMLElement];
      const label = b.id.charAt(0).toUpperCase() + b.id.slice(1);
      if (nm.textContent !== label) nm.textContent = label;
      const c = n > 0 ? String(n) : "";
      if (ct.textContent !== c) ct.textContent = c;
      tags[i]!.setAttribute("aria-label", `${label}${n ? `, ${n} here now` : ""}`);
    });
  }

  function paintAccount() {
    const guest = !me || me.guest;
    const nm = me?.displayName ?? me?.name ?? "";
    who.textContent = nm ? `${nm}${guest ? " · guest" : ""}` : "";
    who.hidden = !nm;
    signBtn.textContent = guest ? "Sign in" : "Sign out";
    signBtn.onclick = () => (guest ? hooks.signIn() : hooks.signOut());
    saveBtn.hidden = !(me && me.guest && me.character);
  }

  function resize() {
    const r = root.getBoundingClientRect();
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      gl!.viewport(0, 0, cw, ch);
    }
  }

  function frame(now: number) {
    raf = 0;
    if (disposed || !shown || document.hidden || document.body.classList.contains("fl-menu-classic")) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!reduced) t += dt;

    // The sky turns under the hand, coasts, and settles with the front world at the front.
    if (!dragging && !diving) {
      if (Math.abs(yawVel) > 0.02) {
        yaw += yawVel * dt;
        yawVel *= Math.exp(-dt * 3.2);
        const f = frontBody(t, yaw);
        if (f !== focus) {
          focus = f;
          paintPlate();
        }
      } else {
        const want = yawFor(focus, t, yaw);
        yaw += (want - yaw) * (reduced ? 1 : 1 - Math.exp(-dt * 4.5));
      }
    }
    if (diving && !reduced) {
      dive = Math.min(1, dive + dt / 1.05);
      flash.style.opacity = String(Math.max(0, (dive - 0.55) / 0.45));
      if (dive >= 1) {
        hooks.play();
        diving = false; // Play takes the page; a failed load brings it back
        window.setTimeout(reset, 1200);
      }
    }

    const fb = ORRERY_BODIES[focus]!;
    const fp = bodyPos(fb, t, yaw);
    // Ease the camera's anchor so a change of world is a glide, not a cut.
    const k = reduced || !camP ? 1 : 1 - Math.exp(-dt * 3.6);
    camP = camP ? [camP[0] + (fp[0] - camP[0]) * k, 0, camP[2] + (fp[2] - camP[2]) * k] : [fp[0], 0, fp[2]];
    camR += (fb.radius - camR) * k;
    const cam = orreryCamera(camP, camR, dive);

    resize();
    const g = gl!;
    g.uniform2f(u.res, canvas.width, canvas.height);
    g.uniform1f(u.time, t);
    g.uniform3fv(u.cam, cam.pos as unknown as number[]);
    g.uniform3fv(u.fwd, cam.fwd as unknown as number[]);
    g.uniform3fv(u.right, cam.right as unknown as number[]);
    g.uniform3fv(u.up, cam.up as unknown as number[]);
    g.uniform1f(u.tan, cam.tan);
    const bodies: number[] = [];
    const lights: number[] = [];
    const foc: number[] = [];
    ORRERY_BODIES.forEach((b, i) => {
      const p = bodyPos(b, t, yaw);
      bodies.push(p[0], p[1], p[2], b.radius);
      const n = data?.online.bodies[b.id]?.players ?? 0;
      lights.push(Math.min(1, 0.18 + n / 12));
      foc.push(i === focus ? 1 : 0);
      // The world's tag rides just above it.
      const s = project([p[0], p[1] + b.radius * 1.18, p[2]], cam, w, h);
      const tag = tags[i]!;
      const under = i !== focus && s.x > plateBox.left - 30 && s.x < plateBox.right + 30 && s.y > plateBox.top - 10 && s.y < plateBox.bottom + 30;
      const vis = s.depth > 0.5 && s.x > -80 && s.x < w + 80 && s.y > 40 && s.y < h - 40 && dive < 0.2 && !under;
      tag.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
      tag.style.opacity = vis ? "1" : "0";
      tag.style.pointerEvents = vis ? "auto" : "none";
      tag.classList.toggle("is-front", i === focus);
    });
    g.uniform4fv(u.body, bodies);
    g.uniform1fv(u.lights, lights);
    g.uniform1fv(u.focus, foc);
    g.drawArrays(g.TRIANGLES, 0, 3);

    // The almanac turns a line every few seconds.
    if (now - almanacAt > 5200) {
      almanacAt = now;
      const lines = almanacLines(data?.online ?? null, data?.board ?? null);
      const lineEl = almanac.lastElementChild as HTMLElement;
      lineEl.classList.remove("is-in");
      void lineEl.offsetWidth;
      lineEl.textContent = lines[almanacI++ % lines.length]!;
      lineEl.classList.add("is-in");
    }
    if (!reduced || dragging || diving || Math.abs(yawVel) > 0.02) wake();
  }

  function wake() {
    if (!raf && !disposed) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function reset() {
    dive = 0;
    diving = false;
    flash.style.opacity = "0";
    root.classList.remove("is-diving");
    wake();
  }

  // ---- hands ----------------------------------------------------------------------------
  const onDown = (e: PointerEvent) => {
    if (diving || (e.target as HTMLElement).closest("button, a, .fl-orrery__plate")) return;
    dragging = true;
    dragX = e.clientX;
    moved = 0;
    yawVel = 0;
    root.setPointerCapture(e.pointerId);
    root.classList.add("is-dragging");
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragX;
    dragX = e.clientX;
    moved += Math.abs(dx);
    if (moved >= 5) touched = true;
    const d = (-dx / w) * 2.4;
    yaw += d;
    yawVel = d / Math.max(0.008, (performance.now() - last) / 1000) * 0.35 + yawVel * 0.65;
    const f = frontBody(t, yaw);
    if (f !== focus) {
      focus = f;
      paintPlate();
    }
    wake();
  };
  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
    if (moved < 5) {
      // A click on the sky: a world under the pointer is chosen (or dived into, if it is the front one).
      const r = root.getBoundingClientRect();
      const fb = ORRERY_BODIES[focus]!;
      const cam = orreryCamera(camP ?? bodyPos(fb, t, yaw), camR, dive);
      const hit = pickBody(e.clientX - r.left, e.clientY - r.top, t, yaw, cam, w, h);
      yawVel = 0;
      if (hit >= 0) choose(hit);
    }
    wake();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!shown || document.body.classList.contains("fl-menu-classic") || e.metaKey || e.ctrlKey || e.altKey) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.closest("input, textarea, select, dialog, [contenteditable]") || document.querySelector("dialog[open]"))) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      choose(neighbour(focus, e.key === "ArrowRight" ? 1 : -1, t, yaw));
    } else if (e.key === "Enter" && !(tgt && tgt.closest("button, a"))) {
      e.preventDefault();
      if (idOf(focus) === enterBody(me)) startDive();
      else choose(indexOf(enterBody(me)));
    }
  };
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onUp);
  window.addEventListener("keydown", onKey);
  const onVis = () => {
    measurePlate();
    wake();
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("resize", onVis);

  // The first view: the world Play goes to is at the front.
  focus = indexOf(enterBody(me));
  yaw = yawFor(focus, t, 0);
  paintTags();
  paintAccount();
  paintPlate(true);
  wake();

  return {
    setData(d) {
      data = d;
      paintTags();
      paintPlate();
      wake();
    },
    setMe(m) {
      const before = enterBody(me);
      me = m;
      paintAccount();
      // Until the traveller has touched the sky, the front world follows where their character is.
      const now = enterBody(me);
      if (now !== before && !touched && !diving) focus = indexOf(now);
      paintPlate(true);
      wake();
    },
    setShown(s) {
      shown = s;
      if (s) reset();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onVis);
      document.body.classList.remove("fl-menu-orrery", "fl-menu-classic");
      root.remove();
      back.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
