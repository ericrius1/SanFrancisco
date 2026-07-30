/**
 * Waves crashing on the ground at Ocean Beach.
 *
 * One thin sheet laid over the beach face, from a little below the waterline to
 * well above the highest run-up. It draws four things at once, all from the
 * analytic wash in ./swash.ts:
 *
 *   the bore     — broken water arriving under its own momentum, with real
 *                  height, so a low look down the beach sees a lip and not a
 *                  decal painted on flat sand
 *   the sheet    — thin water sliding up the face, then draining back
 *   the lace     — fizzing foam on the leading rim, and the streaks it strands
 *   the wet sand — the dark, glossy band the water leaves, drying from the
 *                  top of the beach down, still remembering the last two waves
 *
 * The mesh is static and cheap: the beach profile is traced off the heightmap
 * once, and every vertex carries the four numbers the shader needs (its sand
 * elevation, its row's true waterline, how far a metre of climb runs at this
 * slope, and an end-of-beach fade). Everything that moves is a function of
 * world position and time, so there is no per-frame CPU work beyond a clock.
 */

import * as THREE from "three/webgpu";
import {
  attribute,
  color,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionLocal,
  positionWorld,
  saturate,
  smoothstep,
  uniform,
  vec3
} from "three/tsl";
import { materializeAmount } from "../../render/materialize";
import { oceanBeachApproxShoreX } from "../oceanBeachWaves";
import type { WorldMap } from "../heightmap";
import { SHOREBREAK, shorebreakHandoff, swashState, swashWetness } from "./swash";
import { writeSsrMask } from "../../render/post/shared/gbuffer";

type N = any;

/**
 * Along-beach extent. Pulled in from the surf strip's 1280…4920 at the north
 * end, where the sand gives out into the Sutro headland's rock and the beach
 * profile stops being a beach profile.
 */
const Z_START = 1380;
const Z_END = 4930;
/** One row every 5 m along the beach; one column every ~2.5 m across it. */
const ROW_STEP = 5;
const COLS = 30;
/**
 * Elevation band the sheet covers. The low edge sits under the ocean handoff
 * (so the two sheets overlap rather than leave a gap) and the high edge clears
 * the biggest run-up with room for the bore's lift.
 */
const BAND_LOW_Y = -1.7;
const BAND_HIGH_Y = 4.8;
/** Rows per drawn chunk — small enough that frustum culling is worth something. */
const ROWS_PER_CHUNK = 64;
/** Metres of z-fade at each end of the beach so the sheet does not just stop. */
const END_FADE = 160;
/** Beyond this along-beach distance from the player a chunk is not drawn. */
const CHUNK_DRAW_DISTANCE = 1500;

type BeachRow = {
  z: number;
  /** True waterline X for this row — the y=0 crossing of the real terrain. */
  shoreX: number;
  xLow: number;
  xHigh: number;
  /** Horizontal metres of run per metre of climb (1 / beach slope). */
  run: number;
  weight: number;
};

/**
 * Walk shoreward from deep water until the sand comes up through sea level.
 * `guess` seeds a narrow window; the caller carries the previous row's answer
 * forward so this stays a ~200-sample scan instead of a ~600 m sweep.
 */
function findWaterline(map: WorldMap, z: number, guess: number, reach: number): number | null {
  const from = guess - reach;
  const to = guess + reach;
  let prev = map.groundTop(from, z);
  for (let x = from + 1; x <= to; x += 1) {
    const h = map.groundTop(x, z);
    if (prev < 0 && h >= 0) return x - 1 + -prev / (h - prev);
    prev = h;
  }
  return null;
}

/** March away from the waterline until the terrain reaches `targetY`. */
function walkToElevation(
  map: WorldMap,
  z: number,
  startX: number,
  targetY: number,
  dir: 1 | -1,
  maxDist: number
): number {
  for (let d = 0; d <= maxDist; d += 1.5) {
    const x = startX + dir * d;
    const h = map.groundTop(x, z);
    if (dir < 0 ? h <= targetY : h >= targetY) return x;
  }
  return startX + dir * maxDist;
}

