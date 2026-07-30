import * as THREE from "three/webgpu";
import { normalView, pow, saturate, uniform } from "three/tsl";
import { SUTRO_BATHS, sutroLocalToWorld } from "./layout";

// TSL node type escape hatch (same convention as src/fx/*).
type N = any;

/**
 * The tea parlour: the furniture, lamps and small comforts that turn the
 * restored hall from an empty swimming shed into somewhere you would want to
 * sit for an hour.
 *
 * Everything here is authored in POOL-LOCAL coordinates (see bathers.ts for the
 * convention) and drawn from a handful of InstancedMeshes — one per material —
 * so the whole parlour costs about a dozen draw calls no matter how many
 * tables, chairs, loungers and lamp posts the layout grows to.
 *
 * SEATS are the contract with bathers.ts: each entry names a place a person can
 * actually be, at the height their hips belong, so the two modules can never
 * drift into someone floating beside their own chair.
 *
 * Lamps are glowing GEOMETRY, never scene lights: the renderer carries exactly
 * one sun plus one pooled contextual light for the whole world (see
 * player/lightPool.ts), and adding to that set recompiles every lit pipeline.
 * The globes are emissive, the warm pool each one throws on the deck is an
 * additive disc, and the site's single pooled anchor does the rest.
 */

export type SutroSeatKind = "chair" | "bench";

export type SutroSeat = {
  id: string;
  /** Pool-local metres. */
  lx: number;
  lz: number;
  /** Extra yaw over the site yaw; 0 faces local -Z (round: faces the table). */
  face: number;
  kind: SutroSeatKind;
  /** Deck-relative height of the seat pad's TOP surface, metres. */
  seatY: number;
  /**
   * Deck-relative height a seated rig's HIPS belong at — the single source of
   * truth for "sitting on this". The rig's hip block reaches ~0.11 m below its
   * origin, so hips must ride above the pad, not at it; guessing that offset in
   * bathers.ts is how people ended up buried in their own chairs.
   */
  hipY: number;
  /** Optional table this seat is pulled up to (index into TABLES). */
  table?: number;
};

/** Hip origin above a pad top so the hip block rests ON it, not through it. */
const HIP_ABOVE_PAD = 0.11;
/** Pad-top heights by furniture kind. */
const CHAIR_PAD_Y = 0.47;
const BENCH_PAD_Y = 0.45;


/**
 * Little round café tables, pool-local. Tea lands on these, and each one names
 * the bearings its chairs are pulled up on: hand-placing both the table and its
 * chairs is how you end up with people sitting two metres from their own cup.
 * Bearing 0 is the table's +x side; the chair always faces the table.
 */
export const TABLES: readonly {
  lx: number;
  lz: number;
  lamp: boolean;
  id: string;
  chairs: readonly number[];
}[] = [
  // west ocean gallery — tea in the sunset windows
  { id: "west-a", lx: -34.2, lz: -20, lamp: true, chairs: [1.0, 2.9] },
  { id: "west-b", lx: -34.2, lz: 6, lamp: true, chairs: [0.8, 2.89, 4.98] },
  { id: "west-c", lx: -34.2, lz: 34, lamp: false, chairs: [1.6] },
  // east gallery — the other tea room, looking back over the pools
  { id: "east-a", lx: 25.4, lz: -34, lamp: true, chairs: [2.8, 4.7] },
  { id: "east-b", lx: 25.4, lz: -6, lamp: true, chairs: [2.6, 4.69, 0.5] },
  { id: "east-c", lx: 25.4, lz: 20, lamp: false, chairs: [3.4] },
  // south promenade. Off the deck spine on purpose: the spine carries a row of
  // planters and a row of candle stands, and this table used to seat somebody
  // inside a poppy bed.
  { id: "south", lx: 2, lz: 47, lamp: true, chairs: [0.4, 2.49, 4.59] }
] as const;

/**
 * How far a pulled-up chair sits from the table centre. These avatars are
 * chunky — seated, one occupies roughly 0.6 m of arc — so the reach and the
 * bearing spacing above both have to be generous or a "table for three" reads
 * as three people sitting in each other's laps.
 */
