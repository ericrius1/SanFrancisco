import * as THREE from "three/webgpu";
import {
  normalizeSurfboardConfig,
  surfboardAccentHex,
  surfboardHandling,
  surfboardRailHex,
  type SurfboardConfig,
  type SurfboardShape
} from "./config";
import {
  paintSurfboardSurface,
  prepareSurfboardSurface,
  surfboardSurfacePaintKey
} from "./surfaceTexture";
import { surfboardAssetsReady } from "./assets";
import { applyVehicleShadowPolicy } from "../shadows";

type ShapeProfile = {
  halfLength: number;
  points: [number, number][]; // nose→tail: [z, half-width]
  tailNotch?: number;
  noseRocker: number;
  tailRocker: number;
  rockerSpan: number;
};

/** Flat center-section deck height in surfboard-local space. */
export const SURFBOARD_FLAT_DECK_TOP = 0.105;

const PROFILES: Record<SurfboardShape, ShapeProfile> = {
  shortboard: {
    halfLength: 1.65,
    points: [
      [-1.65, 0.02],
      [-1.52, 0.32],
      [-1.12, 0.49],
      [-0.45, 0.54],
      [0.35, 0.5],
      [1.12, 0.39],
      [1.52, 0.2],
      [1.65, 0.04]
    ],
    noseRocker: 0.17,
    tailRocker: 0.08,
    rockerSpan: 0.56
  },
  fish: {
    halfLength: 1.74,
    points: [
      [-1.74, 0.03],
      [-1.56, 0.38],
      [-1.05, 0.58],
      [-0.28, 0.63],
      [0.52, 0.6],
      [1.22, 0.5],
      [1.62, 0.3],
      [1.7, 0.2]
    ],
    tailNotch: 1.45,
    noseRocker: 0.13,
    tailRocker: 0.04,
    rockerSpan: 0.58
  },
  longboard: {
    halfLength: 2.2,
    points: [
      [-2.2, 0.03],
      [-2.08, 0.32],
      [-1.68, 0.52],
      [-0.85, 0.61],
      [0.25, 0.63],
      [1.22, 0.57],
      [1.82, 0.42],
      [2.12, 0.22],
      [2.2, 0.04]
    ],
    noseRocker: 0.12,
    tailRocker: 0.05,
    rockerSpan: 0.72
  }
};

type SurfboardSurfaceState = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  surfaceMaterial: THREE.MeshStandardMaterial;
  railMaterial: THREE.MeshStandardMaterial;
  accentMaterial: THREE.MeshStandardMaterial;
  paintKey: string;
  config: SurfboardConfig;
  clock: number;
  motion: number;
  shimmer: number;
  loadSerial: number;
  assetsActivated: boolean;
  assetsPainted: boolean;
  disposed: boolean;
  reducedMotion: boolean;
  landingFoam: THREE.Mesh[];
  landingSerial: number;
  landingAge: number;
};

const surfaceStates = new WeakMap<THREE.Group, SurfboardSurfaceState>();
const LANDING_FOAM_COLOR = new THREE.Color(0xeafffb);

function outline(profile: ShapeProfile): THREE.Vector2[] {
  const controls: THREE.Vector3[] = profile.points.map(([z, width]) => new THREE.Vector3(width, z, 0));
  if (profile.tailNotch !== undefined) controls.push(new THREE.Vector3(0, profile.tailNotch, 0));
  for (let i = profile.points.length - 1; i >= 0; i--) {
    const [z, width] = profile.points[i];
    controls.push(new THREE.Vector3(-width, z, 0));
  }
  const curve = new THREE.CatmullRomCurve3(controls, true, "catmullrom", 0.52);
  return curve.getPoints(112).slice(0, 112).map((point) => new THREE.Vector2(point.x, point.y));
}

function rocker(profile: ShapeProfile, z: number): number {
  const distance = Math.abs(z);
  const start = profile.halfLength - profile.rockerSpan;
  if (distance <= start) return 0;
  const t = THREE.MathUtils.clamp((distance - start) / profile.rockerSpan, 0, 1);
  return t * t * (z < 0 ? profile.noseRocker : profile.tailRocker);
}

