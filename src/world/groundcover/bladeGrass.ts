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
  cos,
  float,
  Fn,
  Loop,
  mix,
  modelNormalMatrix,
  normalize,
  normalGeometry,
  positionGeometry,
  sin,
  step,
  uniform,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { groundSwayFlow, groundSwayLite, WIND_DIR } from "./sway";
import { DISPLACERS, MAX_DISPLACERS } from "./displacers";
import { fadeAroundInstanceAnchor, instanceAnchorWorld, worldOffsetToModelLocal } from "./instanceDeform";

export type GrassEntry = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
  spread: number;
  color: THREE.Color;
  windAmp: number;
};

const GRASS_FADE_BAND = 0.16;

export type GrassMaterialState = {
  material: THREE.Material;
  /** World-space XZ focus used only by this grass field's LOD fade. */
  focus: THREE.Vector2;
};

export type GrassMaterialOptions = {
  /** Full layered noise nearby; one coherent sine for mid/far tiles. */
  wind?: "full" | "lite";
  /** Compile-time interaction budget. Far grass uses zero; nearby grass keeps all 12. */
  interactionSlots?: number;
  /** Legacy site grass scales down; streamed fields extinguish stable whole blades. */
  fadeMode?: "scale" | "rank";
  /** Absolute world-space width of a rank fade. Only used by `fadeMode: "rank"`. */
  fadeBand?: number;
};

/**
 * Grass is drawn with InstancedBufferGeometry rather than InstancedMesh. The
 * renderer still emits one instanced draw, but the transform is reconstructed
 * from two vec4 attributes instead of uploading a 4x4 matrix per cluster.
 */
export type GrassMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;

// TSL's d.ts narrows chained vector nodes too aggressively for vendored JS uniforms.
type TslNode = any;

function bladeRank(blade: number): number {
  // Irrational stride: every authored blade gets a stable, well-spaced rank.
  // Keep it strictly inside (0, 1) so coverage=0 rejects all and coverage=1
  // retains all blades.
  return 0.002 + (((blade + 1) * 0.6180339887498949) % 1) * 0.996;
}

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
  const ranks: number[] = [];
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
    const rank = bladeRank(blade);

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const curve = 2 * (1 - t) * t * bend;
      const curveSlope = 2 * (1 - 2 * t) * bend;
      const halfW = bladeWidth * (1 - t * 0.88) * 0.5;
      const cx = rootX + dirX * curve;
      const cz = rootZ + dirZ * curve;
      positions.push(cx - sideX * halfW, t, cz - sideZ * halfW, cx + sideX * halfW, t, cz + sideZ * halfW);
      // A ribbon is lit from its actual blade plane, not from camera-facing up.
      // Keep a small upward component so the curved two-sided strip catches the
      // sky while retaining directional highlights across the clump.
      const normal = new THREE.Vector3(-dirX, 0.22 + curveSlope * 0.18, -dirZ).normalize();
      normals.push(normal.x, normal.y, normal.z, normal.x, normal.y, normal.z);
      const rootShade = 0.56 + t * 0.44;
      const tipWarmth = 0.72 + t * 0.28;
      colors.push(rootShade, rootShade, tipWarmth, rootShade, rootShade, tipWarmth);
      uvs.push(0, t, 1, t);
      ranks.push(rank, rank);
    }

    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      const c = base + (i + 1) * 2;
      indices.push(a, a + 1, c, a + 1, c + 1, c);
    }

    const tip = base + (segments + 1) * 2;
    positions.push(rootX, 1.03, rootZ);
    const tipNormal = new THREE.Vector3(-dirX, 0.16 - bend * 0.18, -dirZ).normalize();
    normals.push(tipNormal.x, tipNormal.y, tipNormal.z);
    colors.push(1, 1, 0.88);
    uvs.push(0.5, 1);
    ranks.push(rank);
    const last = base + segments * 2;
    indices.push(last, last + 1, tip);
    base = tip + 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aGrassBladeRank", new THREE.Float32BufferAttribute(ranks, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A dense grass silhouette without dense geometry: every blade is one narrow,
 * pointed triangle. The tip leans in the authored blade plane, then the shared
 * material adds wind/trample deformation. Compared with a segmented ribbon this
 * puts several times more distinct blades on screen for fewer submitted
 * triangles, and the pointed outline never turns into the old rectangular board.
 */
