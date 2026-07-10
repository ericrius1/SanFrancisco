// Simple flat-glass windows for the SF procedural buildings.
//
// The grammar (facadeKit.faceWindow) emits each glass pane as a flat quad. This
// material draws that pane as SIMPLE glass — no fake interior. By day it's a dark
// zone-tinted pane lifted toward a cool sky sheen at grazing angles (a cheap
// fresnel); at night a per-pane hash decides which panes are "lit" and those emit
// a warm glow. (The old version raymarched a shallow parallax room behind every
// pane — removed: it was a look-and-fragment-cost sink, and the citygen buildings
// have REAL walkable interiors behind them anyway.)
//
// The function/type names are kept (`makeParallaxGlass`, `ParallaxZone`) so the
// render/material wiring is unchanged; only the shader body simplified.
//
// --- per-pane identity WITHOUT touching core ---------------------------------
// core/facade.ts PanelBuilder.quad writes each pane's UVs as (metres / UV_SCALE)
// from that pane's own bottom-left corner, so uv()*UV_SCALE is a per-pane-LOCAL
// metric offset. We reconstruct the pane's WORLD corner (positionWorld − uAxis·u
// − up·v); that corner is invariant across the whole pane, giving a per-window
// hash that can never straddle a boundary (a window is never half-lit/half-dark).
// The one hard dependency: UV_SCALE below MUST equal core's UV_SCALE.
import * as THREE from "three/webgpu";
import {
  positionWorld,
  normalWorldGeometry,
  cameraPosition,
  uv,
  float,
  vec3,
  color,
  mix,
  smoothstep,
  step,
  floor,
  hash,
  uint,
  dot,
  normalize,
} from "three/tsl";
import { LIGHT_SCALE } from "../../../config";
import { WINDOW_GLOW_W } from "../../facade";

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
  litChance: number; // fraction of windows with a light on (0..1)
  glass: number; // flat glass tint (day)
  light: [number, number]; // lamp colour range (warm → cool), mixed per-pane
}

// Zone → look. Only the day tint, the lit fraction and the lamp colour differ now:
//  • residential: dark warm glass, ~1/4 lit, warm lamps.
//  • commercial:  lighter shopfront glass, mostly lit, cooler retail lighting.
//  • loft:        darkest glass, sparsely lit, warm bulbs.
const ZONES: Record<ParallaxZone, ZoneLook> = {
  residential: { litChance: 0.26, glass: 0x20262b, light: [0xffb845, 0xffe4a0] },
  commercial: { litChance: 0.68, glass: 0x28323a, light: [0xfff2d0, 0xdfeaff] },
  loft: { litChance: 0.16, glass: 0x181c20, light: [0xffa838, 0xffcf78] },
};

/**
 * A node material for a flat glass pane: dark zone-tinted glass with a grazing
 * sky sheen by day, and a warm per-pane emissive on the ~lit panes at night. No
 * interior raymarch. DoubleSide (the grammar's quad winding isn't guaranteed
 * outward). Drop-in replacement for the old parallax glass.
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

  // view ray (camera → fragment) and how square-on we're looking at the pane
  const viewDir = normalize(pw.sub(cameraPosition));
  const facing = dot(viewDir, nrm).negate(); // >0 on the front face, →0 at grazing

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

  // per-window identity: lit/dark + lamp tint
  const lit = step(float(1.0 - look.litChance), h(3)); // litChance fraction lit
  const lightCol = mix(col(look.light[0]), col(look.light[1]), h(4));
  const flatGlass = col(look.glass);

  // --- day surface: dark glass + grazing sky sheen -----------------------------
  // A subtle sky reflection so the pane reads as glass, not a painted hole. The
  // reflected ray's up-component picks horizon vs. zenith; a cheap fresnel
  // (~(1-facing)^3, no pow) ramps the sheen up toward grazing.
  const refl = viewDir.sub(nrm.mul(dot(viewDir, nrm).mul(2.0)));
  const skyCol = mix(col(0x9db6d2), col(0xd8e6f2), refl.y.clamp(0.0, 1.0));
  const inv = facing.oneMinus().clamp(0.0, 1.0);
  const fresnel = inv.mul(inv).mul(inv);
  const surface = mix(flatGlass, skyCol, fresnel.mul(0.5));

  // --- night emissive: lit panes glow warm -------------------------------------
  // Gated by the sky's twilight weight (WINDOW_GLOW_W) so the glow only reads
  // after dusk — same gate as the baked facades. A hard grazing cutoff kills
  // sub-pixel emissive shimmer on near-edge-on facades.
  const EMIT = 2.0 * LIGHT_SCALE; // matches the baked city's window-glow scale
  const glowGraze = smoothstep(0.01, 0.06, facing);
  const emissive = lightCol.mul(lit).mul(EMIT).mul(glowGraze).mul(WINDOW_GLOW_W);

  mat.colorNode = surface;
  mat.emissiveNode = emissive;
  mat.metalnessNode = float(0.0);
  return mat;
}
