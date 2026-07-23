import * as THREE from "three/webgpu";
import {
  attribute,
  positionLocal,
  positionView,
  cameraProjectionMatrix,
  modelPosition,
  modelScale,
  float,
  vec2,
  vec3,
  color,
  mix,
  step,
  hash,
  texture,
  textureLoad,
  textureSize,
  instanceIndex,
  drawIndex,
  ivec2,
  int,
  uniform,
  varying,
  Fn
} from "three/tsl";
import { cameraCutawayMask } from "../render/cameraCutaway";
import { buildingGrowAmount } from "../render/materialize";
import { bakedFacadeSurface } from "./facadeBaked";

export { prepareFacadeTextures } from "./facadeBaked";

/** Sky-driven lit-window weight: 0 in daylight → 1 after dusk, written every
 * frame by Sky#applySun. Baked window masks multiply by this so lit panes only
 * read after dark. */
export const WINDOW_GLOW_W = uniform(0);

/* ------------------------------------------------------------------ palettes */

// terrain-bake palette: matches tools/blender_city.py PALETTES (vertex colours)
export const PALETTE_HEX = [0x889eb0, 0xe8e2d5, 0xddd2b8, 0xd9b8a8, 0xb9c9b2, 0xb3c3cd, 0xb07555, 0xc9b189, 0xa8a29a];

export function paletteColor(p: number): THREE.Color {
  return new THREE.Color(PALETTE_HEX[p % PALETTE_HEX.length]);
}

// Limestone-dominant fallback/tint palette retained for roofs and broad
// per-building variation around the authored facade families.
export const MASONRY_HEX = [
  0xa8553c, 0x9c4a34,
  0x8a6a52, 0x7d6450,
  0xc4a370, 0xb89a6f, 0xc2b183,
  0xc6c0b2, 0xc6c0b2, 0xbdb7a8, 0xd1ccbe, 0xb4afa1,
  0x9a988f, 0x8b8983, 0xa5a39a,
  0xdbd6cb,
  0x7c868d
];

// per-building base height rides in the alive texture (G/B = 16-bit fixed point)
export const BASEY_OFFSET = 100;
export const BASEY_SCALE = 80;

// per-building roof height above base rides in the alive texture alpha
// (8-bit, 1.5 m steps → 382 m ceiling; 255 = unknown = never mask).
export const TOPH_SCALE = 1.5;

/* -------------------------------------------------- CPU twin of the GPU hash */

/**
 * three's TSL hash(): PCG (pcg-random.org via shadertoy XlGcRh). Bit-exact JS
 * twin so CPU callers can derive stable per-building material variation.
 */
export function pcgHash(i: number): number {
  const state = (Math.imul(i >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> (((state >>> 28) + 4) & 31)) ^ state) >>> 0, 277803737) >>> 0;
  return (((word >>> 22) ^ word) >>> 0) / 4294967296;
}

/** The broad per-building tone used for roofs and the authored-atlas tint. */
export function buildingTone(bid: number, p: number): THREE.Color {
  const idx = Math.min(MASONRY_HEX.length - 1, Math.floor(pcgHash(bid + 101) * MASONRY_HEX.length));
  const tone = paletteColor(p).lerp(new THREE.Color(MASONRY_HEX[idx]), 0.72);
  return tone.multiplyScalar(0.9 + 0.16 * pcgHash(bid + 223));
}

type N = any;

function facadeSurface(opts: {
  baseTone: N;
  bid: N;
  baseY: N;
  topRel?: N;
  litWindows: boolean;
  litScale?: N;
  detail?: boolean;
  frame?: { pos: N; nrm: N };
}) {
  return bakedFacadeSurface({ ...opts, windowGlowW: WINDOW_GLOW_W });
}

/* ------------------------------------------------------------------ materials */

/**
 * Wire the baked facade nodes onto `mat`, given the per-building alive lookup
 * `info` (RGBA: R alive flag, G/B base height, A roof height) and building id.
 *
 * `batched` selects the position path: an ordinary tile mesh keeps positions
 * normalized with dequantization in `modelScale`; a BatchedMesh instance has
 * already been transformed to world space by three's batch node.
 */
