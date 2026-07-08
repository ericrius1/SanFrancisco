// SF Generated Buildings — self-contained, portable module (like src/world/garden).
//
// Wraps the vendored BuildingGenerator (Blender "build system" port). Phase 1:
// exteriors render through GLOBAL cross-building pools (pools.ts) — three
// BatchedMesh draws for ALL generated buildings instead of ~1,000 InstancedMeshes
// per building — plus one invisible shadow-proxy box per building in a single
// InstancedMesh (the only shadow caster). Interiors are unchanged from Phase 0:
// a pure function of (seed, dims, floors), lazily built within 40 m and fully
// disposed beyond 80 m (interior.ts).
//
// LIGHTING: no THREE lights are added anywhere (fixed LightPool). Interior light
// is emissive quads only.
import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import { generateBuilding } from "../../../vendor/BuildingGenerator/src/generator";
import { defaultParams, type BuildingParams } from "../../../vendor/BuildingGenerator/src/params";
import { loadBuildingKit } from "./kitLoader";
import { buildInterior, type LocalBox } from "./interior";
import { BuildingBatchPools, ShadowProxyPool, type PoolHandle } from "./pools";

/** metres per Blender unit. The building is `floor` units tall, so one storey =
 *  1 unit → SCALE metres (~3 m/storey, door ≈ player-sized). Validated by Box3
 *  in Phase 0: floor=5 building core = 15 m tall. */
export const BUILDING_SCALE = 3.0;

const ENTER_DIST = 40;   // build interior within this
const EXIT_DIST = 80;    // dispose interior beyond this

interface XYZ { x: number; y: number; z: number; }

export interface GeneratedBuildingOpts {
  position: THREE.Vector3 | XYZ;
  yawRad?: number;
  params?: Partial<BuildingParams>;
  seed: number;
  /** "low" drops greeble parts (AC units, clotheslines, signs, props) — roughly
   *  halves merged vertex count + merge time. Used by the streaming ring. */
  detail?: "full" | "low";
}

export interface GeneratedBuilding {
  group: THREE.Group;
  /** footprint half-extents in metres (x=length, z=width) and total height */
  dims: { halfX: number; halfZ: number; height: number; storeyH: number; floors: number };
  stats: { exteriorInstances: number; interiorMeshes: number; interiorBuilt: boolean };
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
}

// ---- module-level shared pools (created with the first building) -----------
let pools: BuildingBatchPools | null = null;
let proxies: ShadowProxyPool | null = null;

/** Per-building frustum cull — call once per frame with the render camera BEFORE
 *  rendering. Without this the batches draw every resident instance regardless of
 *  camera (the ~71 ms/frame Chinatown regression); with it only on-screen
 *  buildings draw. No-op until the first building creates the pools. */
export function cullGeneratedBuildings(camera: THREE.Camera) {
  pools?.cull(camera);
}

/** Advance incremental building merges — call once per frame (with a small time
 *  budget) so streaming buildings in never stalls a frame. No-op until first build. */
export function pumpGeneratedBuildings(maxMs = 6) {
  pools?.pump(maxMs);
}

/** live pool stats for perf probes / debug */
export function buildingPoolStats() {
  return {
    pools: pools ? pools.stats() : null,
    shadowProxies: proxies ? proxies.count : 0,
  };
}

/** inert stub returned when the kit assets are missing — keeps the app booting */
function stub(): GeneratedBuilding {
  const group = new THREE.Group();
  return {
    group,
    dims: { halfX: 0, halfZ: 0, height: 0, storeyH: BUILDING_SCALE, floors: 0 },
    stats: { exteriorInstances: 0, interiorMeshes: 0, interiorBuilt: false },
    update() {},
    dispose() {},
  };
}

