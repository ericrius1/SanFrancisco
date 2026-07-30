import * as THREE from "three/webgpu";
import {
  attribute,
  float as floatRaw,
  mix as mixRaw,
  saturate,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3 as vec3Raw,
  vec4 as vec4Raw
} from "three/tsl";
import { SUN_STATE } from "../sky";
import { goldenHourAmount } from "./sunsetAir";
import { spectrumColor } from "../spectrumRamp";
import { PRISM_GLINT } from "../prismGlint";

// TSL node generics fight composition; `any` is the idiom here (see facade.ts).
type N = any;
const float = floatRaw as (...a: N[]) => N;
const mix = mixRaw as (...a: N[]) => N;
const vec3 = vec3Raw as (...a: N[]) => N;
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
 *
 * Nothing in here may ever CUT OFF: the fan's reach follows the solved landing
 * so beam and smear always meet, the smear fades over the last metres before
 * the waterline instead of vetoing, and every on/off condition arrives through
 * an eased presence rather than a same-frame visibility flip.
 */

/** Bands in the fan. Seven is the sleeve's count and the eye's limit. */
const BANDS = 7;
/** Half-angle the fan splays through, radians. Scaled by the design's spread. */
const FAN_HALF_ANGLE = 0.3;
const FAN_NEAR = 1.2;
/**
 * The AUTHORED fan length. The mesh is built once at this reach and then
 * scaled along its beam axis every frame so the far end sits exactly on the
 * solved landing — a fixed length visibly ended mid-air short of its own
 * smear whenever a high kite or a shallow bank pushed the touchdown past it.
 */
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
const SAND_WIDTH = 30;
const SAND_ALONG = 10;
const SAND_ACROSS = 12;
/** Lift off the sand. Additive and depth-tested, so this only has to clear it. */
const SAND_LIFT = 0.12;
/** Seconds between ground-hit solves; the smear eases between them. */
const SAND_SOLVE_INTERVAL = 0.12;
/**
 * A raked landing spreads the light out along the beam. The along-beam extent
 * of the smear stretches up to this factor as the incidence goes shallow, so
 * the run-out is carried by geometry instead of being truncated by the
 * opacity envelope of a fixed patch.
 */
const SAND_MAX_STRETCH = 1.6;
/** Shoreline fade: sample step, count and the approach distance it fades over. */
const SHORE_STEP = 3.2;
const SHORE_SAMPLES = 5;
const SHORE_RANGE = 9.5;

/**
 * The spectrum's own average — what overlapping bands sum toward. Blending the
 * baked band colours toward this at the smear's ends is what "bands bleeding
 * into each other" looks like without a second texture or draw.
 */
const SPECTRUM_MEAN = (() => {
  const mean = new THREE.Color(0, 0, 0);
  const sample = new THREE.Color();
  const count = 32;
  for (let i = 0; i < count; i++) {
    spectrumColor((i + 0.5) / count, sample);
    mean.r += sample.r;
    mean.g += sample.g;
    mean.b += sample.b;
  }
  return mean.multiplyScalar(1 / count);
})();

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
    /** 0..2 — broader, dimmer, more blended footprint as it rises. Default 1. */
    softness?: number;
    /** 0..2 — depth of the slow deterministic modulation. Default 1. */
    dance?: number;
  }): void;
  dispose(): void;
};

