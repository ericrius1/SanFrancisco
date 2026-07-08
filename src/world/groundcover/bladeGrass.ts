// Shared blade-grass primitives — the ONE good grass look (the botanical
// garden's), promoted into the ground-cover meta-module so every grass system
// renders identical blades: same curved multi-blade cluster geometry, same
// MeshSSS material with wind sway + trample, same instance-buffer write format.
//
// A grass system is then just: (1) sample GrassEntry placements however it likes
// (garden = footprint base + near ring; wildlands = a ring that follows the
// player), (2) write them into a mesh via writeGrassMesh. The blades, lighting,
// wind bending, and player interaction are all shared here — new grasses reuse
// it instead of re-authoring a material.
//
// Wind envelope + trample displacers come from the sibling meta-modules, so what
// bends here bends in lockstep with the wildflowers and any future foliage.

import * as THREE from "three/webgpu";
import {
  attribute,
  cameraViewMatrix,
  color,
  float,
  Fn,
  Loop,
  mix,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  positionLocal,
  uniform,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { groundSway } from "./sway";
import { DISPLACERS, MAX_DISPLACERS } from "./displacers";

// The prevailing wind direction now lives in the shared sway module; re-exported
// here so existing importers (grassField) keep their path.
export { WIND_DIR } from "./sway";

export type GrassEntry = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
  spread: number;
  color: THREE.Color;
  windX: number;
  windZ: number;
};

const GRASS_FADE_BAND = uniform(0.16);
/** Set to the current view focus (x,z); blades fade out toward the field edge. */
export const GRASS_DENSITY_FOCUS = uniform(new THREE.Vector2(1e6, 1e6));

// TSL's d.ts narrows chained vector nodes too aggressively for vendored JS uniforms.
type TslNode = any;

export function createBladeClusterGeometry({
  blades,
  segments,
  width,
  radius,
  curvature
}: {
  blades: number;
  segments: number;
  width: number;
  radius: number;
  curvature: number;
}): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let base = 0;

  for (let blade = 0; blade < blades; blade++) {
    const yaw = (blade / blades) * Math.PI * 2 + (blade % 2) * 0.41;
    const rootA = yaw + 1.37;
    const rootR = radius * (0.15 + 0.85 * ((blade * 4.79) % 1));
    const rootX = Math.cos(rootA) * rootR;
    const rootZ = Math.sin(rootA) * rootR;
    const dirX = Math.cos(yaw);
    const dirZ = Math.sin(yaw);
    const sideX = -dirZ;
    const sideZ = dirX;
    const bend = curvature * (0.7 + 0.45 * ((blade * 2.23) % 1));
    const bladeWidth = width * (0.75 + 0.42 * ((blade * 3.31) % 1));

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const curve = 2 * (1 - t) * t * bend;
      const halfW = bladeWidth * (1 - t * 0.88) * 0.5;
      const cx = rootX + dirX * curve;
      const cz = rootZ + dirZ * curve;
      positions.push(cx - sideX * halfW, t, cz - sideZ * halfW, cx + sideX * halfW, t, cz + sideZ * halfW);
      normals.push(0, 1, 0, 0, 1, 0);
      const rootShade = 0.56 + t * 0.44;
      const tipWarmth = 0.72 + t * 0.28;
      colors.push(rootShade, rootShade, tipWarmth, rootShade, rootShade, tipWarmth);
      uvs.push(0, t, 1, t);
    }

    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      const c = base + (i + 1) * 2;
      indices.push(a, a + 1, c, a + 1, c + 1, c);
    }

    const tip = base + (segments + 1) * 2;
    positions.push(rootX, 1.03, rootZ);
    normals.push(0, 1, 0);
    colors.push(1, 1, 0.88);
    uvs.push(0.5, 1);
    const last = base + segments * 2;
    indices.push(last, last + 1, tip);
    base = tip + 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** The shared grass material: SSS blades, wind sway (shared envelope), and
 *  trample against the shared displacer field. Instances carry aGrassColor
 *  (rgb + per-mesh fade radius), aGrassWind (leanX,leanZ, anchorX,anchorZ), and
 *  aGrassInfo (cosYaw,sinYaw,spread,height). */
