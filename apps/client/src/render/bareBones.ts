// Bare bones out of three's scene walks (#49, D-framerate-2). Every render pass walks the whole scene
// graph to find what to draw (Renderer._projectObject), and the main pass and the sun's shadow map
// each walk it once a frame. In Portus with 40 players that graph was 3,500 objects, 2,700 of them
// bones (65 per character): fingers, toes and legs that draw nothing and hold nothing. A bone with no
// socket or mesh below it is marked invisible, so the walks stop there. Visibility doesn't touch
// matrices: three still updates every bone's world matrix, and skinning reads those, so the mesh moves
// exactly as before. Call it once the model's sockets exist (items go on sockets, which keep their
// bones visible).

import type * as THREE from "three/webgpu";

/** Hide every bone under `root` with nothing but bones below it; returns how many were hidden. */
export function hideBareBones(root: THREE.Object3D): number {
  let hidden = 0;
  const visit = (o: THREE.Object3D): boolean => {
    let holds = !(o as THREE.Bone).isBone; // a socket, a mesh, a group: something to reach
    for (const c of o.children) if (visit(c)) holds = true;
    if ((o as THREE.Bone).isBone && !holds) {
      if (o.visible) hidden++;
      o.visible = false;
    }
    return holds;
  };
  visit(root);
  return hidden;
}
