import * as THREE from "three/webgpu";
import {
  cameraPosition,
  positionLocal,
  positionWorld,
  positionView,
  texture,
  uniform,
  float,
  vec2,
  vec3,
  color,
  mix,
  step,
  smoothstep,
  clamp,
  sin,
  exp,
  max,
  normalize,
  uv,
  uniformArray,
  atan,
  floor,
  mx_fractal_noise_float,
  mx_noise_float,
  textureLevel,
  saturate
} from "three/tsl";
import { PALACE_LAGOON, palaceLagoonMask, waterHeight, type WorldMap } from "./heightmap";
import { materializeAmount } from "../render/materialize";
import { bumpNormal, chopZoneMask, oceanBeachSurfField, oceanBeachSwell, swellBase, swellChop } from "./tslUtil";
import { EXPOSURE_REBASE, LIGHT_SCALE } from "../config";
import { WaterEchoes } from "./waterEchoes";
import { OceanCascades, oceanDetail, cascadeUv, CASCADE_FADE_DIST, HERO_STRIP_GATE } from "./ocean/oceanSim";
import { setHeroFocus } from "./ocean/heroWaves";
import { SUN_DIR, SUN_STATE, type Sky } from "./sky";
import { causticWeb, oceanSurfaceRadiance, twilightDirection, twilightFoamRadiance } from "./waterShadingTSL";
import { governorEffects } from "../render/adaptiveResolution";

const PALACE_LAGOON_SEGMENTS = 112;
const PALACE_LAGOON_RINGS = 18;
const NEAR_PATCH_SIZE = 560;
// 128 segments ≈ 4.4 m spacing — enough to resolve Ocean Beach's ~5 m shoreward
// face without the low-poly shelf the old 96-seg grid left on tall crests.
const NEAR_PATCH_SEGMENTS = 128;
const NEAR_PATCH_MASK_OUTER = 276;
const NEAR_PATCH_MASK_INNER = 210;
// Hi-res hero patch: 0.75 m vertex spacing in arm's reach of the player so
// zoomed-in water shows real wave geometry (the coarse patch's 4.4 m grid
// reads soft up close). ~51k tris — negligible.
const HERO_PATCH_SIZE = 120;
const HERO_PATCH_SEGMENTS = 160;
const HERO_PATCH_MASK_OUTER = 56;
const HERO_PATCH_MASK_INNER = 44;
const NEAR_PATCH_FADE_START_HEIGHT = 5;
const NEAR_PATCH_FADE_END_HEIGHT = 12;
// Far flat-sheet split (GPU-load): the far material's fragment path runs
// map-wide + an 8 km apron, but every one of its detail contributions has faded
// to ~zero within ~2 km of the camera — spark/glint dies at viewDist/1900, the
// FFT foam/crest feature fade at 760 m, and the mid band's slope at 950 m, so by
// ~1.9 km only cascade 0's broad swell normal survives. We keep the expensive
// material only on a camera-following DISC out to this ring ("inner annulus",
// still the public `far` mesh) and cover everything beyond it with a cheap
// horizon sheet. Fade out over 1900→2100 m (err generous per the plan); the
// horizon keeps that same cascade-0 normal + roughness ramp, so the seam is
// carried only by the constant-vs-graded body colour, which fog dominates here.
const FAR_ANNULUS_FADE_INNER = 1900;
const FAR_ANNULUS_FADE_OUTER = 2100;
// Square plane whose inscribed radius (SIZE/2 = 2200 m) covers the fade disc.
const FAR_ANNULUS_SIZE = 4400;
const TAU = Math.PI * 2;

// --- water BRDF (see waterShadingTSL.oceanSurfaceRadiance) ------------------
// Microfacet roughness of the water ITSELF, before the spectral LEADR ramp adds
// back whatever slope variance has faded below pixel footprint. Real water is
// near-mirror; every bit of apparent roughness you see is unresolved waves, and
// within the finest cascade's fade distance the cascades resolve those waves
// explicitly. So this stays low and the ramp does the work — which is what puts
// a crisp sky in close water and a soft, stable glitter band in far water.
const WATER_BASE_ROUGHNESS = 0.055;
// Peak roughness the ramp can add once every band has faded (matches the old
// LEADR calibration, rebased onto the lower floor above).
const WATER_ROUGHNESS_RANGE = 0.4;
const WATER_ROUGHNESS_MAX = 0.62;
// Foam is a rough dielectric raft, not water.
const FOAM_ROUGHNESS = 0.85;

// --- shallow-water transmission (Tier B) -----------------------------------
// Per-metre Beer-Lambert extinction in the linear render space, green-dominant
// like real coastal water — red dies first, which is what turns a sand bed
// green-blue as it drops away, and no colour ramp reproduces that for free.
//
// Calibrated to this bay's authored identity (a "vivid Caribbean" green, not
// the literal grey-green Pacific): at a 2.5 m slant path the bed still reads
// through at (0.09, 0.39, 0.32), so the shallows show a real seabed instead of
// a colour that merely suggests one. True SF turbidity (~1-2 m visibility, i.e.
// roughly sigma 1.35/0.62/0.78) buries the bed and its caustics inside the
// first metre, where almost nothing in the world is.
//
// Deliberately NOT derived from the deep palette via beerLambertWater(): that
// couples extinction to the art colour and makes wet sand read cyan.
const WATER_SIGMA = new THREE.Vector3(0.95, 0.38, 0.46);
// Hard gate. smoothstep clamps, so past this the bed term is EXACTLY zero and
// open water is bit-identical to Tier A — a falsifiable probe assertion, not a
// "small enough to ignore". By 6 m the green channel is already ≤0.10.
const BED_VISIBLE_DEPTH = 6.0;
// Bed palette lifted verbatim from the terrain's own literals so the waterline
// lands on the same colour from both sides. Sand at the swash line, the
// terrain's bay-floor tone once you are a few metres down.
const BED_SAND = 0xd1c49f;
const BED_FLOOR = 0x466c68;
// The terrain is a LIT MeshStandard; the water is unlit with its own
// illuminant, so the two do not agree numerically without one scalar.
const BED_GAIN = 1.25;

// --- reflected coastline (Tier C) ------------------------------------------
// A coast lays a dark band on the water beneath it. Sampling sky there is why
// most ocean shaders read as an empty planet, and it is the single most
// conspicuous thing missing from a bay ringed by cliffs and headlands.
//
// NOT a screen-space march: at grazing incidence on a near-flat surface the
// reflection ray leaves the frustum almost immediately, so SSR misses exactly
// the geometry that matters and ghosts on what it does find. NOT a world-space
// heightfield march either — that costs 8-12 texture fetches per pixel, which
// would hand back everything Tier A saved.
//
// Instead: once per update, sweep the terrain from the CAMERA over a ring of
// azimuths and record the tangent of each direction's horizon. The shader then
// resolves "is there land along this reflected ray" with two uniform-array
// reads and a lerp — no texture fetch, ~15 ALU — and it is correct for terrain
// that is entirely off-screen. The profile is camera-centred while the water
// spans hundreds of metres, but the parallax error over that span is small
// against landforms that are hundreds of metres away and tens of metres tall,
// and the result is a soft band, not a mirror image.
const HORIZON_AZIMUTHS = 48;
/** How far the sweep looks for blocking terrain. */
const HORIZON_MAX_DIST = 2600;
/** Ray steps per azimuth; spacing widens with distance (see #scanHorizon). */
const HORIZON_STEPS = 44;
/** Re-sweep once the camera has moved this far — the profile is a slow field. */
const HORIZON_REFRESH_DIST = 45;
/** How completely terrain suppresses the sky reflection. Not 1: a real coast
 *  reflection still carries scattered skylight, and the profile is coarse. */
const COAST_STRENGTH = 0.8;

// --- coarse water-proximity field (see #buildWaterField) -------------------
// A 128 m-cell distance-to-water map over the height grid, built once at boot
// (~13k cells, ~50 KB). Everything below gates off it; nothing queries the
// height grid per frame.
const WATER_FIELD_CELL = 128;
// The shader's dry mask is `floorH > 0.55`. The CPU field runs a touch higher
// because map.heights is an 8× box-averaged overview until tiles stream in
// (shoreline blocks average land back in), and over-estimating the wet set can
// only keep water alive, never hide it.
const WATER_FIELD_WET_FLOOR = 1.0;
// Optimal 3×3 chamfer weights (Borgefors) — within ~4 % of true Euclidean, so
// queries scale by 0.96 to stay on the under-estimating side.
const CHAMFER_ORTHO = 0.9552;
const CHAMFER_DIAG = 1.3507;
// Dry-land gate for the two displaced patches. Their fragments are all killed
// by the `dry` mask inland, but WGSL discard only demotes to a helper
// invocation: 42.6k displaced vertices still transform and the whole ocean
// composite still evaluates before anything is thrown away. Park both sheets
// once the nearest water is well past the patch rim (NEAR_PATCH_MASK_OUTER =
// 276 m); the band between the two thresholds is hysteresis so a shoreline
// walk can't flip the gate frame to frame.
// 300/380 against a 276 m mask: the patch's own fragment feather has already
// closed by 276 m, so anything past that is shaded-then-discarded water plus
// 32k displaced triangles. The old 460 m release carried a 1.7× margin on a
// sheet whose coverage is decided by an exact per-pixel test anyway.
const NEAR_PATCH_WATER_ON = 300;
const NEAR_PATCH_WATER_OFF = 380;
// Same idea one level down, for the hi-res hero patch — but the 128 m field
// above is far too blunt for a 56 m disc (it reads 0 anywhere within one cell
// of water, so the whole Embarcadero reads 0 while the bay sits ~140 m out
// behind the seawall). The hero gate therefore runs an exact lattice probe
// (#waterWithin) instead, with the same on/off hysteresis shape. 80 m leaves
// 24 m over HERO_PATCH_MASK_OUTER; the release ring is another 30 m out.
const HERO_PATCH_WATER_ON = 80;
const HERO_PATCH_WATER_OFF = 110;
// Per-cascade FFT dispatch gate. Cascade i's on-screen weight is
// saturate(1 − viewDist / CASCADE_FADE_DIST[i]) (oceanSim.oceanDetail), i.e.
// EXACTLY zero past its fade distance — so a band whose nearest water is
// further off than that contributes nothing to any sheet and can stop
// dispatching entirely. Two paddings keep the gate provably conservative:
//   • viewDist is view-space depth, not horizontal range — a fragment out at
//     the frustum corner sits at ~0.7× its euclidean distance, hence the 1.5×.
//   • the near/hero patches displace vertices out to 276 m around the player
//     from cascades 1-2 with no distance fade at all, hence the flat margin.
// Because a band only ever switches at a distance where its weight is already
// zero, resuming it (the sim is a stateless evaluation at absolute t) can't pop.
const CASCADE_GATE_SCALE = 1.5;
const CASCADE_GATE_MARGIN = 320;
const CASCADE_GATE_HYSTERESIS = 200;