function projectPlanarUv(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const width = Math.max(1e-6, bounds.max.x - bounds.min.x);
  const length = Math.max(1e-6, bounds.max.z - bounds.min.z);
  const position = geometry.getAttribute("position");
  const values = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    values[i * 2] = (position.getX(i) - bounds.min.x) / width;
    values[i * 2 + 1] = 1 - (position.getZ(i) - bounds.min.z) / length;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(values, 2));
}

function makeFinGeometry(scale = 1): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.07 * scale, -0.36 * scale, 0.28 * scale, -0.44 * scale);
  shape.lineTo(0.36 * scale, 0);
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape, 12);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

function paintState(state: SurfboardSurfaceState, config: SurfboardConfig): void {
  state.config = normalizeSurfboardConfig(config);
  state.paintKey = surfboardSurfacePaintKey(state.config);
  state.motion = state.config.surfaceMotion / 100;
  state.shimmer = state.config.surfaceShimmer / 100;
  state.railMaterial.color.set(surfboardRailHex(state.config));
  state.accentMaterial.color.set(surfboardAccentHex(state.config));
  state.surfaceMaterial.emissive.set(surfboardAccentHex(state.config));
  state.assetsPainted = paintSurfboardSurface(state.canvas, state.config);
  state.texture.needsUpdate = true;
}

function addFins(
  group: THREE.Group,
  shape: SurfboardShape,
  profile: ShapeProfile,
  material: THREE.Material,
  geometry: (value: THREE.BufferGeometry) => THREE.BufferGeometry
): void {
  if (shape === "longboard") {
    const fin = new THREE.Mesh(geometry(makeFinGeometry(1.35)), material);
    fin.position.set(0, -0.105, profile.halfLength - 0.57);
    group.add(fin);
    return;
  }
  const xs = shape === "fish" ? [-0.31, 0.31] : [-0.23, 0, 0.23];
  for (const x of xs) {
    const fin = new THREE.Mesh(geometry(makeFinGeometry(shape === "fish" ? 1.08 : 0.9)), material);
    fin.position.set(x, -0.1, profile.halfLength - (shape === "fish" ? 0.44 : 0.48) + Math.abs(x) * 0.18);
    fin.rotation.z = x * (shape === "fish" ? 0.92 : 0.7);
    group.add(fin);
  }
}