const CHAIR_REACH = 0.94;

/**
 * Long benches. ONE piece of furniture per entry with several places along it —
 * the previous shape put one bench per SEAT, so two window seats 1.8 m apart
 * each grew their own 2.6 m bench and the two overlapped almost exactly, with
 * both occupants sitting in the middle of the wreckage.
 */
const BENCHES: readonly {
  id: string;
  lx: number;
  lz: number;
  face: number;
  length: number;
  /** Seat offsets along the bench's own long axis, metres from its centre. */
  seats: readonly number[];
}[] = [
  // ocean-window gallery: four benches down its length, all facing the horizon.
  // A bench is the one seat these blocky avatars read perfectly on, so the
  // gallery uses it rather than a steamer chair whose backrest and occupant
  // could never be made to agree.
  // Facing the horizon means facing local -x, and a seat with yaw f looks along
  // (-sin f, -cos f) — so that is f = +pi/2. These three carried -1.5, which
  // aims (+1, 0): the whole ocean gallery sat with its back to the Pacific,
  // staring at the inland wall. Caught by filming the bench from behind and
  // getting two faces looking down the lens.
  { id: "window-bench", lx: -36.2, lz: -3, face: Math.PI / 2, length: 2.4, seats: [-0.6, 0.6] },
  { id: "window-north", lx: -36.2, lz: -41, face: Math.PI / 2, length: 2.4, seats: [-0.6, 0.6] },
  { id: "window-south", lx: -36.2, lz: 21, face: Math.PI / 2, length: 2.4, seats: [-0.6, 0.6] },
  // north end of the great plunge, facing back down the hall
  { id: "north-bench", lx: -20, lz: -60.5, face: 0.05, length: 2.4, seats: [-0.62, 0.62] }
] as const;

/**
 * Where people sit. Tea chairs are derived from their table so the two can
 * never drift apart; loungers and benches are placed directly, since they face
 * the view rather than each other.
 */
export const SEATS: readonly SutroSeat[] = [
  ...TABLES.flatMap((table, index) =>
    table.chairs.map((bearing, seat): SutroSeat => ({
      id: `${table.id}-${seat + 1}`,
      lx: table.lx + Math.cos(bearing) * CHAIR_REACH,
      lz: table.lz + Math.sin(bearing) * CHAIR_REACH,
      // A seat looks along its local -z, which a yaw of f points at
      // (-sin f, -cos f); aiming that back at the table gives f = π/2 - bearing.
      face: Math.PI / 2 - bearing,
      kind: "chair",
      seatY: CHAIR_PAD_Y,
      hipY: CHAIR_PAD_Y + HIP_ABOVE_PAD,
      table: index
    }))
  ),
  // Bench places run along each bench's long axis, which for a seat facing
  // (-sin f, -cos f) is (cos f, -sin f).
  ...BENCHES.flatMap((bench) =>
    bench.seats.map((along, seat): SutroSeat => ({
      id: `${bench.id}-${seat + 1}`,
      lx: bench.lx + Math.cos(bench.face) * along,
      lz: bench.lz - Math.sin(bench.face) * along,
      face: bench.face,
      kind: "bench",
      seatY: BENCH_PAD_Y,
      hipY: BENCH_PAD_Y + HIP_ABOVE_PAD
    }))
  ),
] as const;

/**
 * Standing brass lamp posts. Only at the far EDGES of the hall — the ends of
 * each gallery and the way in. An avenue of them down the middle of the deck
 * flooded the room and flattened it; the candles below are the interior light,
 * and these just keep the corners from going black.
 */
const LAMP_POSTS: readonly { lx: number; lz: number }[] = [
  { lx: -35.8, lz: -62 },
  { lx: -35.8, lz: 56 },
  { lx: 29.6, lz: -62 },
  { lx: 29.6, lz: 56 },
  { lx: -7, lz: 62 }
] as const;

/**
 * Candlelight. This is what lights the hall now: many small warm points along
 * the coping, down the deck spine and on every table, each one a flame the size
 * of a thumbnail instead of a glowing globe the size of a head. A cluster is one
 * holder carrying `count` tapers.
 */
