import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { GroundTopOverlay, WorldMap } from "../heightmap";
import type { TileStreamer } from "../tiles";
import {
  MARIN_TUNNELS,
  tunnelFrame,
  tunnelGrade,
  tunnelLocalPoint,
  tunnelWorldPoint,
  type MarinTunnelSpec,
  type TunnelFrame
} from "./layout";

type TunnelRuntime = Readonly<{
  spec: MarinTunnelSpec;
  frame: TunnelFrame;
  startY: number;
  endY: number;
}>;

type StaticBox = {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
};

const ASPHALT_LIFT = 0.16;
const TERRAIN_SKIN_LIFT = 0.28;
const PORTAL_DEPTH = 1.45;
const ROAD_SEGMENT = 12;
const LINER_SEGMENT = 18;

function hash01(x: number, z: number): number {
  const n = Math.sin(x * 0.0137 + z * 0.0191) * 43758.5453;
  return n - Math.floor(n);
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.clear();
}

function localToWorld(
  frame: TunnelFrame,
  localX: number,
  localZ: number
): { x: number; z: number } {
  return tunnelWorldPoint(frame, localX, localZ);
}

function localBox(frame: TunnelFrame, x: number, y: number, z: number, hx: number, hy: number, hz: number): StaticBox {
  const world = localToWorld(frame, x, z);
  return { x: world.x, y, z: world.z, hx, hy, hz, yaw: frame.yaw };
}

function addQuad(
  positions: number[],
  colors: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
  colorA: THREE.Color,
  colorB: THREE.Color = colorA
): void {
  // a→d→c and a→c→b gives horizontal patches a +Y front face. The
  // replacement terrain is viewed from above; the opposite winding silently
  // culled every approach flank and exposed the clipmap cutout as sky.
  positions.push(...a, ...d, ...c, ...a, ...c, ...b);
  for (const color of [colorA, colorB, colorB, colorA, colorB, colorA]) {
    colors.push(color.r, color.g, color.b);
  }
}

