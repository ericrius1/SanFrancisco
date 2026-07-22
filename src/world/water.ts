import * as THREE from "three/webgpu";
import {
  cameraViewMatrix,
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
  vec4,
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
import { OceanCascades, oceanDetail, cascadeUv, HERO_STRIP_GATE } from "./ocean/oceanSim";
import { setHeroFocus } from "./ocean/heroWaves";
import { SUN_DIR } from "./sky";

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
const TAU = Math.PI * 2;

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
  far: THREE.Mesh;
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
  #uSurfing = uniform(0);
  #uOrigin = uniform(new THREE.Vector2());
  #uHeroOrigin = uniform(new THREE.Vector2());
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
  #lastSimT: number | null = null;
  #frame = 0;
  constructor(scene: THREE.Scene, map: WorldMap, renderer: THREE.WebGPURenderer) {
    this.#renderer = renderer;
    this.ocean = new OceanCascades();
    const { tex, scale } = map.buildFloorTexture();
    const g = map.meta.grid;
    const w = g.width * g.cellSize + 8000;
    const h = g.height * g.cellSize + 8000;

    const makeMaterial = (displace: number, holed: boolean, heroRes = false, originU = this.#uOrigin) => {
      // Both sheets are MeshStandard, not Physical. Water is the biggest surface
      // on screen and the shader is fragment-bound on lighter GPUs (an M2 Air
      // sputters over open bay); the physical fragment path (ior/specular BRDF)
      // is measurably heavier (~0.5 ms/render here on the near patch alone) and
      // the sun glint it bought is carried just as well by the env reflection +
      // roughness gradient + emissive spark below — a headless A/B at sunset was
      // pixel-indistinguishable. The env-mapped Fresnel sky reflection still
      // falls out of Standard for free.
      const mat = new THREE.MeshStandardNodeMaterial({
        roughness: 0.48,
        metalness: 0,
        transparent: false,
        // Ocean is an occluding body, not a tinted overlay. Both sheets write
        // depth; alpha testing below resolves their complementary ownership and
        // reveal masks in the opaque pass.
        depthWrite: true
      });
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

      // Bay gradient — vivid Caribbean: a bright aqua-mint sandy shallow through
      // luminous turquoise to a still-bright deep teal (never a near-black deep,
      // so the whole bay glows). d2 softened (-0.042) so the turquoise carries
      // further out before the deep tone takes over.
      const d1 = exp(depth.mul(-0.24)).oneMinus();
      const d2 = exp(depth.mul(-0.042)).oneMinus().toVar();
      const waterCol = mix(mix(color(0x93e6d4), color(0x16b8a6), d1), color(0x0b7580), d2).toVar();

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
        waterVisibility = waterVisibility.mul(
          smoothstep(
            float(HERO_PATCH_MASK_INNER),
            heroRect.z,
            vec2(p.x.sub(heroRect.x), p.y.sub(heroRect.y)).length()
          )
        );
      }

      const viewDist = positionView.z.negate();
      const detail = clamp(float(1).sub(viewDist.div(1900)), 0, 1).toVar();
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
      const surfFaceTint = displace > 0
        ? smoothstep(0.12, 0.82, surfField.face).toVar()
        : float(0);
      // Height alone used to bleach the entire upper half of every swell. The
      // analytic lip/whitewater channels keep pale water confined to the thin
      // pitching crown and the already-broken shoreward wash, leaving a dark
      // emerald wall beneath it for the rider to carve against.
      const crestRipple = sin(pxz.y.mul(0.47).sub(t.mul(2.1))).mul(0.5).add(0.5);
      const crestBreakup = smoothstep(
        0.5,
        0.9,
        oceanFoam.mul(0.5).add(crestRipple.mul(0.5))
      );
      const surfCrest = displace > 0
        ? smoothstep(0.66, 0.96, surfField.lip)
            .mul(crestBreakup)
            .mul(0.06)
            .add(surfField.white.mul(0.035))
        : float(0);
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
      const rippleNormal = normalize(
        vec3(det.slope.x.mul(slopeK).negate(), 1, det.slope.y.mul(slopeK).negate())
      );
      mat.normalNode = normalize(cameraViewMatrix.mul(vec4(rippleNormal, 0)).xyz);

      // sun sparkle: occasional near-field flecks only; the env-mapped Fresnel
      // reflection carries the broad sunset sheen, so this stays subtle on top.
      const sparkNoise = mx_noise_float(vec3(p.mul(2.2), t.mul(0.8)));
      const spark = smoothstep(0.78, 0.97, sparkNoise).mul(detail.mul(detail)).mul(foamTotal.oneMinus());
      const emeraldVein = smoothstep(0.82, 0.97, sparkNoise.mul(0.5).add(0.5))
        .mul(surfFaceTint.mul(surfFaceTint).mul(surfFaceTint));
      // While the surf overlay is live, standing swell on this sheet must stay
      // luminous water on its sun-shadowed side too — an unlit PBR backside
      // rendered near-black against the bright bay ("dark hole behind the
      // wave"). Build-time gated to the displaced sheet; scaled by uSurfing.
      const surfWallGlow = displace > 0
        ? vec3(0.02, 0.3, 0.18)
            .mul(smoothstep(1.2, 6.0, surfField.height))
            .mul(this.#uSurfing)
            .mul(0.5 * LIGHT_SCALE)
        : vec3(0);
      // Crest subsurface glow (SoT trick): folding crests are thin — light
      // leaks through them. The crest mask is the cascades' 1−Jacobian, so the
      // glow rides exactly the pitching tops, day-gated by sun height.
      const daylight = saturate(this.#uSunDir.y.mul(4));
      const crestGlow = vec3(0.05, 0.4, 0.32)
        .mul(det.crest.mul(det.crest))
        .mul(daylight)
        .mul(0.055 * LIGHT_SCALE);
      mat.emissiveNode = vec3(1.0, 0.95, 0.82).mul(spark.mul(0.035 * LIGHT_SCALE))
        .add(vec3(0.03, 0.42, 0.2).mul(emeraldVein.mul(0.13 * LIGHT_SCALE)))
        .add(crestGlow)
        .add(surfWallGlow);

      // Ocean Beach gets an absorptive blue-green body. Brightness belongs to
      // the thin emerald wall and cool lip in the first-use surf overlay; a
      // globally cyan swell made every set dissolve into marine fog.
      const faceCol = mix(waterCol, color(0x075940), surfFaceTint);
      mat.colorNode = mix(faceCol, color(0xb8cecc), foamTotal);
      // LEADR-lite roughness: whatever spectral slope energy was faded out of
      // the normal at this distance comes back as microfacet variance, so the
      // distant sun path spreads into a stable soft band (no shimmer, no
      // hand-tuned "detail" ramp — the spectrum itself says how rough far
      // water is). varToRough maps the cascades' true variance to a roughness
      // add peaking ≈0.36 when every band has faded.
      const totalVar = this.ocean.cascades.reduce((s, c) => s + c.slopeVariance, 0);
      const varToRough = 0.36 / Math.max(totalVar, 1e-6);
      const baseRough = clamp(float(0.36).add(det.cutVariance.mul(varToRough)), 0.3, 0.8);
      mat.roughnessNode = mix(baseRough, float(0.78), foamTotal);

      // Interior water is fully opaque. opacityNode carries coverage only:
      // the hero surf sheet sits 2.5 cm above this base and wins depth wherever
      // a wave stands. Cutting a second alpha-tested hole here used a different
      // threshold from the hero mask and exposed contour/grid gaps between them.
      mat.opacityNode = waterVisibility
        .mul(dry.oneMinus())
        .mul(this.#uReveal)
        .mul(materializeAmount()); // spatial front sweep (collapses to 1 once revealed)

      mat.envMapIntensity = 0.25;
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

    // far sheet: flat, whole map, with a hole under the near patch
    const farGeo = new THREE.PlaneGeometry(w, h, 8, 8);
    farGeo.rotateX(-Math.PI / 2);
    this.far = new THREE.Mesh(farGeo, makeMaterial(0, true));
    this.far.position.set(g.minX + (g.width * g.cellSize) / 2, 0, g.minZ + (g.height * g.cellSize) / 2);
    this.far.renderOrder = 10;
    this.far.frustumCulled = false;

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

    scene.add(this.far, this.near, this.heroNear, this.palaceLagoon, this.underside);
    this.echoes = new WaterEchoes(scene, map);
  }

  /** Void-realm reveal ramp (0 = hidden in the void, 1 = normal water).
   *  Uniform-only; every water pipeline is unchanged. */
  setReveal(v: number) {
    this.#uReveal.value = Math.min(1, Math.max(0, v));
  }

  update(t: number, camPos: THREE.Vector3, playerPos: THREE.Vector3, surfing = false) {
    this.#uTime.value = t;
    this.#uSurfing.value = surfing ? 1 : 0;

    const camUnder = camPos.y < waterHeight(camPos.x, camPos.z, t) - 0.35;

    // Context profile → sim throttle. All uniform/mask-side (never a material
    // or pipeline swap):
    //   surface play — every band, every frame (boats/boards read the detail).
    //   airborne     — the fine bands are sub-pixel from altitude: off; the
    //                  mid band halves its rate; the 42 m band stays live
    //                  (it IS the flyover texture).
    //   underwater   — surface is a wobbling ceiling: alternate the two
    //                  coarse bands at half rate, fine bands off.
    this.#frame++;
    const airborne = !surfing && camPos.y - waterHeight(playerPos.x, playerPos.z, t) > 60;
    let mask = 0b1111;
    if (camUnder) mask = this.#frame % 2 ? 0b0001 : 0b0010;
    else if (airborne) mask = this.#frame % 2 ? 0b0001 : 0b0011;
    this.simMask = mask;

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
    // Tall Ocean Beach faces put the board ~12 m above sea level; that clearance
    // used to fade the near patch to the flat far sheet mid-ride. Keep it fully
    // visible while surfing so CPU floor and GPU swell stay matched.
    if (surfing) {
      this.#uNearVisibility.value = 1;
      this.near.visible = true;
      this.heroNear.visible = true;
      return;
    }
    const clearance = playerPos.y - waterHeight(playerPos.x, playerPos.z, t);
    this.#uNearVisibility.value = THREE.MathUtils.clamp(
      (NEAR_PATCH_FADE_END_HEIGHT - clearance) / (NEAR_PATCH_FADE_END_HEIGHT - NEAR_PATCH_FADE_START_HEIGHT),
      0,
      1
    );
    // Once the patch has fully feathered out (flying high over the bay) stop
    // drawing it altogether — it's 560 m of shaded-then-invisible water covering
    // most of a downward view. The flat far sheet shows the identical colour
    // underneath, so there's nothing to see; this is pure fragment savings while
    // airborne. Re-shown the instant you drop back toward the surface.
    this.near.visible = this.#uNearVisibility.value > 0.001;
    this.heroNear.visible = this.near.visible;
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
