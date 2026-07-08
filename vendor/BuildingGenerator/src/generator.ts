/**
 * TypeScript port of the "build system" geometry-node graph.
 * See docs/BUILD_SYSTEM.md for the derivation; validated numerically against
 * Blender's evaluated instances with tools/compare_truth.ts.
 *
 * Geometry model (Blender Z-up, validated against ground truth):
 * - facade grids have (N+1) × (floor+1) vertices at unit spacing, centered: columns
 *   x = -N/2 .. +N/2 where N = length (front/back) or width (sides).
 * - bottom row = ground cells, top row = guardrails, rightmost column = corners,
 *   interior = floor-1 rows of window cells.
 * - random values are pure functions of (element index, seed); indices renumber after
 *   every geometry separation, and unlinked Pick-Instance indices default to the
 *   element index (mod child count).
 */
// [SF vendor patch] import three from "three/webgpu" so the core classes share a
// single module instance with the host app (WebGPURenderer). Pure math here.
import { Matrix4, Vector3, Quaternion, Euler } from "three/webgpu";
import type { BuildingParams } from "./params";
import { randBool, randInt, randVecComponent } from "./rng";

export interface Placement {
  key: string;
  matrix: Matrix4;
}

export interface KitCounts {
  count(collection: string): number;
}

const COL = (name: string, idx: number, counts: KitCounts) =>
  `COL[${name}][${((idx % counts.count(name)) + counts.count(name)) % counts.count(name)}]`;
const OBJ = (name: string) => `OBJ[${name}]`;

interface Cell {
  x: number;
  z: number;
}

function separate<T>(arr: T[], pred: (t: T, i: number) => boolean): [T[], T[]] {
  const sel: T[] = [];
  const inv: T[] = [];
  arr.forEach((t, i) => (pred(t, i) ? sel : inv).push(t));
  return [sel, inv];
}

/** facade-local placement before the facade transform is applied */
interface Local {
  key: string;
  /** T(pos) · Rz · S · pre */
  local: Matrix4;
  /** origin x in facade space, used by the side-B column filter */
  ox: number;
}

const _q = new Quaternion();
const _e = new Euler();

function localM(
  x: number, y: number, z: number,
  rz = 0, sx = 1, sy = 1, sz = 1,
  pre?: Matrix4,
): Matrix4 {
  _e.set(0, 0, rz);
  _q.setFromEuler(_e);
  const m = new Matrix4().compose(new Vector3(x, y, z), _q, new Vector3(sx, sy, sz));
  if (pre) m.multiply(pre);
  return m;
}

/** CollectionInfo run through a Transform node: Rz(90°) · S(-1,1,1) */
const MIRROR_PRE = localM(0, 0, 0, Math.PI / 2, -1, 1, 1);

/** per-grid random ranges (front/back "B" vs side "A" use different constants) */
interface GridCfg {
  n: number;              // cell columns: length (front/back) or width (sides)
  yShift: number;         // -0.5 front/back, -0.1 sides
  roomsPick: [number, number];
  awningPick: [number, number];
  curtainPick: [number, number];
  acPick: [number, number];
  clothPick: [number, number];
  acFirstFloorCut: boolean;
}