/** Trace the beach profile once, row by row along the sand. */
function traceBeachRows(map: WorldMap): BeachRow[] {
  const rows: BeachRow[] = [];
  let guess = oceanBeachApproxShoreX(Z_START);
  let reach = 190;
  for (let z = Z_START; z <= Z_END; z += ROW_STEP) {
    const found = findWaterline(map, z, guess, reach);
    // A row with no clean crossing (rock, a gap in the sand) keeps its
    // neighbour's geometry and fades to nothing rather than tearing the strip.
    const shoreX = found ?? guess;
    if (found !== null) {
      guess = found;
      reach = 55; // rows are 5 m apart; the waterline never moves far between them
    }
    const xLow = walkToElevation(map, z, shoreX, BAND_LOW_Y, -1, 190);
    const xHigh = walkToElevation(map, z, shoreX, BAND_HIGH_Y, 1, 220);
    const slope = (map.groundTop(shoreX + 14, z) - map.groundTop(shoreX - 14, z)) / 28;
    const span = xHigh - xLow;
    const endFade =
      Math.min(1, (z - Z_START) / END_FADE) * Math.min(1, (Z_END - z) / END_FADE);
    const usable = found !== null && span > 14 && span < 260 && slope > 0.012;
    rows.push({
      z,
      shoreX,
      xLow,
      xHigh: usable ? xHigh : xLow + 40,
      run: THREE.MathUtils.clamp(1 / Math.max(0.02, slope), 5, 26),
      weight: usable ? endFade : 0
    });
  }
  return rows;
}

