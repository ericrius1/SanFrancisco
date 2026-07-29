import * as THREE from "three/webgpu";
import {
  attribute,
  float as floatRaw,
  saturate,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec4 as vec4Raw
} from "three/tsl";
import { SUN_STATE } from "../sky";
import { goldenHourAmount } from "./sunsetAir";
import { spectrumColor } from "./spectrum";

// TSL node generics fight composition; `any` is the idiom here (see facade.ts).
type N = any;
const float = floatRaw as (...a: N[]) => N;
const vec4 = vec4Raw as (...a: N[]) => N;

/**
 * What the prism kite does instead of casting shadows.
 *
 * Every other sail on this beach is an occluder: the light is warm, the kite
 * takes bites out of it, and what is left over is a shaft. This one is a
 * disperser. A single white beam runs in from the sun, the sail separates it,
 * and a fan of seven bands leaves the far side and falls until it lands on the
 * sand — where it lies as a smear of the same spectrum, in the same order.
 *
 * Three meshes and one draw each. The fan is built ONCE in a local frame with
 * its colours baked into a vertex attribute, so a whole spectrum costs one
 * geometry, one material and one quaternion a frame; only the sand patch is
 * rewritten on the CPU, and only when the beam has actually moved.
 */

/** Bands in the fan. Seven is the sleeve's count and the eye's limit. */
const BANDS = 7;
/** Half-angle the fan splays through, radians. Scaled by the design's spread. */
const FAN_HALF_ANGLE = 0.3;
const FAN_NEAR = 1.2;
const FAN_FAR = 54;
/** Segments along a band; the fade toward the far end is vertex-interpolated. */
const FAN_SEGMENTS = 14;
const ENTRY_LENGTH = 34;
const ENTRY_WIDTH = 0.62;

/**
 * How far below the sun-opposite axis the fan is aimed. Refraction bends the
 * exit ray down off the incoming one, and at these hours the incoming one is
 * within a couple of degrees of level — so without a real tilt the spectrum
 * would run out flat over the water and never reach the beach it is supposed to
 * be lighting. Thirty-four degrees puts the landing about forty metres downsun
 * of a kite thirty metres up: on the sand, in the same frame, in front of the
 * flyers rather than behind them.
 */
const FAN_TILT = 0.6;
/** Metres of sand the landed spectrum covers, along the beam and across it. */
const SAND_LENGTH = 34;
const SAND_WIDTH = 26;
const SAND_ALONG = 10;
const SAND_ACROSS = 12;
/** Lift off the sand. Additive and depth-tested, so this only has to clear it. */
const SAND_LIFT = 0.12;
/** Seconds between ground-hit solves; the smear eases between them. */
const SAND_SOLVE_INTERVAL = 0.12;

export type PrismLightState = {
  /** 0..1 golden-hour window. */
  golden: number;
  /** 0..1 how squarely the camera is looking through the kite at the sun. */
  alignment: number;
  /** 0..1 how much spectrum is actually on screen right now. */
  strength: number;
};

export type PrismAnchor = {
  position: THREE.Vector3;
  /** The kite's own orientation; its roll swings the fan. */
  quaternion: THREE.Quaternion;
  /** The design's `raySpread`, read here as the fan's splay. */
  spread: number;
};

export type PrismLight = {
  group: THREE.Group;
  state: PrismLightState;
  update(o: {
    dt: number;
    camera: THREE.Vector3;
    /** The encounter's shaft dial; the prism rides the same slider. */
    strength: number;
    enabled: boolean;
  }): void;
  dispose(): void;
};

/**
 * The fan, in a local frame where +Y is the beam and the spectrum splays across
 * X. Building it here rather than per frame is the whole performance story: the
 * shape never changes, only where it is pointed.
 */
