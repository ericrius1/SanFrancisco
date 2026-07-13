import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldMap } from "../heightmap";
import type { MdWorldBox, MdWorldMesh } from "./ctx";
import {
  APSE_RADIUS,
  createApseWallSegments,
  createMuseumFloorCollisionMesh,
  FOOT_HALF_W,
  FOOT_Z0,
  FOOT_Z1,
  MD_CENTER,
  MD_YAW,
  mdInsideFootprint,
  mdToWorldXZ,
  PORTAL_H,
  PORTAL_HALF_W,
  TOWER_H,
  VAULT_APEX,
  WALL_THICKNESS,
  WALL_H,
  Z_APSE,
  Z_ENTRANCE
} from "./layout";

/** Local face colours, pushed through sRGB→linear like the baked landmarks. */
const ADOBE = new THREE.Color(0xdcc7a4).convertSRGBToLinear();
const ADOBE_TRIM = new THREE.Color(0xe8d9bd).convertSRGBToLinear();
const STONE_FLOOR = new THREE.Color(0xb08a63).convertSRGBToLinear();
const FLOOR_INLAY = new THREE.Color(0x8f6b48).convertSRGBToLinear();
const VAULT_CREAM = new THREE.Color(0xe6d8bf).convertSRGBToLinear();
const TERRACOTTA = new THREE.Color(0xa9573a).convertSRGBToLinear();
const WOOD = new THREE.Color(0x5a3e26).convertSRGBToLinear();

const WALL_T = WALL_THICKNESS;
const APSE_WALL_H = WALL_H + 0.8;

interface ShellBuild {
  group: THREE.Group;
  floorTop: number;
  colliders: MdWorldBox[];
  floorColliders: MdWorldMesh[];
  radialSurfaces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];
  groundTopAt(x: number, z: number, base: number): number | null;
}

interface GlassSpec {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  ry: number;
  kind: "amber" | "rose";
  radialRays: boolean;
}

/** Per-vertex weathering so big adobe faces don't read as flat "clay": a subtle
 *  value jitter keyed on position + a gentle grime gradient toward the base. */
