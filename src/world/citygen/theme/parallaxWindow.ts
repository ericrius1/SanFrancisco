// Parallax / raymarched interior windows for the SF procedural buildings.
//
// The grammar (facadeKit.faceWindow) emits each glass pane as a flat quad. This
// material fakes a shallow recessed ROOM behind that glass: a view ray is
// intersected with a small box (floor / ceiling / back wall / side walls) in the
// pane's local frame, so the apparent room shifts correctly as the camera moves
// (parallax) and each window reads as its own lit or dark room. It's the same
// technique the baked city uses (see src/world/facade.ts, the `interiorOn` /
// `boxMin`/`boxMax` / `falloffAt` block) — reused here, simplified, and made
// ZONE-BASED (a residential parlor vs. a bright shopfront vs. a dark loft) rather
// than a literal furniture recreation.
//
// --- how it gets a per-pane coordinate WITHOUT touching core -----------------
// core/facade.ts PanelBuilder.quad writes each pane's UVs as (metres / UV_SCALE)
// measured from that pane's own bottom-left corner — every pane restarts at (0,0)
// with its own vertices, so uv() is a clean per-pane-LOCAL coordinate with no
// cross-pane continuity (no seams). Multiplying by UV_SCALE recovers the true
// metric offset from the corner, which we use two ways:
//   1. build the room box in real metres, and
//   2. reconstruct the pane's WORLD corner (positionWorld − uAxis·u − up·v). That
//      corner is invariant across the whole pane, giving a per-window hash that
//      can never straddle a boundary (so a window is never half-lit / half-dark).
// Because the metric UVs are already usable this way, faceWindow's UVs are left
// untouched. The one hard dependency: UV_SCALE below MUST equal core's UV_SCALE.
import * as THREE from "three/webgpu";
import {
  positionWorld,
  normalWorldGeometry,
  cameraPosition,
  uv,
  float,
  vec2,
  vec3,
  vec4,
  color,
  mix,
  smoothstep,
  step,
  floor,
  hash,
  uint,
  select,
  dot,
  normalize,
  pow,
  If,
  Fn,
} from "three/tsl";
import { LIGHT_SCALE } from "../../../config";

// TSL node generics fight composition; `any` is the idiom used across this app's
// node-material code (see facade.ts).
type N = any;

// Colour lesson (see theme/materials.ts header): three/tsl `color(rawInt)` reads
// the int as GRAYSCALE under this engine, so always build through THREE.Color.
const col = (hex: number): N => color(new THREE.Color(hex));

// MUST match core/facade.ts PanelBuilder UV_SCALE. Panel UVs are metres/UV_SCALE,
// so uv()*UV_SCALE == metric offset from the pane's bottom-left corner. If core's
// UV_SCALE changes, the corner reconstruction below silently drifts — change both.
const UV_SCALE = 3.0;

export type ParallaxZone = "residential" | "commercial" | "loft";

interface ZoneLook {
  cellW: number; // nominal pane width (m) — the room box is centred on this
  cellH: number; // nominal pane height (m)
  depth: number; // how far the room recedes behind the glass (m)
  litChance: number; // fraction of windows with a light on (0..1)
  ambient: number; // baseline room brightness (loft reads darker)
  glass: number; // flat glass tint shown when the interior is faded out
  back: [number, number]; // back-wall colour range (mixed by a per-cell hash)
  wall: [number, number]; // side-wall colour range
  floor: [number, number]; // floor colour range
  ceil: number; // ceiling base colour
  light: [number, number]; // lamp colour range (warm → cool)
}

// Zone → look. Depth/brightness/light-frequency are the main knobs:
//  • residential: warm parlor — mid depth, wood floor, ~1/4 lit, warm lamps.
//  • commercial:  bright shopfront — shallow + wide, pale walls, mostly lit, cool.
//  • loft:        deeper + darker industrial room — brick/greys, sparsely lit.
const ZONES: Record<ParallaxZone, ZoneLook> = {
  residential: {
    cellW: 1.5,
    cellH: 2.4,
    depth: 2.7,
    litChance: 0.26,
    ambient: 0.62,
    glass: 0x20262b,
    back: [0x6f5f49, 0x8c7c62], // warm plaster
    wall: [0x7a6b53, 0x9a8b70],
    floor: [0x4a3524, 0x6a4c30], // wood boards
    ceil: 0xb7ad98,
    light: [0xffb845, 0xffe4a0], // warm bulbs
  },
  commercial: {
    cellW: 2.8,
    cellH: 3.2,
    depth: 1.9,
    litChance: 0.68,
    ambient: 0.9,
    glass: 0x28323a,
    back: [0xb8bcc0, 0xd6dade], // pale shop wall
    wall: [0xaeb4b8, 0xccd2d6],
    floor: [0x8f8b82, 0xb4b0a6], // light retail floor
    ceil: 0xe6eaee,
    light: [0xfff2d0, 0xdfeaff], // bright, cooler retail lighting
  },
  loft: {
    cellW: 1.6,
    cellH: 2.7,
    depth: 3.3,
    litChance: 0.16,
    ambient: 0.42,
    glass: 0x181c20,
    back: [0x4a4038, 0x6a5a4a], // exposed brick / dark plaster
    wall: [0x413a34, 0x5a5048],
    floor: [0x3a3024, 0x53442f],
    ceil: 0x6a625a,
    light: [0xffa838, 0xffcf78], // sparse warm bulbs
  },
};

