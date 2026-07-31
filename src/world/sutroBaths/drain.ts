import * as THREE from "three/webgpu";
import {
  Fn,
  atan,
  float as floatRaw,
  fract,
  length,
  mix as mixRaw,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3 as vec3Raw,
  vec4 as vec4Raw
} from "three/tsl";
import { SUTRO_BATHS, SUTRO_DRAIN, sutroLocalToWorld } from "./layout";

/**
 * The drain in the floor of the great plunge.
 *
 * A bronze collar set into the tiles, a throat falling into the dark, and a
 * quiet water-coloured swirl in the shaft. The SURFACE whirlpool — the
 * depression, the tangential spin, the foam lip — lives on the pool sheet
 * itself (`staticWater.ts`) so it is the same material and the same teal as
 * the rest of the bath. This file only owns what you see once you look INTO
 * the bore: the collar, the teeth, and the dark turning below.
 *
 * THE HOLE IS PAINTED, AND HAS TO BE. The plunge's basin is authored geometry
 * with streamed box colliders under it; there is no runtime way to cut a real
 * opening through either. So the bore is a collar standing proud with a throat
 * modelled inside it, and below the tile plane a shaded disc that recedes to
 * black. From every angle a swimmer can actually reach that reads as a shaft.
 * What makes it true is that swimming into it really does take you down
 * (index.ts owns the grab).
 *
 * DRAW ORDER. The renderer runs a REVERSED depth buffer, so three's RenderList
 * flips the transparent renderOrder key: a HIGHER renderOrder draws EARLIER
 * (see SUTRO_WATER_RENDER_ORDER in layout.ts). The pool sheet is 13 and the
 * steam is 12; the swirl film takes 11 so it composites under the sheet's
 * refraction but still reads through two and a half metres of water.
 */

type N = any;
const float = floatRaw as (...a: N[]) => N;
const vec3 = vec3Raw as (...a: N[]) => N;
const vec4 = vec4Raw as (...a: N[]) => N;
const mix = mixRaw as (...a: N[]) => N;

export const SUTRO_DRAIN_RENDER_ORDER = 11;

/** Match the pool sheet's deep / shallow teal so the shaft never reads as a VFX. */
const WATER_DEEP = /*@__PURE__*/ new THREE.Color(0x125257);
const WATER_BODY = /*@__PURE__*/ new THREE.Color(0x3fa398);
const WATER_LIP = /*@__PURE__*/ new THREE.Color(0x8ec9b8);

const THROAT_DEPTH = 1.5;

export type SutroDrain = {
  group: THREE.Group;
  /** 0 = quiet and dark, 1 = turning hard. Ramped by proximity in index.ts. */
  setCharge(charge: number): void;
  /** False until the room below exists: a drain with nowhere to go stays still. */
  setOpen(open: boolean): void;
  update(time: number): void;
  dispose(): void;
};

