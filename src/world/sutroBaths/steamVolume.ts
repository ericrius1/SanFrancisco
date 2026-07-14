// Volumetric thermal steam for the restored Sutro Baths hot pools.
//
// Each heated tank owns ONE upright box shell (BackSide, so the camera can be
// outside or inside the volume). The fragment shader reconstructs a view ray,
// analytically clips it to the pool's oriented column, and raymarches a modest
// number of steps accumulating Beer-Lambert transmittance through an advected
// triNoise3D density field. Warm near the water, cool white as it climbs, with a
// cheap single-tap sun-scatter term so the vapour catches light and reads as
// real rising steam rather than flat billboards.
//
// Reference: the marine-fog density/Beer-Lambert grammar in world/sky.ts
// (#buildFogNode) and the Loop/If/Break raymarch grammar in
// render/contactShadows.ts.

import * as THREE from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  float as floatRaw,
  mix as mixRaw,
  normalize,
  positionWorld,
  pow,
  saturate,
  sin,
  triNoise3D,
  uniform,
  vec3 as vec3Raw,
  vec4 as vec4Raw
} from "three/tsl";
import { WIND_DIR } from "../vegetation/wind";
import { SUTRO_BATHS, sutroLocalToWorld } from "./layout";

// TSL node generics fight composition; `any` is the idiom here (see facade.ts).
type N = any;
const float = floatRaw as (...a: N[]) => N;
const vec3 = vec3Raw as (...a: N[]) => N;
const vec4 = vec4Raw as (...a: N[]) => N;
const mix = mixRaw as (...a: N[]) => N;

/** Hard ceiling on the marched box height so one geometry serves every tuning
 * value of steamHeight (the shader clips the active top with a uniform). */
export const STEAM_MAX_HEIGHT = 12;

/** Fixed loop bound. The active step count is a uniform (`steps`) that breaks
 * the loop early, so cost is lowerable at runtime without a shader rebuild. */
const MAX_MARCH_STEPS = 40;

/** Extinction (per metre) at unit density — the Beer-Lambert mean free path. */
const DENSITY_TO_EXTINCTION = 0.62;
/** Short march toward the sun for the self-shadow / scatter tap. */
const SUN_TAP_DISTANCE = 1.4;
const SUN_SHADOW_K = 1.35;

/** Shared, frame-updated uniforms for every steam shell. */
export type SteamUniforms = {
  time: N;
  gust: N;
  amount: N;
  opacity: N;
  height: N;
  steps: N;
  sunDir: N;
  sunGain: N;
  curl: N;
};

export function createSteamUniforms(): SteamUniforms {
  return {
    time: uniform(0),
    gust: uniform(0.4),
    amount: uniform(0.68),
    opacity: uniform(0.22),
    height: uniform(5.8),
    steps: uniform(28),
    sunDir: uniform(new THREE.Vector3(-0.52, 0.42, -0.28).normalize()),
    sunGain: uniform(0.9),
    curl: uniform(0.6)
  };
}

export type SteamShell = {
  mesh: THREE.Mesh;
  material: THREE.NodeMaterial;
};

type PoolBox = {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  heat: number;
};

/**
 * Build one raymarched steam column for a heated pool. `geometry` is a shared
 * unit box; the mesh is scaled/rotated into the pool's world footprint. The site
 * yaw (`cos`/`sin`) lets the shader fold the world ray into the pool's own
 * axis-aligned column for a clean slab intersection.
 */
