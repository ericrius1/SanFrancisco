import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  color,
  float,
  materialReference,
  mix,
  normalLocal,
  normalMap,
  positionLocal,
  texture,
  uniform,
  vec2,
  vec3
} from "three/tsl";
import { instanceAnchorWorld, worldOffsetToModelLocal } from "../groundcover/instanceDeform";
import { groundSway, groundSwayLite, WIND_DIR } from "../groundcover/sway";
import { foliageBrightness } from "./appearance";
import type { NativeTreeStyle } from "./nativeTreeRecipes";
import type { NativeTreeMaterialAssets } from "./nativeTreeAssets";

type N = any;

type NativeTreeStyleNodes = Readonly<{
  foliageColor: N;
  foliageAccent: N;
  barkColor: N;
  barkAccent: N;
  windAmplitude: N;
  windGrade: N;
}>;

export const NATIVE_TREE_MATERIAL_GRADES = ["near", "mid", "far", "horizon"] as const;
export type NativeTreeMaterialGrade = typeof NATIVE_TREE_MATERIAL_GRADES[number];
export type NativeTreeMaterialTuple = readonly [
  near: THREE.Material,
  mid: THREE.Material,
  far: THREE.Material,
  horizon: THREE.Material
];

export type NativeTreeMaterials = Readonly<{
  /** Fixed order: near, mid, far, horizon. */
  branch: NativeTreeMaterialTuple;
  /** Fixed order: near, mid, far, horizon. */
  foliage: NativeTreeMaterialTuple;
  forGrade(grade: NativeTreeMaterialGrade): Readonly<{ branch: THREE.Material; foliage: THREE.Material }>;
  /** Disposes material/pipeline state only. Shared texture assets stay leased by the forest. */
  dispose(): void;
}>;

const GRADE_INDEX: Readonly<Record<NativeTreeMaterialGrade, number>> = Object.freeze({
  near: 0,
  mid: 1,
  far: 2,
  horizon: 3
});

const WIND_BY_GRADE = [1, 0.76, 0.34, 0.08] as const;
const DRY_FOLIAGE = color(0x9a7138);
const DRY_BARK = color(0x7e6447);

function literalStyleNodes(style: NativeTreeStyle, gradeIndex: number): NativeTreeStyleNodes {
  return {
    foliageColor: color(style.foliageColor),
    foliageAccent: color(style.foliageAccent),
    barkColor: color(style.barkColor),
    barkAccent: color(style.barkAccent),
    windAmplitude: float(style.windAmplitude),
    windGrade: float(WIND_BY_GRADE[gradeIndex])
  };
}

// The landscape/horizon shaders are intentionally species-agnostic. Their
// values still come from each material, but sharing these node identities keeps
// style differences out of WGSL and lets all designs reuse the same WebGPU
// NodeBuilder state and pipeline per fixed LOD grade.
const silhouetteStyleNodes: NativeTreeStyleNodes = Object.freeze({
  foliageColor: materialReference("nativeTreeFoliageColor", "color"),
  foliageAccent: materialReference("nativeTreeFoliageAccent", "color"),
  barkColor: materialReference("nativeTreeBarkColor", "color"),
  barkAccent: materialReference("nativeTreeBarkAccent", "color"),
  windAmplitude: materialReference("nativeTreeWindAmplitude", "float"),
  windGrade: materialReference("nativeTreeWindGrade", "float")
});

function applySilhouetteStyle(
  material: THREE.Material,
  style: NativeTreeStyle,
  gradeIndex: 2 | 3
): void {
  const target = material as N;
  target.nativeTreeFoliageColor = new THREE.Color(style.foliageColor);
  target.nativeTreeFoliageAccent = new THREE.Color(style.foliageAccent);
  target.nativeTreeBarkColor = new THREE.Color(style.barkColor);
  target.nativeTreeBarkAccent = new THREE.Color(style.barkAccent);
  target.nativeTreeWindAmplitude = style.windAmplitude;
  target.nativeTreeWindGrade = WIND_BY_GRADE[gradeIndex];
}

function treeInstanceNodes(): Readonly<{
  root: N;
  yaw: N;
  rootWorld: N;
}> {
  // Both attributes are StorageInstancedBufferAttributes at runtime, staying
  // in two aligned vec4 slots and comfortably under default WebGPU limits.
  const root: N = attribute("aTreeRoot", "vec4"); // local xyz, uniform scale
  const yaw: N = attribute("aTreeYaw", "vec4"); // sin, cos, palette, dryness
  return { root, yaw, rootWorld: instanceAnchorWorld(root.xyz) };
}

