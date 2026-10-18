// Dev lineup (?avatars): every starter look (5 starters + 2 second looks) × 6 palettes on a lit stage, cycling through every clip.
// Keys: ← / → previous/next clip · Space pause/resume cycling · W next weapon · S toggle sockets
// · G toggle the sun's shadow. Drag to orbit, wheel to zoom. Add ?tier=low|medium|high|ultra as usual.
// &warmcheck: run the game's warm-up (the avatar hook) first, then stand the line-up (every look ×
// palette with its starter weapon) and count node builds after it: window.__warmcheck when done.
// &fade: every avatar is a quest NPC (the camera fade's occluder gate) and the fade cone aims at the
// middle row, so the avatars in front of it dissolve while their shadows stay whole (#39 look checks).

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ANIM } from "@firstlight/shared/net/schema";
import { PALETTE_NAMES, STARTER_LOOKS, STARTERS, WEAPONS } from "@firstlight/shared/content/weapons";
import { createRenderer } from "../renderer.ts";
import { AvatarView, avatarWarmupHook, preloadAvatars } from "../Avatars.ts";
import { installShaderMonitor, shaderMonitorFrame, shaderStats, warmup } from "../warmup.ts";
import { setAvatarTextureLowRes } from "./assets.ts";
import { avatarChest, updateOccluderFade } from "../occluderFade.ts";

const R = 5000; // stand the stage on a "planet" big enough to be flat (AvatarView takes planet coords)
const ORDER = [
  "idle", "walk", "run", "sprint", "jump_air", "fall", "land_short", "swim", "swim_idle", "roll_fast",
  "melee_light", "melee_heavy", "block_hold", "punch", "punch_heavy", "aim", "shoot", "cast", "throw",
  "hit", "hit_heavy", "death", "emote_wave", "emote_point", "emote_cheer", "emote_dance",
];
const CYCLE_S = 3.2;