/**
 * A node material whose colour/emissive raymarches a shallow zone-appropriate
 * room behind each glass pane (parallax), with a glassy sky-reflection sheen on
 * top, and distance + grazing fades so it degrades to flat dark glass rather than
 * smearing into long shards at glancing angles. DoubleSide (the grammar's quad
 * winding isn't guaranteed outward). Drop-in replacement for the old flat glass.
 */
export function makeParallaxGlass(
  opts: { zone?: ParallaxZone; seed?: number } = {}
): THREE.Material {
  const look = ZONES[opts.zone ?? "residential"];
  const seedInt = Math.floor(opts.seed ?? 0) & 0xffff;

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.14,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  mat.envMapIntensity = 1.0;

  const pw = positionWorld;
  const nrm = normalWorldGeometry;
  const dist = pw.distance(cameraPosition);

  // view ray (camera → fragment) and how square-on we're looking at the pane
  const viewDir = normalize(pw.sub(cameraPosition));
  const facing = dot(viewDir, nrm).negate(); // >0 on the front face, →0 at grazing

  // Grazing views turn the interior slab into long shards that slide wildly with
  // any camera move (the depth divisor collapses toward 0), and real glass mirrors
  // out at grazing incidence anyway — so fade the room to flat glass there. Also
  // fade with distance (the room detail is sub-pixel far off).
  const grazeFade = smoothstep(0.05, 0.22, facing);
  const interiorOn = smoothstep(340.0, 200.0, dist).mul(grazeFade);

  // pane-local frame: uAxis runs horizontally across the wall, world-up runs up.
  const uAxis = normalize(vec3(nrm.z, float(0.0), nrm.x.negate()));
  const upAxis = vec3(0.0, 1.0, 0.0);

  // per-pane-local metric coordinate (metres from the pane's bottom-left corner)
  const luv = uv().mul(UV_SCALE);
  const lu = luv.x;
  const lv = luv.y;

  // Reconstruct the pane's world corner — invariant across the whole pane, so it
  // hashes to ONE stable id per window (never straddles → never half-lit).
  const corner = pw.sub(uAxis.mul(lu)).sub(upAxis.mul(lv));
  const HK = 0.85; // hash grid: fine enough that neighbouring panes differ
  const cx = floor(corner.x.mul(HK));
  const cy = floor(corner.y.mul(HK));
  const cz = floor(corner.z.mul(HK));
  const cellKey = uint(cx.add(8192))
    .mul(uint(73856093))
    .bitXor(uint(cy.add(8192)).mul(uint(19349663)))
    .bitXor(uint(cz.add(8192)).mul(uint(83492791)))
    .bitXor(uint(seedInt + 1).mul(uint(2654435761)))
    .toVar();
  const h = (k: number): N => hash(cellKey.add(uint(k)));

  // per-window identity: lit/dark + colours + lamp tint
  const lit = step(float(1.0 - look.litChance), h(3)); // litChance fraction lit
  const lightCol = mix(col(look.light[0]), col(look.light[1]), h(4));
  const seedA = h(11);
  const seedB = h(12);
  const backCol = mix(col(look.back[0]), col(look.back[1]), seedA);
  const wallCol = mix(col(look.wall[0]), col(look.wall[1]), seedB);
  const floorCol = mix(col(look.floor[0]), col(look.floor[1]), seedA);
  const ceilBase = col(look.ceil);

  const flatGlass = col(look.glass);

  // --- the interior raymarch (pure ALU; the If is safe — no mx_noise inside) ---
  // Runs behind an If so far / near-grazing fragments skip it, which TSL only
  // allows inside a Fn body — the whole room is therefore an IIFE node. Default
  // (branch skipped) is flat dark glass with no emissive.
  const room: N = Fn(() => {
    const out = vec4(flatGlass, 0.0).toVar();
    If(interiorOn.greaterThan(0.004), () => {
      // view ray in the pane's local frame: x across, y up, z INTO the wall.
      // The z divisor is floored so grazing rays can't explode into NaN shards.
      const dir = vec3(dot(viewDir, uAxis), viewDir.y, facing.max(0.02));

      const halfW = float(look.cellW * 0.5);
      const halfH = float(look.cellH * 0.5);
      const setback = float(0.06); // small recess so the glass isn't flush with the back
      const depth = float(look.depth);
      const boxMin = vec3(halfW.negate(), halfH.negate(), setback);
      const boxMax = vec3(halfW, halfH, setback.add(depth));
      // fragment origin on the glass plane, centred on the nominal pane
      const origin = vec3(lu.sub(halfW), lv.sub(halfH), float(0.0));

      // slab method: the far plane the ray exits through = the visible room wall
      const tFar = boxMin.sub(origin).div(dir).max(boxMax.sub(origin).div(dir));
      const t = tFar.x.min(tFar.y).min(tFar.z);
      const hitP = origin.add(dir.mul(t));
      const q = hitP.sub(boxMin).div(boxMax.sub(boxMin)); // 0..1 inside the box

      const onBack = q.z.greaterThan(0.995);
      const onCeil = q.y.greaterThan(0.995);
      const onFloor = q.y.lessThan(0.005);

      // ceiling lamp: a soft warm disc, much brighter when the room is lit
      const lampDist = vec2(q.x.sub(0.5), q.z.sub(0.5)).length();
      const lampMask = smoothstep(0.3, 0.16, lampDist);
      const ceilCol = mix(ceilBase, lightCol.mul(mix(float(1.0), float(5.0), lit)), lampMask);

      // pick the exit face's colour (mutually exclusive except at box edges)
      const shell = select(onBack, backCol, select(onCeil, ceilCol, select(onFloor, floorCol, wallCol)));

      // soft corner ambient occlusion so the box doesn't read flat-lit
      const aoEdge = (a: N): N => smoothstep(0.0, 0.14, a).mul(smoothstep(0.0, 0.14, a.oneMinus()));
      const edgeAO = select(
        onBack,
        aoEdge(q.x).mul(aoEdge(q.y)),
        select(onFloor.or(onCeil), aoEdge(q.x).mul(aoEdge(q.z)), aoEdge(q.y).mul(aoEdge(q.z)))
      );
      const ao = mix(float(0.68), float(1.0), edgeAO);

      // darker toward the back of the room + overall warm-up when a light is on
      const zFrac = hitP.z.sub(setback).div(depth).clamp(0.0, 1.0);
      const falloff = mix(float(1.0), float(0.42), zFrac);
      const warmth = mix(vec3(1.0, 1.0, 1.0), lightCol, lit.mul(0.8));

      const roomCol = shell
        .mul(ao)
        .mul(falloff)
        .mul(warmth)
        .mul(float(look.ambient))
        .mul(mix(float(1.0), float(1.6), lit));
      out.assign(vec4(roomCol, lit));
    });
    return out;
  })();

  // --- compose the visible glass surface ---------------------------------------
  // room shows through, fading to flat glass with distance + grazing angle
  const interior = mix(flatGlass, room.xyz, interiorOn);

  // a subtle sky reflection on top so it reads as glass, not a painted hole. The
  // reflected ray's up-component picks horizon vs. zenith; a Fresnel term makes
  // the sheen ramp up toward grazing (where the room has already faded out).
  const refl = viewDir.sub(nrm.mul(dot(viewDir, nrm).mul(2.0)));
  const skyCol = mix(col(0x9db6d2), col(0xd8e6f2), refl.y.clamp(0.0, 1.0));
  const fresnel = pow(facing.oneMinus().clamp(0.0, 1.0), float(4.0));
  const surface = mix(interior, skyCol, fresnel.mul(0.55));

  // --- emissive: lit rooms glow; far lit panes keep a flat warm sparkle --------
  const EMIT = 2.0 * LIGHT_SCALE; // matches the baked city's window-glow scale
  const FAR = 0.55 * LIGHT_SCALE;
  const glowGraze = smoothstep(0.02, 0.06, facing);
  const emissive = room.xyz
    .mul(room.w) // room.w == lit flag → 0 for dark rooms
    .mul(interiorOn)
    .mul(EMIT)
    .add(lightCol.mul(lit).mul(interiorOn.oneMinus()).mul(glowGraze).mul(FAR));

  mat.colorNode = surface;
  mat.emissiveNode = emissive;
  mat.metalnessNode = float(0.0);
  return mat;
}