export async function createGeneratedBuilding(
  opts: GeneratedBuildingOpts,
  ctx: { scene: THREE.Object3D; physics: { world: any } }
): Promise<GeneratedBuilding> {
  const kit = await loadBuildingKit();
  if (!kit) return stub();
  if (!pools) pools = new BuildingBatchPools(kit, ctx.scene);
  if (!proxies) proxies = new ShadowProxyPool(ctx.scene);

  const params: BuildingParams = { ...defaultParams(), ...opts.params, randomise: opts.seed };
  // guarantee an open storefront entrance on the ground floor
  params.closedOpenStore = 1.0;

  const pos = opts.position;
  const yaw = opts.yawRad ?? 0;

  // world root: T(pos) · RotY(yaw) · RotX(-90°, Blender Z-up → Y-up) · S(scale)
  const root = new THREE.Matrix4()
    .makeTranslation(pos.x, pos.y, pos.z)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
    .multiply(new THREE.Matrix4().makeScale(BUILDING_SCALE, BUILDING_SCALE, BUILDING_SCALE));

  // ---- footprint dims in metres -------------------------------------------
  const length = params.length;  // Blender units along x (front/back span)
  const width = params.width;    // along y (depth)
  const floors = params.floor;
  const halfX = (length * BUILDING_SCALE) / 2;
  const halfZ = (width * BUILDING_SCALE) / 2;
  const storeyH = BUILDING_SCALE;
  const height = floors * BUILDING_SCALE;

  // ---- exterior → global pools --------------------------------------------
  // world bounding sphere for per-building frustum culling: centre at mid-height,
  // radius reaches the footprint corners + head-room for AC units / awnings /
  // clotheslines / roof props that overhang the core footprint.
  const cullCenter = new THREE.Vector3(pos.x, pos.y + height / 2, pos.z);
  const cullRadius = Math.hypot(halfX, halfZ, height / 2) + 8;
  const placements = generateBuilding(params, kit);
  const handle: PoolHandle = pools.addBuilding(placements, root, { center: cullCenter, radius: cullRadius }, opts.detail ?? "full");

  // ---- shadow proxy: one solid box, slightly inset so the sun-facing facades
  //      sample in front of their own proxy depth (no self-shadow acne) -------
  const proxyInset = 0.35;
  const proxyM = new THREE.Matrix4()
    .makeTranslation(pos.x, pos.y, pos.z)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeTranslation(0, height / 2, 0))
    .multiply(new THREE.Matrix4().makeScale(
      Math.max(0.5, halfX - proxyInset) * 2,
      height,
      Math.max(0.5, halfZ - proxyInset) * 2));
  const proxy = proxies.add(proxyM);

  // outer group hosts the lazily built interior (exterior lives in the pools)
  const outer = new THREE.Group();
  outer.name = "generatedBuilding";
  outer.position.set(pos.x, pos.y, pos.z);
  outer.rotation.y = yaw;
  ctx.scene.add(outer);

  // ---- collider helpers (local Y-up AABB → yawed static body) --------------
  const world = ctx.physics.world;
  const cy = Math.sin(yaw / 2), cw = Math.cos(yaw / 2);
  const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
  const addBox = (b: LocalBox) => {
    const wx = pos.x + b.x * cosY + b.z * sinY;
    const wz = pos.z - b.x * sinY + b.z * cosY;
    const wy = pos.y + b.y;
    const h = world.createBox({
      type: BodyType.Static,
      position: [wx, wy, wz],
      halfExtents: [b.hx, b.hy, b.hz],
      friction: 0.8,
    });
    world.setBodyTransform(h, [wx, wy, wz], [0, cy, 0, cw]);
    return h;
  };

  // ---- exterior perimeter colliders — FRONT (−z) left open -----------------
  const wallT = 0.25;
  const exteriorBodies: number[] = [];
  exteriorBodies.push(addBox({ x: 0, y: height / 2, z: halfZ, hx: halfX, hy: height / 2, hz: wallT }));   // back
  exteriorBodies.push(addBox({ x: -halfX, y: height / 2, z: 0, hx: wallT, hy: height / 2, hz: halfZ }));  // left
  exteriorBodies.push(addBox({ x: halfX, y: height / 2, z: 0, hx: wallT, hy: height / 2, hz: halfZ }));   // right
  exteriorBodies.push(addBox({ x: 0, y: -0.15, z: 0, hx: halfX, hy: 0.15, hz: halfZ }));                  // ground pad
  exteriorBodies.push(addBox({ x: 0, y: height, z: 0, hx: halfX, hy: 0.15, hz: halfZ }));                 // roof cap

  // ---- lazy interior --------------------------------------------------------
  let interiorGroup: THREE.Group | null = null;
  let interiorBodies: number[] = [];
  let interiorMeshCount = 0;
  let disposed = false;
  const _p = new THREE.Vector3();

  const buildInteriorNow = () => {
    if (interiorGroup) return;
    const built = buildInterior({ seed: opts.seed, halfX, halfZ, storeyH, floors });
    interiorGroup = built.group;
    interiorMeshCount = built.meshCount;
    outer.add(interiorGroup);
    for (const b of built.colliders) interiorBodies.push(addBox(b));
  };
  const disposeInteriorNow = () => {
    if (!interiorGroup) return;
    outer.remove(interiorGroup);
    // shared unit geometry + shared materials are never disposed; just drop refs
    interiorGroup.clear();
    interiorGroup = null;
    interiorMeshCount = 0;
    for (const h of interiorBodies) world.destroyBody(h);
    interiorBodies.length = 0;
  };

  const stats = {
    exteriorInstances: handle.vertexCount,
    get interiorMeshes() { return interiorMeshCount; },
    get interiorBuilt() { return interiorGroup !== null; },
  };

  return {
    group: outer,
    dims: { halfX, halfZ, height, storeyH, floors },
    stats: stats as GeneratedBuilding["stats"],
    update(playerPos: THREE.Vector3) {
      if (disposed) return;
      _p.set(playerPos.x - pos.x, 0, playerPos.z - pos.z);
      const d = _p.length();
      if (d < ENTER_DIST && !interiorGroup) buildInteriorNow();
      else if (d > EXIT_DIST && interiorGroup) disposeInteriorNow();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeInteriorNow();
      pools!.removeBuilding(handle);
      pools!.flush();
      proxies!.remove(proxy);
      for (const h of exteriorBodies) world.destroyBody(h);
      exteriorBodies.length = 0;
      ctx.scene.remove(outer);
      outer.clear();
    },
  };
}

export { createGeneratedStreet, type GeneratedStreet } from "./street";
export { createChinatown, type Chinatown } from "./chinatown";
export { createBuildingRing, type BuildingRing } from "./ring";