function windowCellContent(p: BuildingParams, cfg: GridCfg, counts: KitCounts): Local[] {
  const out: Local[] = [];
  const seed = p.randomise;
  const floor = p.floor;
  const emit = (key: string, c: Cell, dx: number, dy: number, dz: number,
                rz = 0, sx = 1, sy = 1, sz = 1, pre?: Matrix4) => {
    const x = c.x + dx;
    out.push({ key, local: localM(x, cfg.yShift + dy, c.z + dz, rz, sx, sy, sz, pre), ox: x });
  };

  // window cells: rows 1..floor-1, columns 0..n-1, x fastest (grid vertex order)
  const cells: Cell[] = [];
  for (let iy = 1; iy <= floor - 1; iy++) {
    for (let ix = 0; ix <= cfg.n - 1; ix++) {
      cells.push({ x: -cfg.n / 2 + ix, z: -floor / 2 + iy });
    }
  }
  if (cells.length === 0) return out;

  const open2 = 2 * p.windowOpenAmount;
  const curtainMax = 5 * p.curtainClose;

  cells.forEach((c, i) => {
    // wall panel + matched window guard (same random value in the original)
    const wallPick = randInt(0, 100, i, seed);
    emit(COL("wall.001", wallPick, counts), c, 0, 0, 0);
    emit(COL("window guard.001", wallPick, counts), c, 0, 0, 0);
    emit(COL("ROOMS.001", randInt(cfg.roomsPick[0], cfg.roomsPick[1], i, seed), counts), c, 0, 0, 0);

    // curtains: pair at the window jambs, x-scaled by "curtain close"
    const pick = randInt(cfg.curtainPick[0], cfg.curtainPick[1], i, seed);
    const sxR = 1 + randVecComponent(0, 1, i, 41, 0) * (curtainMax - 1);
    const sxL = 1 + randVecComponent(0, 1, i, 32, 0) * (curtainMax - 1);
    emit(COL("CURTAINS.001", pick, counts), c, 0.079, 0.038, 0.5, 0, sxR, 1, 1);
    emit(COL("CURTAINS.001", pick, counts), c, 0.919, 0.038, 0.5, 0, -sxL, 1, 1);
  });

  // awnings above windows
  const [awningCells] = separate(cells, (_c, i) => randBool(p.roofProbability, i, seed));
  awningCells.forEach((c, j) =>
    emit(COL("roof.002", randInt(cfg.awningPick[0], cfg.awningPick[1], j, seed), counts), c, 0, 0, 0));

  // AC units (front/back skip the first window row) and clotheslines
  const [eligible, belowCut] = cfg.acFirstFloorCut
    ? separate(cells, c => c.z > -(floor + 1) / 2 + 2)
    : [cells, [] as Cell[]];
  const [acCells, noAc] = separate(eligible, (_c, j) => randBool(p.acUnit, j, seed));
  acCells.forEach((c, k) => {
    const acIdx = randInt(cfg.acPick[0], cfg.acPick[1], k, seed) % counts.count("ac.001");
    // Transform T(0.5,0,0.15) + per-child x jitter baked with TranslateInstances
    const jitter = randVecComponent(-0.175, 0.175, acIdx, 0, 0);
    const pre = new Matrix4().makeTranslation(0.5 + jitter, 0, 0.15);
    emit(COL("ac.001", acIdx, counts), c, 0, 0, 0, 0, 1, 1, 1, pre);
    emit(COL("AC WIRE.001", k, counts), c, 0, 0, 0); // unlinked pick = element index
  });
  const [acCloth] = separate(acCells, (_c, k) => randBool(p.clothlineProbability, k, seed));
  acCloth.forEach((c, m) =>
    emit(COL("cloth lines.001", randInt(cfg.clothPick[0], cfg.clothPick[1], m, seed), counts), c, 0, 0, 0));

  const noAcAll = [...noAc, ...belowCut]; // Join order in the graph
  const [clothEligible] = separate(noAcAll, (_c, k) => randBool(p.clothlineProbability, k, seed));
  const [withClothes, plainCloth] = separate(clothEligible, (_c, m) => randBool(0.5, m, seed));
  withClothes.forEach((c, m) => emit(COL("cloth lines WITH CLOTHES.001", m, counts), c, 0, 0, 0));
  plainCloth.forEach((c, m) => emit(COL("cloth lines.001", m, counts), c, 0, 0, 0));

  // windows: steel vs wood chosen with a FIXED seed (0) in the original
  const [steel, wood] = separate(cells, (_c, i) => randBool(p.windowType, i, 0));
  const panes = (subset: Cell[], frameKey: string, paneKey: string, topCol: string) => {
    subset.forEach((c, j) => {
      emit(frameKey, c, 0, 0, 0);
      emit(COL(topCol, randInt(0, 100, j, seed), counts), c, 0, 0, 0);
      const rotOut = randVecComponent(0, open2, j, seed, 2);   // outer mirrored pair
      const rotIn = randVecComponent(0, -p.windowOpenAmount, j, seed, 2); // inner pair
      emit(paneKey, c, 0.921, 0.011, 0.518, rotOut, -1, 1, 1);
      emit(paneKey, c, 0.494, 0.011, 0.518, rotOut, -1, 1, 1);
      emit(paneKey, c, 0.506, 0.011, 0.518, rotIn, 1, 1, 1);
      emit(paneKey, c, 0.079, 0.011, 0.518, rotIn, 1, 1, 1);
    });
  };
  panes(steel, OBJ("steel frame.001"), OBJ("steel window.001"), "steel window top preset.001");
  panes(wood, OBJ("wood frame.001"), OBJ("wood window.001"), "window wood top preset.001");

  return out;
}