/**
 * Stylized wavelet height field: a sum of directional sines standing in for the
 * old 2×3-octave FBM ripple. Water is the biggest surface on screen and the
 * shader is fragment-bound on lighter GPUs (an M2 Air sputters over open bay),
 * so trading ~6 gradient-noise octaves for ~4 sines per pixel is the single
 * biggest saving — and the crisp interference crests read as *wavier*, not
 * worse. `p` is world xz (a vec2 node), `t` seconds.
 */
function wavelets(p: any, t: any): any {
  return sin(p.x.mul(0.13).add(p.y.mul(0.07)).add(t.mul(1.15))).mul(0.5)
    .add(sin(p.x.mul(0.052).negate().add(p.y.mul(0.164)).sub(t.mul(0.93))).mul(0.42))
    .add(sin(p.x.mul(0.093).sub(p.y.mul(0.121)).add(t.mul(1.45))).mul(0.32))
    .add(sin(p.x.mul(0.205).add(p.y.mul(0.178)).add(t.mul(1.95))).mul(0.2));
}

/**
 * The bay: a calm, clear, Caribbean-green PBR water surface in TSL. Colour comes
 * from true depth (bay-floor height texture) — sandy glow in the shallows through
 * turquoise to deep teal — with shore foam, sun sparkle, and ripple bump. Fresnel
 * sky reflection falls out of the PBR env (the PMREM-baked SkyMesh), so the water
 * always mirrors the actual sky. A displaced near patch bobs around the player and
 * matches the CPU-side waterHeight() the boat floats on.
 */
export class Water {
  far: THREE.Mesh; // inner annulus: the full material on a camera-following disc
  horizon: THREE.Mesh; // cheap flat sheet covering everything beyond the annulus
  near: THREE.Mesh;
  heroNear: THREE.Mesh;
  palaceLagoon: THREE.Mesh;
  underside!: THREE.Mesh; // the surface seen from below — only shown when submerged
  readonly echoes: WaterEchoes;