function assignFacadeNodes(
  mat: THREE.MeshStandardNodeMaterial,
  info: N,
  bid: N,
  vColor: N,
  opts: { detail: boolean; batched: boolean; birth?: N }
): void {
  // Both R=0 (mesh and collider off) and R=1/255 (mesh off, collider kept) are
  // suppressed. The camera cutaway is composed into the same material mask.
  mat.maskNode = info.r.greaterThan(0.5).and(cameraCutawayMask());

  // A deterministic per-building nudge separates duplicate OSM shells.
  const nudge = vec3(hash(bid.add(311)).sub(0.5).mul(0.06), 0, hash(bid.add(577)).sub(0.5).mul(0.06));
  const suppressed = step(info.r, 0.5);
  const sinkMeters = suppressed.mul(1_000_000);
  const baseY = info.g.mul(255).round().mul(256).add(info.b.mul(255).round()).div(BASEY_SCALE).sub(BASEY_OFFSET);
  const grow = opts.birth ? buildingGrowAmount(opts.birth, bid) : float(1);

  if (opts.batched) {
    const p = positionLocal.add(nudge);
    mat.positionNode = vec3(
      p.x,
      baseY.add(p.y.sub(baseY).mul(grow)).sub(sinkMeters),
      p.z
    );
  } else {
    const p = positionLocal.add(nudge.div(modelScale));
    const baseLocalY = baseY.sub(modelPosition.y).div(modelScale.y);
    mat.positionNode = vec3(
      p.x,
      baseLocalY.add(p.y.sub(baseLocalY).mul(grow)).sub(sinkMeters.div(modelScale.y)),
      p.z
    );
  }

  // Pull each building toward the camera by a tiny per-id relative amount to
  // resolve duplicate coplanar shells without changing screen position.
  mat.vertexNode = cameraProjectionMatrix.mul(
    positionView.mul(hash(bid.add(911)).mul(-2e-4).add(1))
  );

  const topRel = info.a.mul(255).round().mul(TOPH_SCALE);

  let palette: N = color(MASONRY_HEX[0]);
  const pick = hash(bid.add(101));
  for (let i = 1; i < MASONRY_HEX.length; i++) {
    palette = mix(palette, color(MASONRY_HEX[i]), step(i / MASONRY_HEX.length, pick));
  }
  const baseTone = varying(mix(vColor, palette, 0.72).mul(hash(bid.add(223)).mul(0.16).add(0.9)) as N) as N;

  const nodes = facadeSurface({ baseTone, bid, baseY, topRel, litWindows: true, detail: opts.detail });
  mat.colorNode = nodes.colorNode;
  mat.roughnessNode = nodes.roughnessNode;
  mat.metalnessNode = nodes.metalnessNode;
  mat.emissiveNode = nodes.emissiveNode;
  mat.normalNode = nodes.normalNode;
  mat.envMapIntensity = 1.0;
}

/**
 * Citywide baked facade material. The near path samples base color plus packed
 * roughness/relief; the far path samples only base color/window alpha.
 */
export function createFacadeMaterial(
  aliveTex: THREE.DataTexture,
  texWidth: number,
  opts: { detail?: boolean; birth?: unknown } = {}
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const detail = opts.detail !== false;
  const bid = attribute("_bid", "float") as unknown as N;
  const vColor = attribute("color", "vec3") as unknown as N;
  const uAliveW = uniform(texWidth);
  const info = texture(aliveTex, vec2(bid.add(0.5).div(uAliveW), 0.5));

  assignFacadeNodes(mat, info, bid, vColor, {
    detail,
    batched: false,
    birth: opts.birth as N | undefined
  });
  return mat;
}

/**
 * Configure the single material shared by every resident building tile folded
 * into the building BatchedMesh. The alive atlas is addressed by batch instance
 * row and per-building id column.
 */
export function configureFacadeBatchMaterial(
  mat: THREE.MeshStandardNodeMaterial,
  atlasTex: THREE.DataTexture,
  batchMesh: THREE.BatchedMesh,
  opts: { birth?: unknown } = {}
): void {
  const bid = attribute("_bid", "float") as unknown as N;
  const vColor = attribute("color", "vec3") as unknown as N;
  const indirect = batchMesh as unknown as { _indirectTexture: THREE.Texture };
  const idTex = indirect._indirectTexture as N;
  const texLoad = textureLoad as unknown as (t: N, coord?: N) => N;
  const texSize = textureSize as unknown as (t: N, level: N) => N;
  const row = (Fn((_: N[], builder: N) => {
    const batchingId: N = builder.getDrawIndex() === null ? instanceIndex : drawIndex;
    const size: N = int(texSize(texLoad(idTex), int(0)).x);
    const x: N = int(batchingId).mod(size);
    const y: N = int(batchingId).div(size);
    return int(texLoad(idTex, ivec2(x, y)).x);
  }) as N)();
  const info: N = texLoad(atlasTex, ivec2(int(bid), row));

  assignFacadeNodes(mat, info, bid, vColor, {
    detail: true,
    batched: true,
    birth: opts.birth as N | undefined
  });
}