/**
 * The fan, in a local frame where +Y is the beam and the spectrum splays across
 * X. Building it here rather than per frame is the whole performance story: the
 * shape never changes, only where it is pointed — and how far, via a Y-only
 * scale. Y-only on purpose: it keeps the far-end width married to the smear's
 * while the reach follows the landing, and the slight splay change it implies
 * is eased and reads as refraction breathing, not as a resize.
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
   * surface the terrain sampler knows nothing about — `ground` there returns
   * the seabed, metres under the waves — so the smear FADES over the last
   * metres of dry sand before the waterline instead of being withheld. A
   * binary veto here popped the whole smear off and on at the solve cadence
   * every time a banking kite walked its landing across the shore.
   */
  water?: (x: number, z: number) => boolean;
  /**
   * Sea surface height. Any smear vertex that strays past the waterline is
   * clamped up to this rather than following the seabed under the waves; by
   * then the shore fade has taken its opacity to ~0, this just guarantees no
   * frame ever shows spectrum metres underwater.
   */
  seaLevel?: number;
}): PrismLight {
  const group = new THREE.Group();
  group.name = "ocean_beach_prism_light";
  group.visible = false;

  const state: PrismLightState = { golden: 0, alignment: 0, strength: 0 };
  const fanStrength = uniform(0);
  const entryStrength = uniform(0);
  const sandStrength = uniform(0);
  /** Softness / dance dials mirrored into the shaders. Static during a take. */
  const softU = uniform(1);
  const danceU = uniform(1);
  const meanColor = vec3(SPECTRUM_MEAN.r, SPECTRUM_MEAN.g, SPECTRUM_MEAN.b);
  // 0 → no bleed, softness 1 → 0.275, softness 2 → 0.55. Saturate keeps the
  // curve monotone without ever letting a band vanish into the mean entirely.
  const bleedBase = saturate(softU.mul(0.5)).mul(0.55);

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
    // Each band breathes on its own pair of incommensurate periods (~6 s and
    // ~10.5 s), keyed off the band's own baked colour — no extra attribute,
    // and deterministic for the same reason the shimmer is.
    const band = attribute("band", "vec3") as N;
    const bandKey = band.x.mul(7.1).add(band.y.mul(3.7)).add(band.z.mul(1.9));
    const breathe = float(1).add(
      danceU.mul(
        sin(time.mul(1.02).add(bandKey.mul(2.6))).mul(0.05)
          .add(sin(time.mul(0.59).add(bandKey.mul(1.7)).add(1.3)).mul(0.04))
      )
    );
    // Toward the far end the bands begin to overlap — mix them toward the
    // spectrum's own mean so the fan hands over to the softer smear it lands as.
    const farBleed = smoothstep(0.5, 1, uv().y).mul(bleedBase.mul(0.8));
    fanMaterial.colorNode = vec4(mix(band, meanColor, farBleed), 1);
    fanMaterial.opacityNode = across.mul(along).mul(shimmer).mul(breathe).mul(fanStrength);
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
    // The exponent relaxes further as the softness dial rises (1.6 → 1.32 at
    // the default), broadening the lit body without moving the zero at the rim.
    const acrossPow = float(1.6).sub(softU.mul(0.28));
    const across = sin(uv().x.mul(Math.PI)).pow(acrossPow);
    // Hottest where the beam first touches down and running out along it, which
    // is what a raking landing actually looks like. The 1.45 tail (up from
    // 1.25) turns the last visible edge into a long feather instead of a band.
    const along = smoothstep(0, 0.14, uv().y).mul(
      saturate(float(1).sub(uv().y)).pow(1.45)
    );
    // Bands bleed into each other toward the smear's ends — overlapping
    // spectra sum toward their mean — plus a whisper of desaturation all over,
    // which is the difference between dyed sand and lit sand.
    const v = uv().y;
    // (Ascending edges only — reversed-edge smoothstep is undefined in WGSL.)
    const endMask = saturate(
      smoothstep(0.55, 0.98, v).add(float(1).sub(smoothstep(0.02, 0.25, v)))
    );
    const bleed = saturate(endMask.mul(bleedBase).add(softU.mul(0.08)));
    const band = attribute("band", "vec3") as N;
    // Per-band breathing on two incommensurate periods (~5.6 s and ~11.9 s):
    // one band swells while another dims, keyed off the baked colour so the
    // motion drifts smoothly across the smear. Time-derived only — replays of
    // the same clock produce the same frames.
    const bandKey = band.x.mul(7.1).add(band.y.mul(3.7)).add(band.z.mul(1.9));
    const breathe = float(1).add(
      danceU.mul(
        sin(time.mul(1.13).add(bandKey.mul(2.9))).mul(0.09)
          .add(sin(time.mul(0.53).add(bandKey.mul(1.7)).add(2.1)).mul(0.07))
      )
    );
    // A subtle along-beam ripple, as if the light were arriving through moving
    // air: two slow waves beating against each other, ±6% at the default dial.
    const ripple = float(1).add(
      danceU.mul(0.06).mul(
        sin(v.mul(11).sub(time.mul(0.62))).mul(sin(v.mul(4.3).add(time.mul(0.41))))
      )
    );
    sandMaterial.colorNode = vec4(mix(band, meanColor, bleed), 1);
    sandMaterial.opacityNode = across.mul(along).mul(breathe).mul(ripple).mul(sandStrength);
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
  const shoreDir = new THREE.Vector3();
  let landed = false;
  let sinceSolve = SAND_SOLVE_INTERVAL;
  /** Eased 0..1 "the smear exists" — replaces every same-frame on/off flip. */
  let presence = 0;
  /** Eased 0..1 shoreline fade; target is re-measured at the solve cadence. */
  let shoreFade = 0;
  let shoreFadeTarget = 1;
  /** Eased beam reach in metres; the fan is scaled so it ends exactly here. */
  let fanLength = FAN_FAR;
  /** Along-beam stretch of the smear under a raking landing; per frame. */
  let alongStretch = 1;
  /** Deterministic clock for the CPU-side sway — pure dt accumulation. */
  let danceTime = 0;
  let danceAmp = 1;

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
        landing.y = opts.ground(landing.x, landing.z);
        return true;
      }
      previous = travel;
    }
    return false;
  };

  /**
   * How dry the ground around the landing is, as a 0..1 fade. Walks a few
   * samples up and down the beam's ground track and converts the distance to
   * the nearest water into a ramp over the last SHORE_RANGE metres. Quantised
   * by the sample step, but the eased `shoreFade` and the eased landing turn
   * the steps into a continuous slide — nothing pops within a frame or
   * between solves.
   */
  const solveShoreFade = (): number => {
    if (!opts.water) return 1;
    if (opts.water(landing.x, landing.z)) return 0;
    shoreDir.set(beamDir.x, 0, beamDir.z);
    if (shoreDir.lengthSq() < 1e-6) shoreDir.set(1, 0, 0);
    shoreDir.normalize();
    let nearest = Infinity;
    for (const sign of [-1, 1]) {
      for (let k = 1; k < SHORE_SAMPLES; k++) {
        const reach = k * SHORE_STEP;
        if (reach >= nearest) break;
        probe.copy(landing).addScaledVector(shoreDir, sign * reach);
        if (opts.water(probe.x, probe.z)) {
          nearest = reach;
          break;
        }
      }
    }
    return THREE.MathUtils.clamp(nearest / SHORE_RANGE, 0, 1);
  };

  const writeSandPatch = () => {
    const positions = sandGeometry.getAttribute("position") as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    sandAlong.set(beamDir.x, 0, beamDir.z);
    if (sandAlong.lengthSq() < 1e-6) sandAlong.set(1, 0, 0);
    sandAlong.normalize();
    sandAcross.set(-sandAlong.z, 0, sandAlong.x);
    // The whole smear sways gently across the beam — centimetres, layered
    // under the ~20 m bank-drag — on two incommensurate slow waves.
    const sway =
      (Math.sin(danceTime * 0.37) * 0.34 + Math.sin(danceTime * 0.83 + 2.4) * 0.22) * danceAmp;
    const seaLevel = opts.seaLevel;
    let offset = 0;
    for (let a = 0; a <= SAND_ALONG; a++) {
      const v = a / SAND_ALONG;
      for (let c = 0; c <= SAND_ACROSS; c++) {
        const u = c / SAND_ACROSS - 0.5;
        sandPoint
          .copy(easedLanding)
          .addScaledVector(sandAlong, (v - 0.35) * SAND_LENGTH * alongStretch)
          .addScaledVector(sandAcross, u * SAND_WIDTH + sway);
        let floor = opts.ground(sandPoint.x, sandPoint.z);
        // Past the waterline the sampler hands back the seabed; hold the
        // vertex at the sea surface so a fading edge never dives underwater.
        if (seaLevel !== undefined && floor < seaLevel && opts.water?.(sandPoint.x, sandPoint.z)) {
          floor = seaLevel;
        }
        array[offset] = sandPoint.x;
        array[offset + 1] = floor + SAND_LIFT;
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
        // The sea stops reflecting a beam that no longer exists.
        PRISM_GLINT.params.value.z = 0;
        return;
      }
      group.visible = true;

      const softness = THREE.MathUtils.clamp(o.softness ?? 1, 0, 2);
      danceAmp = THREE.MathUtils.clamp(o.dance ?? 1, 0, 2);
      softU.value = softness;
      danceU.value = danceAmp;
      danceTime += o.dt;

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

      fanStrength.value = lit * (0.74 - 0.05 * softness);
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
          // Only snap the eased landing when the smear is effectively gone;
          // a brief solve failure mid-swing must not teleport a visible smear.
          if (!landed && presence < 0.02) easedLanding.copy(landing);
          landed = true;
          shoreFadeTarget = solveShoreFade();
        } else {
          landed = false;
        }
      }
      presence += ((landed ? 1 : 0) - presence) * (1 - Math.exp(-o.dt * 3));
      shoreFade += (shoreFadeTarget - shoreFade) * (1 - Math.exp(-o.dt * 3.5));
      if (landed) easedLanding.lerp(landing, Math.min(1, o.dt * 4.5));

      // The fan's reach follows the eased landing, so the beam always ends on
      // its own smear instead of stopping mid-air at an authored length.
      const targetLength = landed
        ? Math.max(FAN_NEAR + 6, easedLanding.distanceTo(opts.anchor.position))
        : FAN_FAR;
      fanLength += (targetLength - fanLength) * (1 - Math.exp(-o.dt * 4));
      fan.scale.y = THREE.MathUtils.clamp(fanLength / FAN_FAR, 0.55, 3.4);

      // Hand the beam to the sea. The water's glint term wants the beam
      // exactly as drawn — same origin, same bank-swung direction, same eased
      // length — so the reflection and the fan move as one thing. `tiltAxis`
      // is the horizontal across-beam axis, which is where the spectrum
      // spreads for a viewer at the beach. Strength deliberately reuses `lit`
      // (alignment-gated like the fan itself): beams and their reflections
      // appear and retire together, and the uniform multiplies the whole term
      // out of the water while it is 0. Last lit prism wins the frame — see
      // prismGlint.ts.
      PRISM_GLINT.origin.value.copy(opts.anchor.position);
      PRISM_GLINT.dir.value.copy(beamDir);
      PRISM_GLINT.across.value.copy(tiltAxis);
      PRISM_GLINT.params.value.set(
        fanLength,
        Math.tan(FAN_HALF_ANGLE * (opts.anchor.spread / 0.3)) * fanLength,
        lit
      );

      // A shallow landing rakes the light out along the beam; carry that in
      // the geometry (stretch) and pay for it in brightness (spread), the way
      // a real footprint dims as it lengthens.
      const incidence = THREE.MathUtils.clamp(-beamDir.y, 0, 1);
      alongStretch =
        1 + (SAND_MAX_STRETCH - 1) * THREE.MathUtils.clamp((0.78 - incidence) / 0.5, 0, 1);
      const spread = 1 / (0.7 + 0.3 * alongStretch);
      // Weaker than the fan and falling off with the beam's own grazing angle:
      // light landing flat on sand spreads out, and a hot rainbow painted on
      // the beach reads as a decal rather than as something being lit. The
      // softness dial trades a little more peak for the broader footprint.
      const peak = Math.max(0.18, 0.5 - 0.085 * softness);
      const grazing = THREE.MathUtils.clamp(incidence * 2.4, 0, 1);
      const strength = lit * peak * grazing * spread * shoreFade * presence;
      sandStrength.value = strength;
      const show = strength > 0.003;
      if (sand.visible !== show) sand.visible = show;
      if (show) writeSandPatch();
    },
    dispose() {
      PRISM_GLINT.params.value.z = 0;
      for (const material of ownedMaterials) material.dispose();
      for (const geometry of ownedGeometries) geometry.dispose();
      group.removeFromParent();
      group.clear();
    }
  };
}
