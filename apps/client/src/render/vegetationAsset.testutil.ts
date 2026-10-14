// Decode shipped geometry in Node without asking for a DOM image decoder or making HTTP requests.
import { readFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { vegetationGeometry, type VegetationAssets } from "./vegetationAssets.ts";

export const vegetationBytes = readFileSync(new URL("../../public/assets-dev/vegetation/vegetation.glb", import.meta.url));
export const vegetationDocument = JSON.parse(vegetationBytes.subarray(20, 20 + vegetationBytes.readUInt32LE(12)).toString());
let pending: Promise<VegetationAssets> | null = null;
export function testVegetationAssets(): Promise<VegetationAssets> {
  return pending ??= decode();
}
async function decode(): Promise<VegetationAssets> {
  const doc = structuredClone(vegetationDocument);
  delete doc.images;
  delete doc.textures;
  delete doc.materials;
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const text = Buffer.from(JSON.stringify(doc));
  const json = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const rest = vegetationBytes.subarray(20 + vegetationBytes.readUInt32LE(12));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + rest.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const bytes = Buffer.concat([header, json, rest]);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  const geometry = new Map<string, THREE.BufferGeometry>();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) geometry.set(mesh.name, vegetationGeometry(mesh.geometry, mesh.matrixWorld));
  });
  return { geometry, atlas: new THREE.Texture(), impostors: new THREE.Texture() };
}
