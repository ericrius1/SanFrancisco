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
 * A bronze collar set into the tiles at the exact centre of the biggest bath,
 * a 2.5 m bore going down into the dark, and the whole pool turning slowly into
 * it. It is the one visible affordance for the sunken gallery, so it is built
 * with the site rather than with the room it drains into: five unlit draws, no
 * textures, and nothing a visitor who never gets in the water will pay for
 * beyond its compile.
 *
 * THE HOLE IS PAINTED, AND HAS TO BE. The plunge's basin is authored geometry
 * with streamed box colliders under it; there is no runtime way to cut a real
 * opening through either. So the bore is a collar standing 34 cm proud with a
 * throat modelled inside it, and below the tile plane a shaded disc that
 * recedes to black. From every angle a swimmer can actually reach — above it,
 * beside it, nose-down in it — that reads as a shaft. What makes it true is
 * that swimming into it really does take you down (index.ts owns the grab).
 *
 * DRAW ORDER. The renderer runs a REVERSED depth buffer, so three's RenderList
 * flips the transparent renderOrder key: a HIGHER renderOrder draws EARLIER (see
 * SUTRO_WATER_RENDER_ORDER in layout.ts). The pool sheet is 13 and the steam is
 * 12, so the drain takes 11 and lands on top of both — which is right, because
 * it is meant to be visible glowing through two and a half metres of water from
 * the surface.
 */

type N = any;
const float = floatRaw as (...a: N[]) => N;
const vec3 = vec3Raw as (...a: N[]) => N;
const vec4 = vec4Raw as (...a: N[]) => N;
const mix = mixRaw as (...a: N[]) => N;

export const SUTRO_DRAIN_RENDER_ORDER = 11;

/** Cold green-blue in the body of the water, near-white where it thins. */
const WATER_DEEP = /*@__PURE__*/ new THREE.Color(0x1c5f70);
const WATER_PALE = /*@__PURE__*/ new THREE.Color(0xa8f0ff);