/** Recreates the instance matrix's Y rotation + uniform scale for a raw anchor attribute. */
function foliageAnchorLocal(anchor: N, root: N, yaw: N): N {
  const rotated = vec3(
    anchor.x.mul(yaw.y).add(anchor.z.mul(yaw.x)),
    anchor.y,
    anchor.z.mul(yaw.y).sub(anchor.x.mul(yaw.x))
  );
  return root.xyz.add(rotated.mul(root.w));
}

/**
 * Applies the native tree's named instance attributes without Three's
 * object-captured InstancedMesh node. Keeping this transform structural makes
 * every chunk expose the same WebGPU vertex layout, so NodeBuilder and pipeline
 * state can be reused while each render object still binds its own buffers.
 */
const nativeInstancePosition = Fn(([position, root, yaw]: N[]) => {
  const sourceNormal: N = normalLocal;
  const rotatedNormal = vec3(
    sourceNormal.x.mul(yaw.y).add(sourceNormal.z.mul(yaw.x)),
    sourceNormal.y,
    sourceNormal.z.mul(yaw.y).sub(sourceNormal.x.mul(yaw.x))
  );
  sourceNormal.assign(rotatedNormal.normalize());
  return foliageAnchorLocal(position, root, yaw);
});

function phaseOffset(phase: N): N {
  return vec2(phase.sin(), phase.cos()).mul(1.7);
}

/**
 * Native instance placement and wind both happen in this position node. The
 * world-space wind vector is transformed back through the mesh-world inverse
 * (w=0) before being added to the named-attribute placement.
 */
function branchPositionNode(style: NativeTreeStyleNodes, gradeIndex: number): N {
  const { root, yaw, rootWorld } = treeInstanceNodes();
  const wind: N = attribute("aTreeWind", "vec4"); // phase, bend, height01, level01
  const shared = gradeIndex === 0 ? groundSway(rootWorld.xz) : groundSwayLite(rootWorld.xz);
  // Every point at a branch junction receives the same height-based offset.
  // This keeps the flattened hierarchy welded without cumulative phase data.
  const trunkBend = shared.mul(wind.z.clamp(0, 1).pow(1.65)).mul(0.24);
  const windWorld = vec3(WIND_DIR.x, 0, WIND_DIR.z)
    .mul(trunkBend)
    .mul(style.windAmplitude.mul(style.windGrade))
    .mul(float(1).sub(yaw.w.clamp(0, 1).mul(0.14)));
  return nativeInstancePosition(positionLocal, root, yaw).add(worldOffsetToModelLocal(windWorld));
}

function foliagePositionNode(style: NativeTreeStyleNodes, gradeIndex: number): N {
  const { root, yaw, rootWorld } = treeInstanceNodes();
  const anchor: N = attribute("aTreeAnchor", "vec3");
  const wind: N = attribute("aTreeWind", "vec4"); // phase, stiffness, height01, leaf tip weight
  const anchorWorld = instanceAnchorWorld(foliageAnchorLocal(anchor, root, yaw));
  const shared = gradeIndex === 0 ? groundSway(rootWorld.xz) : groundSwayLite(rootWorld.xz);
  const baseSway = shared
    .mul(wind.z.clamp(0, 1).pow(1.65))
    .mul(0.24);
  const compliance = float(1).div(wind.y.max(0.12).mul(1.35));
  const leafSway = (gradeIndex === 3
    ? float(0)
    : groundSwayLite(anchorWorld.xz.add(phaseOffset(wind.x))))
    .mul(wind.w.clamp(0, 1).pow(1.55))
    .mul(compliance)
    .mul(0.11);
  const windWorld = vec3(WIND_DIR.x, 0, WIND_DIR.z)
    .mul(baseSway.add(leafSway))
    .mul(style.windAmplitude.mul(style.windGrade))
    .mul(float(1).sub(yaw.w.clamp(0, 1).mul(0.12)));
  return nativeInstancePosition(positionLocal, root, yaw).add(worldOffsetToModelLocal(windWorld));
}

function packedNormalNode(surfaceSample: N, strength: number): N {
  // NormalRGPacking decodes rg from [0,1] to [-1,1] and reconstructs +Z as
  // sqrt(max(0, 1-dot(xy,xy))). B/A remain free for roughness/translucency.
  const node: N = normalMap(surfaceSample, vec2(strength));
  node.unpackNormalMode = THREE.NormalRGPacking;
  return node;
}