function buildFanGeometry(halfAngle: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const band = new THREE.Color();
  for (let i = 0; i < BANDS; i++) {
    const t = BANDS > 1 ? i / (BANDS - 1) : 0.5;
    spectrumColor(t, band);
    const angle = (t - 0.5) * 2 * halfAngle;
    const dirX = Math.sin(angle);
    const dirY = Math.cos(angle);
    // Perpendicular in the fan's own plane; a band widens with range so the far
    // end never thins below a pixel and the whole fan reads as a cone of light.
    const sideX = dirY;
    const sideY = -dirX;
    const push = (r: number, side: number, u: number, v: number) => {
      const width = 0.28 + r * 0.019;
      positions.push(
        dirX * r + sideX * width * side,
        dirY * r + sideY * width * side,
        0
      );
      colors.push(band.r, band.g, band.b);
      uvs.push(u, v);
    };
    for (let s = 0; s < FAN_SEGMENTS; s++) {
      const v0 = s / FAN_SEGMENTS;
      const v1 = (s + 1) / FAN_SEGMENTS;
      const r0 = THREE.MathUtils.lerp(FAN_NEAR, FAN_FAR, v0 * v0);
      const r1 = THREE.MathUtils.lerp(FAN_NEAR, FAN_FAR, v1 * v1);
      push(r0, -1, 0, v0); push(r0, 1, 1, v0); push(r1, -1, 0, v1);
      push(r1, -1, 0, v1); push(r0, 1, 1, v0); push(r1, 1, 1, v1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("band", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

/** Additive, depth-tested, never depth-writing — the shared contract for light. */
function makeAdditive(material: THREE.Material): void {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquation = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
}

export function createPrismLight(opts: {
  anchor: PrismAnchor;
  /** Terrain sampler; the smear on the sand follows the real ground. */
  ground: (x: number, z: number) => number;
  /**
   * Whether a point is sea. A beam that lands offshore has landed on a moving
   * surface the terrain sampler knows nothing about — `ground` there returns the
   * seabed, metres under the waves — so the smear is simply withheld rather than
   * painted onto a seabed nobody can see.
   */
  water?: (x: number, z: number) => boolean;
}): PrismLight {
  const group = new THREE.Group();
  group.name = "ocean_beach_prism_light";
  group.visible = false;

  const state: PrismLightState = { golden: 0, alignment: 0, strength: 0 };
  const fanStrength = uniform(0);
  const entryStrength = uniform(0);
  const sandStrength = uniform(0);

  const ownedMaterials: THREE.Material[] = [];
  const ownedGeometries: THREE.BufferGeometry[] = [];

  // ------------------------------------------------------------------ fan
  const fanGeometry = buildFanGeometry(FAN_HALF_ANGLE * (opts.anchor.spread / 0.3));
  ownedGeometries.push(fanGeometry);
  const fanMaterial = new THREE.MeshBasicNodeMaterial();
  ownedMaterials.push(fanMaterial);
  {
    const across = sin(uv().x.mul(Math.PI)).pow(1.45);
    // Bright where it leaves the sail and thinning with range — but never to
    // nothing before the far end, because the far end is where it meets the
    // sand and the two have to agree.
    const along = smoothstep(0, 0.09, uv().y).mul(
      saturate(float(1).sub(uv().y.mul(0.82))).pow(1.35)
    );
    // A slow breath along each band so the fan is alive without any of it
    // being random: same phase every replay, which the capture harness needs.
    const shimmer = sin(uv().y.mul(7.5).sub(time.mul(0.9))).mul(0.09).add(0.94);
    fanMaterial.colorNode = vec4(attribute("band", "vec3"), 1);
    fanMaterial.opacityNode = across.mul(along).mul(shimmer).mul(fanStrength);
    fanMaterial.side = THREE.DoubleSide;
    makeAdditive(fanMaterial);
  }
  const fan = new THREE.Mesh(fanGeometry, fanMaterial);
  fan.name = "ocean_beach_prism_fan";
  fan.frustumCulled = false;
  fan.renderOrder = 8;
  group.add(fan);

  // ---------------------------------------------------------------- entry
  // The white beam arriving. One quad, billboarded the same way the fan is, and
  // deliberately thin: it is the thing the spectrum is separated FROM, so it
  // has to read as a single line right up to the moment it hits the sail.
  const entryGeometry = new THREE.PlaneGeometry(ENTRY_WIDTH, ENTRY_LENGTH, 1, 8);
  entryGeometry.translate(0, ENTRY_LENGTH * 0.5, 0);
  ownedGeometries.push(entryGeometry);
  const entryMaterial = new THREE.MeshBasicNodeMaterial();
  ownedMaterials.push(entryMaterial);
  {
    const across = sin(uv().x.mul(Math.PI)).pow(2.2);
    // Fades out at the far end rather than at the kite: the beam should look
    // like it comes out of the haze and stops dead on the sail.
    const along = saturate(float(1).sub(uv().y)).pow(0.85).mul(
      smoothstep(0, 0.06, uv().y)
    );
    entryMaterial.colorNode = vec4(1.0, 0.97, 0.92, 1);
    entryMaterial.opacityNode = across.mul(along).mul(entryStrength);
    entryMaterial.side = THREE.DoubleSide;
    makeAdditive(entryMaterial);
  }
  const entry = new THREE.Mesh(entryGeometry, entryMaterial);
  entry.name = "ocean_beach_prism_entry_beam";
  entry.frustumCulled = false;
  entry.renderOrder = 8;
  group.add(entry);

  // ----------------------------------------------------------------- sand
  // Where the fan lands. A grid rather than a quad because it has to lie ON the
  // beach — the dry sand rolls a metre or so across this span, and a flat card
  // would sink into one dune and float over the next.
  const sandGeometry = new THREE.BufferGeometry();
  ownedGeometries.push(sandGeometry);
  {
    const positions = new Float32Array((SAND_ALONG + 1) * (SAND_ACROSS + 1) * 3);
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const band = new THREE.Color();
    for (let a = 0; a <= SAND_ALONG; a++) {
      for (let c = 0; c <= SAND_ACROSS; c++) {
        const u = c / SAND_ACROSS;
        const v = a / SAND_ALONG;
        spectrumColor(u, band);
        colors.push(band.r, band.g, band.b);
        uvs.push(u, v);
      }
    }
    for (let a = 0; a < SAND_ALONG; a++) {
      for (let c = 0; c < SAND_ACROSS; c++) {
        const i0 = a * (SAND_ACROSS + 1) + c;
        const i1 = i0 + 1;
        const i2 = i0 + SAND_ACROSS + 1;
        const i3 = i2 + 1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }
    sandGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    sandGeometry.setAttribute("band", new THREE.Float32BufferAttribute(colors, 3));
    sandGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    sandGeometry.setIndex(indices);
  }
  const sandMaterial = new THREE.MeshBasicNodeMaterial();
  ownedMaterials.push(sandMaterial);
  {
    // Softer across than the fan is. The fan is a beam and wants edges; this is
    // light lying on sand and wants none — a hard-edged band on the beach reads
    // as a decal of a rainbow rather than as a rainbow falling on something.
    const across = sin(uv().x.mul(Math.PI)).pow(1.6);
    // Hottest where the beam first touches down and running out along it, which
    // is what a raking landing actually looks like.
    const along = smoothstep(0, 0.16, uv().y).mul(
      saturate(float(1).sub(uv().y)).pow(1.25)
    );
    sandMaterial.colorNode = vec4(attribute("band", "vec3"), 1);
    sandMaterial.opacityNode = across.mul(along).mul(sandStrength);
    sandMaterial.side = THREE.DoubleSide;
    makeAdditive(sandMaterial);
    // Reversed depth: a ground decal needs a POSITIVE polygon offset to sit in
    // front of the surface it is lying on. A negative one buries it entirely.
    sandMaterial.polygonOffset = true;
    sandMaterial.polygonOffsetFactor = 2;
    sandMaterial.polygonOffsetUnits = 4;
  }
  const sand = new THREE.Mesh(sandGeometry, sandMaterial);
  sand.name = "ocean_beach_prism_sand_spectrum";
  sand.frustumCulled = false;
  sand.renderOrder = 5;
  group.add(sand);

  const sunDir = new THREE.Vector3();
  const toCamera = new THREE.Vector3();
  const beamDir = new THREE.Vector3();
  const spreadAxis = new THREE.Vector3();
  const planeNormal = new THREE.Vector3();
  const kiteRight = new THREE.Vector3();
  const tiltAxis = new THREE.Vector3();
  const tiltQuat = new THREE.Quaternion();
  const basis = new THREE.Matrix4();
  const probe = new THREE.Vector3();
  const landing = new THREE.Vector3();
  const easedLanding = new THREE.Vector3();
  const sandAlong = new THREE.Vector3();
  const sandAcross = new THREE.Vector3();
  const sandPoint = new THREE.Vector3();
  let landed = false;
  let sinceSolve = SAND_SOLVE_INTERVAL;

  /**
   * March the fan's centre ray down to the beach. Coarse on purpose — a two
   * metre step over sixty metres of nearly flat sand is well under a pixel of
   * error at the ranges these shots are filmed from, and the result is eased
   * anyway, so a step boundary can never show as a jump.
   */
  const solveLanding = (): boolean => {
    if (beamDir.y >= -0.02) return false;
    let previous = 0;
    for (let travel = 4; travel <= 220; travel += 2.5) {
      probe.copy(opts.anchor.position).addScaledVector(beamDir, travel);
      const floor = opts.ground(probe.x, probe.z);
      if (probe.y <= floor) {
        // One bisection between the last two steps is enough to put the
        // landing inside a few centimetres of the real surface.
        const mid = (previous + travel) * 0.5;
        landing.copy(opts.anchor.position).addScaledVector(beamDir, mid);
        if (opts.water?.(landing.x, landing.z)) return false;
        landing.y = opts.ground(landing.x, landing.z);
        return true;
      }
      previous = travel;
    }
    return false;
  };

  const writeSandPatch = () => {
    const positions = sandGeometry.getAttribute("position") as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    sandAlong.set(beamDir.x, 0, beamDir.z);
    if (sandAlong.lengthSq() < 1e-6) sandAlong.set(1, 0, 0);
    sandAlong.normalize();
    sandAcross.set(-sandAlong.z, 0, sandAlong.x);
    let offset = 0;
    for (let a = 0; a <= SAND_ALONG; a++) {
      const v = a / SAND_ALONG;
      for (let c = 0; c <= SAND_ACROSS; c++) {
        const u = c / SAND_ACROSS - 0.5;
        sandPoint
          .copy(easedLanding)
          .addScaledVector(sandAlong, (v - 0.35) * SAND_LENGTH)
          .addScaledVector(sandAcross, u * SAND_WIDTH);
        array[offset] = sandPoint.x;
        array[offset + 1] = opts.ground(sandPoint.x, sandPoint.z) + SAND_LIFT;
        array[offset + 2] = sandPoint.z;
        offset += 3;
      }
    }
    positions.needsUpdate = true;
    sandGeometry.computeBoundingSphere();
  };

  return {
    group,
    state,
    update(o) {
      const golden = o.enabled ? goldenHourAmount() : 0;
      state.golden = golden;
      if (golden <= 0.001 || o.strength <= 0.001) {
        if (group.visible) group.visible = false;
        state.alignment = 0;
        state.strength = 0;
        return;
      }
      group.visible = true;

      // SUN_STATE.toSun, not SUN_DIR: the latter hands over to the anti-solar
      // direction once the sun is down, and these shots are cut for the minutes
      // either side of exactly that — a beam that flipped to the far horizon
      // mid-take would send the whole spectrum out the back of the frame.
      sunDir.copy(SUN_STATE.toSun).normalize();
      toCamera.copy(o.camera).sub(opts.anchor.position);
      const distance = Math.max(0.001, toCamera.length());
      toCamera.divideScalar(distance);
      // Same geometry the warm fan scores on — the sun behind the kite, the
      // camera in front of it — but on a far gentler curve. A prism is the
      // subject of these shots rather than a garnish on them, so it stays lit
      // through the near misses instead of only on the exact line-up.
      const alignment = THREE.MathUtils.clamp(-toCamera.dot(sunDir), 0, 1);
      state.alignment = alignment;
      const range =
        THREE.MathUtils.smoothstep(distance, 12, 46) *
        (1 - THREE.MathUtils.smoothstep(distance, 170, 300));
      const lit = Math.pow(alignment, 1.35) * golden * o.strength * range;
      state.strength = lit;

      // The beam leaves along the sun-opposite axis, tilted down into the
      // beach, and the tilt axis is horizontal so the fan falls rather than
      // slews. The kite's own roll rocks it: the spectrum swings as the sail
      // banks through its window, which is the only part of this that moves on
      // its own.
      kiteRight.set(1, 0, 0).applyQuaternion(opts.anchor.quaternion);
      const bank = THREE.MathUtils.clamp(kiteRight.y, -1, 1);
      beamDir.copy(sunDir).negate().normalize();
      // The axis is the beam turned a right angle in the ground plane, and the
      // angle is NEGATIVE: a positive turn about it lifts the beam into the sky
      // instead, which is a very pretty rainbow that never touches the beach.
      tiltAxis.set(-beamDir.z, 0, beamDir.x);
      if (tiltAxis.lengthSq() < 1e-6) tiltAxis.set(1, 0, 0);
      tiltAxis.normalize();
      // 0.16 rather than anything more generous: the sail banks to ±0.78 rad,
      // and the landing distance goes as cot(tilt), so a coefficient twice this
      // walks the smear fifty metres up and down the beach every swing and
      // takes it out of frame. This keeps the sweep to about twenty.
      tiltQuat.setFromAxisAngle(tiltAxis, -(FAN_TILT + bank * 0.16));
      beamDir.applyQuaternion(tiltQuat).normalize();

      // Present the dispersion plane to the camera. A fan is a flat thing and a
      // flat thing seen edge-on is a line, so the splay axis is taken across
      // the view ray — the spectrum is then always laid out for whoever is
      // watching, which is what a lens standing off the axis actually catches.
      spreadAxis.crossVectors(beamDir, toCamera);
      if (spreadAxis.lengthSq() < 1e-6) spreadAxis.copy(tiltAxis);
      spreadAxis.normalize();
      planeNormal.crossVectors(spreadAxis, beamDir).normalize();
      fan.position.copy(opts.anchor.position);
      fan.quaternion.setFromRotationMatrix(basis.makeBasis(spreadAxis, beamDir, planeNormal));

      // The entry beam runs the other way, up the same axis toward the sun,
      // billboarded about it for the same reason.
      entry.position.copy(opts.anchor.position);
      spreadAxis.crossVectors(sunDir, toCamera);
      if (spreadAxis.lengthSq() < 1e-6) spreadAxis.copy(tiltAxis);
      spreadAxis.normalize();
      planeNormal.crossVectors(spreadAxis, sunDir).normalize();
      entry.quaternion.setFromRotationMatrix(basis.makeBasis(spreadAxis, sunDir, planeNormal));

      fanStrength.value = lit * 0.74;
      // The incoming beam is white and therefore the easiest thing here to
      // overdo; it is support for the fan, never the event itself.
      entryStrength.value = Math.pow(alignment, 2.6) * golden * o.strength * range * 0.42;

      // Landing. Solved a few times a second and eased between solves, so a
      // kite swinging through its window drags the smear along the sand instead
      // of teleporting it every time the march crosses a step boundary.
      sinceSolve += o.dt;
      if (sinceSolve >= SAND_SOLVE_INTERVAL) {
        sinceSolve = 0;
        if (solveLanding()) {
          if (!landed) {
            landed = true;
            easedLanding.copy(landing);
          }
        } else {
          landed = false;
        }
      }
      if (!landed) {
        sandStrength.value = 0;
        if (sand.visible) sand.visible = false;
        return;
      }
      if (!sand.visible) sand.visible = true;
      easedLanding.lerp(landing, Math.min(1, o.dt * 4.5));
      writeSandPatch();
      // Weaker than the fan and falling off with the beam's own grazing angle:
      // light landing flat on sand spreads out, and a hot rainbow painted on
      // the beach reads as a decal rather than as something being lit.
      sandStrength.value = lit * 0.5 * THREE.MathUtils.clamp(-beamDir.y * 2.4, 0, 1);
    },
    dispose() {
      for (const material of ownedMaterials) material.dispose();
      for (const geometry of ownedGeometries) geometry.dispose();
      group.removeFromParent();
      group.clear();
    }
  };
}