const FUNNEL_TOP_RADIUS = 2.35;
const FUNNEL_HEIGHT = 2.05;
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

  const glowing = (name: string): THREE.MeshBasicNodeMaterial => {
    const material = new THREE.MeshBasicNodeMaterial({ name });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.side = THREE.DoubleSide;
    return material;
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
    // Ribs turning slowly down the throat — the drain is drawing.
    const ribs = fract(coord.x.mul(9).sub(depth.mul(5)).add(uTime.mul(0.5).mul(uOpen)));
    const rib = smoothstep(float(0.62), float(0.94), ribs).mul(0.16).mul(fall);
    const body = mix(vec3(0.004, 0.008, 0.012), vec3(0.09, 0.14, 0.16), fall);
    return vec4(body.add(vec3(0.2, 0.42, 0.5).mul(rib)), 1);
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
  // violet corona, which is the whole trick that turns a cone into a shaft.
  const floorMaterial = new THREE.MeshBasicNodeMaterial({ name: "sutro_drain_deep" });
  floorMaterial.side = THREE.DoubleSide;
  floorMaterial.colorNode = Fn(() => {
    const radius = length(positionLocal.xy as N).div(SUTRO_DRAIN.radius * 0.52);
    const corona = smoothstep(float(0.35), float(1), radius);
    const glimmer = sin(radius.mul(9).sub(uTime.mul(1.6).mul(uOpen))).mul(0.5).add(0.5).mul(0.05);
    return vec4(
      mix(vec3(0.0, 0.001, 0.002), vec3(0.24, 0.12, 0.44), corona).add(glimmer.mul(uOpen)),
      1
    );
  })() as N;
  const deepGeometry = new THREE.CircleGeometry(SUTRO_DRAIN.radius * 0.52, 32);
  const deep = add(deepGeometry, floorMaterial, "sutro_drain_deep");
  deep.renderOrder = 0;
  deep.rotation.x = Math.PI / 2;
  deep.position.y = -THROAT_DEPTH + 0.02;

  // ---- the water turning into it ----------------------------------------
  // Open-ended cylinder wide at the top and necking into the collar: the funnel
  // the pool makes over a drain. The spiral is a single fract() of "turns
  // around + climb - time", which is what a drawn whirlpool actually is: one
  // continuous line wrapped many times.
  const funnelGeometry = new THREE.CylinderGeometry(
    FUNNEL_TOP_RADIUS,
    SUTRO_DRAIN.radius * 0.92,
    FUNNEL_HEIGHT,
    40,
    1,
    true
  );
  const funnelMaterial = glowing("sutro_drain_funnel");
  funnelMaterial.colorNode = Fn(() => {
    const coord = uv() as N;
    // v runs 0 at the collar to 1 at the mouth on this geometry.
    const climb = coord.y;
    const spiral = fract(coord.x.mul(6).sub(climb.mul(3.4)).sub(uTime.mul(0.42)));
    // Two thicknesses of line, so the whirl reads as water and not a barcode.
    const band = smoothstep(float(0.34), float(0.06), spiral).add(
      smoothstep(float(0.8), float(0.62), spiral).mul(0.45)
    );
    // Thinner and brighter as it necks down, and never a hard edge at the top.
    const neck = mix(float(1.35), float(0.55), climb);
    const mouthFade = smoothstep(float(1), float(0.72), climb);
    const tint = mix(
      vec3(WATER_DEEP.r, WATER_DEEP.g, WATER_DEEP.b),
      vec3(WATER_PALE.r, WATER_PALE.g, WATER_PALE.b),
      band.mul(neck).saturate()
    );
    const alpha = band.mul(neck).mul(mouthFade).mul(mix(float(0.16), float(0.66), uCharge));
    return vec4(tint.mul(mix(float(0.6), float(2.2), uCharge)), alpha);
  })() as N;
  const funnel = add(funnelGeometry, funnelMaterial, "sutro_drain_funnel");
  funnel.position.y = SUTRO_DRAIN.collarHeight + FUNNEL_HEIGHT * 0.5 - 0.1;

  // ---- the ring in the tiles --------------------------------------------
  const RING_REACH = 3.4;
  const ringGeometry = new THREE.RingGeometry(
    SUTRO_DRAIN.collarRadius,
    SUTRO_DRAIN.collarRadius + RING_REACH,
    56,
    1
  );
  const ringMaterial = glowing("sutro_drain_ring");
  ringMaterial.colorNode = Fn(() => {
    // RingGeometry's uv is a plain 0..1 square, so take the radius and the angle
    // from the vertex position instead — exact, and free of the seam.
    const radius = length(positionLocal.xy as N);
    const inner = smoothstep(float(SUTRO_DRAIN.collarRadius), float(SUTRO_DRAIN.collarRadius + 0.5), radius);
    const outer = smoothstep(
      float(SUTRO_DRAIN.collarRadius + RING_REACH),
      float(SUTRO_DRAIN.collarRadius + 0.6),
      radius
    );
    const angle = atan(positionLocal.y as N, positionLocal.x as N);
    // A slow sweep of brightness round the ring: the water is going somewhere.
    const sweep = sin(angle.mul(3).add(uTime.mul(1.1))).mul(0.5).add(0.5).mul(0.55).add(0.45);
    const alpha = inner.mul(outer).mul(sweep).mul(mix(float(0.26), float(0.9), uCharge)).mul(uOpen);
    return vec4(vec3(WATER_PALE.r, WATER_PALE.g, WATER_PALE.b).mul(mix(float(1.1), float(2.8), uCharge)), alpha);
  })() as N;
  const ring = add(ringGeometry, ringMaterial, "sutro_drain_ring");
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;

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
      // The whirl turns; the funnel is symmetric, so this costs nothing.
      funnel.rotation.y = -time * 0.55 * (0.35 + 0.65 * open);
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