function paint(geo: THREE.BufferGeometry, c: THREE.Color, weather = 0.07) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < n; v++) {
    const y = pos.getY(v);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(0.001, maxY - minY);
  for (let v = 0; v < n; v++) {
    const px = pos.getX(v);
    const py = pos.getY(v);
    const pz = pos.getZ(v);
    const h = Math.sin(px * 12.9898 + py * 78.233 + pz * 37.719) * 43758.5453;
    const jitter = (h - Math.floor(h) - 0.5) * 2 * weather; // ±weather
    const grime = -(1 - (py - minY) / span) * weather * 0.9; // darker toward the base
    const f = Math.max(0.6, 1 + jitter + grime);
    col[v * 3] = c.r * f;
    col[v * 3 + 1] = c.g * f;
    col[v * 3 + 2] = c.b * f;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

function box(
  out: THREE.BufferGeometry[],
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  c: THREE.Color,
  ry = 0
) {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  paint(g, c);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  out.push(g);
}

function tube(
  out: THREE.BufferGeometry[],
  x: number,
  y0: number,
  z: number,
  y1: number,
  rBot: number,
  rTop: number,
  c: THREE.Color,
  seg = 12
) {
  const h = y1 - y0;
  if (h <= 0) return;
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg).toNonIndexed();
  paint(g, c);
  g.translate(x, y0 + h / 2, z);
  out.push(g);
}

/** A rounded arch band between two column tops (half-torus, thin). */
function arch(out: THREE.BufferGeometry[], x: number, y: number, z0: number, z1: number, r: number, c: THREE.Color) {
  const mid = (z0 + z1) / 2;
  const g = new THREE.TorusGeometry(r, 0.22, 6, 20, Math.PI).toNonIndexed();
  paint(g, c);
  g.rotateY(Math.PI / 2); // torus plane → Y-Z
  g.translate(x, y, mid);
  out.push(g);
}

/** Cheap terrace sampling — the museum manager needs floorTop before it commits
 *  to building the (heavy) shell, so this is split out and reused by the build. */
export function basilicaFloorTop(map: WorldMap): { floorTop: number; skirtDepth: number } {
  let grade = -Infinity;
  let gradeMin = Infinity;
  for (let lz = FOOT_Z0; lz <= FOOT_Z1; lz += 3) {
    for (let lx = -FOOT_HALF_W; lx <= FOOT_HALF_W; lx += 3) {
      const p = mdToWorldXZ(lx, lz);
      const g = map.baseGroundTop(p.x, p.z);
      grade = Math.max(grade, g);
      gradeMin = Math.min(gradeMin, g);
    }
  }
  const floorTop = grade + 0.35;
  const skirtDepth = Math.min(9, Math.max(1.5, floorTop - gradeMin + 1.5));
  return { floorTop, skirtDepth };
}

export function buildBasilicaShell(map: WorldMap): ShellBuild {
  const { floorTop, skirtDepth } = basilicaFloorTop(map);

  const group = new THREE.Group();
  group.name = "mission_dolores_basilica";
  group.position.set(MD_CENTER.x, floorTop, MD_CENTER.z);
  group.rotation.y = MD_YAW;

  const stone: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const floors: THREE.BufferGeometry[] = [];
  const vault: THREE.BufferGeometry[] = [];
  const roofG: THREE.BufferGeometry[] = [];
  const woodG: THREE.BufferGeometry[] = [];
  const glass: GlassSpec[] = [];

  const naveLen = Z_APSE - Z_ENTRANCE; // 64
  const naveMidZ = (Z_ENTRANCE + Z_APSE) / 2;

  /* ---------------- floor ---------------- */
  box(floors, 0, -0.2, naveMidZ, FOOT_HALF_W * 2, 0.4, naveLen, STONE_FLOOR);
  // a runner of inlay tiles down the central aisle
  for (let z = Z_ENTRANCE + 3; z < Z_APSE; z += 3) {
    box(floors, 0, 0.011, z, 3.2, 0.02, 1.4, FLOOR_INLAY);
  }
  // apse floor fan
  {
    const g = new THREE.CircleGeometry(APSE_RADIUS, 24, Math.PI, Math.PI).toNonIndexed();
    paint(g, STONE_FLOOR);
    // Lower-left half in XY becomes the +z sanctuary fan while preserving an
    // upward-facing winding after the -90° turn onto the floor.
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.005, Z_APSE);
    floors.push(g);
  }

  /* ---------------- foundation apron (fills the downhill gap on the park slope) ---------------- */
  // Keep the apron below the semantic y=0 stone floor; its old +10 cm top
  // depth-occluded the floor and made correctly grounded feet look sunken.
  box(stone, 0, -skirtDepth / 2 - 0.055, naveMidZ, FOOT_HALF_W * 2 + 0.5, skirtDepth + 0.1, naveLen + 4.5, ADOBE);
  {
    const g = new THREE.CylinderGeometry(APSE_RADIUS + 0.25, APSE_RADIUS + 0.25, skirtDepth + 0.1, 24, 1, false, -Math.PI / 2, Math.PI).toNonIndexed();
    paint(g, ADOBE);
    g.translate(0, -skirtDepth / 2 - 0.055, Z_APSE);
    stone.push(g);
  }

  /* ---------------- outer side walls (west x=-12, east x=+12) ---------------- */
  for (const sx of [-1, 1]) {
    const wx = sx * FOOT_HALF_W;
    box(stone, wx, WALL_H / 2, naveMidZ, WALL_T, WALL_H, naveLen, ADOBE);
    // pilaster buttresses + tall arched windows between them
    for (let z = Z_ENTRANCE + 5; z <= Z_APSE - 4; z += 6.4) {
      box(stone, wx - sx * 0.15, WALL_H * 0.62, z, 0.5, WALL_H * 0.7, 1.0, ADOBE_TRIM); // pilaster
      // window: amber emissive on the interior face
      glass.push({ x: wx - sx * 0.34, y: 5.4, z: z + 3.2, w: 1.7, h: 4.4, ry: sx > 0 ? -Math.PI / 2 : Math.PI / 2, kind: "amber", radialRays: true });
    }
    // cornice
    box(trim, wx, WALL_H + 0.25, naveMidZ, WALL_T + 0.35, 0.5, naveLen, ADOBE_TRIM);
  }

  /* ---------------- façade (entrance, z = Z_ENTRANCE) with portal + towers ---------------- */
  const facadeZ = Z_ENTRANCE;
  const facadeTop = 13.5;
  const doorW = PORTAL_HALF_W - 0.3;
  const doorH = PORTAL_H - 0.35;
  const doorX = PORTAL_HALF_W - 0.16;
  const doorZ = facadeZ + doorW / 2 + 0.1;
  // wall split around the central portal gap
  box(stone, -(PORTAL_HALF_W + (FOOT_HALF_W - PORTAL_HALF_W) / 2), WALL_H / 2, facadeZ, FOOT_HALF_W - PORTAL_HALF_W, WALL_H, WALL_T, ADOBE);
  box(stone, PORTAL_HALF_W + (FOOT_HALF_W - PORTAL_HALF_W) / 2, WALL_H / 2, facadeZ, FOOT_HALF_W - PORTAL_HALF_W, WALL_H, WALL_T, ADOBE);
  // lintel over the portal + upper façade panel
  box(stone, 0, (PORTAL_H + WALL_H) / 2, facadeZ, PORTAL_HALF_W * 2 + 1.2, WALL_H - PORTAL_H, WALL_T, ADOBE);
  box(stone, 0, WALL_H + (facadeTop - WALL_H) / 2, facadeZ, FOOT_HALF_W * 2, facadeTop - WALL_H, WALL_T, ADOBE);
  // espadaña / curved pediment crown
  box(trim, 0, facadeTop + 0.4, facadeZ, 8, 0.8, WALL_T + 0.2, ADOBE_TRIM);
  tube(trim, 0, facadeTop + 0.8, facadeZ, facadeTop + 2.4, 1.7, 0.2, ADOBE_TRIM, 16);
  // rose window over the portal (emissive stained glass)
  glass.push({ x: 0, y: 9.4, z: facadeZ + 0.32, w: 3.4, h: 3.4, ry: 0, kind: "rose", radialRays: true });
  // decorative portal surround
  box(trim, 0, PORTAL_H + 0.2, facadeZ + 0.05, PORTAL_HALF_W * 2 + 0.8, 0.5, 0.3, ADOBE_TRIM);
  for (const sx of [-1, 1]) box(trim, sx * (PORTAL_HALF_W + 0.35), PORTAL_H / 2, facadeZ + 0.05, 0.4, PORTAL_H, 0.3, ADOBE_TRIM);
  // Heavy timber leaves stand open against the jambs: the chapel visibly
  // welcomes visitors instead of presenting a shut door they can ghost through.
  for (const sx of [-1, 1]) {
    box(woodG, sx * doorX, doorH / 2, doorZ, doorW, doorH, 0.16, WOOD, Math.PI / 2);
  }

  // twin bell towers flanking the façade
  for (const sx of [-1, 1]) {
    const tx = sx * (FOOT_HALF_W - 1.6);
    box(stone, tx, TOWER_H / 2, facadeZ, 3.4, TOWER_H, 3.4, ADOBE);
    box(trim, tx, TOWER_H + 0.2, facadeZ, 3.9, 0.5, 3.9, ADOBE_TRIM); // cornice
    // bell openings (emissive amber) on the front + sides
    glass.push({ x: tx, y: TOWER_H - 3, z: facadeZ - 1.75, w: 1.5, h: 2.6, ry: 0, kind: "amber", radialRays: false });
    // pyramidal / domed cap
    tube(roofG, tx, TOWER_H + 0.4, facadeZ, TOWER_H + 3.4, 2.5, 0.15, TERRACOTTA, 4);
    tube(trim, tx, TOWER_H + 3.3, facadeZ, TOWER_H + 3.9, 0.28, 0.15, ADOBE_TRIM, 8);
  }

  /* ---------------- apse (semicircular sanctuary, z = Z_APSE) ---------------- */
  {
    for (const seg of createApseWallSegments()) {
      box(stone, seg.x, APSE_WALL_H / 2, seg.z, seg.length, APSE_WALL_H, WALL_T, ADOBE, seg.yaw);
      box(trim, seg.x, APSE_WALL_H + 0.2, seg.z, seg.length + 0.08, 0.4, WALL_T + 0.18, ADOBE_TRIM, seg.yaw);
    }
    // Close the two shoulders between the narrower apse and the outer aisles.
    // Without these, the sanctuary reads as an outdoor set from either aisle.
    const shoulderW = FOOT_HALF_W - APSE_RADIUS;
    const shoulderX = APSE_RADIUS + shoulderW / 2;
    for (const sx of [-1, 1]) {
      box(stone, sx * shoulderX, APSE_WALL_H / 2, Z_APSE, shoulderW, APSE_WALL_H, WALL_T, ADOBE);
      box(trim, sx * shoulderX, APSE_WALL_H + 0.2, Z_APSE, shoulderW, 0.4, WALL_T + 0.25, ADOBE_TRIM);
    }
    // Authored rose and lancet glass are installed by the apse exhibit. Keeping
    // one owner avoids nearly-coplanar duplicate panes and visible z-fighting.
  }

  /* ---------------- colonnade: two rows of columns dividing nave / aisle ---------------- */
  for (const sx of [-1, 1]) {
    const cx = sx * 8;
    const zs: number[] = [];
    for (let z = Z_ENTRANCE + 6; z <= Z_APSE - 4; z += 5.6) zs.push(z);
    for (const z of zs) {
      box(trim, cx, 0.35, z, 1.5, 0.7, 1.5, ADOBE_TRIM); // plinth
      tube(stone, cx, 0.7, z, 8, 0.62, 0.5, ADOBE_TRIM); // shaft
      tube(trim, cx, 8, z, 8.5, 0.72, 0.55, ADOBE_TRIM); // capital
    }
    // round arches spanning between column tops
    for (let i = 0; i < zs.length - 1; i++) arch(stone, cx, 8.4, zs[i], zs[i + 1], (zs[i + 1] - zs[i]) / 2, ADOBE_TRIM);
    // entablature run above the arches
    box(trim, cx, 10.4, naveMidZ, 0.7, 0.6, naveLen - 6, ADOBE_TRIM);
  }

  /* ---------------- barrel vault over the nave ---------------- */
  {
    const r = FOOT_HALF_W; // spans the full interior width
    const vaultLen = naveLen + 12; // reach past the apse mouth so the far end is roofed
    const vaultMidZ = naveMidZ + 4;
    const g = new THREE.CylinderGeometry(r, r, vaultLen, 28, 1, true, Math.PI / 2, Math.PI).toNonIndexed();
    paint(g, VAULT_CREAM);
    g.rotateX(Math.PI / 2); // arch now rises in +Y, runs along Z
    g.scale(1, (VAULT_APEX - WALL_H) / r, 1); // flatten the arch height to the target apex
    g.translate(0, WALL_H, vaultMidZ);
    vault.push(g);

    // The barrel vault is deliberately open-ended, so close the rounded
    // sanctuary with a quiet plaster canopy.  This semicircular soffit follows
    // the same rear footprint as the apse wall and prevents a strip of night
    // sky from appearing above the stained glass when viewed from the nave.
    const apseCanopy = new THREE.CircleGeometry(APSE_RADIUS + 0.12, 36, Math.PI, Math.PI).toNonIndexed();
    paint(apseCanopy, VAULT_CREAM);
    apseCanopy.rotateX(-Math.PI / 2);
    apseCanopy.translate(0, APSE_WALL_H, Z_APSE);
    vault.push(apseCanopy);

    // A shallow triumphal-arch lunette closes the vertical seam where the
    // nave's barrel vault meets the lower apse canopy. Without it, visitors
    // could glimpse the terracotta exterior cap above the rose window.
    const lunetteShape = new THREE.Shape();
    lunetteShape.moveTo(-APSE_RADIUS, APSE_WALL_H);
    for (let i = 0; i <= 24; i++) {
      const x = -APSE_RADIUS + (APSE_RADIUS * 2 * i) / 24;
      const archY = WALL_H + (VAULT_APEX - WALL_H) * Math.sqrt(Math.max(0, 1 - (x * x) / (r * r)));
      lunetteShape.lineTo(x, archY);
    }
    lunetteShape.lineTo(APSE_RADIUS, APSE_WALL_H);
    lunetteShape.closePath();
    const lunette = new THREE.ShapeGeometry(lunetteShape).toNonIndexed();
    paint(lunette, VAULT_CREAM);
    lunette.translate(0, 0, Z_APSE - 0.04);
    vault.push(lunette);

    // painted ribs across the vault (thin arches spanning X at intervals along Z)
    for (let z = Z_ENTRANCE + 4; z <= Z_APSE - 2; z += 6.4) {
      const rib = new THREE.TorusGeometry(r - 0.05, 0.16, 5, 24, Math.PI).toNonIndexed();
      paint(rib, ADOBE_TRIM);
      rib.scale(1, (VAULT_APEX - WALL_H) / r, 1);
      rib.translate(0, WALL_H, z);
      vault.push(rib);
    }
  }

  /* ---------------- exterior gable roof (terracotta) ---------------- */
  buildGableRoof(roofG, naveMidZ, naveLen);

  /* ---------------- merge into a few meshes ---------------- */
  const addMerged = (list: THREE.BufferGeometry[], color: number, name: string, opts: THREE.MeshStandardMaterialParameters = {}) => {
    if (!list.length) return;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, ...opts });
    void color;
    const mesh = new THREE.Mesh(mergeGeometries(list, false)!, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (const g of list) g.dispose();
    group.add(mesh);
  };
  addMerged(stone, 0, "md_walls", { emissive: ADOBE_TRIM, emissiveIntensity: 0.1 });
  addMerged(trim, 0, "md_trim");
  addMerged(floors, 0, "md_floor", { roughness: 0.9 });
  addMerged(woodG, 0, "md_doors", { roughness: 0.7 });
  addMerged(roofG, 0, "md_roof", { roughness: 0.92 });
  // vault reads from below: driven by a cream emissive MAP (the same path the
  // stained glass uses to read bright in this WebGPU pipeline — emissive colour
  // alone renders dark here, and a lit Standard ceiling only catches the
  // hemisphere ground-bounce and reads as a mud-brown cave).
  if (vault.length) {
    const cv = document.createElement("canvas");
    cv.width = 64;
    cv.height = 512;
    const cg = cv.getContext("2d")!;
    cg.fillStyle = "#e9dcc2";
    cg.fillRect(0, 0, 64, 512);
    cg.strokeStyle = "rgba(150,120,80,0.28)";
    cg.lineWidth = 4;
    for (let y = 40; y < 512; y += 72) {
      cg.beginPath();
      cg.moveTo(0, y);
      cg.lineTo(64, y);
      cg.stroke();
    }
    const vtex = new THREE.CanvasTexture(cv);
    vtex.colorSpace = THREE.SRGBColorSpace;
    const vaultGeo = mergeGeometries(vault, false)!;
    vaultGeo.computeVertexNormals(); // the flatten-scale left non-unit normals
    const vaultMesh = new THREE.Mesh(
      vaultGeo,
      new THREE.MeshStandardMaterial({
        map: vtex,
        emissiveMap: vtex,
        emissive: 0xffffff,
        emissiveIntensity: 0.85,
        roughness: 0.92,
        metalness: 0,
        side: THREE.DoubleSide,
        fog: false
      })
    );
    vaultMesh.name = "md_vault";
    for (const g of vault) g.dispose();
    group.add(vaultMesh);
  }

  /* ---------------- stained-glass windows (emissive, self-lit) ---------------- */
  const builtGlass = buildGlass(glass);
  group.add(builtGlass.group);

  /* ---------------- colliders (world space) ---------------- */
  const colliders: MdWorldBox[] = [];
  const pushWall = (lx: number, lz: number, hx: number, hz: number, lyaw = 0) => {
    const w = mdToWorldXZ(lx, lz);
    // Structural walls continue through the visible foundation. Otherwise a
    // capsule that reaches the old coarse edge slope can slip underneath them.
    const hy = (WALL_H + skirtDepth) / 2;
    colliders.push({ x: w.x, y: floorTop + (WALL_H - skirtDepth) / 2, z: w.z, hx, hy, hz, yaw: MD_YAW + lyaw });
  };
  pushWall(-FOOT_HALF_W, naveMidZ, WALL_T / 2, naveLen / 2); // west
  pushWall(FOOT_HALF_W, naveMidZ, WALL_T / 2, naveLen / 2); // east
  // façade split around the portal
  pushWall(-(PORTAL_HALF_W + (FOOT_HALF_W - PORTAL_HALF_W) / 2), facadeZ, (FOOT_HALF_W - PORTAL_HALF_W) / 2, WALL_T / 2);
  pushWall(PORTAL_HALF_W + (FOOT_HALF_W - PORTAL_HALF_W) / 2, facadeZ, (FOOT_HALF_W - PORTAL_HALF_W) / 2, WALL_T / 2);
  // Open door leaves are tangible and match their visible yaw.
  for (const sx of [-1, 1]) {
    const w = mdToWorldXZ(sx * doorX, doorZ);
    colliders.push({
      x: w.x,
      y: floorTop + doorH / 2,
      z: w.z,
      hx: doorW / 2,
      hy: doorH / 2,
      hz: 0.09,
      yaw: MD_YAW + Math.PI / 2
    });
  }
  // Curved apse wall + the two shoulder returns. These are the same sampled
  // segments as the visible sanctuary, so players cannot walk through it.
  for (const seg of createApseWallSegments()) {
    pushWall(seg.x, seg.z, seg.length / 2, WALL_T / 2, seg.yaw);
  }
  const shoulderW = FOOT_HALF_W - APSE_RADIUS;
  const shoulderX = APSE_RADIUS + shoulderW / 2;
  for (const sx of [-1, 1]) pushWall(sx * shoulderX, Z_APSE, shoulderW / 2, WALL_T / 2);
  // column colliders (slim)
  for (const sx of [-1, 1]) {
    for (let z = Z_ENTRANCE + 6; z <= Z_APSE - 4; z += 5.6) {
      const w = mdToWorldXZ(sx * 8, z);
      colliders.push({ x: w.x, y: floorTop + 4, z: w.z, hx: 0.6, hy: 4, hz: 0.6, yaw: MD_YAW });
    }
  }

  /* ---------------- ground-top overlay: flat floor + portal ramp ---------------- */
  const RAMP = 3.5;
  const groundTopAt = (x: number, z: number, base: number): number | null => {
    const dx = x - MD_CENTER.x;
    const dz = z - MD_CENTER.z;
    if (dx * dx + dz * dz > 3600) return null; // 60 m broad-phase
    const c = Math.cos(MD_YAW);
    const s = Math.sin(MD_YAW);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    // The walkable floor begins at the portal. FOOT_Z0 includes the exterior
    // foundation apron, so testing the broad footprint first used to shadow
    // two metres of this ramp and manufacture a sharp collision step.
    if (lz >= Z_ENTRANCE && mdInsideFootprint(x, z)) return floorTop;
    // ramp up to the portal from the −z (entrance) side
    if (Math.abs(lx) <= PORTAL_HALF_W + 0.6 && lz < Z_ENTRANCE && lz >= Z_ENTRANCE - RAMP) {
      const t = (Z_ENTRANCE - lz) / RAMP;
      return Math.max(base, floorTop + (base - floorTop) * t);
    }
    return null;
  };

  const floorGeometry = createMuseumFloorCollisionMesh();
  const floorColliders: MdWorldMesh[] = [{
    x: MD_CENTER.x,
    y: floorTop + 0.005,
    z: MD_CENTER.z,
    yaw: MD_YAW,
    vertices: floorGeometry.vertices,
    indices: floorGeometry.indices
  }];

  return {
    group,
    floorTop,
    colliders,
    floorColliders,
    radialSurfaces: builtGlass.radialSurfaces,
    groundTopAt
  };
}