/** Build a themed shortboard, fish or longboard. Front is local -Z. */
export function buildSurfboardMesh(raw?: SurfboardConfig): THREE.Group {
  const config = normalizeSurfboardConfig(raw ?? {});
  const profile = PROFILES[config.shape];
  const group = new THREE.Group();
  group.name = "surfboard";

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const ownGeometry = <T extends THREE.BufferGeometry>(value: T): T => (geometries.push(value), value);
  const ownMaterial = <T extends THREE.Material>(value: T): T => (materials.push(value), value);

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 512;
  paintSurfboardSurface(canvas, config);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.center.set(0.5, 0.5);

  const surfaceMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.38,
      metalness: 0,
      emissive: surfboardAccentHex(config),
      emissiveMap: texture,
      emissiveIntensity: 0.025
    })
  );
  const railMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: surfboardRailHex(config), roughness: 0.36, metalness: 0 })
  );
  const accentMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: surfboardAccentHex(config), roughness: 0.46, metalness: 0 })
  );
  const leashMaterial = ownMaterial(new THREE.MeshStandardMaterial({ color: 0x20272b, roughness: 0.84 }));

  const points = outline(profile);
  const shape = new THREE.Shape(points);
  const deckGeometry = ownGeometry(
    new THREE.ExtrudeGeometry(shape, {
      depth: 0.11,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.046,
      bevelThickness: 0.03,
      curveSegments: 12,
      steps: 1
    })
  );
  deckGeometry.rotateX(Math.PI / 2);
  deckGeometry.translate(0, 0.075, 0);
  const positions = deckGeometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) positions.setY(i, positions.getY(i) + rocker(profile, positions.getZ(i)));
  positions.needsUpdate = true;
  deckGeometry.computeVertexNormals();
  projectPlanarUv(deckGeometry);
  deckGeometry.clearGroups();
  const deck = new THREE.Mesh(deckGeometry, surfaceMaterial);
  deck.name = "surfboard-surface-shell";
  group.add(deck);

  const railPoints = points.map((point) => new THREE.Vector3(point.x, 0.115 + rocker(profile, point.y), point.y));
  const railGeometry = ownGeometry(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPoints, true, "catmullrom", 0.5), 128, 0.026, 6, true)
  );
  const rail = new THREE.Mesh(railGeometry, railMaterial);
  rail.name = "surfboard-rail";
  group.add(rail);

  addFins(group, config.shape, profile, accentMaterial, ownGeometry);

  // A small tail plug and curved leash retain the handmade/readable silhouette.
  const plug = new THREE.Mesh(ownGeometry(new THREE.CylinderGeometry(0.045, 0.045, 0.022, 16)), accentMaterial);
  plug.position.set(0.23, 0.155 + rocker(profile, profile.halfLength - 0.22), profile.halfLength - 0.22);
  group.add(plug);
  const leashGeometry = ownGeometry(new THREE.TorusGeometry(0.17, 0.016, 7, 22, Math.PI * 1.55));
  const leash = new THREE.Mesh(leashGeometry, leashMaterial);
  leash.rotation.x = Math.PI / 2;
  leash.position.set(0.25, 0.02, profile.halfLength - 0.08);
  group.add(leash);

  // Six tapered rail wedges live inside the already-rendered surfboard
  // hierarchy. They stay at zero scale until the authoritative landing serial
  // advances, then bloom for a third of a second from the real contact rails.
  // Keeping them board-local avoids detached world-space splashes at surf
  // speed and ensures they share the proven WebGPU beauty path of the board.
  const landingFoamGeometry = ownGeometry(new THREE.BufferGeometry());
  landingFoamGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0.3, 1, 0, -0.3], 3)
  );
  landingFoamGeometry.setIndex([0, 1, 2]);
  landingFoamGeometry.computeVertexNormals();
  const landingFoam: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    for (let lane = 0; lane < 3; lane++) {
      const foam = new THREE.Mesh(landingFoamGeometry, railMaterial);
      foam.name = `surfboard-landing-foam-${side < 0 ? "left" : "right"}-${lane}`;
      foam.userData.surfLandingFoam = true;
      foam.userData.foamLane = lane;
      foam.position.set(side * (0.43 + lane * 0.055), 0.12, 0.12 + lane * 0.22);
      foam.rotation.y = (side < 0 ? Math.PI : 0) + side * (lane - 1) * 0.11;
      foam.scale.set(0.001, 0.001, 0.001);
      foam.renderOrder = 17;
      landingFoam.push(foam);
      group.add(foam);
    }
  }

  const state: SurfboardSurfaceState = {
    canvas,
    texture,
    surfaceMaterial,
    railMaterial,
    accentMaterial,
    paintKey: surfboardSurfacePaintKey(config),
    config,
    clock: 0,
    motion: config.surfaceMotion / 100,
    shimmer: config.surfaceShimmer / 100,
    loadSerial: 0,
    assetsActivated: false,
    assetsPainted: false,
    disposed: false,
    reducedMotion:
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    landingFoam,
    landingSerial: 0,
    landingAge: 1
  };
  surfaceStates.set(group, state);
  paintState(state, config);

  // Keep userData clone-safe: remotes may temporarily clone the stock prototype
  // while networking hydrates, so live DOM/material state stays in the WeakMap.
  group.userData.surfboardConfig = { ...config };
  group.userData.surfboardHandling = { ...surfboardHandling(config) };
  group.userData.dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    state.loadSerial++;
    surfaceStates.delete(group);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    texture.dispose();
  };
  // The closed deck already carries the complete board silhouette. Fins,
  // decals, and leash receive but do not multiply shadow-map draws.
  applyVehicleShadowPolicy(group, [deck]);
  return group;
}