export async function startAvatarDevPage() {
  document.getElementById("landing")?.style.setProperty("display", "none");
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "grid";
  const text = document.getElementById("loading-text");
  if (text) text.textContent = "Loading characters…";
  const ctx = await createRenderer(document.getElementById("game")!);
  const warmcheck = new URLSearchParams(location.search).has("warmcheck");
  const fade = new URLSearchParams(location.search).has("fade");
  if (warmcheck) installShaderMonitor(ctx);
  setAvatarTextureLowRes(ctx.tier === "low");
  const assets = await preloadAvatars((f) => {
    const bar = document.getElementById("loading-bar") as HTMLElement | null;
    if (bar) bar.style.width = `${Math.round(f * 100)}%`;
  });
  if (loading) loading.style.display = "none";

  const { scene, camera } = ctx;
  scene.background = new THREE.Color(0x7d8fa6);
  scene.fog = new THREE.Fog(0x7d8fa6, 18, 60);
  const hemi = new THREE.HemisphereLight(0xc4d6ff, 0x5a4d3e, 1.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.2);
  sun.position.set(6, R + 9, 7);
  sun.target.position.set(0, R, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 40;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ color: 0x6f7a5c, roughness: 0.95 }));
  ground.position.set(0, R, 0);
  ground.receiveShadow = true;
  scene.add(ground);

  camera.position.set(4.5, R + 3.2, 10.5);
  camera.lookAt(0, R + 0.9, 0);
  let baseline = 0;
  if (warmcheck) {
    // what Game.firstArrival does: the avatar hook stands every loaded look hidden
    await warmup(ctx, { frames: 4, hooks: [avatarWarmupHook(scene, () => new THREE.Vector3(0, R, 0))] });
    baseline = shaderStats().total;
  }

  const avatars: { a: AvatarView; x: number; z: number }[] = [];
  const dx = 1.25, dz = 2.0;
  // one row per look: the starters, then the second looks
  const rows = STARTER_LOOKS.flatMap((ls, s) => ls.map((_, look) => ({ s, look }))).sort((a, b) => a.look - b.look || a.s - b.s);
  rows.forEach(({ s, look }, r) => {
    for (let p = 0; p < 6; p++) {
      const a = new AvatarView(p, s, look);
      const x = (p - 2.5) * dx;
      const z = ((rows.length - 1) / 2 - r) * dz;
      if (fade) a.root.userData.occluderFade = true;
      scene.add(a.root);
      avatars.push({ a, x, z });
    }
  });
  const fadeTarget = avatars[Math.floor(rows.length / 2) * 6 + 2]!.a.root; // the middle row, third palette
  const chest = new THREE.Vector3();

  camera.position.set(4.5, R + 3.2, 10.5);
  const controls = new OrbitControls(camera, ctx.renderer.domElement);
  controls.target.set(0, R + 0.9, 0);
  controls.enableDamping = true;
  controls.update();

  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;left:12px;top:12px;z-index:20;font:13px/1.45 ui-monospace,monospace;color:#f4f1ea;" +
    "background:#0b0a12cc;padding:10px 12px;border-radius:8px;pointer-events:none;max-width:560px";
  document.body.appendChild(hud);
  const labels = document.createElement("div");
  labels.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:19;font:12px ui-sans-serif,system-ui;color:#fff;text-shadow:0 1px 2px #000";
  document.body.appendChild(labels);

  let idx = 0;
  let paused = false;
  let t = 0;
  let weaponStep = 0;
  const weaponIds = ["fists", ...STARTERS.map((x) => x.weapon), ...WEAPONS.map((w) => w.id)].filter((v, i, arr) => arr.indexOf(v) === i);
  const showClip = () => { for (const { a } of avatars) a.playClip(ORDER[idx]!); t = 0; };
  const applyWeapon = () => {
    for (const { a } of avatars) {
      if (weaponStep === 0) {
        const own = STARTERS[a.starter]!.weapon;
        a.setWeapon(WEAPONS.findIndex((w) => w.id === own));
      } else a.setWeapon(WEAPONS.findIndex((w) => w.id === weaponIds[weaponStep]));
    }
  };
  addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { idx = (idx + 1) % ORDER.length; showClip(); }
    else if (e.key === "ArrowLeft") { idx = (idx - 1 + ORDER.length) % ORDER.length; showClip(); }
    else if (e.key === " ") paused = !paused;
    else if (e.key.toLowerCase() === "w") { weaponStep = (weaponStep + 1) % weaponIds.length; applyWeapon(); }
    else if (e.key.toLowerCase() === "g") sun.castShadow = !sun.castShadow;
  });

  let last = performance.now();
  let started = false;
  const tmp = new THREE.Vector3();
  let checkFrames = 0;
  ctx.renderer.setAnimationLoop(() => {
    if (warmcheck) {
      shaderMonitorFrame();
      // ~10 s: every clip pose has rendered a few times
      if (++checkFrames === 600) {
        const st = shaderStats();
        const check = { afterWarmup: st.afterWarmup, newBuilds: st.total - baseline, recent: st.recent, looks: avatars.length, backend: ctx.webgpu ? "webgpu" : "webgl2", tier: ctx.tier };
        (window as unknown as { __warmcheck: typeof check }).__warmcheck = check;
        console.info("[warmcheck]", JSON.stringify(check));
      }
    }
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!started && assets) { started = true; showClip(); applyWeapon(); }
    if (!paused) {
      t += dt;
      if (t > CYCLE_S) { idx = (idx + 1) % ORDER.length; showClip(); }
    }
    for (const { a, x, z } of avatars) a.set(x, R, z, 0, 0, 1, ANIM.IDLE, dt);
    AvatarView.updateLod(camera, ctx.settings.fullAvatars * 2);
    controls.update();
    if (fade) updateOccluderFade(camera, avatarChest(fadeTarget, null, chest), true);
    ctx.render();
    const info = ctx.renderer.info.render;
    const w = weaponStep === 0 ? "starter weapons" : weaponIds[weaponStep];
    hud.innerHTML = assets
      ? `<b>FIRSTLIGHT starters</b> · clip <b>${ORDER[idx]}</b> (${idx + 1}/${ORDER.length})${paused ? " · paused" : ""}<br>` +
        `held: ${w} · tier ${ctx.tier} (${ctx.webgpu ? "WebGPU" : "WebGL2"}) · draws ${info.drawCalls} · tris ${info.triangles}<br>` +
        `<span style="opacity:.75">←/→ clip · space pause · W weapon · G shadow · drag orbit</span>`
      : "<b>Character GLBs failed to load</b>: showing capsule fallbacks (see console).";
    // row/column labels
    let html = "";
    const put = (v: THREE.Vector3, s: string) => {
      tmp.copy(v).project(camera);
      if (tmp.z > 1) return;
      html += `<div style="position:absolute;left:${((tmp.x + 1) / 2) * innerWidth}px;top:${((1 - tmp.y) / 2) * innerHeight}px;transform:translate(-50%,-50%)">${s}</div>`;
    };
    rows.forEach(({ s, look }, r) => {
      const name = look ? `${STARTERS[s]!.name} · ${STARTER_LOOKS[s]![look]!.name}` : STARTERS[s]!.name;
      put(new THREE.Vector3(-3.4 * dx, R + 1, ((rows.length - 1) / 2 - r) * dz), name);
    });
    for (let p = 0; p < 6; p++) put(new THREE.Vector3((p - 2.5) * dx, R + 2.15, ((rows.length - 1) / 2) * dz), PALETTE_NAMES[p]!);
    labels.innerHTML = html;
  });
}
