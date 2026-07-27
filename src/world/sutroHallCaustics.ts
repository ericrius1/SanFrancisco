import * as THREE from "three/webgpu";
import { float, positionWorld, saturate, smoothstep, uniform, vec3 } from "three/tsl";
import { causticWeb } from "./waterShadingTSL";
import { SUTRO_BATHS } from "./sutroBaths/layout";

type N = any;

/**
 * Water-light on the ironwork.
 *
 * Deliberately NOT under `sutroBaths/`, despite being entirely about the baths.
 * The node has to be built into the hall's materials at the moment the region
 * streamer converts them (before its paced warm compiles them), and the streamer
 * is boot code — so this module is reached at boot. Everything under
 * `sutroBaths/` is optional-site runtime that boot must never pull in, and the
 * lazy-loading contract test enforces exactly that. This is a few hundred bytes
 * of shader graph with no assets and no GPU allocation, so being boot-eager is
 * cheap; living in the optional directory would have been a policy regression.
 *
 * Seven pools under a glass barrel roof, and none of that water was throwing
 * anything back. The reflected caustic playing across a bath house's ceiling is
 * the signature texture of the room — the thing that says "there is water here"
 * from a viewpoint where no water is on screen — and it costs a few ALU on
 * materials the hall already owns.
 *
 * This is not a light and it is not a projection pass. It is the SAME analytic
 * caustic field the pool surface already uses for its bed pattern, evaluated in
 * world XZ and applied to receivers ABOVE the water that face back down toward
 * it. Because both the bed pattern and this share `causticWeb`'s scale and rate,
 * the light on the ribs registers with the light on the pool floor for free —
 * they are literally the same field read from two sides.
 *
 * Three gates keep it honest and keep it off everything it does not belong on:
 *
 *  - a downward-facing gate, since caustic light travels UP out of the water;
 *  - an exponential height falloff, so the effect is strongest on the coping and
 *    the low tie chords and has faded out well before the roof apex 38 m up;
 *  - a pool-footprint mask in hall-local space, so the ironwork over the great
 *    plunge catches it and the ironwork over the dry deck does not.
 *
 * Everything is `mix`/`smoothstep`/`saturate` — no `If()` anywhere near the
 * noise-bearing `causticWeb`, per the WGSL single-emission hazard documented in
 * waterShadingTSL.
 */

/** Warm because the lamps, not the vanished sun, are what the water is bouncing. */
const CAUSTIC_TINT = /*@__PURE__*/ new THREE.Color(0xffd2a0);

/**
 * Metres above the water over which the projection decays to nothing.
 *
 * Deliberately short. Caustic light is focused by the surface and diverges fast,
 * so in a real bath house it lives on the coping, the low tie chords and the
 * first few metres of column — not on a roof rib 30 m up. At 9.5 the pattern was
 * still worth 0.2 at the purlins and painted the whole barrel vault.
 */
const FALLOFF_HEIGHT = 6.5;

/**
 * Peak emissive contribution, sized against the same measured ambient the hall
 * grade uses (`scene.environmentIntensity` ~0.14). Unclamped this term peaked
 * near 0.2 — brighter than the ambient lighting the room and six times the
 * interior self-glow floor — which turned `causticWeb`'s high-contrast cells
 * into leopard-spot camouflage on the ironwork instead of light moving over it.
 */
const CAUSTIC_GAIN = 0.5;

/**
 * The pool field, simplified to two rectangles in hall-local XZ.
 *
 * SUTRO_POOLS has seven entries, but six of them are the graduated baths packed
 * into one column, so two boxes cover the real footprint to well within the
 * softness of the mask. Seven tests would cost more and look identical.
 */
const PLUNGE = { minX: -31, maxX: -10, minZ: -55, maxZ: 29 };
const BATHS = { minX: -4, maxX: 19, minZ: -55, maxZ: 44 };
/** Metres of feather on the mask edge — caustic light spills past a coping. */
const MASK_FEATHER = 3.5;

export type SutroHallCaustics = {
  /** Multiplied into a material's emissive chain; zero when the pocket is out. */
  readonly node: N;
  /** 0 daylight (off) .. 1 deep twilight. */
  setTwilight(depth: number): void;
  setTime(seconds: number): void;
  setStrength(strength: number): void;
  /** Hard off for site sleep/dispose, so a retired hall cannot keep shimmering. */
  clear(): void;
};

