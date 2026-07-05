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
import { bumpNormal, chopZoneMask, swellBase, swellChop } from "./tslUtil";
import { LIGHT_SCALE } from "../config";

const PALACE_LAGOON_SEGMENTS = 112;
const PALACE_LAGOON_RINGS = 18;
const NEAR_PATCH_SIZE = 560;
const NEAR_PATCH_SEGMENTS = 110;
const NEAR_PATCH_MASK_OUTER = 276;
const NEAR_PATCH_MASK_INNER = 210;
const NEAR_PATCH_FADE_START_HEIGHT = 5;
const NEAR_PATCH_FADE_END_HEIGHT = 12;
const TAU = Math.PI * 2;

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

  #uTime = uniform(0);
  #uNearRect = uniform(new THREE.Vector3(0, 0, NEAR_PATCH_MASK_OUTER));
  #uNearVisibility = uniform(1);
  #uOrigin = uniform(new THREE.Vector2());

  constructor(scene: THREE.Scene, map: WorldMap) {
    const { tex, scale } = map.buildFloorTexture();
    const g = map.meta.grid;
    const w = g.width * g.cellSize + 8000;
    const h = g.height * g.cellSize + 8000;

    const makeMaterial = (displace: number, holed: boolean) => {
      // near patch: full physical (ior + tuned specular carry the sun path
      // right around the player). Far sheet: standard — the physical fragment
      // path is measurably heavier and the sheet is the biggest surface on
      // screen over open water (2560×1440 open-bay: sheets hidden 120fps vs
      // 69fps drawn), while past the near hole the extra sheen never reads.
      const mat =
        displace > 0
          ? new THREE.MeshPhysicalNodeMaterial({
              transparent: true,
              depthWrite: false,
              roughness: 0.48,
              metalness: 0,
              ior: 1.33,
              specularIntensity: 0.16
            })
          : new THREE.MeshStandardNodeMaterial({
              transparent: true,
              depthWrite: false,
              roughness: 0.48,
              metalness: 0
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
        const swell = swellBase(lx, lz, t).add(swellChop(lx, lz, t).mul(chopZoneMask(lx, lz).mul(rim)));
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

      // Bay gradient: lift the deep water floor so the foreground stays teal,
      // not black, while the stronger roughness below keeps sunset glare soft.
      const d1 = exp(depth.mul(-0.24)).oneMinus();
      const d2 = exp(depth.mul(-0.055)).oneMinus().toVar();
      const waterCol = mix(mix(color(0xa7bb9f), color(0x2f9d91), d1), color(0x0f5a5c), d2).toVar();

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
      // shore foam: soft lapping band + speckle
      const nA = mx_fractal_noise_float(vec3(pxz.mul(0.11), t.mul(0.05)), 3).mul(0.5).add(0.5);
      const lap = sin(t.mul(1.1).add(depth.mul(9)).add(nA.mul(6))).mul(0.5).add(0.5);
      const foamNoise = mx_fractal_noise_float(vec3(pxz.mul(0.9), t.mul(0.12)), 3).mul(0.5).add(0.5);
      // chop-zone whitecaps: scattered speckle so rough patches read from afar
      const zoneF = chopZoneMask(pxz.x, pxz.y).toVar();
      const foam = foamBand.mul(smoothstep(0.45, 0.75, foamNoise.mul(0.75).add(lap.mul(0.35)))).mul(0.85)
        .add(zoneF.mul(smoothstep(0.62, 0.88, foamNoise)).mul(0.28))
        .toVar();

      // ripple bump, faded fully out with distance to kill shimmer; the bump
      // digs harder inside chop zones so the surface texture sells the waves
      const rippleH = mx_fractal_noise_float(vec3(p.mul(0.11), t.mul(0.09)), 3)
        .add(mx_fractal_noise_float(vec3(p.mul(0.045), t.mul(0.055).negate()), 3).mul(0.9))
        .mul(0.22)
        .mul(detail)
        .mul(zoneF.mul(0.8).add(1));
      mat.normalNode = bumpNormal(rippleH);

      // sun sparkle: occasional near-field flecks only; the physical specular
      // carries the sunset reflection, so this stays below the authored emissive accents.
      const sparkNoise = mx_noise_float(vec3(p.mul(2.2), t.mul(0.8)));
      const spark = smoothstep(0.78, 0.97, sparkNoise).mul(detail.mul(detail)).mul(foam.oneMinus());
      mat.emissiveNode = vec3(1.0, 0.95, 0.82).mul(spark.mul(0.035 * LIGHT_SCALE));

      mat.colorNode = mix(waterCol, color(0xf0f7f2), foam);
      // roughness rises as the ripple bump fades (Toksvig-style): distant water
      // spreads the sun path into a soft band instead of a mirror streak
      const baseRough = mix(float(0.76), float(0.42), detail);
      mat.roughnessNode = mix(baseRough, float(0.78), foam);

      const alpha = clamp(mix(0.42, 0.93, d2).add(foam.mul(0.4)), 0, 0.97);
      mat.opacityNode = alpha.mul(waterVisibility).mul(dry.oneMinus());

      mat.envMapIntensity = 0.25;
      return mat;
    };

    const makePalaceLagoonMaterial = () => {
      const mat = new THREE.MeshPhysicalNodeMaterial({
        transparent: true,
        depthWrite: false,
        roughness: 0.5,
        metalness: 0,
        ior: 1.33,
        specularIntensity: 0.22,
        side: THREE.DoubleSide
      });

      const t = this.#uTime;
      const edgeUv = uv().sub(vec2(0.5, 0.5)).mul(2).toVar();
      const radial = edgeUv.x.mul(edgeUv.x).add(edgeUv.y.mul(edgeUv.y)).toVar();
      const edgeFade = smoothstep(0.64, 0.96, radial).oneMinus().toVar();
      const shore = smoothstep(0.42, 0.96, radial).toVar();

      const swell = swellBase(positionLocal.x, positionLocal.z, t).mul(0.42);
      mat.positionNode = positionLocal.add(vec3(0, swell, 0));

      const p = positionWorld.xz;

      // shore cut: the lagoon ellipse spills east onto higher urban ground, so
      // hide water wherever the bay-floor rises to (or above) the pond waterline.
      // This carves the sheet down to the true low basin — no water draped over
      // roads/houses — while the low park basin stays flooded. Matches the flora
      // exclusion in flora.ts (WorldMap.lagoonWater).
      const fuv = p.sub(vec2(scale.x, scale.y)).div(vec2(scale.z, scale.w));
      const floorH = texture(tex, fuv).r;
      const shoreCut = smoothstep(PALACE_LAGOON.surfaceY + 0.45, PALACE_LAGOON.surfaceY - 0.05, floorH).toVar();

      const foamNoise = mx_fractal_noise_float(vec3(p.mul(0.31), t.mul(0.1)), 3).mul(0.5).add(0.5);
      const lap = sin(t.mul(1.25).add(radial.mul(11)).add(foamNoise.mul(5))).mul(0.5).add(0.5);
      const foam = shore
        .mul(smoothstep(0.56, 0.82, foamNoise.mul(0.62).add(lap.mul(0.38))))
        .mul(edgeFade)
        .mul(0.62)
        .toVar();

      const rippleH = mx_fractal_noise_float(vec3(p.mul(0.18), t.mul(0.11)), 3)
        .add(mx_fractal_noise_float(vec3(p.mul(0.07), t.mul(0.06).negate()), 3).mul(0.75))
        .mul(0.16)
        .mul(edgeFade);
      mat.normalNode = bumpNormal(rippleH);

      const lagoonCol = mix(color(0x164f68), color(0x63c2b5), smoothstep(0.05, 0.9, radial));
      mat.colorNode = mix(lagoonCol, color(0xecf5e9), foam);
      mat.roughnessNode = mix(float(0.42), float(0.72), shore);
      mat.opacityNode = clamp(edgeFade.mul(0.94).add(foam.mul(0.16)), 0, 0.98).mul(shoreCut);

      const sparkle = smoothstep(0.8, 0.98, mx_noise_float(vec3(p.mul(1.8), t.mul(0.7))))
        .mul(edgeFade)
        .mul(foam.oneMinus());
      mat.emissiveNode = vec3(0.75, 0.92, 0.86).mul(sparkle.mul(0.018 * LIGHT_SCALE));
      mat.envMapIntensity = 0.32;
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

    this.palaceLagoon = new THREE.Mesh(createPalaceLagoonGeometry(map), makePalaceLagoonMaterial());
    this.palaceLagoon.name = "palace_fine_arts_lagoon";
    this.palaceLagoon.renderOrder = 10.5;

    scene.add(this.far, this.near, this.palaceLagoon);
  }

  update(t: number, _camPos: THREE.Vector3, playerPos: THREE.Vector3) {
    this.#uTime.value = t;
    // snap the near patch to its own grid so vertices don't swim
    const snap = NEAR_PATCH_SIZE / NEAR_PATCH_SEGMENTS;
    this.near.position.x = Math.round(playerPos.x / snap) * snap;
    this.near.position.z = Math.round(playerPos.z / snap) * snap;
    this.#uOrigin.value.set(this.near.position.x, this.near.position.z);
    this.#uNearRect.value.set(this.near.position.x, this.near.position.z, NEAR_PATCH_MASK_OUTER);

    const clearance = playerPos.y - waterHeight(playerPos.x, playerPos.z, t);
    this.#uNearVisibility.value = THREE.MathUtils.clamp(
      (NEAR_PATCH_FADE_END_HEIGHT - clearance) / (NEAR_PATCH_FADE_END_HEIGHT - NEAR_PATCH_FADE_START_HEIGHT),
      0,
      1
    );
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