/** guardrail top row + corner column, per grid, in facade-local space */
function facadeFrame(p: BuildingParams, n: number, railCol: string,
                     mirrored: boolean, counts: KitCounts): Local[] {
  const out: Local[] = [];
  const topZ = p.floor / 2;
  const rightX = n / 2;
  const pre = mirrored ? MIRROR_PRE : undefined;
  const put = (key: string, x: number, z: number, cornerPre?: Matrix4) =>
    out.push({ key, local: localM(x, 0, z, 0, 1, 1, 1, cornerPre), ox: x });

  // rails: unlinked pick = column index
  for (let ix = 0; ix <= n - 1; ix++) put(COL(railCol, ix, counts), -n / 2 + ix, topZ);
  // only the corner pieces are mirrored on the side facades
  put(COL("roofcorner", 0, counts), rightX, topZ, pre);
  for (let iy = 1; iy <= p.floor - 1; iy++) put(COL("corner", 0, counts), rightX, -p.floor / 2 + iy, pre);
  put(COL("ground_corner", 0, counts), rightX, -p.floor / 2, pre);
  return out;
}

function frontGround(p: BuildingParams, counts: KitCounts): Local[] {
  const out: Local[] = [];
  const seed = p.randomise;
  const z0 = -p.floor / 2;
  const row: Cell[] = [];
  for (let ix = 0; ix <= p.length - 1; ix++) row.push({ x: -p.length / 2 + ix, z: z0 });
  const put = (key: string, c: Cell) => out.push({ key, local: localM(c.x, 0, c.z), ox: c.x });

  // store items are instanced on the WHOLE row (picks use full-row index) and only
  // then split by open/closed — mirror that order here
  const picks = row.map((_c, i) => ({
    wire: randInt(0, 25, i, seed),
    sign: randInt(0, 25, i, seed),
    hanging: randInt(0, 25, i, seed),
    lights: randInt(0, 25, i, seed),
    propFront: randInt(0, 25, i, seed),
    propStore: randInt(0, 25, i, seed),
  }));
  row.forEach((c, i) => {
    put(COL("groud_front", i, counts), c); // unlinked pick = index
    put(COL("wire", picks[i].wire, counts), c);
  });

  const openFlags = row.map((_c, i) => randBool(p.closedOpenStore, i, seed));
  const withIdx = row.map((c, i) => ({ c, i }));
  const open = withIdx.filter(e => openFlags[e.i]);
  const closed = withIdx.filter(e => !openFlags[e.i]);

  open.forEach(({ c, i }, j) => {
    put(COL("storefront", i, counts), c);
    put(COL("storeinside", i, counts), c);
    put(COL("lightsground", picks[i].lights, counts), c);
    put(COL("prop_store", picks[i].propStore, counts), c);
    if (randBool(p.storeSign, j, seed)) {
      put(COL("store_sign", picks[i].sign, counts), c);
      put(COL("store_sign_hanging", picks[i].hanging, counts), c);
    }
    if (randBool(p.roofOnStore, j, seed)) put(OBJ("store_roof"), c);
    if (randBool(p.objectOnGround, j, seed)) put(COL("prop_front", picks[i].propFront, counts), c);
  });
  closed.forEach(({ c, i }, j) => {
    put(COL("shutter", i, counts), c);
    if (randBool(p.storeSign, j, 0)) put(COL("old store_sign", i, counts), c); // fixed seed
    if (randBool(p.objectOnGround, j, seed)) put(COL("prop_groud", i, counts), c);
  });
  return out;
}

function backGround(p: BuildingParams, counts: KitCounts): Local[] {
  const out: Local[] = [];
  const seed = p.randomise;
  const z0 = -p.floor / 2;
  for (let ix = 0; ix <= p.length - 1; ix++) {
    const x = -p.length / 2 + ix;
    const put = (key: string) => out.push({ key, local: localM(x, 0, z0), ox: x });
    put(COL("ground_back", randInt(0, 100, ix, seed), counts));
    put(COL("wire", randInt(0, 25, ix, seed), counts));
    put(COL("eletricarea", randInt(0, 31, ix, seed), counts));
  }
  return out;
}

function sideGround(p: BuildingParams, counts: KitCounts): Local[] {
  const out: Local[] = [];
  const seed = p.randomise;
  const z0 = -p.floor / 2;
  const row: Cell[] = [];
  for (let ix = 0; ix <= p.width - 1; ix++) row.push({ x: -p.width / 2 + ix, z: z0 });
  row.forEach((c, i) => {
    out.push({ key: COL("groud side wall", randInt(0, 100, i, seed), counts), local: localM(c.x, 0, c.z), ox: c.x });
  });
  row.forEach((c, i) => {
    if (randBool(p.objectOnGround, i, seed)) {
      out.push({ key: COL("prop_groud", randInt(0, 54, i, seed), counts), local: localM(c.x, 0, c.z), ox: c.x });
    }
  });
  return out;
}

