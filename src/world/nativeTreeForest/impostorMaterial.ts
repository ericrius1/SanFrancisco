import * as THREE from "three/webgpu";
import {
  atan, attribute, cameraPosition, float, instanceIndex, mix, texture,
  transformNormalToView, uniform, vec2, vec3, vertexStage
} from "three/tsl";
import { instanceAnchorWorld, worldOffsetToModelLocal } from "../groundcover/instanceDeform";
import { applyGroundcoverAtmosphere } from "../groundcover/foliageAtmosphere";
import { foliageBrightness } from "../vegetation/appearance";
import type { NativeTreeStyle } from "../vegetation/nativeTreeRecipes";
import type { NativeTreeIndirectSource } from "../vegetation/nativeTreeMaterials";
import type { NativeTreeImpostor } from "./nativeGeometry";
import { TREE_IMPOSTOR_ELEVATIONS, TREE_IMPOSTOR_PADDING, TREE_IMPOSTOR_TILE, TREE_IMPOSTOR_YAWS } from "./impostorBake";

type N = any;

/** One dynamically lit, capture-shaped billboard for the entire distant tree. */
export function createTreeImpostorMaterial(
  style: NativeTreeStyle,
  impostor: NativeTreeImpostor,
  source: NativeTreeIndirectSource
): THREE.MeshLambertNodeMaterial {
  const material = new THREE.MeshLambertNodeMaterial();
  material.name = "native-tree:impostor:indirect";
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTest = 0;
  material.alphaToCoverage = false;
  material.dithering = false;
  const index = (source.visibleIndices.element(instanceIndex) as N).toVar();
  const root: N = source.root.element(index).toVar();
  const yaw: N = source.yaw.element(index).toVar();
  const center: N = uniform(new THREE.Vector3(...impostor.center));
  const size: N = uniform(new THREE.Vector2(...impostor.size));
  const localCenter = vec3(
    center.x.mul(yaw.y).add(center.z.mul(yaw.x)), center.y,
    center.z.mul(yaw.y).sub(center.x.mul(yaw.x))
  ).mul(root.w).add(root.xyz);
  const worldCenter = instanceAnchorWorld(localCenter);
  const direction: N = (cameraPosition as N).sub(worldCenter).normalize().toVar();
  const horizontalLength = direction.xz.length();
  const horizontal = horizontalLength.max(0.0001);
  // Looking exactly down is well-defined too (the epsilon only fixes the pole).
  const right = horizontalLength.lessThan(0.0001).select(vec3(1, 0, 0),
    vec3(direction.z.div(horizontal), 0, direction.x.negate().div(horizontal)));
  const up = direction.cross(right).normalize();
  const projectedHeight = size.y.mul(horizontal).add(size.x.mul(direction.y.abs()));
  // Resolve the viewing direction in authored-tree coordinates, before yaw.
  const localDirection = vec3(
    direction.x.mul(yaw.y).sub(direction.z.mul(yaw.x)), direction.y,
    direction.z.mul(yaw.y).add(direction.x.mul(yaw.x))
  );
  const angle: N = atan(localDirection.x, localDirection.z).div(Math.PI * 2).add(1).fract().mul(TREE_IMPOSTOR_YAWS);
  const elevation: N = atan(localDirection.y.max(0), horizontal).div(Math.PI * 0.5).mul(TREE_IMPOSTOR_ELEVATIONS - 1);
  const hulls: N[] = Array.from({ length: TREE_IMPOSTOR_ELEVATIONS }, (_, i) => attribute(`aHull${i}`, "vec2"));
  let supports: N = hulls[TREE_IMPOSTOR_ELEVATIONS - 1];
  for (let row = TREE_IMPOSTOR_ELEVATIONS - 2; row >= 0; row--) {
    supports = elevation.lessThan(row + 1).select(hulls[row].max(hulls[row + 1]), supports);
  }
  const planes: N = attribute("aHullPlanes", "vec4");
  const hullPosition = vec2(planes.x.mul(supports.x).add(planes.y.mul(supports.y)),
    planes.z.mul(supports.x).add(planes.w.mul(supports.y)));
  const billboardUv: N = vertexStage(hullPosition.add(0.5));
  // Match the capture padding while retaining only the silhouette hull.
  const billboardOffset = right.mul(hullPosition.x.mul(size.x))
    .add(up.mul(hullPosition.y.mul(projectedHeight))).mul(root.w).mul(TREE_IMPOSTOR_TILE / (TREE_IMPOSTOR_TILE - TREE_IMPOSTOR_PADDING * 2));
  material.positionNode = localCenter.add(worldOffsetToModelLocal(billboardOffset));

  // Dense angle captures keep changes small (22.5° yaw, 15° elevation).
  // Stable per-tree thresholds distribute changes across a stand without
  // fragment-level frame scatter, which defeats texture-cache locality.
  const angularThreshold = yaw.z.mul(0.16).add(0.42);
  const frame: N = vertexStage(vec2(angle.add(angularThreshold).floor().mod(TREE_IMPOSTOR_YAWS),
    elevation.add(angularThreshold).floor().min(TREE_IMPOSTOR_ELEVATIONS - 1)));
  const y: N = vertexStage(yaw);
  const sampleUv = frame.add(billboardUv).div(vec2(TREE_IMPOSTOR_YAWS, TREE_IMPOSTOR_ELEVATIONS));
  const texel: N = (texture(impostor.color, sampleUv) as N).toVar();
  const coverage: N = texel.a;
  // NodeMaterial evaluates maskNode before diffuse colour, normal decoding and
  // lighting. Empty silhouette fragments pay only for view selection and one
  // atlas read; alphaTest would run after the entire albedo graph instead.
  material.maskNode = coverage.greaterThan(0.2);
  const oct = texel.rg.mul(2).sub(1);
  const nz = float(1).sub(oct.x.abs()).sub(oct.y.abs());
  const fold = nz.negate().max(0);
  const normal: N = vec3(oct.x.add(oct.x.greaterThanEqual(0).select(fold.negate(), fold)),
    oct.y.add(oct.y.greaterThanEqual(0).select(fold.negate(), fold)), nz).normalize().toVar();
  const packed = texel.b.mul(255).round();
  const isLeaf = packed.greaterThanEqual(128).select(1, 0);
  const palette = packed.mod(128).div(127);
  const foliagePalette = palette.mul(0.58).add(y.z.mul(0.42)).clamp(0, 1);
  const foliageColor = mix(uniform(new THREE.Color(style.foliageColor)), uniform(new THREE.Color(style.foliageAccent)), foliagePalette);
  const barkColor = mix(uniform(new THREE.Color(style.barkColor)), uniform(new THREE.Color(style.barkAccent)), palette);
  const leaf = mix(foliageColor, uniform(new THREE.Color(0x9a7138)), y.w.clamp(0, 1).mul(0.52))
    .mul(impostor.foliageOpening).mul(foliageBrightness as N);
  const bark = mix(barkColor, uniform(new THREE.Color(0x7e6447)), y.w.clamp(0, 1).mul(0.24));
  const albedo = mix(bark, leaf, isLeaf);
  material.colorNode = albedo;
  (material as N).emissiveNode = albedo.mul(isLeaf).mul(0.012);
  const rotated = vec3(
    normal.x.mul(y.y).add(normal.z.mul(y.x)), normal.y,
    normal.z.mul(y.y).sub(normal.x.mul(y.x))
  );
  material.normalNode = transformNormalToView(rotated).normalize();
  applyGroundcoverAtmosphere(material);
  return material;
}