function makeRibbon(
  runtime: TunnelRuntime,
  width: number,
  lift: number,
  material: THREE.Material,
  name: string
): THREE.Mesh {
  const { spec, frame, startY, endY } = runtime;
  const halfLength = frame.length * 0.5;
  const extent = halfLength + spec.approachLength;
  const segments = Math.max(2, Math.ceil((extent * 2) / ROAD_SEGMENT));
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const along = -extent + (i / segments) * extent * 2;
    const y = tunnelGrade(startY, endY, frame, along) + lift;
    positions.push(-width * 0.5, y, along, width * 0.5, y, along);
    if (i < segments) {
      const k = i * 2;
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

function makeLaneMarkings(runtime: TunnelRuntime): THREE.Group {
  const group = new THREE.Group();
  group.name = `${runtime.spec.id}_lane_markings`;
  const lineMaterial = new THREE.MeshStandardMaterial({
    color: 0xe7ddbd,
    emissive: 0x19170f,
    emissiveIntensity: 0.16,
    roughness: 0.82,
    metalness: 0
  });
  const yellowMaterial = new THREE.MeshStandardMaterial({
    color: 0xd7a927,
    emissive: 0x211703,
    emissiveIntensity: 0.14,
    roughness: 0.82
  });
  const { spec } = runtime;
  if (spec.bores.length === 1) {
    group.add(makeRibbon(runtime, 0.16, ASPHALT_LIFT + 0.025, yellowMaterial, `${spec.id}_centerline`));
  } else {
    for (const bore of spec.bores) {
      const halfLane = bore.halfWidth * 0.46;
      for (const offset of [bore.offset - halfLane, bore.offset + halfLane]) {
        const line = makeRibbon(runtime, 0.12, ASPHALT_LIFT + 0.025, lineMaterial, `${spec.id}_lane_line`);
        line.position.x = offset;
        group.add(line);
      }
    }
  }
  return group;
}

function makeInnerLiner(runtime: TunnelRuntime, boreOffset: number, boreHalfWidth: number, material: THREE.Material): THREE.Mesh {
  const { spec, frame, startY, endY } = runtime;
  const halfLength = frame.length * 0.5;
  const lengthSegments = Math.max(2, Math.ceil(frame.length / LINER_SEGMENT));
  const archSegments = 14;
  const cross: Array<[number, number]> = [
    [-boreHalfWidth, 0],
    [-boreHalfWidth, spec.wallHeight]
  ];
  for (let i = 1; i < archSegments; i++) {
    const angle = Math.PI - (i / archSegments) * Math.PI;
    cross.push([
      Math.cos(angle) * boreHalfWidth,
      spec.wallHeight + Math.sin(angle) * spec.archRadius
    ]);
  }
  cross.push([boreHalfWidth, spec.wallHeight], [boreHalfWidth, 0]);

  const positions: number[] = [];
  const indices: number[] = [];
  for (let iz = 0; iz <= lengthSegments; iz++) {
    const along = -halfLength + (iz / lengthSegments) * frame.length;
    const roadY = tunnelGrade(startY, endY, frame, along);
    for (const [x, y] of cross) positions.push(x + boreOffset, roadY + y, along);
  }
  const stride = cross.length;
  for (let iz = 0; iz < lengthSegments; iz++) {
    for (let ix = 0; ix < stride - 1; ix++) {
      const a = iz * stride + ix;
      const b = a + stride;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${spec.id}_liner`;
  mesh.receiveShadow = true;
  return mesh;
}

function makeArchBand(
  halfWidth: number,
  wallHeight: number,
  radius: number,
  band: number,
  depth: number,
  material: THREE.Material
): THREE.Group {
  const group = new THREE.Group();
  const segments = 18;
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let zIndex = 0; zIndex <= 1; zIndex++) {
    const z = (zIndex - 0.5) * depth;
    for (let i = 0; i <= segments; i++) {
      const angle = Math.PI - (i / segments) * Math.PI;
      for (const r of [radius, radius + band]) {
        positions.push(Math.cos(angle) * (halfWidth + (r - radius)), wallHeight + Math.sin(angle) * r, z);
      }
    }
  }
  const row = (segments + 1) * 2;
  for (let zIndex = 0; zIndex < 2; zIndex++) {
    const base = zIndex * row;
    for (let i = 0; i < segments; i++) {
      const k = base + i * 2;
      if (zIndex === 0) indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      else indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (const edge of [0, 1]) {
      const a = i * 2 + edge;
      const b = a + 2;
      const c = a + row;
      const d = b + row;
      indices.push(a, c, b, b, c, d);
    }
  }
  const meshGeometry = geometry;
  meshGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  meshGeometry.setIndex(indices);
  meshGeometry.computeVertexNormals();
  const arch = new THREE.Mesh(meshGeometry, material);
  arch.name = "portal_arch";
  arch.castShadow = true;
  arch.receiveShadow = true;
  group.add(arch);

  const columnHeight = wallHeight + band * 0.5;
  const columnGeometry = new THREE.BoxGeometry(band, columnHeight, depth);
  for (const side of [-1, 1]) {
    const column = new THREE.Mesh(columnGeometry, material);
    column.position.set(side * (halfWidth + band * 0.5), columnHeight * 0.5, 0);
    column.castShadow = true;
    column.receiveShadow = true;
    group.add(column);
  }
  return group;
}

function makePortal(
  runtime: TunnelRuntime,
  at: "start" | "end",
  concrete: THREE.Material,
  rainbowMaterials: readonly THREE.Material[]
): THREE.Group {
  const { spec, frame, startY, endY } = runtime;
  const group = new THREE.Group();
  group.name = `${spec.id}_${at}_portal`;
  const sign = at === "start" ? -1 : 1;
  const along = sign * frame.length * 0.5;
  group.position.z = along;
  group.position.y = tunnelGrade(startY, endY, frame, along);
  if (at === "start") group.rotation.y = Math.PI;

  for (const bore of spec.bores) {
    const portal = makeArchBand(
      bore.halfWidth,
      spec.wallHeight,
      spec.archRadius,
      1.15,
      PORTAL_DEPTH,
      concrete
    );
    portal.position.x = bore.offset;
    group.add(portal);

    if (spec.rainbowPortal === at) {
      for (let i = 0; i < rainbowMaterials.length; i++) {
        const rainbow = makeArchBand(
          bore.halfWidth + 1.21 + i * 0.24,
          spec.wallHeight,
          spec.archRadius + 1.21 + i * 0.24,
          0.19,
          0.16,
          rainbowMaterials[i]
        );
        rainbow.position.x = bore.offset;
        rainbow.position.z = -PORTAL_DEPTH * 0.52 - 0.1;
        group.add(rainbow);
      }
    }
  }

  return group;
}

function makeTerrainSkin(
  runtime: TunnelRuntime,
  map: WorldMap,
  material: THREE.Material
): THREE.Mesh {
  const { spec, frame, startY, endY } = runtime;
  const halfLength = frame.length * 0.5;
  // Overlap the analytic cutout by one metre so its 35 cm alpha feather never
  // reveals a bright seam between the clipmap and this replacement skin.
  const extent = halfLength + spec.approachLength + 1;
  const skinHalfWidth = spec.cutoutHalfWidth + 1;
  const xSegments = Math.max(8, Math.ceil((skinHalfWidth * 2) / 2.6));
  const zSegments = Math.max(8, Math.ceil((extent * 2) / 11));
  const zValues = Array.from(
    { length: zSegments + 1 },
    (_, index) => -extent + (index / zSegments) * extent * 2
  );
  zValues.push(-halfLength, halfLength);
  zValues.sort((a, b) => a - b);
  const zRows = zValues.filter((value, index) =>
    index === 0 || Math.abs(value - zValues[index - 1]) > 0.01
  );
  const positions: number[] = [];
  const colors: number[] = [];
  const gold = new THREE.Color(0x9f925d);
  const straw = new THREE.Color(0xb1a06a);
  const sage = new THREE.Color(0x73835b);
  const rock = new THREE.Color(0x777269);
  const worldVertex = (localX: number, along: number): [number, number, number] => {
    const world = localToWorld(frame, localX, along);
    const base = map.baseGroundTop(world.x, world.z) + TERRAIN_SKIN_LIFT;
    const roadY = tunnelGrade(startY, endY, frame, along);
    const inside = Math.abs(along) <= halfLength + 1;
    const insideDistance = Math.max(0, halfLength - Math.abs(along));
    const roofCore = spec.roadWidth * 0.5 + 0.9;
    const lateralWeight = Math.max(
      0,
      Math.min(1, (skinHalfWidth - Math.abs(localX)) / Math.max(0.1, skinHalfWidth - roofCore))
    );
    const clearY = roadY + spec.wallHeight + spec.archRadius + 0.62;
    const portalT = Math.min(1, insideDistance / 32);
    const portalBlend = portalT * portalT * (3 - 2 * portalT);
    const centerRoof = clearY + (Math.max(base, clearY) - clearY) * portalBlend;
    // At a tunnel mouth, lower only the centre of the replacement heightfield
    // to the crown envelope. It then eases back to the surveyed DEM over 32 m.
    // The flanks retain their actual elevations, forming the natural cut face
    // without a separate wall or a terrain sheet across the bore.
    const approachCore = spec.roadWidth * 0.5 + 1.4;
    const approachWeight = Math.max(
      0,
      Math.min(1, (skinHalfWidth - Math.abs(localX)) / Math.max(0.1, skinHalfWidth - approachCore))
    );
    const approachFloor = roadY - 0.22;
    const roof = inside
      ? base + (centerRoof - base) * lateralWeight
      : base + (approachFloor - base) * approachWeight;
    return [localX, roof, along];
  };

  for (let iz = 0; iz < zRows.length - 1; iz++) {
    const z0 = zRows[iz];
    const z1 = zRows[iz + 1];
    const zMid = (z0 + z1) * 0.5;
    const approach = Math.abs(zMid) > halfLength;
    const touchesPortal =
      Math.abs(Math.abs(z0) - halfLength) < 0.02 ||
      Math.abs(Math.abs(z1) - halfLength) < 0.02;
    for (let ix = 0; ix < xSegments; ix++) {
      const x0 = -skinHalfWidth + (ix / xSegments) * skinHalfWidth * 2;
      const x1 = -skinHalfWidth + ((ix + 1) / xSegments) * skinHalfWidth * 2;
      const xMid = (x0 + x1) * 0.5;
      // Let the terrain flanks overlap the asphalt by a few centimetres. A
      // wider skipped slot exposes the clipmap cutout as two bright gutters.
      if (
        approach && touchesPortal &&
        Math.abs(xMid) < Math.max(0.2, spec.roadWidth * 0.5 + 0.35)
      ) continue;
      const a = worldVertex(x0, z0);
      const b = worldVertex(x1, z0);
      const c = worldVertex(x1, z1);
      const d = worldVertex(x0, z1);
      const world = localToWorld(frame, xMid, zMid);
      const patch = hash01(Math.floor(world.x / 48) * 48, Math.floor(world.z / 48) * 48);
      const chosen = patch > 0.86 ? sage : patch > 0.42 ? straw : gold;
      const steep = Math.max(
        Math.abs(a[1] - b[1]),
        Math.abs(b[1] - c[1]),
        Math.abs(c[1] - d[1]),
        Math.abs(d[1] - a[1])
      ) > 5.5;
      addQuad(positions, colors, a, b, c, d, steep ? rock : chosen, steep ? rock : gold);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${spec.id}_terrain_roof`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeTunnelLights(runtime: TunnelRuntime): THREE.InstancedMesh {
  const { spec, frame, startY, endY } = runtime;
  const countPerBore = Math.max(4, Math.floor(frame.length / 24));
  const count = countPerBore * spec.bores.length;
  const geometry = new THREE.BoxGeometry(0.55, 0.12, 1.25);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffe4a8,
    emissive: 0xffc866,
    emissiveIntensity: 5,
    roughness: 0.36,
    toneMapped: false
  });
  const lights = new THREE.InstancedMesh(geometry, material, count);
  lights.name = `${spec.id}_warm_lights`;
  const matrix = new THREE.Matrix4();
  let index = 0;
  for (const bore of spec.bores) {
    for (let i = 0; i < countPerBore; i++) {
      const along = -frame.length * 0.5 + ((i + 0.5) / countPerBore) * frame.length;
      const y = tunnelGrade(startY, endY, frame, along) + spec.wallHeight + spec.archRadius - 0.28;
      matrix.makeTranslation(bore.offset, y, along);
      lights.setMatrixAt(index++, matrix);
    }
  }
  lights.instanceMatrix.needsUpdate = true;
  return lights;
}

function makeTrafficSignals(runtime: TunnelRuntime): THREE.Group {
  const group = new THREE.Group();
  group.name = `${runtime.spec.id}_signals`;
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x3e4544, roughness: 0.72 });
  const redMaterial = new THREE.MeshStandardMaterial({
    color: 0x44120c,
    emissive: 0xff2a15,
    emissiveIntensity: 4,
    toneMapped: false
  });
  for (const sign of [-1, 1]) {
    const along = sign * (runtime.frame.length * 0.5 + 8);
    const y = tunnelGrade(runtime.startY, runtime.endY, runtime.frame, along);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.2, 8), poleMaterial);
    pole.position.set(-runtime.spec.roadWidth * 0.5 - 1, y + 1.6, along);
    group.add(pole);
    const signal = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 7), redMaterial);
    signal.position.set(-runtime.spec.roadWidth * 0.5 - 1, y + 3.0, along);
    group.add(signal);
  }
  return group;
}