const CANDLE_CLUSTERS: readonly { lx: number; lz: number; count: number }[] = [
  // west coping, the whole length of the great plunge and its south court
  ...[-52, -44, -36, -28, -20, -12, -4, 4, 12, 20, 28, 36].map((lz) => ({ lx: -32.4, lz, count: 2 })),
  // The central deck spine between the plunge and the graduated baths. It
  // STOPS at z 16: past that the spine is under the great plunge's south court.
  ...[-56, -48, -40, -32, -24, -16, -8, 0, 8, 16].map((lz) => ({ lx: -7.2, lz, count: 3 })),
  // the cross promenade, where the spine meets the head of the bath column
  ...[0, 8, 16].map((lx) => ({ lx, lz: 18.3, count: 3 })),
  // east coping of the graduated baths
  ...[-50, -42, -34, -26, -18, -10, -2, 6, 14, 22, 30, 38].map((lz) => ({ lx: 20.6, lz, count: 2 })),
  // the ocean-window gallery rail
  ...[-56, -48, -24, -16, 8, 16, 40, 48].map((lz) => ({ lx: -36.6, lz, count: 2 })),
  // south promenade, framing the way in
  { lx: -18, lz: 52, count: 3 },
  { lx: 4, lz: 52, count: 3 }
] as const;

/** Taper height above the deck: on a slim coping holder, and on a tea table. */
const CANDLE_HOLDER_Y = 0.95;
const CANDLE_TABLE_Y = 0.84;

/** Folded towels left on the coping — small, but they say "people live here". */
const TOWELS: readonly { lx: number; lz: number; face: number; tone: number }[] = [
  { lx: -32.4, lz: -32, face: 0.3, tone: 0 },
  { lx: -32.4, lz: 12, face: -0.2, tone: 1 },
  { lx: -8.6, lz: -14, face: 1.4, tone: 2 },
  { lx: -8.6, lz: 17.4, face: 1.6, tone: 0 },
  { lx: 20.6, lz: -40, face: -1.5, tone: 1 },
  { lx: 20.6, lz: 3, face: -1.4, tone: 2 },
  { lx: -35.4, lz: -30, face: -1.5, tone: 1 }
] as const;

const TOWEL_TONES = [0xe9e2cf, 0xd9cdb4, 0xe4d5c6] as const;

const LAMP_GLOBE_Y = 2.45; // above the deck, on a period standard

type Batch = {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
};

export type SutroParlour = {
  group: THREE.Group;
  /** 0 = full daylight (lamps dark), 1 = deep twilight (lamps blazing). */
  setLampGlow(glow: number): void;
  stats: { tables: number; seats: number; lamps: number; candles: number; draws: number };
  dispose(): void;
};

/**
 * A downward-facing disc whose vertex alpha falls from a warm centre to nothing
 * at the rim, so an additive light pool has no visible edge. Two rings keep the
 * falloff from banding across a 2.5 m disc without paying for a texture.
 */