/**
 * One shared instance. The hall's materials are deduplicated per unique source
 * material by the region streamer, so every rib, column and wall panel reads the
 * same uniforms — and the site pushes time and twilight into them once a frame
 * rather than per material.
 */
export function createSutroHallCaustics(): SutroHallCaustics {
  const timeU = uniform(0);
  const twilightU = uniform(0);
  const strengthU = uniform(1);

  // World -> hall-local, the shader-side twin of layout.ts sutroWorldToLocal.
  // It has to be shader-side: the region streamer hands ONE material twin to
  // every mesh that shared a source material, so there is no per-mesh seam to
  // split the ribs over the plunge from the ribs over the deck.
  const c = Math.cos(SUTRO_BATHS.yaw);
  const s = Math.sin(SUTRO_BATHS.yaw);
  const dx = positionWorld.x.sub(SUTRO_BATHS.centerX);
  const dz = positionWorld.z.sub(SUTRO_BATHS.centerZ);
  const localX = dx.mul(c).sub(dz.mul(s));
  const localZ = dx.mul(s).add(dz.mul(c));

  const boxMask = (box: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
    smoothstep(0, MASK_FEATHER, localX.sub(box.minX))
      .mul(smoothstep(0, MASK_FEATHER, float(box.maxX).sub(localX)))
      .mul(smoothstep(0, MASK_FEATHER, localZ.sub(box.minZ)))
      .mul(smoothstep(0, MASK_FEATHER, float(box.maxZ).sub(localZ)));
  const poolMask = saturate(boxMask(PLUNGE).add(boxMask(BATHS)));

  // Caustic light leaves the water going up, so only surfaces turned back down
  // toward it receive any. `normalWorld` is deliberately NOT used: the ribs are
  // thin round-ish members whose interpolated normals swing through the whole
  // sphere, and gating on them made the effect strobe along each rib. Height
  // above the water is the stable proxy, which is also what the falloff wants.
  const height = positionWorld.y.sub(SUTRO_BATHS.waterY);
  const above = smoothstep(0, 1.2, height);
  const falloff = height.max(0).div(FALLOFF_HEIGHT).negate().exp();

  // Same field and rate as the pool surface's bed caustics (staticWater.ts),
  // but the cells WIDEN with distance from the water.
  //
  // That is not a fudge, it is what caustics do: the surface acts as a lens, and
  // the focused cells diverge as they propagate, so the mesh on a bed 1 m down
  // is fine and the mesh thrown onto ironwork 8 m up is broad and soft. Holding
  // the bed's 1.9 scale all the way up was what made this read as leopard-spot
  // camouflage on the purlins — a pattern the size of the member it lands on is
  // texture, not light. Widened, the same field becomes slow shapes moving
  // across the iron, which is the thing worth having.
  const spread = float(1.9).sub(saturate(height.div(11)).mul(1.35));
  const pattern = causticWeb(positionWorld.xz.mul(spread), timeU.mul(0.55));

  const node = vec3(CAUSTIC_TINT.r, CAUSTIC_TINT.g, CAUSTIC_TINT.b)
    .mul(pattern)
    .mul(poolMask)
    .mul(above)
    .mul(falloff)
    .mul(CAUSTIC_GAIN)
    .mul(twilightU)
    .mul(strengthU);

  return {
    node,
    setTwilight(depth) {
      twilightU.value = depth < 0 ? 0 : depth > 1 ? 1 : depth;
    },
    setTime(seconds) {
      timeU.value = seconds;
    },
    setStrength(strength) {
      strengthU.value = Math.max(0, strength);
    },
    clear() {
      twilightU.value = 0;
    }
  };
}

/** Module-scope so the region streamer and the site read the same uniforms. */
let shared: SutroHallCaustics | null = null;

export function sutroHallCaustics(): SutroHallCaustics {
  if (!shared) shared = createSutroHallCaustics();
  return shared;
}

/**
 * Materials that must never receive it. Glass is transmissive and the lamp
 * globes are emitters; painting caustic on either reads as a bug rather than as
 * water. Everything else in the hall — iron, plaster, tile, timber — is a
 * legitimate receiver.
 */
const CAUSTIC_EXCLUDED = new Set([
  "sutro_roof_glass",
  "sutro_window_glass",
  "sutro_lamp"
]);

export function shouldReceiveHallCaustics(materialName: string): boolean {
  return materialName.startsWith("sutro_") && !CAUSTIC_EXCLUDED.has(materialName);
}
