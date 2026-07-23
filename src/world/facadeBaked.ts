import * as THREE from "three/webgpu";
import {
  positionWorld,
  normalWorldGeometry,
  cameraPosition,
  float,
  vec2,
  color,
  mix,
  step,
  smoothstep,
  fract,
  floor,
  abs,
  hash,
  texture,
  uint,
  mod,
  dot,
  normalize
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { loadTexture } from "../render/textures";
import { bumpNormal } from "./tslUtil";

type N = any;

const FLOOR_H = 3.7;
const COL_W = 3.35;
const ATLAS_GRID = 2;
const ATLAS_GUTTER_UV = 8 / 1024;
const ATLAS_CONTENT_UV = 496 / 1024;

let facadeColorTexture: THREE.Texture | null = null;
let facadeSurfaceTexture: THREE.Texture | null = null;
let facadeTexturePromise: Promise<void> | null = null;

/**
 * Buildings belong to the immediate starting world, so the two small atlases
 * are boot fundamentals. They must be ready before the first facade node graph
 * is assembled because TSL texture nodes hold the concrete Texture objects.
 */
export function prepareFacadeTextures(): Promise<void> {
  if (facadeColorTexture && facadeSurfaceTexture) return Promise.resolve();
  if (!facadeTexturePromise) {
    facadeTexturePromise = Promise.all([
      loadTexture("/building-facades/facade-color", {
        srgb: true,
        anisotropy: 8
      }),
      loadTexture("/building-facades/facade-surface", {
        srgb: false,
        anisotropy: 8
      })
    ])
      .then(([colorTexture, surfaceTexture]) => {
        for (const textureAsset of [colorTexture, surfaceTexture]) {
          textureAsset.wrapS = THREE.ClampToEdgeWrapping;
          textureAsset.wrapT = THREE.ClampToEdgeWrapping;
          textureAsset.needsUpdate = true;
        }
        facadeColorTexture = colorTexture;
        facadeSurfaceTexture = surfaceTexture;
      })
      .catch((error: unknown) => {
        facadeTexturePromise = null;
        throw new Error("Unable to load the baked building facade atlases", { cause: error });
      });
  }
  return facadeTexturePromise;
}

const cellHash = (key: N, k: number): N => hash(key.add(uint(k)));

/**
 * Four GPT-image-authored facade families replace the old fragment-time brick,
 * weather, frame, glass, and roughness synthesis. The remaining math only
 * projects a stable cell UV and preserves dynamic night occupancy.
 */
export function bakedFacadeSurface(opts: {
  baseTone: N;
  bid: N;
  baseY: N;
  topRel?: N;
  litWindows: boolean;
  litScale?: N;
  detail?: boolean;
  frame?: { pos: N; nrm: N };
  windowGlowW: N;
}) {
  if (!facadeColorTexture || !facadeSurfaceTexture) {
    throw new Error("prepareFacadeTextures() must resolve before facade materials are created");
  }

  const { baseTone, bid, baseY, litWindows } = opts;
  const detail = opts.detail !== false;
  const p = opts.frame ? opts.frame.pos : positionWorld;
  const n = opts.frame ? opts.frame.nrm : normalWorldGeometry;
  const dist = positionWorld.distance(cameraPosition);
  const wallMask = smoothstep(0.62, 0.4, abs(n.y));
  const across = p.x.mul(n.z).sub(p.z.mul(n.x));
  const rel = p.y.sub(baseY);
  const rowCoord = rel.div(FLOOR_H);
  const colCoord = across.div(COL_W);
  const fRow = fract(rowCoord);
  const fCol = fract(colCoord);

  const family = floor(hash(bid.add(101)).mul(ATLAS_GRID * ATLAS_GRID));
  const atlasUv = vec2(
    mod(family, ATLAS_GRID)
      .mul(1 / ATLAS_GRID)
      .add(ATLAS_GUTTER_UV)
      .add(fCol.mul(ATLAS_CONTENT_UV)),
    floor(family.div(ATLAS_GRID))
      .mul(1 / ATLAS_GRID)
      .add(ATLAS_GUTTER_UV)
      .add(fRow.mul(ATLAS_CONTENT_UV))
  );
  const baked = texture(facadeColorTexture, atlasUv);
  const buildingBrightness = hash(bid.add(223)).mul(0.12).add(0.94);
  const authoredColor = mix(baked.rgb.mul(buildingBrightness), baseTone, 0.12);
  const surface = mix(baseTone, authoredColor, wallMask);

  // Alpha stores inverse glass coverage, keeping opaque-wall RGB intact through
  // lossy WebP encoding. Incomplete roof rows never glow.
  const rowFits = opts.topRel
    ? step(floor(rowCoord).add(1).mul(FLOOR_H), opts.topRel.sub(0.45))
    : float(1);
  const pane = baked.a.oneMinus().mul(wallMask).mul(rowFits);
  const cellKey = uint(floor(colCoord).add(1 << 16))
    .mul(uint(73856093))
    .bitXor(uint(floor(rowCoord).add(1 << 16)).mul(uint(19349663)))
    .bitXor(uint(bid.add(7)).mul(uint(83492791)))
    .toVar();
  let lit: N = litWindows ? step(0.8, cellHash(cellKey, 3)) : float(0);
  if (litWindows && opts.litScale) lit = lit.mul(opts.litScale);

  const warmLight = mix(color(0xffb845), color(0xffe49c), cellHash(cellKey, 4));
  const coolLight = mix(color(0xdfe8ff), color(0x9fb6ff), cellHash(cellKey, 5));
  const lightColor = mix(warmLight, coolLight, step(0.88, cellHash(cellKey, 6)));
  const facing = dot(normalize(p.sub(cameraPosition)), n).negate();
  const glowGraze = smoothstep(0.01, 0.06, facing);
  const emissive = litWindows
    ? lightColor.mul(lit).mul(pane).mul(2.0 * LIGHT_SCALE).mul(glowGraze).mul(opts.windowGlowW)
    : color(0x000000);

  // Far per-tile materials stop after the color/alpha sample. The batched and
  // near paths add one packed linear lookup for roughness and subtle relief.
  let roughness: N = mix(float(0.93), float(0.18), pane);
  let normalNode: N = normalWorldGeometry;
  if (detail) {
    const bakedSurface = texture(facadeSurfaceTexture, atlasUv);
    roughness = mix(float(0.93), bakedSurface.g, wallMask);
    const relief = bakedSurface.r
      .sub(0.5)
      .mul(0.055)
      .mul(wallMask)
      .mul(smoothstep(240.0, 40.0, dist));
    normalNode = bumpNormal(relief);
  }

  return {
    colorNode: surface,
    roughnessNode: roughness,
    metalnessNode: float(0),
    emissiveNode: emissive,
    normalNode
  };
}