function foliageColorNode(style: NativeTreeStyleNodes, texel: N | null): N {
  const yaw: N = attribute("aTreeYaw", "vec4");
  const material: N = attribute("aTreeMaterial", "vec2"); // palette, crown opening
  const palette = material.x.mul(0.58).add(yaw.z.mul(0.42)).clamp(0, 1);
  const authored = mix(style.foliageColor, style.foliageAccent, palette);
  // The KTX2 map already carries species color. The authored palette provides
  // art direction as a restrained linear-space tint instead of double-darkening.
  const tint = mix(vec3(1), authored.mul(1.55), 0.38);
  const mapped = texel ? texel.rgb.mul(tint) : authored;
  const dry = yaw.w.clamp(0, 1);
  const opening = material.y.clamp(0, 1).mul(0.3).add(0.7);
  return mix(mapped, DRY_FOLIAGE, dry.mul(0.52)).mul(opening).mul(foliageBrightness as N);
}

function branchColorNode(style: NativeTreeStyleNodes, texel: N | null): N {
  const yaw: N = attribute("aTreeYaw", "vec4");
  const heightAndLevel: N = attribute("aTreeWind", "vec4");
  const authored = mix(
    style.barkColor,
    style.barkAccent,
    heightAndLevel.w.mul(0.44).add(heightAndLevel.z.mul(0.16)).clamp(0, 1)
  );
  const tint = mix(vec3(1), authored.mul(1.48), 0.44);
  const mapped = texel ? texel.rgb.mul(tint) : authored;
  return mix(mapped, DRY_BARK, yaw.w.clamp(0, 1).mul(0.24));
}

function configureCommon(material: THREE.Material, name: string): void {
  material.name = name;
  material.depthWrite = true;
  material.depthTest = true;
  material.transparent = false;
  material.dithering = true;
}

function texturedBranchMaterial(
  style: NativeTreeStyle,
  assets: NativeTreeMaterialAssets,
  gradeIndex: 0 | 1
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  configureCommon(material, `native-tree:${assets.id}:branch:${NATIVE_TREE_MATERIAL_GRADES[gradeIndex]}`);
  const styleNodes = literalStyleNodes(style, gradeIndex);
  const colorSample: N = texture(assets.barkColor);
  const surfaceSample: N = texture(assets.barkSurface);
  material.colorNode = branchColorNode(styleNodes, colorSample);
  material.normalNode = packedNormalNode(surfaceSample, gradeIndex === 0 ? 0.82 : 0.56);
  material.roughnessNode = surfaceSample.b.clamp(0.42, 1);
  material.metalnessNode = float(0);
  material.positionNode = branchPositionNode(styleNodes, gradeIndex);
  material.envMapIntensity = gradeIndex === 0 ? 0.58 : 0.42;
  return material;
}

const silhouetteBranchNodes = Object.freeze({
  color: branchColorNode(silhouetteStyleNodes, null),
  // Landscape and horizon use the same lightweight sway structure; their
  // exact 0.34/0.08 strengths are per-material uniforms.
  position: branchPositionNode(silhouetteStyleNodes, 2)
});

function cheapBranchMaterial(
  style: NativeTreeStyle,
  assets: NativeTreeMaterialAssets,
  gradeIndex: 2 | 3
): THREE.MeshLambertNodeMaterial {
  const material = new THREE.MeshLambertNodeMaterial();
  configureCommon(material, `native-tree:${assets.id}:branch:${NATIVE_TREE_MATERIAL_GRADES[gradeIndex]}`);
  applySilhouetteStyle(material, style, gradeIndex);
  material.colorNode = silhouetteBranchNodes.color;
  material.positionNode = silhouetteBranchNodes.position;
  return material;
}

function texturedFoliageMaterial(
  style: NativeTreeStyle,
  assets: NativeTreeMaterialAssets,
  gradeIndex: 0 | 1
): THREE.MeshSSSNodeMaterial {
  const material = new THREE.MeshSSSNodeMaterial();
  configureCommon(material, `native-tree:${assets.id}:foliage:${NATIVE_TREE_MATERIAL_GRADES[gradeIndex]}`);
  const styleNodes = literalStyleNodes(style, gradeIndex);
  material.side = assets.leafStyle.twoSided ? THREE.DoubleSide : THREE.FrontSide;
  material.shadowSide = THREE.DoubleSide;
  const colorSample: N = texture(assets.leafColor);
  const surfaceSample: N = texture(assets.leafSurface);
  const leafColor = foliageColorNode(styleNodes, colorSample);
  material.colorNode = leafColor;
  material.emissiveNode = leafColor.mul(gradeIndex === 0 ? 0.035 : 0.024);
  material.opacityNode = colorSample.a;
  // Texture generation preserves coverage through every mip at this exact
  // cutoff. Raising it at runtime would throw that coverage away and make
  // mid-distance crowns dissolve into isolated pixels.
  material.alphaTestNode = float(assets.leafStyle.alphaCutoff);
  material.normalNode = packedNormalNode(surfaceSample, gradeIndex === 0 ? 0.72 : 0.46);
  material.roughnessNode = surfaceSample.b.clamp(0.34, 1);
  material.metalnessNode = float(0);
  material.positionNode = foliagePositionNode(styleNodes, gradeIndex);
  const translucency = surfaceSample.a.mul(assets.leafStyle.translucency);
  material.thicknessColorNode = leafColor.mul(translucency).mul(gradeIndex === 0 ? 1 : 0.68);
  material.thicknessDistortionNode = uniform(gradeIndex === 0 ? 0.42 : 0.3);
  material.thicknessAmbientNode = uniform(gradeIndex === 0 ? 0.12 : 0.08);
  material.thicknessAttenuationNode = uniform(1);
  material.thicknessPowerNode = uniform(gradeIndex === 0 ? 4.2 : 5.2);
  material.thicknessScaleNode = uniform(gradeIndex === 0 ? 2.7 : 1.65);
  material.envMapIntensity = gradeIndex === 0 ? 0.46 : 0.3;
  return material;
}