export function createMicroBladeClusterGeometry({
  blades,
  width,
  radius,
  lean
}: {
  blades: number;
  width: number;
  radius: number;
  lean: number;
}): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const ranks: number[] = [];
  const indices: number[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let blade = 0; blade < blades; blade++) {
    const rank = bladeRank(blade);
    const yaw = blade * goldenAngle + rank * 1.73;
    const rootAngle = yaw + 1.19 + rank * 2.1;
    const rootRadius = radius * Math.sqrt((blade + 0.35) / Math.max(1, blades));
    const rootX = Math.cos(rootAngle) * rootRadius;
    const rootZ = Math.sin(rootAngle) * rootRadius;
    const dirX = Math.cos(yaw);
    const dirZ = Math.sin(yaw);
    const sideX = -dirZ;
    const sideZ = dirX;
    const bladeWidth = width * (0.78 + rank * 0.38);
    const halfWidth = bladeWidth * 0.5;
    const bladeLean = lean * (0.68 + rank * 0.5);

    const left = new THREE.Vector3(rootX - sideX * halfWidth, 0, rootZ - sideZ * halfWidth);
    const right = new THREE.Vector3(rootX + sideX * halfWidth, 0, rootZ + sideZ * halfWidth);
    const tip = new THREE.Vector3(rootX + dirX * bladeLean, 1.03, rootZ + dirZ * bladeLean);
    const normal = new THREE.Vector3()
      .subVectors(right, left)
      .cross(new THREE.Vector3().subVectors(tip, left))
      .normalize();
    const base = positions.length / 3;

    positions.push(left.x, left.y, left.z, right.x, right.y, right.z, tip.x, tip.y, tip.z);
    normals.push(normal.x, normal.y, normal.z, normal.x, normal.y, normal.z, normal.x, normal.y, normal.z);
    colors.push(0.56, 0.56, 0.72, 0.56, 0.56, 0.72, 1, 1, 0.88);
    uvs.push(0, 0, 1, 0, 0.5, 1);
    ranks.push(rank, rank, rank);
    indices.push(base, base + 1, base + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aGrassBladeRank", new THREE.Float32BufferAttribute(ranks, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** The shared grass material: SSS blades, wind sway (shared envelope), and
 *  trample against the shared displacer field. Instances carry a compact
 *  position/yaw vec4, shape/wind/fade vec4, and normalized RGBA tint. The
 *  position graph reconstructs the transform explicitly and keeps all wind,
 *  interaction, and anchor-fade operations in their declared coordinate space. */
export function createGrassMaterial(options: GrassMaterialOptions = {}): GrassMaterialState {
  const mat = new THREE.MeshSSSNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.roughness = 0.94;
  mat.metalness = 0;

  const focus = new THREE.Vector2(1e6, 1e6);
  const focusU = uniform(focus);
  const tint = attribute("aGrassColor", "vec4") as TslNode;
  const transform = attribute("aGrassTransform", "vec4") as TslNode; // anchorXYZ, yaw
  const shape = attribute("aGrassShape", "vec4") as TslNode; // spread, height, windAmp, fadeRadius
  const bladeT = positionGeometry.y.clamp(0, 1);
  const rootAo = bladeT.smoothstep(0, 0.34).mul(0.46).add(0.54);
  const grassRoot = color(0x1f4f1c);
  const grassTip = color(0x8cbd45);
  mat.colorNode = mix(grassRoot, grassTip, bladeT.pow(0.82)).mul(tint.xyz).mul(rootAo);

  const fadeRadius = shape.w.max(1);
  const anchorLocal = transform.xyz;
  const anchorWorld = instanceAnchorWorld(anchorLocal);
  const dist = anchorWorld.xz.sub(focusU).length();
  const rankFade = options.fadeMode === "rank";
  const fadeBand = rankFade
    ? float(Math.max(1, Number(options.fadeBand ?? 12)))
    : fadeRadius.mul(GRASS_FADE_BAND).max(1);
  const fade = fadeRadius.sub(dist).div(fadeBand).clamp(0, 1);

  // A moving field must not visibly sink into the floor. Streamed layers use a
  // deterministic rank carried by the instance byte plus a constant rank on
  // each authored blade. Coverage removes whole full-height blades in a broad,
  // spatially staggered band; no screen-space dither crawls while wind moves.
  let deformationFade: TslNode = fade;
  if (rankFade) {
    const authoredRank = attribute("aGrassBladeRank", "float") as TslNode;
    const stableRank = tint.w.mul(0.754877666).add(authoredRank).fract().mul(0.996).add(0.002);
    mat.opacityNode = step(stableRank, fade);
    mat.alphaTestNode = float(0.5);
    deformationFade = float(1);
  }

  // Compact instance transform: position/rotation + shape replace a 16-float
  // matrix. This is 36 bytes/cluster including normalized RGBA, down from 96.
  const yawCos = cos(transform.w);
  const yawSin = sin(transform.w);
  const source = positionGeometry as TslNode;
  const shaped = vec3(source.x.mul(shape.x), source.y.mul(shape.y), source.z.mul(shape.x));
  const placed = vec3(
    shaped.x.mul(yawCos).sub(shaped.z.mul(yawSin)).add(anchorLocal.x),
    shaped.y.add(anchorLocal.y),
    shaped.x.mul(yawSin).add(shaped.z.mul(yawCos)).add(anchorLocal.z)
  );
  const scaled = rankFade ? placed : fadeAroundInstanceAnchor(placed, anchorLocal, fade);

  // Trample: accumulate world-space push away from each displacer plus a
  // "crush" factor that flattens blades and damps their wind response.
  const interactionSlots = Math.max(0, Math.min(MAX_DISPLACERS, Math.floor(options.interactionSlots ?? MAX_DISPLACERS)));
  const trampleAccum = interactionSlots > 0
    ? (Fn(() => {
      const push = vec2(0).toVar();
      const crush = float(0).toVar();
      Loop(interactionSlots, ({ i }: { i: TslNode }) => {
        const d = (DISPLACERS as TslNode).element(i);
        const delta = anchorWorld.xz.sub(d.xy);
        const len = delta.length().max(1e-4);
        const infl = d.z.sub(len).div(d.z.max(1e-4)).clamp(0, 1);
        const s = infl.mul(infl).mul(d.w);
        push.addAssign(delta.div(len).mul(s));
        crush.addAssign(s);
      });
      return vec3(push, crush);
    }) as TslNode)()
    : vec3(0);
  const push = trampleAccum.xy;
  const crush = trampleAccum.z;
  const crushed = crush.min(1);
  const pushLen = push.length();
  const pushXZ = push.mul(pushLen.min(1).div(pushLen.max(1e-4))).mul(0.85);
  const trampleT: TslNode = bladeT.pow(1.35).mul(deformationFade);
  const trampleWorld = vec3(pushXZ.x, crushed.mul(-0.42), pushXZ.y).mul(trampleT);
  const localTrample = worldOffsetToModelLocal(trampleWorld);

  const windDamp = float(1).sub(crushed.mul(0.75));
  // Near/hero grass rides the swirling flow field (direction varies across the
  // meadow); the cheap "lite" distance grade keeps the single prevailing heading.
  const flowXZ = options.wind === "lite"
    ? vec2(WIND_DIR.x, WIND_DIR.z).mul(groundSwayLite(anchorWorld.xz))
    : groundSwayFlow(anchorWorld.xz);
  const bendWorld = vec3(flowXZ.x, 0, flowXZ.y)
    .mul(shape.z)
    .mul(bladeT.pow(2.05).mul(deformationFade))
    .mul(windDamp);
  const bendLocal = worldOffsetToModelLocal(bendWorld);
  mat.positionNode = scaled.add(bendLocal).add(localTrample);

  // Rotate the authored blade-plane normal by the compact instance yaw, then
  // lean it with the same world-space deformation used by the vertex. This
  // preserves rolling highlights and backlighting instead of forcing every
  // blade to a camera-space up normal.
  const sourceNormal = vec3(
    normalGeometry.x.div(shape.x.max(1e-4)),
    normalGeometry.y.div(shape.y.max(1e-4)),
    normalGeometry.z.div(shape.x.max(1e-4))
  );
  const rotatedNormal = vec3(
    sourceNormal.x.mul(yawCos).sub(sourceNormal.z.mul(yawSin)),
    sourceNormal.y,
    sourceNormal.x.mul(yawSin).add(sourceNormal.z.mul(yawCos))
  );
  const normalWorld = normalize(modelNormalMatrix.mul(rotatedNormal));
  const normalView = cameraViewMatrix.mul(vec4(normalWorld, 0)).xyz;
  const deformView = cameraViewMatrix.mul(vec4(bendWorld.add(trampleWorld), 0)).xyz;
  mat.normalNode = normalize(normalView.sub(deformView.mul(bladeT.mul(0.3).add(0.08))));
  mat.thicknessColorNode = tint.y.mul(bladeT.mul(0.72).add(0.28)).mul(uniform(new THREE.Color(0.42, 0.68, 0.24)));
  mat.thicknessDistortionNode = uniform(0.38);
  mat.thicknessAmbientNode = uniform(0.08);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(5.0);
  mat.thicknessScaleNode = uniform(2.35);
  return { material: mat, focus };
}

/** An empty instanced grass mesh (static-usage buffers, sized to `capacity`).
 *  Grass never casts or receives shadows — overlapping blade tris × CSM was a
 *  foliage GPU outlier, and small-scale shadowing doesn't read on blades. */
export function createGrassMesh(
  name: string,
  capacity: number,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  _castShadow = false
): GrassMesh {
  const instancedGeometry = new THREE.InstancedBufferGeometry();
  if (geometry.index) instancedGeometry.setIndex(geometry.index.clone());
  for (const [attributeName, sourceAttribute] of Object.entries(geometry.attributes)) {
    instancedGeometry.setAttribute(attributeName, sourceAttribute.clone());
  }
  for (const group of geometry.groups) instancedGeometry.addGroup(group.start, group.count, group.materialIndex);
  const mesh = new THREE.Mesh(instancedGeometry, material) as GrassMesh;
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  // StaticDrawUsage on purpose: r185 re-uploads DynamicDrawUsage buffers every
  // frame regardless of version; static + needsUpdate uploads only on rewrite.
  const transformAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  transformAttr.setUsage(THREE.StaticDrawUsage);
  const shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  shapeAttr.setUsage(THREE.StaticDrawUsage);
  // RGB is a normalized linear tint; alpha remains available for future masks.
  const colorAttr = new THREE.InstancedBufferAttribute(new Uint8Array(capacity * 4), 4, true);
  colorAttr.setUsage(THREE.StaticDrawUsage);
  mesh.geometry.setAttribute("aGrassTransform", transformAttr);
  mesh.geometry.setAttribute("aGrassShape", shapeAttr);
  mesh.geometry.setAttribute("aGrassColor", colorAttr);
  mesh.geometry.instanceCount = 0;
  // Keep empty pools out of the render list. WebGPU otherwise still builds a
  // node-material pipeline for a zero-instance draw during world arrival.
  mesh.visible = false;
  mesh.userData.grassCapacity = capacity;
  mesh.userData.grassLastCount = 0;
  return mesh;
}

export function grassMeshCapacity(mesh: GrassMesh): number {
  return Number(mesh.userData.grassCapacity) || 0;
}

export function grassMeshCount(mesh: GrassMesh): number {
  return Number.isFinite(mesh.geometry.instanceCount) ? mesh.geometry.instanceCount : 0;
}

export function setGrassMeshCount(mesh: GrassMesh, count: number) {
  const nextCount = Math.max(0, Math.min(grassMeshCapacity(mesh), Math.floor(count)));
  mesh.geometry.instanceCount = nextCount;
  mesh.visible = nextCount > 0;
}

/** Set a conservative local-space bound after placement so tiles can cull. */
export function setGrassMeshBounds(mesh: GrassMesh, entries: readonly GrassEntry[], padding = 2) {
  if (entries.length === 0) {
    mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    return;
  }
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const entry of entries) {
    point.set(entry.x, entry.y + entry.height * 0.5, entry.z);
    box.expandByPoint(point);
  }
  box.expandByScalar(Math.max(0, padding));
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  mesh.geometry.boundingSphere = sphere;
}

/** Write a bounded range without publishing the instance count. Streaming
 *  builders use this to keep large buffer fills inside their frame slice. */
export function writeGrassMeshRange(
  mesh: GrassMesh,
  entries: readonly GrassEntry[],
  fadeRadius: number,
  start = 0,
  end = entries.length
) {
  const capacity = grassMeshCapacity(mesh);
  const from = Math.max(0, Math.min(capacity, Math.floor(start)));
  const to = Math.max(from, Math.min(capacity, entries.length, Math.floor(end)));
  const transformAttr = mesh.geometry.getAttribute("aGrassTransform") as THREE.InstancedBufferAttribute;
  const shapeAttr = mesh.geometry.getAttribute("aGrassShape") as THREE.InstancedBufferAttribute;
  const colorAttr = mesh.geometry.getAttribute("aGrassColor") as THREE.InstancedBufferAttribute;
  const transforms = transformAttr.array as Float32Array;
  const shapes = shapeAttr.array as Float32Array;
  const colors = colorAttr.array as Uint8Array;
  for (let i = from; i < to; i++) {
    const entry = entries[i];
    const offset = i * 4;
    transforms[offset] = entry.x;
    transforms[offset + 1] = entry.y;
    transforms[offset + 2] = entry.z;
    transforms[offset + 3] = entry.yaw;
    shapes[offset] = entry.spread;
    shapes[offset + 1] = entry.height;
    shapes[offset + 2] = entry.windAmp;
    shapes[offset + 3] = fadeRadius;
    colors[offset] = Math.round(THREE.MathUtils.clamp(entry.color.r, 0, 1) * 255);
    colors[offset + 1] = Math.round(THREE.MathUtils.clamp(entry.color.g, 0, 1) * 255);
    colors[offset + 2] = Math.round(THREE.MathUtils.clamp(entry.color.b, 0, 1) * 255);
    // Stable per-instance fade rank in the byte that was previously unused.
    // Integer hashing avoids large-world floating-point drift and remains
    // deterministic across refreshes, tile sizes, and additive render layers.
    let rankHash = (
      Math.imul(Math.round(entry.x * 100), 374761393) +
      Math.imul(Math.round(entry.z * 100), 668265263) +
      Math.imul(Math.round(entry.yaw * 1000), 2246822519)
    ) | 0;
    rankHash = Math.imul(rankHash ^ (rankHash >>> 15), 2246822519);
    rankHash = Math.imul(rankHash ^ (rankHash >>> 13), 3266489917);
    rankHash ^= rankHash >>> 16;
    colors[offset + 3] = 1 + ((rankHash >>> 0) % 254);
  }
}

/** Publish a completed compact-buffer write atomically. */
export function finishGrassMeshWrite(mesh: GrassMesh, count: number) {
  const finalCount = Math.max(0, Math.min(grassMeshCapacity(mesh), Math.floor(count)));
  const transformAttr = mesh.geometry.getAttribute("aGrassTransform") as THREE.InstancedBufferAttribute;
  const shapeAttr = mesh.geometry.getAttribute("aGrassShape") as THREE.InstancedBufferAttribute;
  const colorAttr = mesh.geometry.getAttribute("aGrassColor") as THREE.InstancedBufferAttribute;
  mesh.userData.grassLastCount = finalCount;
  setGrassMeshCount(mesh, finalCount);
  transformAttr.needsUpdate = true;
  shapeAttr.needsUpdate = true;
  colorAttr.needsUpdate = true;
}

/** Write `entries` into the compact transform/shape/color buffers.
 *  `fadeRadius` is the field radius the blades fade toward. */
export function writeGrassMesh(mesh: GrassMesh, entries: GrassEntry[], fadeRadius: number) {
  const count = Math.min(entries.length, grassMeshCapacity(mesh));
  writeGrassMeshRange(mesh, entries, fadeRadius, 0, count);
  finishGrassMeshWrite(mesh, count);
}