  #uTime = uniform(0);
  // Void-realm reveal (docs/VOID_STREAM_REWRITE.md M2): 1 = normal water,
  // 0 = fully hidden in the holo void. A plain opacity multiply on every
  // sheet — same pipelines, driven by VoidRealm.update(). M5 multiplies the
  // SPATIAL front amount (materializeAmount at positionWorld) inside this too,
  // so the bay materializes as the front crosses it rather than one global
  // fade; #uReveal stays the void-phase outer multiplier.
  #uReveal = uniform(1);
  #uNearRect = uniform(new THREE.Vector3(0, 0, NEAR_PATCH_MASK_OUTER));
  #uHeroRect = uniform(new THREE.Vector3(0, 0, HERO_PATCH_MASK_OUTER));
  #uNearVisibility = uniform(1);
  // 1 while the hero sheet draws, 0 once it parks (see HERO_PATCH_WATER_*).
  // The coarse near patch reads it to CLOSE its hero hole — without this the
  // parked sheet would leave a 44–56 m bite out of the water at the player's
  // feet with nothing behind it.
  #uHeroVisibility = uniform(1);
  #uSurfing = uniform(0);
  #uOrigin = uniform(new THREE.Vector2());
  #uHeroOrigin = uniform(new THREE.Vector2());
  // Camera XZ centre of the inner annulus; the horizon sheet reads it to cut the
  // complementary hole (this sheet is static/map-centred, so it needs the origin
  // in world space rather than the annulus' own positionLocal).
  #uFarAnnulusOrigin = uniform(new THREE.Vector2());
  #uCamXZ = uniform(new THREE.Vector2());
  #uCamY = uniform(0);
  // Spectral detail cascades (world/ocean/): FFT wind sea layered over the
  // analytic hero swell. VISUAL-only by contract — physics keeps reading
  // waterHeight(); the vertex add is amplitude-capped detail (see #uDetailAmp)
  // so hulls/rails never drift more than ripple scale from the CPU surface.
  readonly ocean: OceanCascades;
  #renderer: THREE.WebGPURenderer;
  /** Vertex displacement scale for the FFT bands (director/profile lever). */
  #uDetailAmp = uniform(0.85);
  /** Sim throttle mask (bit per cascade) + rate, driven by the profile. */
  simMask = 0b111;
  #uSunDir = uniform(SUN_DIR);
  /** Key-light radiance (sun.color × sun.intensity) for the BRDF's glint lobe.
   *  Sky owns the day/night grade; this just mirrors it into the water graph so
   *  the sun path dims through dusk and becomes a moon path at night. */
  #uSunRadiance = uniform(new THREE.Color(1, 1, 1));
  /** Horizon-band afterglow for aerated foam (twilightFoamRadiance): the light
   *  that keeps a crash readable after sunRadiance has died with the disc.
   *  Zero outside roughly +2°…−9.5° true sun elevation. */
  #uTwilightRadiance = uniform(new THREE.Color(0, 0, 0));
  /** Unit direction to the sunset horizon point — the TRUE sun bearing
   *  (SUN_STATE.toSun), NOT SUN_DIR, which is the moon after dusk. */
  #uTwilightDir = uniform(new THREE.Vector3(-1, 0.06, 0).normalize());
  /** tan(elevation) of the terrain horizon per azimuth, swept from the camera
   *  (see HORIZON_* and #scanHorizon). Negative where nothing blocks. */
  //   +1 entry duplicating index 0, so the shader's azimuth lerp never needs a
  //   modulo to wrap the last spoke back to the first.
  #horizonData = new Array<number>(HORIZON_AZIMUTHS + 1).fill(-1);
  #uHorizon = uniformArray(new Array<number>(HORIZON_AZIMUTHS + 1).fill(-1), "float");
  #horizonAt = new THREE.Vector2(Infinity, Infinity);
  #sky: Sky;
  #lastSimT: number | null = null;
  #frame = 0;
  /** Chamfer distance-to-water in CELL units, one entry per WATER_FIELD_CELL. */
  #waterField: Float32Array | null = null;
  #waterFieldW = 0;
  #waterFieldH = 0;
  #waterFieldStep = WATER_FIELD_CELL;
  #waterFieldMinX = 0;
  #waterFieldMinZ = 0;
  /** Hysteretic gates driven by the field (see the constants above). */
  #nearWaterGate = true;
  #heroWaterGate = true;
  #cascadeGate = 0b1111;
  /** Height lattice, for the hero patch's fine-grained water probe. */
  #map: WorldMap;
  constructor(scene: THREE.Scene, map: WorldMap, renderer: THREE.WebGPURenderer, sky: Sky) {
    this.#renderer = renderer;
    this.#map = map;
    this.#sky = sky;
    this.ocean = new OceanCascades();
    const { tex, scale } = map.buildFloorTexture();
    this.#buildWaterField(map);
    const g = map.meta.grid;
    const w = g.width * g.cellSize + 8000;
    const h = g.height * g.cellSize + 8000;

    const makeMaterial = (displace: number, holed: boolean, heroRes = false, originU = this.#uOrigin, annulus = false) => {
      // UNLIT material + a hand-written water BRDF (waterShadingTSL.
      // oceanSurfaceRadiance). Water has no meaningful diffuse lobe, so running
      // it through three's analytic-light + IBL path was paying ~1500 ALU and 6
      // texture fetches per pixel — a pooled point light at intensity 0 (263
      // ALU + 2 DFG fetches), the split-sum specular LUTs, and the analytic sky
      // evaluated TWICE (radiance + irradiance) — to produce a Lambert lobe that
      // is physically wrong for water anyway.
      //
      // `lights = false` makes NodeMaterial.setupOutgoingLight return
      // diffuseColor.rgb directly and skip the whole lighting block, while
      // setupDiffuseColor (maskNode / opacityNode / alphaTest) and setupOutput
      // (scene.fogNode, tone mapping) are untouched — so every sheet handoff and
      // the fog composite behave exactly as before. Basic is the base class only
      // because it is the material whose contract is already "colorNode IS the
      // outgoing radiance"; nothing here uses its lighting model.
      const mat = new THREE.MeshBasicNodeMaterial({
        transparent: false,
        // Ocean is an occluding body, not a tinted overlay. Both sheets write
        // depth; alpha testing below resolves their complementary ownership and
        // reveal masks in the opaque pass.
        depthWrite: true
      });
      mat.lights = false;
      mat.alphaTestNode = float(0.5);

      const t = this.#uTime;

      // --- vertex swell (near patch only), matching CPU waterHeight() ------
      // world xz = baked-rotation local xz + mesh origin (kept in a uniform so we
      // never read positionWorld inside positionNode, which would be circular)
      if (displace > 0) {
        const lx = positionLocal.x.add(originU.x);
        const lz = positionLocal.z.add(originU.y);
        // zone chop faded out toward the patch rim so the displaced edge never
        // steps off the flat far sheet (nothing physical reads water height
        // that far from the player)
        const rim = smoothstep(276, 200, positionLocal.xz.length());
        // Ocean Beach swell matches CPU waterHeight() so board rails, wake, and
        // the near patch share one surface. While the surf overlay is live its
        // mid-swell sheet continues the sets past this patch at full height, so
        // the swell must NOT rim-fade (a half-height crossfade ring read as a
        // flat grey strip through every set); the fragment opacity feather
        // (210→276 m) hands off to that sheet instead.
        const surfRim = mix(rim, float(1), this.#uSurfing);
        const swell = swellBase(lx, lz, t)
          .add(swellChop(lx, lz, t).mul(chopZoneMask(lx, lz).mul(rim)))
          .add(oceanBeachSwell(lx, lz, t).mul(surfRim));
        const wxz = vec2(lx, lz);
        // Physics band (cascade 0): FULL amplitude, never art-scaled — the CPU
        // twin (ocean/heroWaves) sums these exact cosines, so hulls, rails and
        // swimmers ride precisely this surface. Rim-faded identically to the
        // CPU focus fade, and gated out of the authored Ocean Beach strip
        // (same rectangle+feather as heroStripMask on the CPU).
        const gate = HERO_STRIP_GATE;
        const stripMask = smoothstep(gate.minX - gate.feather, gate.minX, lx)
          .mul(smoothstep(gate.maxX, gate.maxX + gate.feather, lx).oneMinus())
          .mul(smoothstep(gate.minZ - gate.feather, gate.minZ, lz))
          .mul(smoothstep(gate.maxZ, gate.maxZ + gate.feather, lz).oneMinus());
        const c0 = this.ocean.cascades[0];
        const physDisp = textureLevel(c0.dispTex, cascadeUv(wxz, c0.spec), float(0)).xyz
          .mul(rim)
          .mul(stripMask.oneMinus());
        // Visual-only detail bands (c1, + c2 on the hi-res hero patch): a small
        // calm ring keeps their ≤15 cm of unmatched displacement away from
        // hull contact; pulled down while surfing so rails stay glued.
        const calmRing = smoothstep(9, 22, positionLocal.xz.length());
        const detailAmp = this.#uDetailAmp
          .mul(mix(float(1), float(0.3), this.#uSurfing))
          .mul(rim)
          .mul(calmRing);
        let fftDisp: any = vec3(0);
        for (const c of this.ocean.cascades.slice(1, heroRes ? 3 : 2)) {
          fftDisp = fftDisp.add(textureLevel(c.dispTex, cascadeUv(wxz, c.spec), float(0)).xyz);
        }
        mat.positionNode = positionLocal
          .add(vec3(0, swell.mul(displace), 0))
          .add(physDisp)
          .add(fftDisp.mul(detailAmp));
      }

      // --- fragment: depth-graded colour, foam, visibility -----------------
      const pxz = positionWorld.xz.toVar();

      // depth from the bay-floor height field
      const mapUv = pxz.sub(vec2(scale.x, scale.y)).div(vec2(scale.z, scale.w)).toVar();
      const floorH = texture(tex, mapUv).r.toVar();
      const inMap = step(0.001, mapUv.x).mul(step(mapUv.x, 0.999)).mul(step(0.001, mapUv.y)).mul(step(mapUv.y, 0.999));
      const dry = step(0.55, floorH).mul(inMap); // dry land under this pixel: hide
      const depth = max(0, positionWorld.y.sub(floorH)).toVar();

      // Bay gradient — vivid Caribbean: luminous turquoise through a still-bright
      // deep teal (never a near-black deep, so the whole bay glows). d2 softened
      // (-0.042) so the turquoise carries further out before the deep tone takes
      // over.
      //
      // The shallow anchor USED to be a near-white aqua-mint (0x93e6d4), which
      // was a stand-in for "you can see the sand" back when the surface was
      // opaque. Tier B transmits the real bed, so keeping the pale anchor
      // double-counted it: the shallows washed to mint and the actual seabed —
      // and its caustics — were invisible inside the wash. The in-scatter is now
      // saturated turquoise all the way in, and the LIGHTENING at a shoreline
      // comes from the bed showing through, which is where it physically is.
      const d1 = exp(depth.mul(-0.24)).oneMinus();
      const d2 = exp(depth.mul(-0.042)).oneMinus().toVar();
      const waterCol = mix(mix(color(0x35c9b0), color(0x16b8a6), d1), color(0x0b7580), d2).toVar();

      // Feather the player-following near patch into the far bay sheet. This
      // keeps the displaced water useful for watercraft without leaving a
      // camera-following square over the ocean during flight.
      const p = positionWorld.xz;
      const rect = this.#uNearRect;
      const followMask = holed
        ? smoothstep(
            rect.z,
            float(NEAR_PATCH_MASK_INNER),
            vec2(p.x.sub(rect.x), p.y.sub(rect.y)).length()
          ).mul(this.#uNearVisibility)
        : smoothstep(
            heroRes ? float(HERO_PATCH_MASK_OUTER) : float(NEAR_PATCH_MASK_OUTER),
            heroRes ? float(HERO_PATCH_MASK_INNER) : float(NEAR_PATCH_MASK_INNER),
            positionLocal.xz.length()
          ).mul(this.#uNearVisibility);
      let waterVisibility = holed ? followMask.oneMinus() : followMask;
      // The hi-res hero patch cuts a complementary hole in the coarse near
      // patch (same alpha-tested handoff as near-vs-far, one level down).
      if (displace > 0 && !heroRes) {
        const heroRect = this.#uHeroRect;
        const heroHole = smoothstep(
          float(HERO_PATCH_MASK_INNER),
          heroRect.z,
          vec2(p.x.sub(heroRect.x), p.y.sub(heroRect.y)).length()
        );
        // …and CLOSE that hole whenever the hero sheet is parked, or the gate
        // would punch a hole in the water at the player's feet.
        waterVisibility = waterVisibility.mul(mix(float(1), heroHole, this.#uHeroVisibility));
      }
      // Inner-annulus outer rim: the full material only reaches ~2 km from the
      // camera, so fade it out over its rim and let the cheap horizon sheet
      // (complementary radial mask, alpha-tested at 0.5 — the same handoff the
      // near↔far pair uses one level down) own everything beyond. The annulus
      // mesh is camera-centred, so its own local radius IS the view-distance ring.
      if (annulus) {
        waterVisibility = waterVisibility.mul(
          smoothstep(float(FAR_ANNULUS_FADE_OUTER), float(FAR_ANNULUS_FADE_INNER), positionLocal.xz.length())
        );
      }

      // Coverage: the ONE term that decides whether this sheet owns the pixel.
      // It feeds maskNode and opacityNode from the same node, so the early
      // discard and the alpha test are identical by construction — every
      // hero↔near↔far↔horizon handoff keeps its exact 0.5 cut.
      //
      // Why it matters: these sheets are map-wide punch-through planes, so at a
      // waterfront stop they rasterize ~2 screenfuls over a view that is almost
      // all land, and every one of those doomed fragments used to pay the whole
      // ocean composite first (three emits opacity + alphaTest AFTER colorNode,
      // NodeMaterial.setupDiffuseColor). maskNode is the FIRST statement of that
      // method, so the kill now costs one floor fetch and a handful of
      // smoothsteps instead of 2–5 cascade fetches, foam, surf, normals, PBR,
      // the analytic sky IBL and the fog graph.
      const coverage = waterVisibility
        .mul(dry.oneMinus())
        .mul(this.#uReveal)
        .mul(materializeAmount()) // spatial front sweep (collapses to 1 once revealed)
        .toVar();
      mat.maskNode = coverage.greaterThan(0.5);

      const viewDist = positionView.z.negate();
      const foamBand = smoothstep(1.4, 0.15, depth).toVar();

      // NO If() gates here: a branch inside a Fn corrupted unrelated outputs
      // for branch-skipping pixels in the facade material (WGSL→Metal
      // uniformity miscompile around the mx_noise library — see facade.ts),
      // so the water stack runs unbranched like it always had, with foamBand/
      // detail as plain multipliers.
      // Spectral detail composite (world/ocean/): one fetch per cascade gives
      // slopes + persistent Jacobian foam + crest mask. This REPLACED the old
      // 2×FBM(2) foam noise on the biggest fragment surface in the game — foam
      // now appears exactly where crests physically fold, and the per-pixel
      // cost went down (texture fetches vs gradient-noise ALU). The far sheet
      // pays for two cascades only: the finest band's fade distance sits
      // inside the near patch.
      const det = oceanDetail(this.ocean.cascades, pxz, viewDist, heroRes ? 4 : displace > 0 ? 3 : 2);
      const oceanFoam = det.foam.toVar();
      // shore lapping keeps its depth-driven band; the FFT foam field now
      // supplies the irregularity the old FBM provided (plus a slow spatial
      // phase so flat-calm shorelines still lap unevenly).
      const lap = sin(
        t.mul(1.1).add(depth.mul(9)).add(oceanFoam.mul(4)).add(pxz.x.mul(0.043)).add(pxz.y.mul(0.051))
      ).mul(0.5).add(0.5);
      // chop-zone whitecaps: the analytic chop zones whip the same spectral
      // foam harder instead of drawing their own speckle.
      const zoneF = chopZoneMask(pxz.x, pxz.y).toVar();
      const shoreFoam = foamBand.mul(smoothstep(0.3, 0.78, oceanFoam.mul(0.55).add(lap.mul(0.45)))).mul(0.85);
      const seaFoam = saturate(oceanFoam.mul(zoneF.mul(0.6).add(0.55)));
      const foam = saturate(shoreFoam.add(seaFoam)).toVar();
      // Ocean Beach face tint: the tall authored swell keeps the same water
      // shader, but its lifted green wall and breaking crown need to read
      // against the darker Pacific at a glance.
      const surfField = oceanBeachSurfField(pxz.x, pxz.y, t);
      // Saturate the authored face independently of the blue bay body. A
      // thresholded mask preserves a dark Pacific base at noon while letting
      // the steep wall reach a distinctly emerald read instead of a cyan wash.
      // The flat far sheet must never paint an authored crest at sea level.
      // Only the displaced near sheet participates in the Ocean Beach face;
      // its coarse row is cut out below where the high-resolution surf sheet
      // replaces it, preventing two transparent versions of the same wave.
      // Has this crest thrown yet? Everything below hangs off this one number.
      // A swell that has not reached the bar is GLASS — emerald, dark, no foam
      // anywhere on it — and the same swell twenty metres further in is
      // aerated white water from crown to apron. Before this channel existed
      // both states were shaded identically and the entire beach was a single
      // pale wash: waves visibly rolled through, and none of them ever broke.
      const broke = displace > 0 ? surfField.breaking.toVar() : float(0);
      const surfFaceTint = displace > 0
        ? smoothstep(0.12, 0.82, surfField.face).mul(broke.mul(0.8).oneMinus()).toVar()
        : float(0);
      // Height alone used to bleach the entire upper half of every swell. The
      // analytic lip/whitewater channels keep pale water confined to the thin
      // pitching crown and the already-broken shoreward wash, leaving a dark
      // emerald wall beneath it for the rider to carve against.
      const crestRipple = sin(pxz.y.mul(0.47).sub(t.mul(2.1))).mul(0.5).add(0.5);
      const crestBreakup = smoothstep(
        0.35,
        0.85,
        oceanFoam.mul(0.5).add(crestRipple.mul(0.5))
      );
      // The crown goes near-solid white and the apron behind it stays white
      // for the fifty-odd metres the analytic `white` channel spans. max(),
      // not add(): the two overlap, and summing them clipped the overlap into
      // one flat plateau with no edge where the lip actually is.
      const lipFoam = displace > 0
        ? smoothstep(0.22, 0.8, surfField.lip)
            .mul(crestBreakup.mul(0.24).add(0.76))
            .mul(broke)
            .toVar()
        : float(0);
      const apronFoam = displace > 0
        ? surfField.white
            .mul(1.7)
            .mul(crestBreakup.mul(0.38).add(0.62))
            .mul(broke)
            .toVar()
        : float(0);
      // The WALL itself. Lip and apron alone painted a white crown on a wave
      // whose face stayed a tall glassy emerald pane — a wave shape wearing a
      // foam hat, which is exactly what "the waves never actually crash"
      // looks like. Once a crest has thrown, the whole standing face is
      // aerated water: white from the crown down to the base, with the
      // break-up noise only mottling it. The band runs from just offshore of
      // the crest to well down its shoreward slope, so it meets the apron and
      // the roller reads as one white mass marching in.
      const wallFoam = displace > 0
        ? surfField.mask
            .mul(smoothstep(-16, -3, surfField.crestD))
            .mul(smoothstep(22, 46, surfField.crestD).oneMinus())
            .mul(crestBreakup.mul(0.3).add(0.7))
            .mul(broke)
            .toVar()
        : float(0);
      const surfCrest = max(max(lipFoam, apronFoam), wallFoam).toVar();
      const foamTotal = clamp(
        foam.mul(surfFaceTint.mul(0.85).oneMinus()).add(surfCrest),
        0,
        1
      ).toVar();
      // Surface normal straight from the cascades' analytic slopes (spectral
      // i·k derivatives — not screen derivatives, so nothing can expose the
      // mesh topology, and the per-cascade distance fades in oceanDetail()
      // kill shimmer exactly where each band drops below pixel footprint.
      // Chop zones dig the slopes a little harder, like the old ripple did.
      // NO If() gates here (see the branch-hazard note above).
      const slopeK = zoneF.mul(0.35).add(1);
      // WORLD space now (the BRDF reflects in world space and the sky is a
      // world-direction function), so the old cameraViewMatrix multiply is gone.
      const rippleNormal = normalize(
        vec3(det.slope.x.mul(slopeK).negate(), 1, det.slope.y.mul(slopeK).negate())
      ).toVar();

      // LEADR-lite roughness: whatever spectral slope energy was faded out of
      // the normal at this distance comes back as microfacet variance, so the
      // distant sun path spreads into a stable soft band (no shimmer, no
      // hand-tuned "detail" ramp — the spectrum itself says how rough far
      // water is). The floor is now WATER's own roughness rather than the old
      // 0.36 stand-in, because the BRDF below reflects the sky explicitly: close
      // water, where every band is resolved, should be a near-mirror.
      const totalVar = this.ocean.cascades.reduce((s, c) => s + c.slopeVariance, 0);
      const varToRough = WATER_ROUGHNESS_RANGE / Math.max(totalVar, 1e-6);
      const baseRough = clamp(
        float(WATER_BASE_ROUGHNESS).add(det.cutVariance.mul(varToRough)),
        WATER_BASE_ROUGHNESS,
        WATER_ROUGHNESS_MAX
      );
      const roughness = mix(baseRough, float(FOAM_ROUGHNESS), foamTotal).toVar();

      // Ocean Beach gets an absorptive blue-green body. Brightness belongs to
      // the thin emerald wall and cool lip in the first-use surf overlay; a
      // globally cyan swell made every set dissolve into marine fog.
      const faceCol = mix(waterCol, color(0x075940), surfFaceTint);

      // --- the water BRDF ------------------------------------------------
      // Fresnel-weighted sky reflection vs in-scattered body, plus a GGX sun
      // lobe whose width rides the same spectral variance as the roughness.
      // The sky is this project's ANALYTIC sky evaluated along the true
      // reflected ray — no PMREM, no render target, and it tracks the sun
      // continuously instead of at a bake cadence.
      const viewDir = normalize(positionWorld.sub(cameraPosition));

      // --- shallow-water transmission (Tier B) ---------------------------
      // The seabed through Beer-Lambert absorption. No scene-colour copy and no
      // pipeline change: the bathymetry is ALREADY fetched above for the dry
      // mask, so this is pure ALU on a value we have. (A screen-space
      // refraction is not merely unwanted here — it is non-functional: water
      // draws BEFORE terrain, so the framebuffer it would sample contains no
      // seabed at all.)
      // Slant path, not vertical depth: looking along the water you see through
      // far more of it, which is why a shoreline goes opaque as you flatten out.
      const slant = viewDir.y.abs().max(0.18);
      const pathLength = depth.div(slant);
      // EXACTLY zero past BED_VISIBLE_DEPTH (smoothstep clamps its interpolant),
      // so deep water is bit-identical to Tier A.
      const shallowGate = smoothstep(BED_VISIBLE_DEPTH, 0, depth).toVar();
      const bedT = exp(pathLength.negate().mul(vec3(WATER_SIGMA))).mul(shallowGate).toVar();
      // Sand at the swash line, the terrain's own bay-floor tone by ~3 m down —
      // both ends land on terrain literals, so the waterline stops being a seam.
      const bedBase = mix(color(BED_SAND), color(BED_FLOOR), smoothstep(0.3, 3.0, depth));
      // Caustics: BUILD-TIME gated to the displaced sheets. TSL only dead-strips
      // a subgraph that is unreferenced at build time (a JS ternary) — never one
      // merely multiplied by zero at runtime — and the branchless rule forbids
      // an If(), so the expensive term must be excluded here or the far annulus
      // pays ~77 ALU for a web it can never show.
      const caustic = displace > 0
        ? causticWeb(pxz.mul(1.4).add(rippleNormal.xz.mul(1.1)), t.mul(0.5))
            // Fade on the sheet's OWN radius, not viewDist: the patch is
            // player-centred while viewDist is camera-relative, and a chase or
            // flight camera decouples them. Closed well inside the 210–276 m
            // handoff, so the far sheet never needs the term.
            .mul(smoothstep(150, 60, positionLocal.xz.length()))
        : float(0);
      // Light focuses on the bed, so caustics brighten it PROPORTIONALLY rather
      // than adding a flat white — and they dim with depth and with the sun.
      // The falloff is deliberately gentle (0.45, not 0.9): real caustics are
      // strongest around 1-3 m, and since the bed is only a fraction of the
      // final pixel at those depths, a steep falloff plus a small gain makes
      // the web mathematically present and visually absent.
      const causticFocus = exp(depth.negate().mul(0.45)).mul(det.crest.mul(0.6).add(1));
      const bedAlbedo = bedBase.mul(
        caustic.mul(1.8).mul(causticFocus).mul(saturate(this.#uSunDir.y.mul(4))).add(1)
      );

      // --- reflected coastline (Tier C) ----------------------------------
      // Resolve the reflected ray against the CPU horizon profile: two uniform
      // reads, a lerp and a smoothstep — no texture fetch — and it sees terrain
      // entirely outside the frustum, which a screen-space march cannot.
      // Evaluated as a CALLBACK so it uses the BRDF's own horizon-clamped
      // reflected direction (the real per-pixel wave normal), not a flat mirror.
      const coastBlock = (skyDir: any) => {
        const reflTan = skyDir.y.div(max(skyDir.xz.length(), 1e-3));
        // atan2 -> 0..1 around the compass, matching #scanHorizon's a/N x TAU.
        const azimuth = atan(skyDir.z, skyDir.x).div(TAU).add(1).fract().mul(HORIZON_AZIMUTHS);
        const a0 = floor(azimuth);
        const i0 = a0.toInt().toVar();
        const horizonTan = mix(
          this.#uHorizon.element(i0) as never,
          this.#uHorizon.element(i0.add(1)) as never,
          azimuth.sub(a0)
        ) as never as ReturnType<typeof float>;
        // Wide feather: 48 spokes is 7.5 deg apart, and a hard threshold across
        // that spacing reads as faceted polygons rather than a coastal haze.
        return smoothstep(horizonTan.add(0.09), horizonTan.sub(0.09), reflTan)
          .mul(COAST_STRENGTH)
          // Past ~1.4 km the profile's camera-centred parallax stops being a
          // good approximation of the water's own view, and fog owns the pixel.
          .mul(clamp(float(1).sub(viewDist.div(1400)), 0, 1));
      };
      // Reflected land: fog-tinted and dark. A coastal reflection reads as a
      // dark band borrowing the sky's own haze, never a legible mirror image —
      // and shading it from `ambient` keeps it tracking the day cycle.
      const coastRadiance = this.#sky.ambientRadiance().mul(vec3(0.42, 0.46, 0.42));

      const surface = oceanSurfaceRadiance({
        normal: rippleNormal,
        viewDir,
        roughness,
        reflectionBlock: coastBlock,
        blockedRadiance: coastRadiance,
        sunDir: this.#uSunDir,
        sunRadiance: this.#uSunRadiance,
        ambient: this.#sky.ambientRadiance(),
        bodyAlbedo: faceCol,
        bedAlbedo,
        bedTransmittance: bedT,
        bedGain: BED_GAIN,
        foam: foamTotal,
        foamAlbedo: color(0xdfe8e6),
        // Only the analytic breaking channel is aerated whitewater; the bay's
        // spectral foam is spent bubbles and stays a flat raft. Build-time
        // gated to the displaced sheet, so the far annulus emits none of it.
        // The CROWN is weighted far above the apron behind it: the pitching
        // lip is the thinnest, most aerated water on the wave and the only
        // part the sun genuinely shines through, and giving both the same
        // weight flattened the whole break into one even white plateau with
        // no edge to read the wave's shape against. The broken wall sits
        // between the two — a metre-thick white mass with a low sun behind
        // it glows through its whole height, and that glow is most of what
        // makes a sunset crash read as a crash.
        foamGlow: displace > 0
          ? lipFoam.mul(2.1).add(apronFoam.mul(0.55)).add(wallFoam.mul(1.1))
          : undefined,
        // Twilight handover: foamGlow above is multiplied by sunRadiance in
        // the BRDF, which dies with the disc at 20.3 — these light the same
        // aerated channels from the horizon band through deep sunset. Only
        // read where foamGlow is set, so the far/horizon sheets pay nothing.
        twilightRadiance: displace > 0 ? this.#uTwilightRadiance : undefined,
        twilightDir: displace > 0 ? this.#uTwilightDir : undefined,
        // Crest subsurface (SoT trick): the cascades' 1−Jacobian mask IS the set
        // of folding, thin crests, so the glow rides exactly the pitching tops.
        // It lives inside the BRDF now so it gets the view dependence it needs —
        // light through a wave is only visible when the sun is beyond it.
        // Broken water gets NO thin-crest glow: the emerald backlit-pane
        // effect belongs to glassy folding crests, and it was strong enough
        // at sunset to repaint the whitewater mint wherever the foam mix was
        // below 1 — which is why a "crashed" wall still read as a glass one.
        sss: displace > 0
          ? det.crest.mul(det.crest).mul(broke.mul(0.9).oneMinus())
          : det.crest.mul(det.crest),
        skyRadiance: (dir, level) => this.#sky.envRadiance(dir, level)
      });

      // A standing swell lit THROUGH. Two jobs from one term:
      //
      // While the surf overlay is live it keeps the wave's sun-shadowed side
      // luminous water rather than the near-black hole it rendered as against
      // the bright bay. And whenever the sun is low and BEYOND the wave — the
      // whole of golden hour on a west-facing beach — an unbroken face is a
      // pane of backlit water and the brightest green thing on the sea, which
      // is most of what a sunset set actually looks like.
      //
      // The gates are geometric, so it costs nothing when the geometry is
      // wrong: it needs the camera looking sunward (viewDir·sun), a sun near
      // the horizon, and a face that has not yet gone to foam — light does not
      // pass through aerated white water. Build-time gated to the displaced
      // sheet; the surfing term keeps that overlay at least as strong as it was.
      // Foam, not `broke`, is what closes this term off. `broke` is a per-CREST
      // number — it says the wave has gone, and dimming the glow by it also
      // dims the trough and the shoulder either side, while still letting a
      // green wash sit on top of the white water itself. Aerated foam is
      // opaque: subtracting the actual foam coverage puts the glow exactly
      // where light still passes and nowhere else, which is what stops the
      // whitewater reading as pale mint instead of white.
      const sunward = saturate(viewDir.dot(this.#uSunDir)).toVar();
      const foamClear = foamTotal.oneMinus().toVar();
      const surfWallGlow = displace > 0
        ? vec3(0.045, 0.34, 0.2)
            .mul(smoothstep(1.2, 6.0, surfField.height))
            // Squared: half-foam is already mostly aerated, and a linear
            // falloff left a green wash lying over the whitewater.
            .mul(foamClear.mul(foamClear))
            .mul(
              sunward
                .mul(sunward)
                .mul(saturate(float(1).sub(this.#uSunDir.y.mul(3.4))))
                .add(this.#uSurfing)
            )
            .mul(0.5 * LIGHT_SCALE)
        : vec3(0);
      // The mx_noise sun sparkle is GONE — one 3D gradient-noise evaluation
      // (~485 ALU, 20% of the far sheet's whole fragment shader) standing in for
      // a glint the BRDF's GGX lobe now produces correctly, tracking sun AND
      // view instead of drifting through a noise field. The emerald surf vein it
      // also drove rides the analytic surf field directly instead.
      // The vein needs BREAK-UP, not just the face mask: cubing surfFaceTint
      // alone paints a solid emerald sheet over the whole wave face instead of
      // the marbled streaks it is meant to be. The old form got that from the
      // mx_noise field the sparkle shared; three counter-drifting sines give
      // the same irregularity for ~12 ALU instead of ~485.
      const veinBreak = sin(pxz.x.mul(0.21).add(pxz.y.mul(0.13)).add(t.mul(0.6)))
        .mul(sin(pxz.x.mul(0.077).sub(pxz.y.mul(0.164)).sub(t.mul(0.43))))
        .mul(0.5)
        .add(0.5);
      const emeraldVein = surfFaceTint
        .mul(surfFaceTint)
        .mul(surfFaceTint)
        .mul(smoothstep(0.35, 0.8, veinBreak))
        // Same rule as the wall glow: no green marbling on top of white water.
        .mul(foamClear.mul(foamClear));
      // Added into colorNode rather than emissiveNode: with `lights = false`
      // the outgoing light IS diffuseColor.rgb, so the two are identical here —
      // one fewer node, and the whole surface stays one expression.
      mat.colorNode = surface
        .add(vec3(0.03, 0.42, 0.2).mul(emeraldVein.mul(0.13 * LIGHT_SCALE)))

        .add(surfWallGlow);

      // Interior water is fully opaque. opacityNode carries coverage only:
      // the hero surf sheet sits 2.5 cm above this base and wins depth wherever
      // a wave stands. Cutting a second alpha-tested hole here used a different
      // threshold from the hero mask and exposed contour/grid gaps between them.
      // Same node as maskNode above — the alpha test stays as the authoritative
      // cut so nothing downstream depends on discard semantics.
      mat.opacityNode = coverage;

      return mat;
    };

    // Cheap horizon sheet: covers the map beyond the inner annulus (~2 km+ from
    // the camera, fog-dominated). It DROPS the map-wide far material's expensive
    // fragment work — the depth-graded body colour (constant fog-teal instead),
    // the mx_noise sun-spark, all foam/lap/chop/surf, and the 2nd FFT cascade —
    // and KEEPS only what stays visible or correct at range: cascade 0's broad
    // swell normal (so it matches the annulus at the handoff and fades to a flat
    // mirror past 3.4 km), the LEADR-lite roughness ramp, and a single floor
    // fetch for the DRY-LAND mask (a coplanar y≈0 plane can graze distant
    // coastlines the depth buffer resolves imperfectly — Marin, the East Bay
    // hills — so the mask, not depth alone, is what keeps water off far land).
    // No If() (WGSL→Metal uniformity hazard): mix/multiply/smoothstep only.
    const makeHorizonMaterial = () => {
      // Unlit + hand-written BRDF, same as the annulus (see makeMaterial). This
      // sheet gained the MOST from dropping the lit path: its own water maths
      // was only ~10% of the emitted shader, the rest being the generic PBR +
      // IBL tail it now skips entirely.
      const mat = new THREE.MeshBasicNodeMaterial({
        transparent: false,
        depthWrite: true
      });
      mat.lights = false;
      mat.alphaTestNode = float(0.5);

      // flat sheet — displace = 0, no vertex work.
      const pxz = positionWorld.xz.toVar();

      // Dry-land mask ONLY (coarse version of the annulus' mask): one floor
      // fetch, thresholded. The depth-graded colour that also read this texture
      // is dropped, so this fetch survives purely for coastline correctness.
      const mapUv = pxz.sub(vec2(scale.x, scale.y)).div(vec2(scale.z, scale.w)).toVar();
      const floorH = texture(tex, mapUv).r;
      const inMap = step(0.001, mapUv.x).mul(step(mapUv.x, 0.999)).mul(step(0.001, mapUv.y)).mul(step(mapUv.y, 0.999));
      const dry = step(0.55, floorH).mul(inMap);

      // Complementary outer handoff: transparent inside the annulus' fade ring,
      // opaque beyond it — the exact mirror of the annulus' smoothstep, measured
      // from the same camera-XZ origin (in world space, since this sheet is
      // static/map-centred). alphaTest 0.5 → exactly one sheet draws per pixel.
      const ao = this.#uFarAnnulusOrigin;
      const outer = smoothstep(
        float(FAR_ANNULUS_FADE_INNER),
        float(FAR_ANNULUS_FADE_OUTER),
        vec2(pxz.x.sub(ao.x), pxz.y.sub(ao.y)).length()
      );
      // Coverage first (see the annulus material): this sheet spans the whole
      // map + apron, so the inner 2.1 km hole and every land pixel are killed
      // before the cascade fetch and the shared fog/IBL path.
      const coverage = outer
        .mul(dry.oneMinus())
        .mul(this.#uReveal)
        .mul(materializeAmount()) // spatial front sweep
        .toVar();
      mat.maskNode = coverage.greaterThan(0.5);

      const viewDist = positionView.z.negate();
      // One cascade (the physics band's broad swell normal). It matches the
      // annulus exactly at the handoff — cascade 1's slope has faded to 0 by
      // 950 m, well inside the ~2 km ring — and its cutVariance drives the same
      // roughness ramp so distant water never shimmers. No foam/crest fetches.
      const det = oceanDetail(this.ocean.cascades, pxz, viewDist, 1);
      const rippleNormal = normalize(vec3(det.slope.x.negate(), 1, det.slope.y.negate())).toVar();

      const totalVar = this.ocean.cascades.reduce((s, c) => s + c.slopeVariance, 0);
      const varToRough = WATER_ROUGHNESS_RANGE / Math.max(totalVar, 1e-6);
      const roughness = clamp(
        float(WATER_BASE_ROUGHNESS).add(det.cutVariance.mul(varToRough)),
        WATER_BASE_ROUGHNESS,
        WATER_ROUGHNESS_MAX
      ).toVar();

      // Same BRDF as the annulus, so the 1.9–2.1 km handoff stays seamless:
      // identical Fresnel, identical sky sample, identical roughness ramp. Only
      // the body colour is simplified (the annulus' depth gradient has already
      // asymptoted to this exact deep tone by the handoff) and there is no foam.
      const viewDir = normalize(positionWorld.sub(cameraPosition));
      mat.colorNode = oceanSurfaceRadiance({
        normal: rippleNormal,
        viewDir,
        roughness,
        sunDir: this.#uSunDir,
        sunRadiance: this.#uSunRadiance,
        ambient: this.#sky.ambientRadiance(),
        bodyAlbedo: color(0x0b7580),
        foam: float(0),
        foamAlbedo: color(0xdfe8e6),
        skyRadiance: (dir, level) => this.#sky.envRadiance(dir, level)
      });

      mat.opacityNode = coverage;

      return mat;
    };

    const makePalaceLagoonMaterial = () => {
      const mat = new THREE.MeshPhysicalNodeMaterial({
        roughness: 0.34,
        metalness: 0,
        ior: 1.33,
        specularIntensity: 0.62,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false
      });

      const t = this.#uTime;
      const edgeUv = uv().sub(vec2(0.5, 0.5)).mul(2).toVar();
      const radial = edgeUv.x.mul(edgeUv.x).add(edgeUv.y.mul(edgeUv.y)).toVar();
      const edgeFade = smoothstep(0.64, 0.96, radial).oneMinus().toVar();
      const shore = smoothstep(0.42, 0.96, radial).toVar();

      // The sheltered lagoon should read as a reflecting pool, not a small
      // patch of bay swell. Keep just enough displacement to catch the sky.
      const swell = swellBase(positionLocal.x, positionLocal.z, t).mul(0.18);
      mat.positionNode = positionLocal.add(vec3(0, swell, 0));

      const p = positionWorld.xz;

      // shore cut: the lagoon ellipse spills east onto higher urban ground, so
      // hide water wherever the bay-floor rises to (or above) the pond waterline.
      // This carves the sheet down to the true low basin — no water draped over
      // roads/houses — while the low park basin stays flooded. The same
      // WorldMap.lagoonWater mask keeps outdoor planting out of the basin.
      const fuv = p.sub(vec2(scale.x, scale.y)).div(vec2(scale.z, scale.w));
      const floorH = texture(tex, fuv).r;
      const shoreCut = smoothstep(PALACE_LAGOON.surfaceY + 0.45, PALACE_LAGOON.surfaceY - 0.05, floorH).toVar();

      const foamNoise = mx_fractal_noise_float(vec3(p.mul(0.31), t.mul(0.1)), 2).mul(0.5).add(0.5);
      const lap = sin(t.mul(1.25).add(radial.mul(11)).add(foamNoise.mul(5))).mul(0.5).add(0.5);
      const foam = shore
        .mul(smoothstep(0.56, 0.82, foamNoise.mul(0.62).add(lap.mul(0.38))))
        .mul(edgeFade)
        .mul(0.2)
        .toVar();

      // wavelet ripple (see bay) + a little FBM(2) break-up — the lagoon is small
      // and always close, so it keeps the organic layer.
      const rippleH = wavelets(p, t)
        .mul(0.2)
        .add(mx_fractal_noise_float(vec3(p.mul(0.16), t.mul(0.08)), 2).mul(0.06))
        .mul(edgeFade);
      mat.normalNode = bumpNormal(rippleH);

      // Palace palette: deep olive-teal in the reflection lane, mossy shallows
      // at the planted edge. The previous aqua made the pond read like the bay
      // and washed the warm stone out of its reflection.
      const lagoonCol = mix(color(0x071d18), color(0x3e5c3e), smoothstep(0.08, 0.94, radial));
      mat.colorNode = mix(lagoonCol, color(0xe8e1cf), foam);
      mat.roughnessNode = mix(float(0.24), float(0.58), shore);
      mat.opacityNode = clamp(edgeFade.mul(0.975).add(foam.mul(0.08)), 0, 1)
        .mul(shoreCut)
        .mul(this.#uReveal)
        .mul(materializeAmount()); // spatial front sweep

      const sparkle = smoothstep(0.8, 0.98, mx_noise_float(vec3(p.mul(1.8), t.mul(0.7))))
        .mul(edgeFade)
        .mul(foam.oneMinus());
      mat.emissiveNode = vec3(1.0, 0.78, 0.48).mul(sparkle.mul(0.048 * LIGHT_SCALE));
      mat.envMapIntensity = 0.38;
      return mat;
    };

    // far flat sheet, SPLIT for GPU-load (see FAR_ANNULUS_* above):
    //   • far     — inner annulus. The full material, geometry trimmed to a
    //               ~2.1 km disc that FOLLOWS the camera (recentred in update),
    //               still holed under the near patch, fading out at its own rim.
    //   • horizon — cheap map-wide sheet covering everything past that ring.
    //               Static/map-centred, parked just below (y = −0.02) so the
    //               annulus wins any overlap depth; complementary alpha handoff.
    const farGeo = new THREE.PlaneGeometry(FAR_ANNULUS_SIZE, FAR_ANNULUS_SIZE, 8, 8);
    farGeo.rotateX(-Math.PI / 2);
    this.far = new THREE.Mesh(farGeo, makeMaterial(0, true, false, this.#uOrigin, true));
    this.far.renderOrder = 10;
    this.far.frustumCulled = false;

    const horizonGeo = new THREE.PlaneGeometry(w, h, 8, 8);
    horizonGeo.rotateX(-Math.PI / 2);
    this.horizon = new THREE.Mesh(horizonGeo, makeHorizonMaterial());
    this.horizon.position.set(g.minX + (g.width * g.cellSize) / 2, -0.02, g.minZ + (g.height * g.cellSize) / 2);
    this.horizon.renderOrder = 9.8;
    this.horizon.frustumCulled = false;

    // near patch: displaced vertices for a gentle bob around the player
    const nearGeo = new THREE.PlaneGeometry(NEAR_PATCH_SIZE, NEAR_PATCH_SIZE, NEAR_PATCH_SEGMENTS, NEAR_PATCH_SEGMENTS);
    nearGeo.rotateX(-Math.PI / 2);
    this.near = new THREE.Mesh(nearGeo, makeMaterial(1, false));
    this.near.renderOrder = 11;
    this.near.position.y = 0.02;
    this.near.frustumCulled = false;

    // hero patch: the same surface at 0.75 m vertex spacing right around the
    // player (plus the micro cascade in both vertex and normal), feathered
    // into the coarse near patch through the #uHeroRect hole.
    const heroGeo = new THREE.PlaneGeometry(HERO_PATCH_SIZE, HERO_PATCH_SIZE, HERO_PATCH_SEGMENTS, HERO_PATCH_SEGMENTS);
    heroGeo.rotateX(-Math.PI / 2);
    this.heroNear = new THREE.Mesh(heroGeo, makeMaterial(1, false, true, this.#uHeroOrigin));
    this.heroNear.renderOrder = 11.2;
    this.heroNear.position.y = 0.035;
    this.heroNear.frustumCulled = false;

    // Underside of the surface — the "ceiling" you see when diving. The top
    // sheets are single-sided, so from below you'd otherwise stare straight
    // through to the sky (pillars stabbing into "air"). This downward-facing
    // plane, shown only when the camera is submerged, is that missing lid: a
    // bright Snell's-window spot straight overhead fading to teal at grazing,
    // with a gentle ripple, so up is always legible. Unlit (cheap) and follows
    // the camera in XZ; ripple is world-locked so it doesn't swim.
    // depthTest OFF: with reversed-z the lid otherwise fails the depth compare
    // against the sky and vanishes (the whole reason it looked see-through). It's
    // a submerged-only ceiling drawn before the water sheets, so skipping the test
    // is safe — nothing legitimately sits between you and the surface above.
    const undMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    // Basic's lighting model resolves to diffuseColor.rgb anyway (no AO map,
    // no specular), so this is bit-identical output — it just stops compiling
    // the whole analytic-light + IBL tail into a lid that never used it.
    undMat.lights = false;
    {
      const t = this.#uTime;
      const camXZ = this.#uCamXZ;
      const camY = this.#uCamY;
      const pw = positionWorld;
      const horiz = pw.xz.sub(camXZ).length().toVar();
      const depthY = max(0.4, float(0.0).sub(camY)); // surface(≈0) − camY = how deep the camera is
      // A SMALL bright "window to the sky" straight overhead; everything else is
      // an opaque rippled teal surface. Keeping the window tight matters because
      // the look-up pitch is clamped — a wide window filled the whole up-view with
      // near-white and just looked like open sky. NB: TSL smoothstep(lo,hi,x)
      // needs lo<hi — reversed edges silently return 0, so invert with oneMinus().
      const winR = depthY.mul(0.9);
      // The window edge rides the real simulated surface: one coarse-cascade
      // fetch warps the radius so the bright circle wobbles with the waves
      // overhead instead of sitting glass-still.
      const lidCascade = this.ocean.cascades[0];
      const lidSlope = texture(lidCascade.derivTex, cascadeUv(pw.xz, lidCascade.spec));
      const wobble = lidSlope.x.add(lidSlope.y).mul(depthY.mul(0.7));
      const win = smoothstep(winR.mul(0.3), winR, horiz.add(wobble)).oneMinus().toVar(); // 1 overhead → 0 grazing
      const rip = sin(pw.x.mul(0.09).add(t.mul(1.2)))
        .mul(sin(pw.z.mul(0.075).sub(t.mul(0.95))))
        .mul(0.5)
        .add(0.5);
      const bright = clamp(win.add(rip.mul(0.14)), 0, 1); // ripple shimmers across the whole lid
      // authored at the reference exposure — rebased (config.EXPOSURE_REBASE)
      undMat.colorNode = mix(color(0x0b5265), color(0xd8fbff), bright).mul(EXPOSURE_REBASE);
      // Feather by horizontal distance (NOT uv — this plane's uv isn't 0..1 after
      // the rotate, and a uv rim silently zeroed the whole opacity). distFade
      // melts the far rim into the marine fog; the window stays a touch clearer.
      const distFade = clamp(float(1).sub(horiz.div(1300)), 0, 1);
      // near-opaque so the real sky can't leak through the "surface"; the window
      // lets a little brightness through (like looking out into the air).
      undMat.opacityNode = clamp(mix(float(0.98), float(0.88), win).mul(distFade), 0, 1)
        .mul(this.#uReveal)
        .mul(materializeAmount()); // spatial front sweep
    }
    const undGeo = new THREE.PlaneGeometry(3200, 3200, 1, 1);
    undGeo.rotateX(Math.PI / 2); // face DOWN (−y) → visible only from below
    this.underside = new THREE.Mesh(undGeo, undMat);
    this.underside.frustumCulled = false;
    // Intentional legacy exception: this depth-test-free submerged backdrop is
    // not one of the compositing profiles yet. Keep its audited raw assignment
    // until that specialized profile is introduced deliberately.
    this.underside.renderOrder = 9;
    this.underside.visible = false;
    this.underside.position.y = -0.05;

    this.palaceLagoon = new THREE.Mesh(createPalaceLagoonGeometry(map), makePalaceLagoonMaterial());
    this.palaceLagoon.name = "palace_fine_arts_lagoon";
    this.palaceLagoon.renderOrder = 10.5;

    scene.add(this.far, this.horizon, this.near, this.heroNear, this.palaceLagoon, this.underside);
    this.echoes = new WaterEchoes(scene, map);
  }

  /**
   * Coarse distance-to-water field, built once. Downsamples map.heights to
   * 128 m cells (wet if ANY stride-2 tap is at/below the waterline — the same
   * subsample the shader's half-res floor texture reads) and runs a two-pass
   * chamfer distance transform over the result. ~1 ms at boot for 118×109
   * cells / 50 KB; the alternative is a height-grid search per frame, which is
   * exactly the cost the gates below exist to avoid.
   */
  #buildWaterField(map: WorldMap) {
    const { width: W, height: H, cellSize, minX, minZ } = map.meta.grid;
    const taps = Math.max(1, Math.round(WATER_FIELD_CELL / cellSize)); // grid cells per field cell
    const step = taps * cellSize;
    const cw = Math.ceil(W / taps);
    const ch = Math.ceil(H / taps);
    const d = new Float32Array(cw * ch).fill(Infinity);
    const heights = map.heights;
    // seed: one tap at or below the waterline marks its whole field cell wet.
    // Cell-major with an early break so open bay/ocean exits on the first tap.
    for (let cz = 0; cz < ch; cz++) {
      const gz1 = Math.min(H, (cz + 1) * taps);
      for (let cx = 0; cx < cw; cx++) {
        const gx1 = Math.min(W, (cx + 1) * taps);
        let wet = false;
        for (let gz = cz * taps; gz < gz1 && !wet; gz += 2) {
          const row = gz * W;
          for (let gx = cx * taps; gx < gx1; gx += 2) {
            if (heights[row + gx] <= WATER_FIELD_WET_FLOOR) {
              wet = true;
              break;
            }
          }
        }
        if (wet) d[cz * cw + cx] = 0;
      }
    }
    // Everything outside the grid is open ocean — the sheets run an 8 km apron
    // and their `inMap` term drops the dry mask out there — so the border ring
    // is always within one cell of water.
    for (let cx = 0; cx < cw; cx++) {
      d[cx] = 0;
      d[(ch - 1) * cw + cx] = 0;
    }
    for (let cz = 0; cz < ch; cz++) {
      d[cz * cw] = 0;
      d[cz * cw + cw - 1] = 0;
    }
    // forward pass (top-left → bottom-right), then backward
    for (let cz = 0; cz < ch; cz++) {
      for (let cx = 0; cx < cw; cx++) {
        const i = cz * cw + cx;
        let v = d[i];
        if (v === 0) continue;
        if (cx > 0) v = Math.min(v, d[i - 1] + CHAMFER_ORTHO);
        if (cz > 0) {
          v = Math.min(v, d[i - cw] + CHAMFER_ORTHO);
          if (cx > 0) v = Math.min(v, d[i - cw - 1] + CHAMFER_DIAG);
          if (cx < cw - 1) v = Math.min(v, d[i - cw + 1] + CHAMFER_DIAG);
        }
        d[i] = v;
      }
    }
    for (let cz = ch - 1; cz >= 0; cz--) {
      for (let cx = cw - 1; cx >= 0; cx--) {
        const i = cz * cw + cx;
        let v = d[i];
        if (v === 0) continue;
        if (cx < cw - 1) v = Math.min(v, d[i + 1] + CHAMFER_ORTHO);
        if (cz < ch - 1) {
          v = Math.min(v, d[i + cw] + CHAMFER_ORTHO);
          if (cx < cw - 1) v = Math.min(v, d[i + cw + 1] + CHAMFER_DIAG);
          if (cx > 0) v = Math.min(v, d[i + cw - 1] + CHAMFER_DIAG);
        }
        d[i] = v;
      }
    }
    this.#waterField = d;
    this.#waterFieldW = cw;
    this.#waterFieldH = ch;
    this.#waterFieldStep = step;
    this.#waterFieldMinX = minX;
    this.#waterFieldMinZ = minZ;
  }

  /**
   * Conservative lower bound on the horizontal distance (m) from (x,z) to the
   * nearest water. Deliberately never over-estimates: the query point can sit
   * anywhere in its own cell (hence the −1 cell), and the chamfer metric runs
   * up to ~4 % long. Off-grid reads 0 — that's the open ocean apron.
   */
  #distanceToWater(x: number, z: number): number {
    const f = this.#waterField;
    if (!f) return 0;
    const step = this.#waterFieldStep;
    const cx = Math.floor((x - this.#waterFieldMinX) / step);
    const cz = Math.floor((z - this.#waterFieldMinZ) / step);
    if (cx < 0 || cz < 0 || cx >= this.#waterFieldW || cz >= this.#waterFieldH) return 0;
    return Math.max(0, (f[cz * this.#waterFieldW + cx] * 0.96 - 1) * step);
  }

  /**
   * Exact "is any water within `radius` of (x,z)" test against the height
   * lattice — the fine-grained companion to #distanceToWater, for gates whose
   * radius is smaller than one 128 m field cell. Conservative the same two
   * ways the field is: WATER_FIELD_WET_FLOOR sits above the shader's own 0.55
   * cut, and anything reaching off-grid is the open-ocean apron. Bounded by
   * the disc (≈780 reads at 110 m on the 8 m lattice) with an early-out on the
   * first wet node, and only ever called once the coarse field has failed to
   * settle the question.
   */
  #waterWithin(x: number, z: number, radius: number): boolean {
    const { width: W, height: H, cellSize, minX, minZ } = this.#map.meta.grid;
    if (
      x - radius < minX ||
      z - radius < minZ ||
      x + radius > minX + (W - 1) * cellSize ||
      z + radius > minZ + (H - 1) * cellSize
    ) {
      return true;
    }
    const heights = this.#map.heights;
    const gx0 = Math.max(0, Math.ceil((x - radius - minX) / cellSize));
    const gx1 = Math.min(W - 1, Math.floor((x + radius - minX) / cellSize));
    const gz0 = Math.max(0, Math.ceil((z - radius - minZ) / cellSize));
    const gz1 = Math.min(H - 1, Math.floor((z + radius - minZ) / cellSize));
    const r2 = radius * radius;
    for (let gz = gz0; gz <= gz1; gz++) {
      const dz = minZ + gz * cellSize - z;
      const span2 = r2 - dz * dz;
      if (span2 <= 0) continue;
      const row = gz * W;
      for (let gx = gx0; gx <= gx1; gx++) {
        const dx = minX + gx * cellSize - x;
        if (dx * dx > span2) continue;
        if (heights[row + gx] <= WATER_FIELD_WET_FLOOR) return true;
      }
    }
    return false;
  }

  /**
   * Sweep the terrain horizon around `x,z` and publish tan(elevation) per
   * azimuth — the CPU half of the reflected coastline (Tier C).
   *
   * One pass is HORIZON_AZIMUTHS × HORIZON_STEPS height lookups (48 × 44 ≈ 2.1k)
   * and only runs when the camera has moved HORIZON_REFRESH_DIST, so it is far
   * below the cost of the per-pixel marching it replaces.
   *
   * Steps widen quadratically: near ground dominates the horizon angle (a 20 m
   * bluff at 100 m subtends more than a 200 m ridge at 2 km), so resolution
   * belongs close in. Rays start beyond the first step to avoid the camera's
   * own cell reporting itself as a cliff.
   */
  #scanHorizon(x: number, z: number) {
    const map = this.#map;
    for (let a = 0; a < HORIZON_AZIMUTHS; a++) {
      const ang = (a / HORIZON_AZIMUTHS) * TAU;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      let best = -1; // tan(elevation); <0 means "open sky along this bearing"
      for (let s = 1; s <= HORIZON_STEPS; s++) {
        const f = s / HORIZON_STEPS;
        const d = HORIZON_MAX_DIST * f * f;
        if (d < 8) continue;
        // groundTop, not the water surface: a cliff blocks the reflection, and
        // sea-level cells give tan ≈ 0 which never wins against `best`.
        const h = map.groundTop(x + dx * d, z + dz * d);
        if (h <= 0.5) continue;
        const tan = h / d;
        if (tan > best) best = tan;
      }
      this.#horizonData[a] = best;
    }
    this.#horizonData[HORIZON_AZIMUTHS] = this.#horizonData[0]; // wrap sentinel
    const u = this.#uHorizon as unknown as { array: number[]; needsUpdate: boolean };
    for (let i = 0; i <= HORIZON_AZIMUTHS; i++) u.array[i] = this.#horizonData[i];
    u.needsUpdate = true;
    this.#horizonAt.set(x, z);
  }

  /** Void-realm reveal ramp (0 = hidden in the void, 1 = normal water).
   *  Uniform-only; every water pipeline is unchanged. */
  setReveal(v: number) {
    this.#uReveal.value = Math.min(1, Math.max(0, v));
  }

  update(t: number, camPos: THREE.Vector3, playerPos: THREE.Vector3, surfing = false) {
    this.#uTime.value = t;
    this.#uSurfing.value = surfing ? 1 : 0;
    // Mirror the key light's graded radiance into the BRDF. Sky owns the
    // day/night curve (and swaps colour + direction to the moon after dusk), so
    // the water's sun path follows the sky for free — no second grade to keep
    // in sync. #uSunDir already tracks SUN_DIR, which Sky mutates in place.
    this.#uSunRadiance.value.copy(this.#sky.sun.color).multiplyScalar(this.#sky.sun.intensity);
    // Twilight foam light: TRUE solar state (SUN_DIR/sun.* are the moon after
    // −2°), resolved once per frame into the two uniforms the BRDF reads.
    twilightFoamRadiance(SUN_STATE.elevationDeg, this.#uTwilightRadiance.value);
    twilightDirection(SUN_STATE.toSun, this.#uTwilightDir.value);
    // Reflected-coastline horizon profile (Tier C). Slow field, camera-centred,
    // re-swept only on real movement.
    if (this.#horizonAt.distanceToSquared({ x: camPos.x, y: camPos.z } as THREE.Vector2) >
        HORIZON_REFRESH_DIST * HORIZON_REFRESH_DIST) {
      this.#scanHorizon(camPos.x, camPos.z);
    }

    const camUnder = camPos.y < waterHeight(camPos.x, camPos.z, t) - 0.35;

    // Context profile → sim throttle. All uniform/mask-side (never a material
    // or pipeline swap):
    //   surface play — every band, every frame (boats/boards read the detail).
    //   airborne     — the fine bands are sub-pixel from altitude: off; the
    //                  mid band halves its rate; the 42 m band stays live
    //                  (it IS the flyover texture).
    //   underwater   — surface is a wobbling ceiling: alternate the two
    //                  coarse bands at half rate, fine bands off.
    //   plain surface + governor hot (fftEconomy) — keep the coarse+mid bands
    //                  every frame, but alternate the two FINE bands (2,3)
    //                  odd/even so each updates at half rate. These bands are
    //                  VISUAL-only (physics reads the analytic hero band =
    //                  cascade 0, never these), and surfing is excluded so a
    //                  rider on the water never sees half-rate ripple. When the
    //                  governor is cool this branch is skipped → bit-identical
    //                  to full-rate 0b1111.
    this.#frame++;
    const airborne = !surfing && camPos.y - waterHeight(playerPos.x, playerPos.z, t) > 60;
    let mask = 0b1111;
    if (camUnder) mask = this.#frame % 2 ? 0b0001 : 0b0010;
    else if (airborne) mask = this.#frame % 2 ? 0b0001 : 0b0011;
    else if (!surfing && governorEffects().fftEconomy) {
      mask = 0b0011 | (this.#frame % 2 ? 0b0100 : 0b1000);
    }
    // Nearest water to the player AND to the camera — a chase/flight camera
    // can sit well off the player, and every fade the gates reason about is
    // measured from the camera.
    const waterDist = Math.min(
      this.#distanceToWater(playerPos.x, playerPos.z),
      this.#distanceToWater(camPos.x, camPos.z)
    );

    // Inner annulus follows the CAMERA (its detail fades are all view-distance
    // based, and the fragment shading is world-locked so the flat sheet doesn't
    // swim — no vertex grid to snap to). The horizon sheet reads this same origin
    // to cut its complementary hole.
    this.far.position.x = camPos.x;
    this.far.position.z = camPos.z;
    this.#uFarAnnulusOrigin.value.set(camPos.x, camPos.z);
    // snap the near patch to its own grid so vertices don't swim
    const snap = NEAR_PATCH_SIZE / NEAR_PATCH_SEGMENTS;
    this.near.position.x = Math.round(playerPos.x / snap) * snap;
    this.near.position.z = Math.round(playerPos.z / snap) * snap;
    this.#uOrigin.value.set(this.near.position.x, this.near.position.z);
    this.#uNearRect.value.set(this.near.position.x, this.near.position.z, NEAR_PATCH_MASK_OUTER);
    // hero patch: finer snap grid, own origin/hole uniforms; and tell the CPU
    // physics twin where the rendered focus fade is centred this frame.
    const heroSnap = HERO_PATCH_SIZE / HERO_PATCH_SEGMENTS;
    this.heroNear.position.x = Math.round(playerPos.x / heroSnap) * heroSnap;
    this.heroNear.position.z = Math.round(playerPos.z / heroSnap) * heroSnap;
    this.#uHeroOrigin.value.set(this.heroNear.position.x, this.heroNear.position.z);
    this.#uHeroRect.value.set(this.heroNear.position.x, this.heroNear.position.z, HERO_PATCH_MASK_OUTER);
    setHeroFocus(this.near.position.x, this.near.position.z);

    // --- displaced-sheet visibility --------------------------------------
    // Resolved BEFORE the cascade gate below, which needs to know which sheets
    // are actually going to consume each band this frame.
    if (surfing) {
      // Tall Ocean Beach faces put the board ~12 m above sea level; that
      // clearance used to fade the near patch to the flat far sheet mid-ride.
      // Keep both fully visible while surfing so CPU floor and GPU swell stay
      // matched.
      this.#uNearVisibility.value = 1;
      this.#nearWaterGate = true;
      this.#heroWaterGate = true;
      this.near.visible = true;
      this.heroNear.visible = true;
    } else {
      // Horizontal companion to the altitude fade below (NEAR_PATCH_WATER_*):
      // once the nearest water is past the patch rim there is nothing for
      // either displaced sheet to draw, whatever the clearance says.
      this.#nearWaterGate =
        waterDist < (this.#nearWaterGate ? NEAR_PATCH_WATER_OFF : NEAR_PATCH_WATER_ON);
      const clearance = playerPos.y - waterHeight(playerPos.x, playerPos.z, t);
      this.#uNearVisibility.value = THREE.MathUtils.clamp(
        (NEAR_PATCH_FADE_END_HEIGHT - clearance) / (NEAR_PATCH_FADE_END_HEIGHT - NEAR_PATCH_FADE_START_HEIGHT),
        0,
        1
      );
      // Once the patch has fully feathered out (flying high over the bay) stop
      // drawing it altogether — it's 560 m of shaded-then-invisible water
      // covering most of a downward view. The flat far sheet shows the
      // identical colour underneath, so there's nothing to see; this is pure
      // fragment savings while airborne. Re-shown the instant you drop back
      // toward the surface. The inland gate rides the same uniform on purpose:
      // zeroing it also closes the far sheet's follow-hole, so no gap can open
      // where the patch used to be.
      if (!this.#nearWaterGate) this.#uNearVisibility.value = 0;
      this.near.visible = this.#uNearVisibility.value > 0.001;
      // Hero patch: its own, much tighter gate. Inheriting the near patch's
      // 300 m release kept 120 m of the heaviest material in the game alive
      // over a 56 m disc — at a seawall stop that is ~40 % of the screen and
      // 51k displaced triangles producing literally zero wet pixels. The
      // coarse field settles the far cases for free; only inside its blind
      // spot do we pay for the exact lattice probe.
      const heroRadius = this.#heroWaterGate ? HERO_PATCH_WATER_OFF : HERO_PATCH_WATER_ON;
      this.#heroWaterGate =
        waterDist <= heroRadius && this.#waterWithin(playerPos.x, playerPos.z, heroRadius);
      this.heroNear.visible = this.near.visible && this.#heroWaterGate;
    }
    this.#uHeroVisibility.value = this.heroNear.visible ? 1 : 0;

    // --- sim throttle ------------------------------------------------------
    // Proximity gate (see CASCADE_GATE_*): bands whose fade distance is
    // provably behind the nearest water stop dispatching. AND-composed with the
    // context throttles above, so it can only ever remove work, never add it.
    let gate = 0;
    for (let i = 0; i < this.ocean.cascades.length; i++) {
      const bit = 1 << i;
      // an unlisted band is treated as the widest one, i.e. never gated
      const on = (CASCADE_FADE_DIST[i] ?? CASCADE_FADE_DIST[0]) * CASCADE_GATE_SCALE + CASCADE_GATE_MARGIN;
      const hyst = this.#cascadeGate & bit ? CASCADE_GATE_HYSTERESIS : 0;
      if (waterDist < on + hyst) gate |= bit;
    }
    this.#cascadeGate = gate; // distance hysteresis state — consumers are AND'd in below
    // Consumer gate: the two finest bands have no reader once their only sheet
    // is parked. oceanDetail() pays for cascades [0, count): hero 4, near 3,
    // far 2, horizon 1 — so band 3 exists solely for the hero sheet and band 2
    // for hero+near (hero.visible implies near.visible). A band whose consumer
    // is hidden contributes to no pixel, and resuming it can't pop for the same
    // reason the distance gate can't: the sim is a stateless evaluation at
    // absolute t, not an integration.
    let consumers = 0b1111;
    if (!this.heroNear.visible) consumers &= ~0b1000;
    if (!this.near.visible) consumers &= ~0b0100;
    this.simMask = mask & gate & consumers;

    // Advance the spectral cascades (~18 tiny compute dispatches, ≲0.3 ms GPU
    // all-in at full rate). A skipped cascade keeps its last textures — the
    // ocean just advances at a lower rate there.
    const dt = this.#lastSimT === null ? 1 / 60 : Math.min(Math.max(t - this.#lastSimT, 0), 0.1);
    this.#lastSimT = t;
    this.ocean.update(this.#renderer, t, dt, this.simMask);

    // show the underside ceiling only while the camera is below the surface,
    // parked at the camera's XZ so its Snell window stays centred overhead
    this.underside.visible = camUnder;
    if (camUnder) {
      this.underside.position.set(camPos.x, -0.05, camPos.z);
      this.#uCamXZ.value.set(camPos.x, camPos.z);
      this.#uCamY.value = camPos.y;
    }
  }
}

function createPalaceLagoonGeometry(map: WorldMap): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushVertex = (x: number, z: number, u: number, v: number) => {
    const y = Math.max(PALACE_LAGOON.surfaceY, map.groundHeight(x, z) + 0.28);
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    uvs.push(u, v);
  };

  pushVertex(PALACE_LAGOON.x, PALACE_LAGOON.z, 0.5, 0.5);

  for (let r = 1; r <= PALACE_LAGOON_RINGS; r++) {
    const f = r / PALACE_LAGOON_RINGS;
    for (let s = 0; s < PALACE_LAGOON_SEGMENTS; s++) {
      const a = (s / PALACE_LAGOON_SEGMENTS) * TAU;
      const wobble = 1 + Math.sin(a * 3 + 0.35) * 0.045 + Math.sin(a * 7 - 1.1) * 0.025;
      const x = PALACE_LAGOON.x + Math.cos(a) * PALACE_LAGOON.radiusX * f * wobble;
      const z = PALACE_LAGOON.z + Math.sin(a) * PALACE_LAGOON.radiusZ * f * wobble;
      const mask = palaceLagoonMask(x, z);
      const shoreLift = (1 - mask) * 0.025;
      positions.push(x, Math.max(PALACE_LAGOON.surfaceY, map.groundHeight(x, z) + 0.28) + shoreLift, z);
      normals.push(0, 1, 0);
      uvs.push(0.5 + Math.cos(a) * f * 0.5, 0.5 + Math.sin(a) * f * 0.5);
    }
  }

  for (let s = 0; s < PALACE_LAGOON_SEGMENTS; s++) {
    const next = (s + 1) % PALACE_LAGOON_SEGMENTS;
    indices.push(0, 1 + next, 1 + s);
  }

  for (let r = 1; r < PALACE_LAGOON_RINGS; r++) {
    const inner = 1 + (r - 1) * PALACE_LAGOON_SEGMENTS;
    const outer = inner + PALACE_LAGOON_SEGMENTS;
    for (let s = 0; s < PALACE_LAGOON_SEGMENTS; s++) {
      const next = (s + 1) % PALACE_LAGOON_SEGMENTS;
      indices.push(inner + s, inner + next, outer + s);
      indices.push(inner + next, outer + next, outer + s);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  // the shader swell lifts vertices past the static bounds — pad the sphere
  // so frustum culling (unlike the map-wide sheets, this mesh is local and
  // worth culling) never pops the rim mid-bob
  geo.boundingSphere!.radius += 2;
  return geo;
}