/** A terracotta roof shell that clears the interior vault, plus an apse cap. */
function buildGableRoof(out: THREE.BufferGeometry[], midZ: number, len: number) {
  const ridgeY = VAULT_APEX + 3; // 17 — well above the vault crown
  const eaveY = WALL_H + 0.8; // 11.8
  const halfW = FOOT_HALF_W + 1; // slight overhang past the walls
  const depth = len + 2;
  const rise = ridgeY - eaveY;
  const slope = Math.hypot(halfW, rise);
  const pitch = Math.atan2(rise, halfW);

  // Two thin pitched panels. The former solid triangular extrusion had a
  // horizontal bottom face at the eaves that sliced through the barrel vault
  // and read as a black ceiling from inside the church.
  for (const sx of [-1, 1]) {
    const panel = new THREE.BoxGeometry(slope, 0.28, depth).toNonIndexed();
    paint(panel, TERRACOTTA);
    panel.rotateZ(sx * -pitch);
    panel.translate(sx * halfW / 2, (eaveY + ridgeY) / 2, midZ);
    out.push(panel);
  }

  // Close only the front and rear gable ends with thin adobe triangles; these
  // preserve the basilica silhouette without putting any surface over the nave.
  const makePediment = (z: number, faceRear: boolean) => {
    const shape = new THREE.Shape();
    shape.moveTo(-halfW, eaveY);
    shape.lineTo(0, ridgeY);
    shape.lineTo(halfW, eaveY);
    shape.closePath();
    const pediment = new THREE.ShapeGeometry(shape).toNonIndexed();
    paint(pediment, ADOBE);
    if (!faceRear) pediment.rotateY(Math.PI);
    pediment.translate(0, 0, z);
    out.push(pediment);
  };
  makePediment(midZ - depth / 2 - 0.15, false);
  makePediment(midZ + depth / 2 + 0.15, true);

  // conical cap over the semicircular apse
  // Exterior cone only: a closed bottom cap becomes a huge dark disk when seen
  // from inside the sanctuary and fights the barrel vault.
  // Rear half only: a full cone projects ten metres into the nave and its
  // terracotta underside appears as a stray red arch above the sanctuary.
  const cap = new THREE.ConeGeometry(
    APSE_RADIUS + 1.5,
    4.5,
    20,
    1,
    true,
    -Math.PI / 2,
    Math.PI
  ).toNonIndexed();
  paint(cap, TERRACOTTA);
  cap.translate(0, WALL_H + 2.25, Z_APSE);
  out.push(cap);
}