export function createGrassMaterial(): THREE.Material {
  const mat = new THREE.MeshSSSNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.roughness = 0.94;
  mat.metalness = 0;

  const tint = attribute("aGrassColor", "vec4") as TslNode;
  const wind = attribute("aGrassWind", "vec4") as TslNode;
  const bladeT = positionGeometry.y.clamp(0, 1);
  const rootAo = bladeT.mul(0.42).add(0.58);
  const grassRoot = color(0x1f4f1c);
  const grassTip = color(0x8cbd45);
  mat.colorNode = mix(grassRoot, grassTip, bladeT.pow(0.82)).mul(tint.xyz).mul(rootAo);

  const fadeRadius = tint.w.max(1);
  const dist = wind.zw.sub(GRASS_DENSITY_FOCUS).length();
  const fade = fadeRadius.sub(dist).div(fadeRadius.mul(GRASS_FADE_BAND).max(1)).clamp(0, 1);
  const scaled = positionLocal.mul(fade);
  const anchorWorld = modelWorldMatrix.mul(vec4(wind.z, 0, wind.w, 1)).xz;

  // Trample: accumulate world-space push away from each displacer plus a
  // "crush" factor that flattens blades and damps their wind response.
  const info = attribute("aGrassInfo", "vec4") as TslNode; // cosYaw, sinYaw, spread, height
  const trampleAccum = (Fn(() => {
    const push = vec2(0).toVar();
    const crush = float(0).toVar();
    Loop(MAX_DISPLACERS, ({ i }: { i: TslNode }) => {
      const d = (DISPLACERS as TslNode).element(i);
      const delta = anchorWorld.sub(d.xy);
      const len = delta.length().max(1e-4);
      const infl = d.z.sub(len).div(d.z.max(1e-4)).clamp(0, 1);
      const s = infl.mul(infl).mul(d.w);
      push.addAssign(delta.div(len).mul(s));
      crush.addAssign(s);
    });
    return vec3(push, crush);
  }) as TslNode)();
  const push = trampleAccum.xy;
  const crush = trampleAccum.z;
  const crushed = crush.min(1);
  const pushLen = push.length();
  const pushXZ = push.mul(pushLen.min(1).div(pushLen.max(1e-4))).mul(0.85);
  // positionNode offsets get the instance rotation/scale applied AFTER this
  // runs, so map the world offset back into the instance frame — R(-yaw) and
  // divide by the XZ/Y scales.
  const trampleT: TslNode = bladeT.pow(1.35).mul(fade);
  const worldX: TslNode = pushXZ.x.mul(trampleT);
  const worldZ: TslNode = pushXZ.y.mul(trampleT);
  const trampleLocalX: TslNode = info.x.mul(worldX).sub(info.y.mul(worldZ)).div(info.z.max(1e-4));
  const trampleLocalY: TslNode = (crushed as TslNode).mul(-0.42).mul(trampleT).div(info.w.max(1e-4));
  const trampleLocalZ: TslNode = info.y.mul(worldX).add(info.x.mul(worldZ)).div(info.z.max(1e-4));
  const localTrample = vec3(trampleLocalX, trampleLocalY, trampleLocalZ).clamp(-4, 4);

  const windDamp = float(1).sub(crushed.mul(0.75));
  const bend = vec3(wind.x, 0, wind.y).mul(groundSway(anchorWorld)).mul(bladeT.pow(2.05).mul(fade)).mul(windDamp);
  mat.positionNode = scaled.add(bend).add(localTrample);

  mat.normalNode = normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  mat.thicknessColorNode = tint.y.mul(bladeT.mul(0.72).add(0.28)).mul(uniform(new THREE.Color(0.42, 0.68, 0.24)));
  mat.thicknessDistortionNode = uniform(0.38);
  mat.thicknessAmbientNode = uniform(0.08);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(5.0);
  mat.thicknessScaleNode = uniform(2.35);
  return mat;
}

