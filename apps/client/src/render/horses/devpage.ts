// Dev lineup (?horses): the six coats, each with a rider in the saddle, cycling idle / walk / run /
// gallop / jump in place. Keys: ← / → gait · Space pause · R riders on/off · drag to orbit.

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { HORSE, HORSE_COATS } from "@firstlight/shared/content/horse";
import { ANIM, PF } from "@firstlight/shared/net/schema";
import { createRenderer } from "../renderer.ts";
import { AvatarView, preloadAvatars } from "../Avatars.ts";
import { setAvatarTextureLowRes } from "../avatars/assets.ts";
import { HorseView, preloadHorse } from "../Horses.ts";

const R = 5000;
const GAITS: { name: string; speed: number; airborne: boolean; anim: number }[] = [
  { name: "idle", speed: 0, airborne: false, anim: ANIM.IDLE },
  { name: "walk 2 m/s", speed: 2, airborne: false, anim: ANIM.WALK },
  { name: `canter ${HORSE.speed} m/s`, speed: HORSE.speed, airborne: false, anim: ANIM.SPRINT },
  { name: `gallop ${HORSE.sprint} m/s`, speed: HORSE.sprint, airborne: false, anim: ANIM.SPRINT },
  { name: "jump", speed: 8, airborne: true, anim: ANIM.JUMP },
];

export async function startHorseDevPage() {
  document.getElementById("landing")?.style.setProperty("display", "none");
  const ctx = await createRenderer(document.getElementById("game")!);
  setAvatarTextureLowRes(ctx.tier === "low");
  await Promise.all([preloadAvatars(), preloadHorse()]);
  const { scene, camera } = ctx;
  scene.background = new THREE.Color(0x7d8fa6);
  scene.fog = new THREE.Fog(0x7d8fa6, 20, 70);
  scene.add(new THREE.HemisphereLight(0xc4d6ff, 0x5a4d3e, 1.3));
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.2);
  sun.position.set(6, R + 9, 7);
  sun.target.position.set(0, R, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 40;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x6f7a5c, roughness: 0.95 }));
  ground.position.set(0, R, 0);
  ground.receiveShadow = true;
  scene.add(ground);

  const rows = HORSE_COATS.map((_, i) => {
    const horse = new HorseView(i);
    horse.setDetail(true);
    const rider = new AvatarView(i % 6, i % 4);
    rider.setDetail(true);
    rider.setFlags(PF.MOUNTED);
    scene.add(horse.root, rider.root);
    return { horse, rider, x: (i - 2.5) * 2.2 };
  });

  camera.position.set(7, R + 3.5, 9);
  const controls = new OrbitControls(camera, ctx.renderer.domElement);
  controls.target.set(0, R + 1.2, 0);
  controls.enableDamping = true;
  controls.update();

  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;left:12px;top:12px;z-index:20;font:13px/1.45 ui-monospace,monospace;color:#f4f1ea;background:#0b0a12cc;padding:10px 12px;border-radius:8px;pointer-events:none";
  document.body.appendChild(hud);

  let gait = 0;
  let paused = false;
  let riders = true;
  let t = 0;
  addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { gait = (gait + 1) % GAITS.length; t = 0; }
    else if (e.key === "ArrowLeft") { gait = (gait - 1 + GAITS.length) % GAITS.length; t = 0; }
    else if (e.key === " ") paused = !paused;
    else if (e.key.toLowerCase() === "r") riders = !riders;
  });
  (window as unknown as { __horseDev: unknown }).__horseDev = { setGait: (i: number) => { gait = i; t = 0; }, setRiders: (on: boolean) => (riders = on), rows };

  const seat = new THREE.Vector3();
  let last = performance.now();
  ctx.renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) {
      t += dt;
      if (t > 4) { gait = (gait + 1) % GAITS.length; t = 0; }
    }
    const g = GAITS[gait]!;
    for (const { horse, rider, x } of rows) {
      horse.set(x, R, 0, 0, 0, 1, g.speed, g.airborne && t % 1.2 < 0.9, dt);
      rider.root.visible = riders;
      rider.set(x, R, 0, 0, 0, 1, g.anim, dt);
      horse.seat(seat);
      rider.root.position.copy(seat).addScaledVector(seat.clone().normalize(), -rider.seatDrop());
    }
    controls.update();
    ctx.render();
    const info = ctx.renderer.info.render;
    hud.innerHTML = `<b>FIRSTLIGHT horses</b> · ${g.name}${paused ? " · paused" : ""} · draws ${info.drawCalls} · tris ${info.triangles}<br>` +
      `<span style="opacity:.75">←/→ gait · space pause · R riders · drag orbit</span>`;
  });
}