const silhouetteFoliageNodes = Object.freeze({
  2: (() => {
    const leafColor = foliageColorNode(silhouetteStyleNodes, null);
    return Object.freeze({
      color: leafColor,
      emissive: leafColor.mul(0.12),
      position: foliagePositionNode(silhouetteStyleNodes, 2)
    });
  })(),
  3: (() => {
    const leafColor = foliageColorNode(silhouetteStyleNodes, null);
    return Object.freeze({
      color: leafColor,
      emissive: leafColor.mul(0.14),
      position: foliagePositionNode(silhouetteStyleNodes, 3)
    });
  })()
});

function landscapeFoliageMaterial(
  style: NativeTreeStyle,
  assets: NativeTreeMaterialAssets
): THREE.MeshLambertNodeMaterial {
  const gradeIndex = 2;
  const material = new THREE.MeshLambertNodeMaterial();
  configureCommon(material, `native-tree:${assets.id}:foliage:far`);
  applySilhouetteStyle(material, style, gradeIndex);
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;
  // At this distance each compiler shape is a whole foliage cluster. Keeping
  // it opaque gives a stable stylized crown, skips texture sampling/alpha
  // overdraw, and lets KTX2 detail remain genuinely close-range and on-demand.
  material.colorNode = silhouetteFoliageNodes[gradeIndex].color;
  (material as N).emissiveNode = silhouetteFoliageNodes[gradeIndex].emissive;
  material.positionNode = silhouetteFoliageNodes[gradeIndex].position;
  return material;
}

function horizonFoliageMaterial(
  style: NativeTreeStyle,
  assets: NativeTreeMaterialAssets
): THREE.MeshLambertNodeMaterial {
  const gradeIndex = 3;
  const material = new THREE.MeshLambertNodeMaterial();
  configureCommon(material, `native-tree:${assets.id}:foliage:horizon`);
  applySilhouetteStyle(material, style, gradeIndex);
  material.side = THREE.DoubleSide;
  // Native compiler silhouettes are real geometry, so the horizon grade needs
  // no texture or alpha overdraw at all.
  material.colorNode = silhouetteFoliageNodes[gradeIndex].color;
  // MeshLambertNodeMaterial inherits the common NodeMaterial emissive path at
  // runtime even though Three's declaration omits the field for this subclass.
  (material as N).emissiveNode = silhouetteFoliageNodes[gradeIndex].emissive;
  material.positionNode = silhouetteFoliageNodes[gradeIndex].position;
  return material;
}

/**
 * Builds the four fixed material grades for one compiled archetype. Texture
 * ownership remains with `loadNativeTreeMaterialSet`; this object owns only its
 * eight small material instances.
 */
export function createNativeTreeMaterials(
  style: NativeTreeStyle,
  assets: NativeTreeMaterialAssets
): NativeTreeMaterials {
  const branch: NativeTreeMaterialTuple = Object.freeze([
    texturedBranchMaterial(style, assets, 0),
    texturedBranchMaterial(style, assets, 1),
    cheapBranchMaterial(style, assets, 2),
    cheapBranchMaterial(style, assets, 3)
  ]);
  const foliage: NativeTreeMaterialTuple = Object.freeze([
    texturedFoliageMaterial(style, assets, 0),
    texturedFoliageMaterial(style, assets, 1),
    landscapeFoliageMaterial(style, assets),
    horizonFoliageMaterial(style, assets)
  ]);
  let disposed = false;
  return Object.freeze({
    branch,
    foliage,
    forGrade(grade: NativeTreeMaterialGrade) {
      const index = GRADE_INDEX[grade];
      return Object.freeze({ branch: branch[index], foliage: foliage[index] });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const material of [...branch, ...foliage]) material.dispose();
    }
  });
}
