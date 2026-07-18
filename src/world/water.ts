import * as THREE from "three/webgpu";
import {
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
  uv,
  mx_fractal_noise_float,
  mx_noise_float
} from "three/tsl";
import { PALACE_LAGOON, palaceLagoonMask, waterHeight, type WorldMap } from "./heightmap";
import { bumpNormal, chopZoneMask, oceanBeachSurfField, oceanBeachSwell, swellBase, swellChop } from "./tslUtil";
import { EXPOSURE_REBASE, LIGHT_SCALE } from "../config";
import { WaterEchoes } from "./waterEchoes";

const PALACE_LAGOON_SEGMENTS = 112;
const PALACE_LAGOON_RINGS = 18;
const NEAR_PATCH_SIZE = 560;
// 128 segments ≈ 4.4 m spacing — enough to resolve Ocean Beach's ~5 m shoreward
// face without the low-poly shelf the old 96-seg grid left on tall crests.
const NEAR_PATCH_SEGMENTS = 128;
const NEAR_PATCH_MASK_OUTER = 276;
const NEAR_PATCH_MASK_INNER = 210;
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
  palaceLagoon: THREE.Mesh;
  underside!: THREE.Mesh; // the surface seen from below — only shown when submerged
  readonly echoes: WaterEchoes;

  #uTime = uniform(0);
  #uNearRect = uniform(new THREE.Vector3(0, 0, NEAR_PATCH_MASK_OUTER));
  #uNearVisibility = uniform(1);
  #uSurfing = uniform(0);
  #uOrigin = uniform(new THREE.Vector2());
  #uCamXZ = uniform(new THREE.Vector2());
  #uCamY = uniform(0);
  constructor(scene: THREE.Scene, map: WorldMap) {
    const { tex, scale } = map.buildFloorTexture();
    const g = map.meta.grid;
    const w = g.width * g.cellSize + 8000;
    const h = g.height * g.cellSize + 8000;

    const makeMaterial = (displace: number, holed: boolean) => {
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
        transparent: true,
        // The displaced near sheet can fold over itself in screen space from a
        // surfer-height camera. Let its closest triangles occlude distant rows;
        // the map-wide flat sheet remains a non-writing backdrop.
        depthWrite: displace > 0,
        alphaTest: displace > 0 ? 0.02 : 0
      });

      const t = this.#uTime;

      // --- vertex swell (near patch only), matching CPU waterHeight() ------
      // world xz = baked-rotation local xz + mesh origin (kept in a uniform so we
      // never read positionWorld inside positionNode, which would be circular)
      if (displace > 0) {
        const lx = positionLocal.x.add(this.#uOrigin.x);
        const lz = positionLocal.z.add(this.#uOrigin.y);
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
        mat.positionNode = positionLocal.add(vec3(0, swell.mul(displace), 0));
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
            float(NEAR_PATCH_MASK_OUTER),
            float(NEAR_PATCH_MASK_INNER),
            positionLocal.xz.length()
          ).mul(this.#uNearVisibility);
      const waterVisibility = holed ? followMask.oneMinus() : followMask;

      const viewDist = positionView.z.negate();
      const detail = clamp(float(1).sub(viewDist.div(1900)), 0, 1).toVar();
      const foamBand = smoothstep(1.4, 0.15, depth).toVar();

      // NO If() gates here: a branch inside a Fn corrupted unrelated outputs
      // for branch-skipping pixels in the facade material (WGSL→Metal
      // uniformity miscompile around the mx_noise library — see facade.ts),
      // so the water stack runs unbranched like it always had, with foamBand/
      // detail as plain multipliers.
      // shore foam: soft lapping band + speckle. FBM trimmed 3→2 octaves — foam
      // only reads in the shallows/chop, so the third octave never paid for
      // itself on a fragment-bound GPU.
      // near patch drives the lapping band with real FBM; the full-screen far
      // sheet uses a cheap sine instead (build-time branch, not a shader If()) —
      // its foam only reads faintly at distant shorelines, never worth 2 octaves
      // across the whole horizon.
      const nA =
        displace > 0
          ? mx_fractal_noise_float(vec3(pxz.mul(0.11), t.mul(0.05)), 2).mul(0.5).add(0.5)
          : sin(pxz.x.mul(0.09).add(pxz.y.mul(0.07)).add(t.mul(0.4))).mul(0.5).add(0.5);
      const lap = sin(t.mul(1.1).add(depth.mul(9)).add(nA.mul(6))).mul(0.5).add(0.5);
      const foamNoise = mx_fractal_noise_float(vec3(pxz.mul(0.9), t.mul(0.12)), 2).mul(0.5).add(0.5);
      // chop-zone whitecaps: scattered speckle so rough patches read from afar
      const zoneF = chopZoneMask(pxz.x, pxz.y).toVar();
      const foam = foamBand.mul(smoothstep(0.45, 0.75, foamNoise.mul(0.75).add(lap.mul(0.35)))).mul(0.85)
        .add(zoneF.mul(smoothstep(0.6, 0.86, foamNoise)).mul(0.34))
        .toVar();
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
        0.68,
        0.9,
        foamNoise.mul(0.66).add(crestRipple.mul(0.34))
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
      // ripple bump: stylized directional wavelets (sum of sines) replace the old
      // 2×3-octave FBM — a fraction of the per-pixel ALU on the biggest surface on
      // screen, while reading crisper/wavier. Still faded out with distance to kill
      // shimmer, and dug harder inside chop zones. bumpNormal is only screen-space
      // derivatives of this height, so a cheaper height = a cheaper bump.
      // NO If() gates here (see the branch-hazard note above).
      let rippleH = wavelets(p, t).mul(0.3);
      if (displace > 0) {
        // near patch (where you actually look from a boat/board) keeps a touch of
        // organic FBM(2) break-up on top of the wavelets
        rippleH = rippleH.add(mx_fractal_noise_float(vec3(p.mul(0.09), t.mul(0.06)), 2).mul(0.12));
      }
      rippleH = rippleH.mul(detail).mul(zoneF.mul(0.9).add(1));
      // positionNode displacement does not automatically rebuild the macro
      // normal for this node material. Include the full analytic surf height
      // so a standing wall shades as a wall rather than reflecting the bright
      // sky as though it were a horizontal sheet.
      mat.normalNode = bumpNormal(
        displace > 0 ? rippleH.add(surfField.height) : rippleH
      );

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
      mat.emissiveNode = vec3(1.0, 0.95, 0.82).mul(spark.mul(0.035 * LIGHT_SCALE))
        .add(vec3(0.03, 0.42, 0.2).mul(emeraldVein.mul(0.13 * LIGHT_SCALE)))
        .add(surfWallGlow);

      // Ocean Beach gets an absorptive blue-green body. Brightness belongs to
      // the thin emerald wall and cool lip in the first-use surf overlay; a
      // globally cyan swell made every set dissolve into marine fog.
      const faceCol = mix(waterCol, color(0x075940), surfFaceTint);
      mat.colorNode = mix(faceCol, color(0xb8cecc), foamTotal);
      // roughness rises as the ripple bump fades (Toksvig-style): distant water
      // spreads the sun path into a soft band instead of a mirror streak
      const baseRough = mix(float(0.76), float(0.42), detail);
      mat.roughnessNode = mix(baseRough, float(0.78), foamTotal);

      // Body reads (near-)opaque so the Caribbean colour shows at full saturation
      // instead of the sky bleeding through and greying it out: shallow 0.82,
      // deep 1.0. Only the thin edges stay soft — the player-patch feather
      // (waterVisibility) and the land cutout (dry) — so no seams, no z-fight.
      const alpha = clamp(mix(0.82, 1.0, d2).add(foamTotal.mul(0.25)), 0, 1);
      const surfPresence = max(max(surfField.face, surfField.lip), surfField.white);
      // The lazy high-resolution face follows the player in a 1080 m down-line
      // window — wider than this whole 560 m near patch — so whenever the surf
      // overlay is live the base near sheet yields everywhere its semantic surf
      // water is strong, preventing two copies of the same wall.
      const surfReplacement = displace > 0
        ? smoothstep(0.12, 0.38, surfPresence).mul(this.#uSurfing)
        : float(0);
      mat.opacityNode = alpha
        .mul(waterVisibility)
        .mul(surfReplacement.oneMinus())
        .mul(dry.oneMinus());

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
      mat.opacityNode = clamp(edgeFade.mul(0.975).add(foam.mul(0.08)), 0, 1).mul(shoreCut);

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
      const win = smoothstep(winR.mul(0.3), winR, horiz).oneMinus().toVar(); // 1 overhead → 0 grazing
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
      undMat.opacityNode = clamp(mix(float(0.98), float(0.88), win).mul(distFade), 0, 1);
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

    scene.add(this.far, this.near, this.palaceLagoon, this.underside);
    this.echoes = new WaterEchoes(scene, map);
  }

  update(t: number, camPos: THREE.Vector3, playerPos: THREE.Vector3, surfing = false) {
    this.#uTime.value = t;
    this.#uSurfing.value = surfing ? 1 : 0;

    // show the underside ceiling only while the camera is below the surface,
    // parked at the camera's XZ so its Snell window stays centred overhead
    const camUnder = camPos.y < waterHeight(camPos.x, camPos.z, t) - 0.35;
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
    // Tall Ocean Beach faces put the board ~12 m above sea level; that clearance
    // used to fade the near patch to the flat far sheet mid-ride. Keep it fully
    // visible while surfing so CPU floor and GPU swell stay matched.
    if (surfing) {
      this.#uNearVisibility.value = 1;
      this.near.visible = true;
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