export function generateBuilding(p: BuildingParams, counts: KitCounts): Placement[] {
  const out: Placement[] = [];
  const seed = p.randomise;

  // final lift applied to everything: T(0, -0.6, floor/2 + 0.05)
  const FINAL = new Matrix4().makeTranslation(0, -0.6, p.floor / 2 + 0.05);
  const facade = (tx: number, ty: number, rz: number) =>
    FINAL.clone().multiply(localM(tx, ty, 0, rz));

  // facade mapping validated against Blender's evaluated instances:
  // stores/guardrail-front live at +Y with a 180° turn; the solid-column side at -X
  const M_FRONT = facade(0, p.width / 2 + 0.6, Math.PI);
  const M_BACK = facade(0, -p.width / 2 + 0.6, 0);
  const M_SIDE_A = facade(p.length / 2, 0.6, Math.PI / 2);       // all-windows side
  const M_SIDE_B = facade(-p.length / 2, 0.6, Math.PI * 1.5);    // solid-column side

  const push = (facadeM: Matrix4, items: Local[]) => {
    for (const it of items) out.push({ key: it.key, matrix: facadeM.clone().multiply(it.local) });
  };

  // ---- front/back facade (grid B: length × floor) ----
  const cfgB: GridCfg = {
    n: p.length, yShift: -0.5,
    roomsPick: [0, 80], awningPick: [45, 125], curtainPick: [0, 101],
    acPick: [50, 100], clothPick: [0, 113],
    acFirstFloorCut: true,
  };
  const windowsB = windowCellContent(p, cfgB, counts);
  const frameFront = facadeFrame(p, p.length, "guardrail front", false, counts);
  const frameBack = facadeFrame(p, p.length, "guardrail back", false, counts);
  push(M_FRONT, windowsB);
  push(M_FRONT, frameFront);
  push(M_FRONT, frontGround(p, counts));
  push(M_BACK, windowsB);
  push(M_BACK, frameBack);
  push(M_BACK, backGround(p, counts));

  // ---- side facades (grid A: width × floor) ----
  const cfgA: GridCfg = {
    n: p.width, yShift: -0.1,
    roomsPick: [0, 101], awningPick: [0, 113], curtainPick: [0, 164],
    acPick: [50, 200], clothPick: [0, 96],
    acFirstFloorCut: false,
  };
  const windowsA = windowCellContent(p, cfgA, counts);
  const frameSide = facadeFrame(p, p.width, "guardrailside", true, counts);
  const groundSide = sideGround(p, counts);

  push(M_SIDE_A, windowsA);
  push(M_SIDE_A, frameSide);
  push(M_SIDE_A, groundSide);

  // side B: drop column-0 window items (facade-local x <= -(width+1)/2 + 1.45)
  // and cover that column with solid wall panels instead
  const thr = -(p.width + 1) / 2 + 1.45;
  push(M_SIDE_B, windowsA.filter(it => it.ox > thr));
  for (let iy = 1; iy <= p.floor - 1; iy++) {
    const c: Cell = { x: -p.width / 2, z: -p.floor / 2 + iy };
    push(M_SIDE_B, [{ key: COL("side_wall", 0, counts), local: localM(c.x, 0, c.z), ox: c.x }]);
  }
  push(M_SIDE_B, frameSide);
  push(M_SIDE_B, groundSide);

  // ---- roof ----
  const roofZ = p.floor / 2 + 0.1;
  const roofFaces: Cell[] = [];
  for (let j = 0; j < p.width; j++) {
    for (let i = 0; i < p.length; i++) {
      roofFaces.push({ x: -p.length / 2 + 0.5 + i, z: 0.6 - p.width / 2 + 0.5 + j });
    }
  }
  const putRoof = (key: string, c: Cell) =>
    out.push({ key, matrix: FINAL.clone().multiply(localM(c.x, c.z, roofZ)) });
  roofFaces.forEach(c => {
    for (let k = 0; k < counts.count("roof"); k++) putRoof(`COL[roof][${k}]`, c); // Pick Instance off
  });
  const [propFaces] = separate(roofFaces, (_c, i) => randBool(p.objectOnRoof, i, 0)); // fixed seed
  propFaces.forEach((c, j) => putRoof(COL("roof_prop", randInt(0, 120, j, seed), counts), c));
  // (the watertank branch in the .blend has a disconnected mesh input — it never fires)

  return out;
}