function buildTunnel(
  runtime: TunnelRuntime,
  map: WorldMap,
  topMaterial: THREE.Material,
  concreteMaterial: THREE.Material,
  linerMaterial: THREE.Material,
  rainbowMaterials: readonly THREE.Material[],
  bodySpecs: StaticBox[]
): THREE.Group {
  const { spec, frame, startY, endY } = runtime;
  const root = new THREE.Group();
  root.name = `${spec.id}_tunnel`;
  root.position.set(frame.centerX, 0, frame.centerZ);
  root.rotation.y = frame.yaw;

  // Do not reuse the city road node material here: it intentionally multiplies
  // by terrainCutoutMask(), which would erase the very road that replaces this
  // tunnel's cutout.
  const roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x3c3d3d,
    roughness: 0.96,
    metalness: 0
  });
  const shoulderMaterial = new THREE.MeshStandardMaterial({
    color: 0x716c62,
    roughness: 1,
    metalness: 0
  });
  const shoulders = makeRibbon(
    runtime,
    spec.roadWidth + (spec.bores.length === 1 ? 4 : 8),
    ASPHALT_LIFT - 0.025,
    shoulderMaterial,
    `${spec.id}_shoulders`
  );
  const road = makeRibbon(runtime, spec.roadWidth, ASPHALT_LIFT, roadMaterial, `${spec.id}_asphalt`);
  root.add(shoulders, road, makeLaneMarkings(runtime));
  for (const bore of spec.bores) {
    root.add(makeInnerLiner(runtime, bore.offset, bore.halfWidth, linerMaterial));
  }
  root.add(
    makePortal(runtime, "start", concreteMaterial, rainbowMaterials),
    makePortal(runtime, "end", concreteMaterial, rainbowMaterials),
    makeTunnelLights(runtime)
  );
  if (spec.trafficSignals) root.add(makeTrafficSignals(runtime));

  root.add(makeTerrainSkin(runtime, map, topMaterial));

  const physicsSegments = Math.max(4, Math.ceil(frame.length / 44));
  for (let i = 0; i < physicsSegments; i++) {
    const along0 = -frame.length * 0.5 + (i / physicsSegments) * frame.length;
    const along1 = -frame.length * 0.5 + ((i + 1) / physicsSegments) * frame.length;
    const along = (along0 + along1) * 0.5;
    const segmentLength = along1 - along0 + 0.5;
    const roadY = tunnelGrade(startY, endY, frame, along);
    for (const bore of spec.bores) {
      const clearHeight = spec.wallHeight + spec.archRadius;
      bodySpecs.push(
        localBox(frame, bore.offset - bore.halfWidth - 0.22, roadY + clearHeight * 0.5, along, 0.28, clearHeight * 0.5, segmentLength * 0.5),
        localBox(frame, bore.offset + bore.halfWidth + 0.22, roadY + clearHeight * 0.5, along, 0.28, clearHeight * 0.5, segmentLength * 0.5),
        localBox(frame, bore.offset, roadY + clearHeight + 0.28, along, bore.halfWidth, 0.28, segmentLength * 0.5)
      );
    }
  }
  return root;
}