/** Emissive stained-glass panes (procedural leaded-glass look, self-lit). */
function buildGlass(specs: GlassSpec[]): {
  group: THREE.Group;
  radialSurfaces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];
} {
  const g = new THREE.Group();
  g.name = "md_stained_glass";
  const radialSurfaces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
  for (const s of specs) {
    const pane = s.kind === "rose"
      ? buildRosePane(s.x, s.y, s.z, Math.min(s.w, s.h) / 2, s.ry)
      : buildAmberPane(s.x, s.y, s.z, s.w, s.h, s.ry);
    g.add(pane);
    if (s.radialRays) radialSurfaces.push(pane);
  }
  return { group: g, radialSurfaces };
}

const GLASS_COLORS = [0xffcf6b, 0xe8834a, 0x6fae8f, 0x5a86c4, 0xc36f9a, 0xe0c04a];

function buildAmberPane(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry: number
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 256;
  const c = canvas.getContext("2d")!;
  for (let iy = 0; iy < 8; iy++) {
    for (let ix = 0; ix < 4; ix++) {
      c.fillStyle = `#${GLASS_COLORS[(ix + iy) % GLASS_COLORS.length].toString(16).padStart(6, "0")}`;
      c.fillRect(ix * 32 + 2, iy * 32 + 2, 28, 28);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.25, roughness: 0.4, side: THREE.DoubleSide });
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.name = "md_window";
  return mesh;
}

function buildRosePane(
  x: number,
  y: number,
  z: number,
  r: number,
  ry: number
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#1a1206";
  c.fillRect(0, 0, 256, 256);
  const cx = 128;
  const cy = 128;
  const petals = 12;
  for (let ring = 3; ring >= 1; ring--) {
    const rr = (ring / 3) * 120;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + ring * 0.2;
      c.fillStyle = `#${GLASS_COLORS[(i + ring) % GLASS_COLORS.length].toString(16).padStart(6, "0")}`;
      c.beginPath();
      c.moveTo(cx, cy);
      c.arc(cx, cy, rr, a - Math.PI / petals + 0.03, a + Math.PI / petals - 0.03);
      c.closePath();
      c.fill();
    }
  }
  c.fillStyle = "#fff2c8";
  c.beginPath();
  c.arc(cx, cy, 18, 0, Math.PI * 2);
  c.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.35, roughness: 0.4, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(r, 32), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.name = "md_rose_window";
  return mesh;
}