export function createSteamShell(
  geometry: THREE.BufferGeometry,
  box: PoolBox,
  u: SteamUniforms,
  yaw: number
): SteamShell {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const halfX = box.halfX;
  const halfZ = box.halfZ;
  const waterY = SUTRO_BATHS.waterY;

  // Per-pool constants baked as literals (they never change at runtime).
  const kHalfX = float(halfX);
  const kHalfZ = float(halfZ);
  const kWaterY = float(waterY);
  // The shell mesh is placed at the pool's WORLD centre (sutroLocalToWorld
  // below), so the shader must fold the world-space view ray around that same
  // world centre — NOT the site-local pool centre — or the marched column is
  // displaced by the whole ~6 km site translation and density collapses to 0.
  const worldCentre = sutroLocalToWorld(box.cx, box.cz);
  const kCx = float(worldCentre.x);
  const kCz = float(worldCentre.z);
  const kCos = float(c);
  const kSin = float(s);
  const kHeat = float(box.heat);

  const WARM_BASE = vec3(1.0, 0.8, 0.58); // glow near the heated water
  const COOL_CREST = vec3(0.9, 0.94, 1.0); // cool white higher in the plume
  const SUN_TINT = vec3(1.0, 0.87, 0.72);

  // sutroWorldToLocal rotation applied to an XZ offset: [[c,-s],[s,c]].
  const toLocalXZ = (dx: N, dz: N): N =>
    vec3(kCos.mul(dx).sub(kSin.mul(dz)), float(0), kSin.mul(dx).add(kCos.mul(dz)));

  // Density at a point given its pool-local position (for footprint/height
  // falloff) and its world position (for the drifting noise field).
  const densityAt = Fn(([pLocal, pWorld]: N[]): N => {
    const h = saturate(pLocal.y.sub(kWaterY).div(u.height.max(0.5)));

    // Soft footprint: full in the core, feathering out toward the rim, and a
    // gentle taper as the plume rises so the column narrows into a crown.
    const taper = float(1).sub(h.mul(0.35));
    const rx = saturate(
      float(1).sub(pLocal.x.abs().sub(kHalfX.mul(0.5)).div(kHalfX.mul(0.5).max(0.001)))
    );
    const rz = saturate(
      float(1).sub(pLocal.z.abs().sub(kHalfZ.mul(0.5)).div(kHalfZ.mul(0.5).max(0.001)))
    );
    const radial = rx.mul(rz).mul(taper);

    // Top-heavy dissipation: densest just above the water, thinning upward,
    // with a short rise-in so it doesn't clip hard at the surface.
    const vertical = pow(saturate(float(1).sub(h)), 1.3).mul(saturate(h.mul(14)));

    // Advect the noise field: upward over time (steam rises) plus a wind lean
    // that grows with height and gust, and a slow horizontal curl.
    const gustMix = float(0.35).add(u.gust.mul(0.75));
    const rise = u.time.mul(0.55);
    const lean = u.time.mul(0.12).add(h.mul(gustMix).mul(2.4));
    const curlAmt = sin(pWorld.y.mul(0.3).add(u.time.mul(0.5)).add(pWorld.x.mul(0.05)))
      .mul(u.curl)
      .mul(h);
    const np = vec3(
      pWorld.x.sub(float(WIND_DIR.x).mul(lean)).add(curlAmt),
      pWorld.y.sub(rise),
      pWorld.z.sub(float(WIND_DIR.z).mul(lean)).sub(curlAmt)
    );

    const n1 = triNoise3D(np.mul(0.085), float(0.6), u.time.mul(0.3));
    const n2 = triNoise3D(np.mul(0.2).add(vec3(11.3, 4.1, 7.7)), float(0.95), u.time.mul(0.55));
    const fbm = n1.mul(0.65).add(n2.mul(0.4));
    // Shape wisps and open clear gaps between billows.
    const shaped = saturate(fbm.sub(0.18).div(0.72));

    return shaped.mul(vertical).mul(radial).mul(kHeat).mul(u.amount).mul(1.6);
  });

  const marched = Fn((): N => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(cameraPosition));

    // Fold ray into the pool's axis-aligned column (Y unchanged).
    const roL = toLocalXZ(ro.x.sub(kCx), ro.z.sub(kCz)).add(vec3(0, ro.y, 0));
    const rdL = toLocalXZ(rd.x, rd.z).add(vec3(0, rd.y, 0));

    const top = kWaterY.add(u.height);
    const bmin = vec3(kHalfX.negate(), kWaterY, kHalfZ.negate());
    const bmax = vec3(kHalfX, top, kHalfZ);
    // Guard the slab reciprocal: axis-parallel rays give rdL component 0, and
    // 0 * inf in the slab test poisons tNear/tFar with NaN. Keep the sign, floor
    // the magnitude so parallel rays yield a large-but-finite slope.
    const inv = rdL.sign().div(rdL.abs().max(vec3(1e-5, 1e-5, 1e-5)));
    const t0 = bmin.sub(roL).mul(inv);
    const t1 = bmax.sub(roL).mul(inv);
    const tsmall = t0.min(t1);
    const tbig = t0.max(t1);
    const tNear = tsmall.x.max(tsmall.y).max(tsmall.z).max(0);
    const tFar = tbig.x.min(tbig.y).min(tbig.z);

    const span = tFar.sub(tNear).max(0);
    const stepLen = span.div(u.steps);

    // Sun tap direction, in world and folded local space.
    const sunW = u.sunDir;
    const sunL = toLocalXZ(sunW.x, sunW.z).add(vec3(0, sunW.y, 0));
    const forward = saturate(rd.dot(sunW));
    const forwardScatter = pow(forward, 4);

    const col = vec3(0, 0, 0).toVar();
    const trans = float(1).toVar();
    const t = tNear.add(stepLen.mul(0.5)).toVar();

    Loop(MAX_MARCH_STEPS, ({ i }: N) => {
      If(float(i).greaterThanEqual(u.steps), () => {
        Break();
      });

      const pW = ro.add(rd.mul(t));
      const pL = roL.add(rdL.mul(t));
      const d = densityAt(pL, pW);

      const ext = d.mul(stepLen).mul(DENSITY_TO_EXTINCTION);
      const a = ext.negate().exp().oneMinus();

      // Height for colouring + one-tap self-shadow toward the sun.
      const h = saturate(pL.y.sub(kWaterY).div(u.height.max(0.5)));
      const sW = pW.add(sunW.mul(SUN_TAP_DISTANCE));
      const sL = pL.add(sunL.mul(SUN_TAP_DISTANCE));
      const ds = densityAt(sL, sW);
      const lightT = ds.mul(SUN_SHADOW_K).negate().exp();

      const base = mix(WARM_BASE, COOL_CREST, h);
      const tinted = mix(base, SUN_TINT, forwardScatter.mul(lightT).mul(0.6));
      const shadeScalar = mix(float(0.4), float(1.0), lightT);
      const scatter = float(0.55).add(u.sunGain.mul(forwardScatter).mul(lightT));
      const lit = tinted.mul(shadeScalar).mul(scatter);

      col.addAssign(trans.mul(a).mul(lit));
      trans.mulAssign(a.oneMinus());
      t.addAssign(stepLen);

      If(trans.lessThan(0.012), () => {
        Break();
      });
    });

    const alpha = trans.oneMinus().mul(u.opacity);
    // Return premultiplied radiance in rgb + coverage in a. The colorNode below
    // un-premultiplies so the renderer's opacity multiply composites correctly.
    return vec4(col, alpha);
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "sutro_steam_volume";
  const out: N = marched();
  material.colorNode = out.rgb.div(out.a.max(0.0015));
  material.opacityNode = out.a;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.BackSide;
  material.toneMapped = true;
  material.fog = true;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `sutro_steam_${box.heat.toFixed(2)}`;
  mesh.scale.set(halfX * 2, STEAM_MAX_HEIGHT, halfZ * 2);
  const world = sutroLocalToWorld(box.cx, box.cz);
  mesh.position.set(world.x, waterY + STEAM_MAX_HEIGHT * 0.5, world.z);
  mesh.rotation.y = yaw;
  mesh.renderOrder = 12;
  mesh.layers.set(31);
  mesh.frustumCulled = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return { mesh, material };
}