export type MarinHeadlandsTunnelsDebug = Readonly<{
  active: boolean;
  tunnels: readonly Readonly<{
    id: MarinTunnelSpec["id"];
    length: number;
    startY: number;
    endY: number;
  }>[];
}>;

/**
 * Geographic replacement for the two headland tunnel corridors. The ordinary
 * DEM remains the broad-landform authority; two narrow cutouts hand only the
 * overhangs to authored meshes, while a composed ground overlay lowers the
 * driveable floor beneath those roofs.
 */
export class MarinHeadlandsTunnels {
  readonly root = new THREE.Group();
  readonly #map: WorldMap;
  readonly #physics: Physics;
  readonly #tiles: TileStreamer;
  readonly #runtimes: TunnelRuntime[];
  readonly #bodySpecs: StaticBox[] = [];
  readonly #bodies: number[] = [];
  readonly #overlay: GroundTopOverlay;
  #active = false;

  constructor(map: WorldMap, physics: Physics, tiles: TileStreamer) {
    this.#map = map;
    this.#physics = physics;
    this.#tiles = tiles;
    this.root.name = "marin_headlands_tunnels";

    this.#runtimes = MARIN_TUNNELS.map((spec) => {
      const frame = tunnelFrame(spec);
      return {
        spec,
        frame,
        startY: map.baseGroundTop(spec.start.x, spec.start.z),
        endY: map.baseGroundTop(spec.end.x, spec.end.z)
      };
    });

    const topMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.98,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide
    });
    const concreteMaterial = new THREE.MeshStandardMaterial({
      color: 0x9a978d,
      roughness: 0.9,
      metalness: 0
    });
    const linerMaterial = new THREE.MeshStandardMaterial({
      color: 0x53534f,
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide
    });
    const rainbowMaterials = [0xd64a3b, 0xe78d37, 0xd9c648, 0x5f9f69, 0x5482aa, 0x7e6392].map((color) =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.78,
        emissive: color,
        emissiveIntensity: 0.08
      })
    );

    for (const runtime of this.#runtimes) {
      this.root.add(
        buildTunnel(
          runtime,
          map,
          topMaterial,
          concreteMaterial,
          linerMaterial,
          rainbowMaterials,
          this.#bodySpecs
        )
      );
    }
    this.root.userData.sfDebug = () => this.debugState();

    this.#overlay = (x, z, base) => {
      let top = base;
      for (const runtime of this.#runtimes) {
        const local = tunnelLocalPoint(runtime.frame, x, z);
        const halfLength = runtime.frame.length * 0.5 + runtime.spec.approachLength;
        if (
          Math.abs(local.along) <= halfLength &&
          Math.abs(local.lateral) <= runtime.spec.roadWidth * 0.5 + 0.8
        ) {
          top = Math.min(
            top,
            tunnelGrade(runtime.startY, runtime.endY, runtime.frame, local.along) + ASPHALT_LIFT
          );
        }
      }
      return top;
    };
  }

  addTo(scene: THREE.Scene): void {
    if (this.#active) return;
    scene.add(this.root);
    const claimed: string[] = [];
    try {
      for (const runtime of this.#runtimes) {
        const id = `marin:${runtime.spec.id}`;
        this.#tiles.setTerrainCutout(id, {
          centerX: runtime.frame.centerX,
          centerZ: runtime.frame.centerZ,
          halfX: runtime.spec.cutoutHalfWidth,
          halfZ: runtime.frame.length * 0.5 + runtime.spec.approachLength,
          yaw: runtime.frame.yaw,
          feather: 0.35
        });
        claimed.push(id);
      }
      this.#map.setGroundTopOverlay(this.#overlay);
      for (const box of this.#bodySpecs) {
        const body = this.#physics.world.createBox({
          type: BodyType.Static,
          position: [box.x, box.y, box.z],
          halfExtents: [box.hx, box.hy, box.hz],
          friction: 0.76
        });
        const quat: [number, number, number, number] = [
          0,
          Math.sin(box.yaw * 0.5),
          0,
          Math.cos(box.yaw * 0.5)
        ];
        this.#physics.world.setBodyTransform(body, [box.x, box.y, box.z], quat);
        this.#physics.addQuerySolid(body, box);
        this.#bodies.push(body);
      }
      this.#active = true;
    } catch (error) {
      for (const id of claimed) this.#tiles.clearTerrainCutout(id);
      this.#map.clearGroundTopOverlay(this.#overlay);
      this.root.removeFromParent();
      throw error;
    }
  }

  debugState(): MarinHeadlandsTunnelsDebug {
    return {
      active: this.#active,
      tunnels: this.#runtimes.map((runtime) => ({
        id: runtime.spec.id,
        length: runtime.frame.length,
        startY: runtime.startY,
        endY: runtime.endY
      }))
    };
  }

  dispose(): void {
    if (this.#active) {
      for (const runtime of this.#runtimes) {
        this.#tiles.clearTerrainCutout(`marin:${runtime.spec.id}`);
      }
      this.#map.clearGroundTopOverlay(this.#overlay);
      for (const body of this.#bodies.splice(0)) {
        this.#physics.removeQuerySolid(body);
        this.#physics.world.destroyBody(body);
      }
      this.#active = false;
    }
    this.root.removeFromParent();
    disposeObject(this.root);
  }
}

export function createMarinHeadlandsTunnels(
  map: WorldMap,
  physics: Physics,
  tiles: TileStreamer
): MarinHeadlandsTunnels {
  return new MarinHeadlandsTunnels(map, physics, tiles);
}