/** Live customizer preview. Shape changes require buildSurfboardMesh(). */
export function updateSurfboardSurface(board: THREE.Group, raw: SurfboardConfig): void {
  const state = surfaceStates.get(board);
  if (!state || state.disposed) return;
  const config = normalizeSurfboardConfig(raw);
  const paintKey = surfboardSurfacePaintKey(config);
  state.motion = config.surfaceMotion / 100;
  state.shimmer = config.surfaceShimmer / 100;
  state.config = config;
  if (paintKey !== state.paintKey || (!state.assetsPainted && surfboardAssetsReady(config))) {
    paintState(state, config);
    if (state.assetsActivated) void activateSurfboardAssets(board);
  }
  board.userData.surfboardConfig = { ...config };
  board.userData.surfboardHandling = { ...surfboardHandling(config) };
}

/**
 * First-use gate for PNG art. Building a board never calls Image/fetch; the game
 * invokes this only when that board enters surf mode. Later selected-art edits
 * stay lazy but reload automatically because this board is already activated.
 */
export async function activateSurfboardAssets(board: THREE.Group): Promise<void> {
  const state = surfaceStates.get(board);
  if (!state || state.disposed) return;
  state.assetsActivated = true;
  const serial = ++state.loadSerial;
  const paintKey = state.paintKey;
  await prepareSurfboardSurface(state.config);
  if (state.disposed || serial !== state.loadSerial || paintKey !== state.paintKey) return;
  state.assetsPainted = paintSurfboardSurface(state.canvas, state.config);
  state.texture.needsUpdate = true;
}

/** Gentle UV drift + pearlescent breathing; no canvas work or texture uploads. */
export function animateSurfboard(
  board: THREE.Group,
  dt: number,
  elapsed?: number,
  landingCompression = 0,
  landingSerial = 0
): void {
  const state = surfaceStates.get(board);
  if (!state || state.disposed) return;
  const step = Math.min(Math.max(dt, 0), 0.05);
  if (!state.reducedMotion) state.clock += step * (0.18 + state.motion * 0.72);
  const time = elapsed ?? state.clock;
  const motion = state.reducedMotion ? 0 : state.motion;
  state.texture.offset.set(
    Math.sin(time * 0.31) * 0.012 * motion,
    Math.cos(time * 0.24 + 0.7) * 0.016 * motion
  );
  state.texture.rotation = Math.sin(time * 0.19) * 0.025 * motion;
  const breathe = 0.5 + 0.5 * Math.sin(time * 1.4 + state.config.textureRotation * 0.07);
  state.surfaceMaterial.emissiveIntensity = 0.012 + state.shimmer * (0.035 + breathe * 0.075);
  state.surfaceMaterial.roughness = 0.44 - state.shimmer * (0.06 + breathe * 0.08);

  if (landingSerial !== state.landingSerial) {
    state.landingSerial = landingSerial;
    state.landingAge = landingSerial > 0 ? 0 : 1;
  } else {
    state.landingAge += step;
  }
  const age = state.landingAge;
  const birth = THREE.MathUtils.smoothstep(age, 0, 0.045);
  const fade = 1 - THREE.MathUtils.smoothstep(age, 0.18, 0.34);
  const envelope = birth * fade * THREE.MathUtils.clamp(0.45 + landingCompression * 0.75, 0, 1);
  state.railMaterial.color.set(surfboardRailHex(state.config)).lerp(LANDING_FOAM_COLOR, envelope);
  state.railMaterial.emissive.set(0xb9ffeb);
  state.railMaterial.emissiveIntensity = 0.7 * envelope;
  for (const foam of state.landingFoam) {
    const lane = Number(foam.userData.foamLane ?? 0);
    if (envelope <= 1e-4) {
      foam.scale.set(0.001, 0.001, 0.001);
      continue;
    }
    const laneLength = 1 - lane * 0.12;
    const length = (0.48 + age * 5.1) * laneLength * birth;
    const width = (0.66 + age * 0.7) * (1 - lane * 0.08) * Math.sqrt(fade);
    foam.scale.set(Math.max(0.001, length), 1, Math.max(0.001, width));
  }
}