export function createSutroDrain(): SutroDrain {
  const group = new THREE.Group();
  group.name = "sutro_baths_plunge_drain";
  const world = sutroLocalToWorld(SUTRO_DRAIN.x, SUTRO_DRAIN.z);
  group.position.set(world.x, SUTRO_DRAIN.y, world.z);
  group.rotation.y = SUTRO_BATHS.yaw;

  const uTime = uniform(0) as N;
  const uCharge = uniform(0) as N;
  const uOpen = uniform(0) as N;

  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  const add = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = SUTRO_DRAIN_RENDER_ORDER;
    geometries.push(geometry);
    materials.push(material);
    group.add(mesh);
    return mesh;
  };

  // ---- the collar --------------------------------------------------------
  // Real, lit bronze: the one solid thing here, so the eye has something to
  // read the scale of the bore against.
  // Emissive on purpose. This collar is the ONLY clue that the sunken gallery
  // exists, it is 2.5 m down in an 84 m pool, and the underwater rig hazes
  // everything at that range to a pale wash — an unlit bronze ring down there
  // is invisible from the surface, which makes the room undiscoverable.
  const collarMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_drain_collar",
    color: 0x8d6a34,
    roughness: 0.36,
    metalness: 0.82,
    emissive: new THREE.Color(0x3f8fa0),
    emissiveIntensity: 0.55
  });
  const collarGeometry = new THREE.CylinderGeometry(
    SUTRO_DRAIN.radius,
    SUTRO_DRAIN.collarRadius,
    SUTRO_DRAIN.collarHeight,
    36,
    1,
    true
  );
  // Open-ended, so a swimmer looking into the bore from any angle sees bronze
  // rather than the back of a one-sided cone.
  collarMaterial.side = THREE.DoubleSide;
  const collar = add(collarGeometry, collarMaterial, "sutro_drain_collar");
  collar.renderOrder = 0;
  collar.receiveShadow = true;
  collar.position.y = SUTRO_DRAIN.collarHeight * 0.5;

  // A ring of bronze teeth around the outside — a grating that was lifted off a
  // long time ago and never put back.
  const toothGeometry = new THREE.BoxGeometry(0.42, 0.16, 0.17);
  const teeth = new THREE.InstancedMesh(toothGeometry, collarMaterial, 18);
  teeth.name = "sutro_drain_collar_teeth";
  teeth.castShadow = false;
  teeth.receiveShadow = true;
  const toothMatrix = new THREE.Matrix4();
  const toothPosition = new THREE.Vector3();
  const toothQuaternion = new THREE.Quaternion();
  const toothScale = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    toothPosition.set(
      Math.cos(angle) * (SUTRO_DRAIN.collarRadius - 0.1),
      0.07,
      Math.sin(angle) * (SUTRO_DRAIN.collarRadius - 0.1)
    );
    toothQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle);
    toothMatrix.compose(toothPosition, toothQuaternion, toothScale);
    teeth.setMatrixAt(i, toothMatrix);
  }
  teeth.instanceMatrix.needsUpdate = true;
  geometries.push(toothGeometry);
  group.add(teeth);

  // ---- the throat --------------------------------------------------------
  // Below the collar's lip: an unlit cone falling away to nothing. Depth-tested
  // and depth-writing, so the water sheet and the collar sort against it
  // correctly and it genuinely occludes what it should.
  const throatMaterial = new THREE.MeshBasicNodeMaterial({ name: "sutro_drain_throat" });
  throatMaterial.side = THREE.BackSide;
  throatMaterial.colorNode = Fn(() => {
    const coord = uv() as N;
    // v: 1 at the lip, 0 at the far end of the cone.
    const depth = coord.y;
    const fall = smoothstep(float(0.05), float(0.95), depth);
    // Soft helical darkening — water colour, not a barcode of glow bands.
    const spiral = fract(
      coord.x.mul(4.2).sub(depth.mul(2.6)).sub(uTime.mul(0.55).mul(uOpen.add(0.25)))
    );
    const band = smoothstep(float(0.55), float(0.12), spiral)
      .mul(0.22)
      .mul(fall)
      .mul(mix(float(0.35), float(1), uCharge));
    const body = mix(
      vec3(WATER_DEEP.r * 0.15, WATER_DEEP.g * 0.15, WATER_DEEP.b * 0.18),
      vec3(WATER_BODY.r * 0.55, WATER_BODY.g * 0.55, WATER_BODY.b * 0.55),
      fall
    );
    return vec4(body.add(vec3(WATER_LIP.r, WATER_LIP.g, WATER_LIP.b).mul(band)), 1);
  })() as N;
  const throatGeometry = new THREE.CylinderGeometry(
    SUTRO_DRAIN.radius,
    SUTRO_DRAIN.radius * 0.52,
    THROAT_DEPTH,
    32,
    1,
    true
  );
  const throat = add(throatGeometry, throatMaterial, "sutro_drain_throat");
  throat.renderOrder = 0;
  throat.position.y = -THROAT_DEPTH * 0.5 + 0.02;

  // The bottom of the throat: not a lid, a distance. Near-black with a faint
  // teal corona — the same trick that turns a cone into a shaft, now in pool
  // colour instead of a violet VFX disc.
  const floorMaterial = new THREE.MeshBasicNodeMaterial({ name: "sutro_drain_deep" });
  floorMaterial.side = THREE.DoubleSide;
  floorMaterial.colorNode = Fn(() => {
    const radius = length(positionLocal.xy as N).div(SUTRO_DRAIN.radius * 0.52);
    const corona = smoothstep(float(0.25), float(1), radius);
    const spin = sin(
      atan(positionLocal.y as N, positionLocal.x as N)
        .mul(3)
        .sub(uTime.mul(1.4).mul(uOpen.add(0.2)))
        .add(radius.mul(-4))
    )
      .mul(0.5)
      .add(0.5)
      .mul(0.06)
      .mul(uOpen);
    return vec4(
      mix(
        vec3(0.0, 0.004, 0.006),
        vec3(WATER_DEEP.r * 0.7, WATER_DEEP.g * 0.55, WATER_DEEP.b * 0.65),
        corona
      ).add(spin),
      1
    );
  })() as N;
  const deepGeometry = new THREE.CircleGeometry(SUTRO_DRAIN.radius * 0.52, 32);
  const deep = add(deepGeometry, floorMaterial, "sutro_drain_deep");
  deep.renderOrder = 0;
  deep.rotation.x = Math.PI / 2;
  deep.position.y = -THROAT_DEPTH + 0.02;

  // ---- the water film inside the bore ------------------------------------
  // A short open cylinder of pool-coloured water turning just above the collar.
  // Normal blending (not additive), soft edges, same teal as the sheet — so
  // from the surface it reads as the whirl continuing down the hole rather
  // than a cut-off cyan VFX cone.
  const filmHeight = SUTRO_BATHS.waterY - SUTRO_DRAIN.y - SUTRO_DRAIN.collarHeight * 0.35;
  const filmGeometry = new THREE.CylinderGeometry(
    SUTRO_DRAIN.radius * 0.98,
    SUTRO_DRAIN.radius * 0.88,
    Math.max(0.8, filmHeight * 0.55),
    48,
    1,
    true
  );
  const filmMaterial = new THREE.MeshBasicNodeMaterial({ name: "sutro_drain_whirl_film" });
  filmMaterial.transparent = true;
  filmMaterial.depthWrite = false;
  filmMaterial.side = THREE.DoubleSide;
  filmMaterial.colorNode = Fn(() => {
    const coord = uv() as N;
    const climb = coord.y;
    const spiral = fract(
      coord.x
        .mul(5.5)
        .sub(climb.mul(2.8))
        .sub(uTime.mul(0.7).mul(mix(float(0.35), float(1.15), uCharge)))
    );
    // Wide soft ribbons, not thin barcode lines — reads as folding water.
    const band = smoothstep(float(0.72), float(0.18), spiral).mul(0.55).add(
      smoothstep(float(0.95), float(0.78), spiral).mul(0.25)
    );
    const mouthFade = smoothstep(float(1), float(0.55), climb).mul(
      smoothstep(float(0), float(0.18), climb)
    );
    const tint = mix(
      vec3(WATER_DEEP.r, WATER_DEEP.g, WATER_DEEP.b),
      vec3(WATER_BODY.r, WATER_BODY.g, WATER_BODY.b),
      band.mul(0.65).add(0.2)
    );
    const alpha = band
      .mul(mouthFade)
      .mul(mix(float(0.18), float(0.48), uCharge))
      .mul(mix(float(0.45), float(1), uOpen));
    return vec4(tint, alpha);
  })() as N;
  const film = add(filmGeometry, filmMaterial, "sutro_drain_whirl_film");
  film.position.y = SUTRO_DRAIN.collarHeight + Math.max(0.8, filmHeight * 0.55) * 0.45;

  let charge = 0;
  let open = 0;

  return {
    group,
    setCharge(next) {
      const clamped = THREE.MathUtils.clamp(next, 0, 1);
      if (Math.abs(clamped - charge) < 1e-3) return;
      charge = clamped;
      uCharge.value = clamped;
    },
    setOpen(next) {
      const target = next ? 1 : 0;
      if (open === target) return;
      open = target;
      uOpen.value = target;
    },
    update(time) {
      uTime.value = time;
      // The film is radially symmetric; spinning it costs a matrix write and
      // keeps the helix from feeling frozen when charge is low.
      film.rotation.y = -time * 0.85 * (0.4 + 0.6 * open);
    },
    dispose() {
      teeth.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      collarMaterial.dispose();
      geometries.length = 0;
      materials.length = 0;
      group.clear();
      group.removeFromParent();
    }
  };
}