/** An empty instanced grass mesh (static-usage buffers, sized to `capacity`). */
export function createGrassMesh(
  name: string,
  capacity: number,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  castShadow: boolean
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry.clone(), material, capacity);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  // StaticDrawUsage on purpose: r185 re-uploads DynamicDrawUsage buffers every
  // frame regardless of version; static + needsUpdate uploads only on rewrite.
  const matrixAttr = new THREE.StorageInstancedBufferAttribute(capacity, 16);
  matrixAttr.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix = matrixAttr;
  const colorAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  colorAttr.setUsage(THREE.StaticDrawUsage);
  const windAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  windAttr.setUsage(THREE.StaticDrawUsage);
  const infoAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  infoAttr.setUsage(THREE.StaticDrawUsage);
  mesh.geometry.setAttribute("aGrassColor", colorAttr);
  mesh.geometry.setAttribute("aGrassWind", windAttr);
  mesh.geometry.setAttribute("aGrassInfo", infoAttr);
  mesh.count = 0;
  return mesh;
}

const grassWriteDummy = new THREE.Object3D();

/** Write `entries` into `mesh` (matrices + the three grass attributes), zeroing
 *  any slots a previous larger write left behind. `fadeRadius` is the field
 *  radius the blades fade toward. */
export function writeGrassMesh(mesh: THREE.InstancedMesh, entries: GrassEntry[], fadeRadius: number) {
  // never write past the mesh's fixed capacity — a high density knob can sample
  // more blades than the buffers hold; the overflow is simply dropped.
  const capacity = mesh.instanceMatrix.count;
  if (entries.length > capacity) entries = entries.slice(0, capacity);
  const matrices = mesh.instanceMatrix.array as Float32Array;
  const colorAttr = mesh.geometry.getAttribute("aGrassColor") as THREE.StorageInstancedBufferAttribute;
  const windAttr = mesh.geometry.getAttribute("aGrassWind") as THREE.StorageInstancedBufferAttribute;
  const infoAttr = mesh.geometry.getAttribute("aGrassInfo") as THREE.StorageInstancedBufferAttribute;
  const colors = colorAttr.array as Float32Array;
  const winds = windAttr.array as Float32Array;
  const infos = infoAttr.array as Float32Array;
  const dummy = grassWriteDummy;
  entries.forEach((entry, i) => {
    dummy.position.set(entry.x, entry.y, entry.z);
    dummy.rotation.set(0, entry.yaw, 0);
    dummy.scale.set(entry.spread, entry.height, entry.spread);
    dummy.updateMatrix();
    dummy.matrix.toArray(matrices, i * 16);
    const ci = i * 4;
    colors[ci] = entry.color.r;
    colors[ci + 1] = entry.color.g;
    colors[ci + 2] = entry.color.b;
    colors[ci + 3] = fadeRadius;
    winds[ci] = entry.windX;
    winds[ci + 1] = entry.windZ;
    winds[ci + 2] = entry.x;
    winds[ci + 3] = entry.z;
    infos[ci] = Math.cos(entry.yaw);
    infos[ci + 1] = Math.sin(entry.yaw);
    infos[ci + 2] = entry.spread;
    infos[ci + 3] = entry.height;
  });
  const lastCount = (mesh.userData.grassLastCount as number) ?? 0;
  if (lastCount > entries.length) {
    matrices.fill(0, entries.length * 16, lastCount * 16);
    colors.fill(0, entries.length * 4, lastCount * 4);
    winds.fill(0, entries.length * 4, lastCount * 4);
    infos.fill(0, entries.length * 4, lastCount * 4);
  }
  mesh.userData.grassLastCount = entries.length;
  mesh.count = entries.length;
  mesh.instanceMatrix.needsUpdate = true;
  colorAttr.needsUpdate = true;
  windAttr.needsUpdate = true;
  infoAttr.needsUpdate = true;
}