function lampPoolGeometry(radius: number): THREE.BufferGeometry {
  const segments = 22;
  const position: number[] = [0, 0, 0];
  const color: number[] = [1, 0.78, 0.5];
  const index: number[] = [];
  const rings = [
    { r: radius * 0.45, tint: [0.72, 0.53, 0.32] },
    { r: radius, tint: [0, 0, 0] }
  ];
  for (const ring of rings) {
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      position.push(Math.cos(angle) * ring.r, 0, Math.sin(angle) * ring.r);
      color.push(ring.tint[0], ring.tint[1], ring.tint[2]);
    }
  }
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    index.push(0, 1 + next, 1 + i);
    index.push(1 + i, 1 + next, 1 + segments + i);
    index.push(1 + next, 1 + segments + next, 1 + segments + i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Deck-height world placement for a pool-local point. */
function place(dummy: THREE.Object3D, lx: number, lz: number, y: number, yaw: number, scale = 1): void {
  const world = sutroLocalToWorld(lx, lz);
  dummy.position.set(world.x, SUTRO_BATHS.deckY + y, world.z);
  dummy.rotation.set(0, SUTRO_BATHS.yaw + yaw, 0);
  dummy.scale.setScalar(scale);
  dummy.updateMatrix();
}

function buildBatch(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  name: string,
  shadows = true,
  tint?: THREE.Color
): Batch {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.frustumCulled = false; // one batch spans the whole hall
  if (tint) {
    // Uniform per-batch tint through instanceColor. Every batch on the shared
    // furniture material must carry one, or the ones without it compile as a
    // second pipeline variant.
    for (let index = 0; index < count; index++) mesh.setColorAt(index, tint);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  return { mesh, geometry, material };
}

export function createSutroParlour(): SutroParlour {
  const group = new THREE.Group();
  group.name = "sutro_baths_parlour";

  const dummy = new THREE.Object3D();
  const batches: Batch[] = [];
  const track = <T extends Batch>(batch: T): T => {
    batches.push(batch);
    group.add(batch.mesh);
    return batch;
  };

  const chairs = SEATS.filter((seat) => seat.kind === "chair");

  // ---------------------------------------------------------------- materials
  // ONE furniture material for brass, timber, canvas and porcelain, tinted per
  // instance. Four near-identical MeshStandardMaterials were four more pipelines
  // to compile the moment a visitor arrives, and each compile window holds a
  // frame — the whole furniture set now costs exactly one.
  const furniture = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.66,
    metalness: 0.12
  });
  furniture.name = "sutro_parlour_furniture";
  const BRASS = new THREE.Color(0x8e7045);
  const TIMBER = new THREE.Color(0x7c4c34);
  const CANVAS = new THREE.Color(0xdfd3b4);
  const PORCELAIN = new THREE.Color(0xf4efe2);
  const globe = new THREE.MeshStandardMaterial({
    color: 0xfff0d2,
    roughness: 0.5,
    metalness: 0,
    emissive: new THREE.Color(0xffc98a),
    emissiveIntensity: 0
  });
  globe.name = "sutro_parlour_lamp_globe";
  // Additive, vertex-faded disc: a flat circle reads as a hard orange coin on
  // the deck, so the fan carries a bright centre out to a transparent rim and
  // the pool of light has an edge you cannot point at.
  // A soft ball of light around each globe. A sphere reads as a halo from any
  // angle without a per-frame billboard update, and additive blending with no
  // depth write keeps it out of the depth buffer entirely. The opacity falls off
  // toward the silhouette (squared view-facing normal), which is what separates
  // a glow from a flat orange coin stuck to the lamp.
  const haloGlow = uniform(0);
  const halo = new THREE.MeshBasicNodeMaterial({
    color: 0xffb877,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  halo.name = "sutro_parlour_lamp_halo";
  halo.opacityNode = pow(saturate((normalView as N).z), 2.4).mul(haloGlow) as N;
  const pool = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  pool.name = "sutro_parlour_lamp_pool";

  // ---------------------------------------------------------------- table tops
  const tableTop = track(buildBatch(
    new THREE.CylinderGeometry(0.52, 0.52, 0.055, 14),
    furniture,
    TABLES.length,
    "sutro_parlour_table_tops",
    true,
    TIMBER
  ));
  const tableStem = track(buildBatch(
    new THREE.CylinderGeometry(0.055, 0.13, 0.74, 10),
    furniture,
    TABLES.length,
    "sutro_parlour_table_stems",
    true,
    BRASS
  ));
  TABLES.forEach((table, index) => {
    place(dummy, table.lx, table.lz, 0.76, index * 0.7);
    tableTop.mesh.setMatrixAt(index, dummy.matrix);
    place(dummy, table.lx, table.lz, 0.37, index * 0.7);
    tableStem.mesh.setMatrixAt(index, dummy.matrix);
  });

  // ---------------------------------------------------------------- tea service
  // Pot, two cups and a tray per lamp-lit table: enough porcelain to read as
  // "someone is having tea" at deck distance, all in one instanced draw.
  const potGeometry = new THREE.SphereGeometry(0.09, 10, 7);
  const pots = track(buildBatch(
    potGeometry,
    furniture,
    TABLES.length * 4,
    "sutro_parlour_tea_service",
    true,
    PORCELAIN
  ));
  let potIndex = 0;
  TABLES.forEach((table, index) => {
    const spin = index * 1.31;
    place(dummy, table.lx - 0.22, table.lz + 0.14, 0.87, spin);
    pots.mesh.setMatrixAt(potIndex++, dummy.matrix);
    for (let cup = 0; cup < 3; cup++) {
      const angle = spin + cup * 2.1;
      place(
        dummy,
        table.lx + Math.cos(angle) * 0.26,
        table.lz + Math.sin(angle) * 0.26,
        0.82,
        angle,
        0.42
      );
      pots.mesh.setMatrixAt(potIndex++, dummy.matrix);
    }
  });

  // ---------------------------------------------------------------- chairs
  const chairSeat = track(buildBatch(
    new THREE.BoxGeometry(0.5, 0.06, 0.5),
    furniture,
    chairs.length,
    "sutro_parlour_chair_seats",
    true,
    TIMBER
  ));
  const chairBack = track(buildBatch(
    new THREE.BoxGeometry(0.5, 0.52, 0.05),
    furniture,
    chairs.length,
    "sutro_parlour_chair_backs",
    true,
    TIMBER
  ));
  const chairLegs = track(buildBatch(
    new THREE.CylinderGeometry(0.024, 0.024, 0.46, 6),
    furniture,
    chairs.length * 4,
    "sutro_parlour_chair_legs",
    true,
    BRASS
  ));
  let seatIndex = 0;
  let legIndex = 0;
  for (const seat of chairs) {
    // Pads are authored by their TOP surface, so drop the slab half-thickness.
    place(dummy, seat.lx, seat.lz, seat.seatY - 0.03, seat.face);
    chairSeat.mesh.setMatrixAt(seatIndex, dummy.matrix);
    // A seat faces its local -z, so the back rail sits at local +z behind it,
    // clear of the sitter's own hip block (0.24 m deep).
    const c = Math.cos(seat.face);
    const s = Math.sin(seat.face);
    const backOffset = 0.28;
    place(dummy, seat.lx - backOffset * s, seat.lz + backOffset * c, seat.seatY + 0.23, seat.face);
    chairBack.mesh.setMatrixAt(seatIndex, dummy.matrix);
    seatIndex++;
    for (let corner = 0; corner < 4; corner++) {
      const ox = corner % 2 ? 0.2 : -0.2;
      const oz = corner < 2 ? 0.2 : -0.2;
      place(dummy, seat.lx + ox * c - oz * s, seat.lz + ox * s + oz * c, seat.seatY - 0.26, seat.face);
      chairLegs.mesh.setMatrixAt(legIndex++, dummy.matrix);
    }
  }

  // ---------------------------------------------------------------- benches
  // One slab and one back rail per BENCH (not per seat), scaled to its length.
  const benchSeat = track(buildBatch(
    new THREE.BoxGeometry(1, 0.07, 0.52),
    furniture,
    BENCHES.length,
    "sutro_parlour_bench_seats",
    true,
    TIMBER
  ));
  const benchBack = track(buildBatch(
    new THREE.BoxGeometry(1, 0.4, 0.05),
    furniture,
    BENCHES.length,
    "sutro_parlour_bench_backs",
    true,
    TIMBER
  ));
  const benchLegs = track(buildBatch(
    new THREE.BoxGeometry(0.07, 0.45, 0.4),
    furniture,
    BENCHES.length * 2,
    "sutro_parlour_bench_legs",
    true,
    TIMBER
  ));
  let benchLegIndex = 0;
  BENCHES.forEach((bench, index) => {
    const c = Math.cos(bench.face);
    const s = Math.sin(bench.face);
    place(dummy, bench.lx, bench.lz, BENCH_PAD_Y - 0.035, bench.face);
    dummy.scale.set(bench.length, 1, 1);
    dummy.updateMatrix();
    benchSeat.mesh.setMatrixAt(index, dummy.matrix);
    // The backrest goes BEHIND the sitter, which is the reverse of the look
    // direction (-sin f, -cos f) — so +0.3 * (sin f, cos f). The x term used to
    // be negated, which is invisible on a bench facing along z (sin f ~ 0) and
    // puts the backrest across the sitter's chest on one facing along x.
    place(dummy, bench.lx + 0.3 * s, bench.lz + 0.3 * c, BENCH_PAD_Y + 0.2, bench.face);
    dummy.scale.set(bench.length, 1, 1);
    dummy.updateMatrix();
    benchBack.mesh.setMatrixAt(index, dummy.matrix);
    for (const end of [-1, 1]) {
      const along = end * (bench.length * 0.5 - 0.18);
      place(dummy, bench.lx + c * along, bench.lz - s * along, BENCH_PAD_Y - 0.26, bench.face);
      benchLegs.mesh.setMatrixAt(benchLegIndex++, dummy.matrix);
    }
  });

  // ---------------------------------------------------------------- towels
  const towels = track(buildBatch(
    new THREE.BoxGeometry(0.52, 0.09, 0.36),
    furniture,
    TOWELS.length,
    "sutro_parlour_folded_towels",
    true,
    CANVAS
  ));
  TOWELS.forEach((towel, index) => {
    place(dummy, towel.lx, towel.lz, 0.05, towel.face);
    towels.mesh.setMatrixAt(index, dummy.matrix);
    towels.mesh.setColorAt(index, new THREE.Color(TOWEL_TONES[towel.tone % TOWEL_TONES.length]));
  });
  if (towels.mesh.instanceColor) towels.mesh.instanceColor.needsUpdate = true;

  // ---------------------------------------------------------------- lamps
  // Five, at the edges. The globes are small and the floor pool is faint: these
  // exist so the far corners are not black, not to light the room.
  const lampPosts = track(buildBatch(
    new THREE.CylinderGeometry(0.045, 0.09, 2.34, 8),
    furniture,
    LAMP_POSTS.length,
    "sutro_parlour_lamp_posts",
    true,
    BRASS
  ));
  const lampGlobes = track(buildBatch(
    new THREE.SphereGeometry(0.15, 12, 9),
    globe,
    LAMP_POSTS.length,
    "sutro_parlour_lamp_globes",
    false
  ));
  const lampHalos = track(buildBatch(
    new THREE.SphereGeometry(0.46, 12, 9),
    halo,
    LAMP_POSTS.length,
    "sutro_parlour_lamp_halos",
    false
  ));
  lampHalos.mesh.renderOrder = 8;
  const lampPools = track(buildBatch(
    lampPoolGeometry(1.5),
    pool,
    LAMP_POSTS.length,
    "sutro_parlour_lamp_floor_pools",
    false
  ));
  lampPools.mesh.renderOrder = 6;
  LAMP_POSTS.forEach((lamp, index) => {
    place(dummy, lamp.lx, lamp.lz, 1.17, index * 0.6);
    lampPosts.mesh.setMatrixAt(index, dummy.matrix);
    place(dummy, lamp.lx, lamp.lz, LAMP_GLOBE_Y, 0);
    lampGlobes.mesh.setMatrixAt(index, dummy.matrix);
    lampHalos.mesh.setMatrixAt(index, dummy.matrix);
    place(dummy, lamp.lx, lamp.lz, 0.035, 0);
    lampPools.mesh.setMatrixAt(index, dummy.matrix);
  });

  // ---------------------------------------------------------------- candles
  // Every taper is a holder cup, a wax column, and a flame. The flame is a tiny
  // emissive bead with an equally tiny halo: bright enough to be a point of
  // light at any distance, far too small to wash out the room the way a globe
  // does. Four instanced draws for the whole hall.
  const candlePlaces: { lx: number; lz: number; y: number; spin: number; stand: boolean }[] = [];
  for (const [clusterIndex, cluster] of CANDLE_CLUSTERS.entries()) {
    for (let taper = 0; taper < cluster.count; taper++) {
      // Fan the tapers around their holder so a cluster reads as several flames.
      const angle = clusterIndex * 0.9 + (taper / Math.max(1, cluster.count)) * Math.PI * 2;
      const radius = cluster.count > 1 ? 0.075 : 0;
      candlePlaces.push({
        lx: cluster.lx + Math.cos(angle) * radius,
        lz: cluster.lz + Math.sin(angle) * radius,
        // Staggered heights read as hand-placed rather than machined.
        y: CANDLE_HOLDER_Y + ((clusterIndex + taper) % 3) * 0.022,
        spin: angle,
        stand: true
      });
    }
  }
  // A candle on every tea table, in place of the table lamps that used to sit there.
  for (const [tableIndex, table] of TABLES.entries()) {
    for (let taper = 0; taper < 2; taper++) {
      const angle = tableIndex * 1.7 + taper * Math.PI;
      candlePlaces.push({
        lx: table.lx + Math.cos(angle) * 0.17,
        lz: table.lz + Math.sin(angle) * 0.17,
        y: CANDLE_TABLE_Y + taper * 0.02,
        spin: angle,
        stand: false // standing on the table top
      });
    }
  }
  // …and one at each end of every bench.
  for (const bench of BENCHES) {
    const c = Math.cos(bench.face);
    const s = Math.sin(bench.face);
    for (const end of [-1, 1]) {
      const along = end * (bench.length * 0.5 + 0.22);
      candlePlaces.push({
        lx: bench.lx + c * along,
        lz: bench.lz - s * along,
        y: CANDLE_HOLDER_Y,
        spin: bench.face,
        stand: true
      });
    }
  }

  const standPlaces = candlePlaces.filter((candle) => candle.stand);
  const candleStands = track(buildBatch(
    new THREE.CylinderGeometry(0.016, 0.05, 0.62, 6),
    furniture,
    standPlaces.length,
    "sutro_parlour_candle_stands",
    false,
    BRASS
  ));
  const candleWax = track(buildBatch(
    new THREE.CylinderGeometry(0.019, 0.023, 0.15, 6),
    furniture,
    candlePlaces.length,
    "sutro_parlour_candle_tapers",
    false,
    CANVAS
  ));
  const candleFlames = track(buildBatch(
    new THREE.SphereGeometry(0.02, 6, 5),
    globe,
    candlePlaces.length,
    "sutro_parlour_candle_flames",
    false
  ));
  const candleHalos = track(buildBatch(
    new THREE.SphereGeometry(0.14, 8, 6),
    halo,
    candlePlaces.length,
    "sutro_parlour_candle_halos",
    false
  ));
  candleHalos.mesh.renderOrder = 8;
  standPlaces.forEach((candle, index) => {
    place(dummy, candle.lx, candle.lz, candle.y - 0.42, candle.spin);
    candleStands.mesh.setMatrixAt(index, dummy.matrix);
  });
  candlePlaces.forEach((candle, index) => {
    place(dummy, candle.lx, candle.lz, candle.y, candle.spin);
    candleWax.mesh.setMatrixAt(index, dummy.matrix);
    place(dummy, candle.lx, candle.lz, candle.y + 0.095, candle.spin);
    candleFlames.mesh.setMatrixAt(index, dummy.matrix);
    candleHalos.mesh.setMatrixAt(index, dummy.matrix);
  });

  for (const batch of batches) {
    batch.mesh.instanceMatrix.needsUpdate = true;
    batch.mesh.computeBoundingSphere();
  }

  let disposed = false;

  return {
    group,
    setLampGlow(glow) {
      const g = THREE.MathUtils.clamp(glow, 0, 1);
      globe.emissiveIntensity = g * 3.1;
      // The globe body itself lifts off its unlit grey as the lamp warms.
      globe.color.setRGB(0.86 + g * 0.14, 0.82 + g * 0.12, 0.72 + g * 0.1);
      pool.opacity = g * 0.09;
      haloGlow.value = g * 0.44;
      lampPools.mesh.visible = g > 0.02;
      lampHalos.mesh.visible = g > 0.02;
      candleHalos.mesh.visible = g > 0.02;
      candleFlames.mesh.visible = g > 0.02;
    },
    stats: {
      tables: TABLES.length,
      seats: SEATS.length,
      lamps: LAMP_POSTS.length,
      candles: candlePlaces.length,
      draws: batches.length
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const batch of batches) {
        batch.mesh.removeFromParent();
        batch.mesh.dispose();
        batch.geometry.dispose();
      }
      for (const material of [furniture, globe, halo, pool]) material.dispose();
      group.removeFromParent();
    }
  };
}