/** One drawable slab of the strip: rows [start, end] inclusive. */
function buildChunk(map: WorldMap, rows: BeachRow[], start: number, end: number): THREE.BufferGeometry {
  const rowCount = end - start + 1;
  const count = rowCount * COLS;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const sandY = new Float32Array(count);
  const shoreX = new Float32Array(count);
  const run = new Float32Array(count);
  const edge = new Float32Array(count);

  for (let r = 0; r < rowCount; r++) {
    const row = rows[start + r];
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const x = row.xLow + ((row.xHigh - row.xLow) * c) / (COLS - 1);
      const y = map.groundTop(x, row.z);
      // Real terrain normal: the sheet has to catch the sun the way the sand
      // under it does, or the wet band reads as a sticker.
      const hx = (map.groundTop(x + 2, row.z) - map.groundTop(x - 2, row.z)) / 4;
      const hz = (map.groundTop(x, row.z + 2) - map.groundTop(x, row.z - 2)) / 4;
      const inv = 1 / Math.hypot(hx, 1, hz);
      position[i * 3] = x;
      position[i * 3 + 1] = y + SHOREBREAK.lift;
      position[i * 3 + 2] = row.z;
      normal[i * 3] = -hx * inv;
      normal[i * 3 + 1] = inv;
      normal[i * 3 + 2] = -hz * inv;
      sandY[i] = y;
      shoreX[i] = row.shoreX;
      run[i] = row.run;
      // Feather the shoreward lip of the strip too: above the highest run-up
      // there is nothing to draw, and a hard geometry edge up there would be
      // visible on the few frames a huge set reaches it.
      edge[i] = row.weight * Math.min(1, (COLS - 1 - c) / 2.5);
    }
  }

  const indices = new Uint32Array((rowCount - 1) * (COLS - 1) * 6);
  let k = 0;
  for (let r = 0; r < rowCount - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      indices[k++] = a;
      indices[k++] = a + COLS;
      indices[k++] = a + 1;
      indices[k++] = a + 1;
      indices[k++] = a + COLS;
      indices[k++] = a + COLS + 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("aSandY", new THREE.BufferAttribute(sandY, 1));
  geometry.setAttribute("aShoreX", new THREE.BufferAttribute(shoreX, 1));
  geometry.setAttribute("aRun", new THREE.BufferAttribute(run, 1));
  geometry.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Everything the surface does, from one evaluation of the wash. Shared by the
 * vertex stage (which only wants the bore's height) and the fragment stage.
 */
function shorebreakSurface(z: N, sandY: N, shoreX: N, run: N, t: N, jitter: N | null = null) {
  const state = swashState(z, shoreX, t);
  const surfaceY = jitter ? state.runupY.add(jitter) : state.runupY;
  const depth = surfaceY.sub(sandY).toVar();
  // Horizontal metres behind the leading edge — the natural ruler for foam,
  // and the one that automatically stretches where the beach flattens out.
  const behind = depth.mul(run).toVar();
  const covered = smoothstep(0, 0.025, depth).toVar();
  // 1 while the wave is still slamming in, 0 once it is only draining back.
  const rush = smoothstep(0, SHOREBREAK.upFraction * 0.85, state.u).oneMinus().toVar();
  const front = smoothstep(0, SHOREBREAK.boreReach, behind).oneMinus().toVar();
  return { state, depth, behind, covered, rush, front };
}

const WET_SAND = /*@__PURE__*/ color(0x45382a);
const SHALLOW = /*@__PURE__*/ color(0x2c6f69);
const FOAM = /*@__PURE__*/ color(0xeff5f3);

export class OceanBeachShorebreak {
  readonly group = new THREE.Group();
  #uTime = uniform(0);
  /** Soft fade-in so the sheet does not pop into a frame the player is watching. */
  #uAmount = uniform(0);
  #amount = 0;
  #material: THREE.MeshStandardNodeMaterial;
  #chunks: { mesh: THREE.Mesh; z: number }[] = [];
  #rows: BeachRow[];
  #debugTime: number | null = null;

  constructor(map: WorldMap) {
    this.group.name = "ocean_beach_shorebreak";
    this.#material = this.#createMaterial();

    const rows = traceBeachRows(map);
    this.#rows = rows;
    for (let start = 0; start < rows.length - 1; start += ROWS_PER_CHUNK) {
      const end = Math.min(rows.length - 1, start + ROWS_PER_CHUNK);
      const geometry = buildChunk(map, rows, start, end);
      const mesh = new THREE.Mesh(geometry, this.#material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      // Transparent, so it draws after the opaque sand and after the ocean —
      // which is what lets the ocean's own surface occlude the sheet's foot.
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.#chunks.push({ mesh, z: (rows[start].z + rows[end].z) / 2 });
    }
  }

  #createMaterial(): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial({
      transparent: true,
      depthWrite: false,
      metalness: 0
    });
    // The sheet lives 7 cm off the sand; at a grazing look down a 3 km beach
    // that is not enough on its own once the terrain drops to a coarser LOD.
    // Signs are POSITIVE here: the renderer runs a reversed depth buffer
    // (renderCore.ts), so a positive bias is the one that pulls toward the
    // camera. Negative offsets bury the whole sheet under the sand.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 2;
    material.polygonOffsetUnits = 4;

    const t = this.#uTime;
    const sandY: N = attribute("aSandY", "float");
    const shoreX: N = attribute("aShoreX", "float");
    const run: N = attribute("aRun", "float");
    const edge: N = attribute("aEdge", "float");

    // --- vertex: give the bore real thickness -----------------------------
    {
      const s = shorebreakSurface(positionLocal.z, sandY, shoreX, run, t);
      const lip = s.covered.mul(s.front).mul(s.rush.mul(0.72).add(0.28));
      material.positionNode = positionLocal.add(
        vec3(0, lip.mul(SHOREBREAK.boreLift).mul(this.#uAmount), 0)
      );
    }

    // --- fragment ---------------------------------------------------------
    const p = positionWorld.xz.toVar();
    // A wash edge is never a clean contour: the sheet finds the low ground and
    // throws tongues of water ahead of itself. Displacing the water LINE (in
    // elevation, world-locked, drifting slowly) rather than fading the alpha
    // is what buys those tongues — and it costs the same two noise fetches.
    const edgeJitter = mx_noise_float(vec3(p.x.mul(0.05), p.y.mul(0.055), t.mul(0.09)))
      .mul(0.17)
      .add(mx_noise_float(vec3(p.x.mul(0.22), p.y.mul(0.24), t.mul(0.4))).mul(0.05))
      .toVar();
    const s = shorebreakSurface(p.y, sandY, shoreX, run, t, edgeJitter);
    const wet = swashWetness(sandY, s.state).toVar();

    // Foam lace rides WITH the front: measuring it behind the edge glues the
    // fizz to the water's leading line as it races up the sand.
    const lace = mx_fractal_noise_float(
      vec3(s.behind.mul(0.38), p.y.mul(0.34), t.mul(0.6)),
      3
    ).mul(0.5).add(0.5).toVar();
    const fizz = mx_noise_float(vec3(s.behind.mul(1.5), p.y.mul(1.4), t.mul(2.1)))
      .mul(0.5)
      .add(0.5)
      .toVar();
    // Sand foam is world-locked instead: what the water strands stays stuck to
    // the beach and does not slide along under the next wash.
    const grime = mx_noise_float(vec3(p.x.mul(0.42), p.y.mul(0.3), t.mul(0.03)))
      .mul(0.5)
      .add(0.5)
      .toVar();

    const rim = smoothstep(0, SHOREBREAK.edgeReach, s.behind).oneMinus();
    // The crash itself: thick, bright, turbulent, and spent within a few
    // seconds of the wave arriving. Mostly solid white — a bore is aerated
    // water, not a tint — with the noise only breaking up its trailing edge.
    const boreFoam = s.covered
      .mul(s.front)
      .mul(s.rush)
      .mul(smoothstep(0.18, 0.66, lace).mul(0.3).add(0.7));
    // The lacy leading rim outlives the bore and thins out on the drain, and
    // the last hand's width of it is the bright line the eye actually tracks.
    const rimFoam = s.covered
      .mul(rim)
      .mul(smoothstep(0.2, 0.6, lace.mul(0.6).add(fizz.mul(0.4))));
    const lip = s.covered.mul(smoothstep(0, 1.3, s.behind).oneMinus()).mul(0.9);
    // Streaks and patches stranded on sand the sheet has already left. Cubing
    // the wetness confines them to the last few seconds behind the retreating
    // edge — spread over the whole wet band they wash it out to a pale smear,
    // which is the opposite of what a wet beach looks like.
    const residue = wet
      .mul(wet)
      .mul(wet)
      .mul(s.covered.oneMinus())
      .mul(smoothstep(0.6, 0.92, grime))
      .mul(0.45);
    const foam = saturate(max(max(boreFoam, max(rimFoam, lip)), residue)).toVar();
    // Swash on sand is centimetres deep and nearly clear — the darkened sand
    // shows straight through it. Only down by the waterline, where there is a
    // real body of water standing over the bed, does it take on the sea's
    // colour, so both the tint and the film's own opacity ramp slowly.
    const film = s.covered.mul(smoothstep(0, 0.35, s.depth)).toVar();

    const albedo = mix(WET_SAND, SHALLOW, saturate(s.depth.mul(0.8)));
    material.colorNode = mix(albedo, FOAM, foam);
    // Wet sand and thin water are glossy — that low-sun sheen off a just-washed
    // beach is most of what sells the effect. Foam is not. Not TOO glossy,
    // though: a mirror-smooth sheet this wide turns the sun into one blown-out
    // disc lying on the beach.
    material.roughnessNode = mix(float(0.52), float(0.92), foam);
    material.opacityNode = saturate(max(max(wet.mul(0.5), film.mul(0.62)), foam.mul(0.95)))
      .mul(edge)
      .mul(shorebreakHandoff(sandY))
      .mul(this.#uAmount)
      .mul(materializeAmount()); // spatial front sweep (collapses to 1 once revealed)
    // SSR opt-in, from the same two nodes the shading already uses: `wet` says
    // how wet the sand still is, `foam` says how much of the pixel is aerated
    // spray. Aerated water has no specular surface to reflect in — the
    // roughnessNode above already ramps to 0.92 under foam for exactly this
    // reason — so the mask carries the same complementarity and the mirror can
    // never contradict the gloss.
    //
    // NOTE for integration: this material is transparent, and MRT attachments
    // other than `output` are `_noBlending` (MRTNode.js:110), so this sheet
    // OVERWRITES the terrain's gbuffer wherever it draws, at full weight, even
    // where its own opacity is near zero. That is benign here only because the
    // terrain writes the same kind of signal underneath (terrainClipmap's
    // `wetSand`) over the same band; it is not a general licence.
    writeSsrMask(material, wet.mul(foam.oneMinus()));
    return material;
  }

  /**
   * Harness hook: pin the wash clock so a shot lands on a chosen wave phase.
   * Every wave here differs — set rhythm, per-wave grain, along-beach cusps —
   * so wall-clock screenshots sample an arbitrary wave and two runs are not
   * comparable. Pass null to hand the clock back to the world.
   */
  setDebugTime(time: number | null): void {
    this.#debugTime = time;
  }

  /** `focus` is the player: only the slabs of beach near them are drawn. */
  update(time: number, dt: number, focus: THREE.Vector3): void {
    this.#uTime.value = this.#debugTime ?? time;
    this.#amount = Math.min(1, this.#amount + dt / 0.7);
    this.#uAmount.value = this.#amount;
    for (const chunk of this.#chunks) {
      chunk.mesh.visible = Math.abs(chunk.z - focus.z) < CHUNK_DRAW_DISTANCE;
    }
  }

  /** Read-only surface for the shot harness — what did the beach trace find? */
  debugState() {
    return {
      chunks: this.#chunks.length,
      amount: this.#amount,
      visible: this.#chunks.filter((c) => c.mesh.visible).length,
      rows: this.#rows
        .filter((_, i) => i % 60 === 0)
        .map((r) => ({
          z: r.z,
          shoreX: Math.round(r.shoreX * 10) / 10,
          span: Math.round((r.xHigh - r.xLow) * 10) / 10,
          run: Math.round(r.run * 10) / 10,
          weight: Math.round(r.weight * 100) / 100
        }))
    };
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const chunk of this.#chunks) chunk.mesh.geometry.dispose();
    this.#material.dispose();
    this.#chunks.length = 0;
  }
}
