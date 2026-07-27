import * as THREE from "three/webgpu";
import {
  cameraPosition,
  color,
  float as floatRaw,
  fract,
  instanceIndex,
  mix as mixRaw,
  normalize,
  saturate,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  varying,
  vec2 as vec2Raw,
  vec3 as vec3Raw,
  vec4 as vec4Raw
} from "three/tsl";
import { SUN_DIR, SUN_STATE } from "../sky";

// TSL node generics fight composition; `any` is the idiom here (see facade.ts).
type N = any;
const float = floatRaw as (...a: N[]) => N;
const vec2 = vec2Raw as (...a: N[]) => N;
const vec3 = vec3Raw as (...a: N[]) => N;
const vec4 = vec4Raw as (...a: N[]) => N;
const mix = mixRaw as (...a: N[]) => N;

/**
 * The half hour that makes Ocean Beach worth standing on: the marine layer
 * comes back over the sand, the sun drops into it, and anything with a hole in
 * it starts throwing light around. This module owns that weather for the kite —
 * drifting mist, the shafts the kite itself cuts out of the low sun, and the
 * halo that leaks around its edges.
 *
 * Everything here is a no-op away from golden hour: one `strength` uniform
 * reaches zero, the group hides, and nothing is submitted.
 */

const MIST_COUNT = 16;
const MOTE_COUNT = 96;
const SHAFT_COUNT = 6;
const SHAFT_LENGTH = 38;
const SHAFT_WIDTH = 2.6;
/** Under this range the kite is the subject and its shafts are just a smear. */
const SHAFT_NEAR = 26;
const SHAFT_NEAR_FULL = 95;

/**
 * 0 in daylight, 1 through the sunset window, 0 again once the sky has gone.
 * SUN_DIR flips to the moon after dusk, so this reads the true solar elevation.
 */
export function goldenHourAmount(): number {
  const elevation = SUN_STATE.elevationDeg;
  // THREE.MathUtils.smoothstep short-circuits on an inverted range, so both
  // edges run low→high and the falling side is taken as a complement.
  const stillHigh = THREE.MathUtils.smoothstep(elevation, 4, 16);
  const alreadyGone = THREE.MathUtils.smoothstep(elevation, -8.5, -2.5);
  return THREE.MathUtils.clamp((1 - stillHigh) * alreadyGone, 0, 1);
}

export type SunsetAirState = {
  /** 0..1 golden-hour window. */
  golden: number;
  /** 0..1 how squarely the camera is looking through the kite at the sun. */
  backlight: number;
  /** 0..1 mist density actually in the air right now. */
  haze: number;
};

/** One kite's live position and how wide a fan its silhouette throws. */
export type RayAnchor = { position: THREE.Vector3; spread: number };

export type SunsetAir = {
  group: THREE.Group;
  state: SunsetAirState;
  update(o: {
    dt: number;
    camera: THREE.Vector3;
    mist: number;
    shafts: number;
    enabled: boolean;
  }): void;
  dispose(): void;
};

/** Cheap deterministic per-instance randomness. */
function hash(seed: N): N {
  return fract(sin(seed.mul(127.1).add(311.7)).mul(43758.5453));
}

export function createSunsetAir(opts: {
  center: { x: number; z: number };
  /** Sand height at the site; the mist floor sits just above it. */
  groundY: number;
  /** Downwind direction the banks travel on — the kite's site wind. */
  wind: THREE.Vector3;
  /** Live kite positions; each gets its own fan and halo. */
  anchors: readonly RayAnchor[];
}): SunsetAir {
  const group = new THREE.Group();
  group.name = "ocean_beach_kite_sunset_air";
  group.visible = false;

  const state: SunsetAirState = { golden: 0, backlight: 0, haze: 0 };
  const sunDir = uniform(new THREE.Vector3().copy(SUN_DIR));
  const mistStrength = uniform(0);
  const moteStrength = uniform(0);
  const shaftStrength = uniform(0);
  const haloStrength = uniform(0);

  const drift = new THREE.Vector3(opts.wind.x, 0, opts.wind.z).normalize();
  const across = new THREE.Vector3(-drift.z, 0, drift.x);
  const driftAxis = uniform(drift.clone());
  const acrossAxis = uniform(across.clone());
  // The marine layer sits out over the water, downwind of the beach — which is
  // also behind the kite from the sand, so it backs the whole scene instead of
  // washing the foreground the camera is standing in.
  const fieldCenter = uniform(
    new THREE.Vector3(
      opts.center.x + drift.x * 32,
      opts.groundY - 1.5,
      opts.center.z + drift.z * 32
    )
  );

  const ownedMaterials: THREE.Material[] = [];
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const own = <T extends THREE.Material>(material: T): T => {
    ownedMaterials.push(material);
    return material;
  };

  // ---------------------------------------------------------------- mist
  // One instanced billboard set, drifting entirely on the GPU: the CPU writes
  // four uniforms a frame and never touches a position.
  const mistMaterial = own(new THREE.SpriteNodeMaterial());
  {
    const i = float(instanceIndex);
    const r1 = hash(i.add(1.3));
    const r2 = hash(i.mul(2.7).add(11.9));
    const r3 = hash(i.mul(4.1).add(29.3));
    const r4 = hash(i.mul(6.7).add(53.1));
    // Wrapped travel downwind: a bank leaves one edge of the field and
    // re-enters at the other without a respawn pop, because it is the same
    // instance the whole way.
    const along = fract(r1.add(time.mul(0.0068).add(r2.mul(0.13)))).sub(0.5).mul(210);
    const side = r2.sub(0.5).mul(150);
    const lift = r3.mul(12).add(0.8);
    const world = fieldCenter
      .add(driftAxis.mul(along))
      .add(acrossAxis.mul(side))
      .add(vec3(0, lift, 0));
    const worldVarying = varying(world) as N;
    mistMaterial.positionNode = world;
    mistMaterial.scaleNode = vec2(r4.mul(34).add(28), r4.mul(11).add(13));

    // A bank of fog lit from behind is not grey; it is the brightest thing on
    // the beach. Warm it by how nearly the camera is looking through it at the
    // sun, and leave the shadowed side a cool marine blue.
    const viewRay = normalize(worldVarying.sub(cameraPosition));
    const glow = saturate(viewRay.dot(sunDir)).pow(3.4);
    const tint = mix(color(0xbccadb), color(0xffd9ac), glow.mul(0.92).add(0.08));

    const d = uv().sub(0.5);
    const radial = saturate(float(1).sub(d.length().mul(2))).pow(1.9);
    // Two offset lobes break the circle so a bank never reads as a disc.
    const lobeA = saturate(float(1).sub(d.sub(vec2(0.17, 0.06)).length().mul(2.6)));
    const lobeB = saturate(float(1).sub(d.add(vec2(0.21, 0.04)).length().mul(2.9)));
    const shape = saturate(radial.mul(0.62).add(lobeA.mul(0.3)).add(lobeB.mul(0.26)));

    const distance = worldVarying.sub(cameraPosition).length();
    // A near bank is the one that swallows the frame, so it stays the faintest;
    // the far field is handed back to the world's own fog rather than stacked
    // on top of it. Between them is the band where a bank reads as weather.
    const near = smoothstep(11, 50, distance);
    const far = float(1).sub(smoothstep(150, 260, distance));

    mistMaterial.colorNode = vec4(tint.mul(glow.mul(0.55).add(0.85)), 1);
    mistMaterial.opacityNode = shape.mul(mistStrength).mul(near).mul(far).mul(0.3);
    mistMaterial.transparent = true;
    mistMaterial.depthWrite = false;
  }
  const mist = new THREE.Sprite(mistMaterial);
  mist.name = "ocean_beach_kite_sea_mist";
  mist.count = MIST_COUNT;
  mist.frustumCulled = false;
  mist.renderOrder = 6;
  group.add(mist);

  // ---------------------------------------------------------------- motes
  // Sand and salt hanging in the light. Tiny, additive, and only ever visible
  // where the low sun can actually pick them out.
  const moteMaterial = own(new THREE.SpriteNodeMaterial());
  {
    const i = float(instanceIndex);
    const r1 = hash(i.add(7.7));
    const r2 = hash(i.mul(3.3).add(17.1));
    const r3 = hash(i.mul(5.9).add(41.7));
    const drifted = fract(r1.add(time.mul(0.018))).sub(0.5).mul(74);
    const side = r2.sub(0.5).mul(58);
    // A slow figure of eight so no two motes travel on the same line.
    const bobble = sin(time.mul(0.6).add(r3.mul(6.28))).mul(0.7);
    const lift = r3.mul(7).add(0.7).add(bobble);
    const world = fieldCenter
      .add(driftAxis.mul(drifted))
      .add(acrossAxis.mul(side.add(sin(time.mul(0.31).add(r1.mul(9.4))).mul(2.4))))
      .add(vec3(0, lift, 0));
    const worldVarying = varying(world) as N;
    moteMaterial.positionNode = world;
    moteMaterial.scaleNode = float(r2.mul(0.045).add(0.03));

    const viewRay = normalize(worldVarying.sub(cameraPosition));
    const glow = saturate(viewRay.dot(sunDir)).pow(2.2);
    const d = uv().sub(0.5).length().mul(2);
    const soft = saturate(float(1).sub(d)).pow(2.6);
    const distance = worldVarying.sub(cameraPosition).length();
    const near = smoothstep(1.5, 6, distance);
    const far = float(1).sub(smoothstep(45, 90, distance));

    moteMaterial.colorNode = vec4(
      mix(color(0xffe6c2), color(0xfff3e0), glow).mul(soft).mul(glow.mul(0.8).add(0.2)),
      1
    );
    moteMaterial.opacityNode = soft.mul(moteStrength).mul(near).mul(far).mul(0.7);
    moteMaterial.transparent = true;
    moteMaterial.depthWrite = false;
    moteMaterial.blending = THREE.CustomBlending;
    moteMaterial.blendSrc = THREE.OneFactor;
    moteMaterial.blendDst = THREE.OneFactor;
    moteMaterial.blendEquation = THREE.AddEquation;
    moteMaterial.blendSrcAlpha = THREE.ZeroFactor;
    moteMaterial.blendDstAlpha = THREE.OneFactor;
  }
  const motes = new THREE.Sprite(moteMaterial);
  motes.name = "ocean_beach_kite_motes";
  motes.count = MOTE_COUNT;
  motes.frustumCulled = false;
  motes.renderOrder = 7;
  group.add(motes);

  // ---------------------------------------------------------------- shafts
  // The kite's own god rays. They are geometry rather than screen space
  // because they have to be legible from the beach at any hour the raymarched
  // pass is not running — and because a real shaft splays off the sun axis
  // rather than lying on it, which is what makes it read as radial from the
  // silhouette instead of collapsing to a point.
  const shaftGeometry = new THREE.PlaneGeometry(SHAFT_WIDTH, SHAFT_LENGTH, 1, 12);
  shaftGeometry.translate(0, SHAFT_LENGTH * 0.5, 0);
  ownedGeometries.push(shaftGeometry);
  const shaftMaterial = own(new THREE.MeshBasicNodeMaterial());
  {
    const acrossU = sin(uv().x.mul(Math.PI)).pow(1.7);
    const alongV = smoothstep(0, 0.1, uv().y).mul(
      saturate(float(1).sub(uv().y)).pow(1.55)
    );
    shaftMaterial.colorNode = mix(color(0xffbb72), color(0xfff0d2), uv().y.oneMinus().pow(2));
    shaftMaterial.opacityNode = acrossU.mul(alongV).mul(shaftStrength);
    shaftMaterial.transparent = true;
    shaftMaterial.depthWrite = false;
    shaftMaterial.side = THREE.DoubleSide;
    shaftMaterial.blending = THREE.CustomBlending;
    shaftMaterial.blendSrc = THREE.SrcAlphaFactor;
    shaftMaterial.blendDst = THREE.OneFactor;
    shaftMaterial.blendEquation = THREE.AddEquation;
    shaftMaterial.blendSrcAlpha = THREE.ZeroFactor;
    shaftMaterial.blendDstAlpha = THREE.OneFactor;
  }
  // One fan and one halo per kite. They all share a single geometry and a
  // single material, so three kites' worth of shafts is still one pipeline —
  // per-fan brightness rides on width and halo size instead of on a uniform.
  const shaftGroup = new THREE.Group();
  shaftGroup.name = "ocean_beach_kite_god_rays";

  // ----------------------------------------------------------------- halo
  const haloMaterial = own(new THREE.SpriteNodeMaterial());
  {
    const d = uv().sub(0.5).length().mul(2);
    const soft = saturate(float(1).sub(d)).pow(2.2);
    const core = saturate(float(1).sub(d.mul(2.4))).pow(3).mul(1.4);
    haloMaterial.colorNode = vec4(color(0xffd39a).mul(soft.add(core)), 1);
    haloMaterial.opacityNode = soft.mul(haloStrength);
    haloMaterial.transparent = true;
    haloMaterial.depthWrite = false;
    haloMaterial.depthTest = false;
    haloMaterial.blending = THREE.CustomBlending;
    haloMaterial.blendSrc = THREE.SrcAlphaFactor;
    haloMaterial.blendDst = THREE.OneFactor;
    haloMaterial.blendEquation = THREE.AddEquation;
    haloMaterial.blendSrcAlpha = THREE.ZeroFactor;
    haloMaterial.blendDstAlpha = THREE.OneFactor;
  }

  // Fixed splay per shaft: a spread angle off the sun axis and a roll around
  // it, seeded rather than random so a fan is stable frame to frame. Each
  // design widens or tightens the whole fan through its own `spread`.
  type Fan = {
    anchor: RayAnchor;
    meshes: THREE.Mesh[];
    halo: THREE.Sprite;
    splay: { angle: number; roll: number; rollRate: number }[];
    strength: number;
    haloStrength: number;
    distance: number;
  };
  const fans: Fan[] = opts.anchors.map((anchor, fanIndex) => {
    const meshes: THREE.Mesh[] = [];
    const splay: { angle: number; roll: number; rollRate: number }[] = [];
    for (let i = 0; i < SHAFT_COUNT; i++) {
      const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
      shaft.name = `ocean_beach_kite_god_ray_${fanIndex}_${i}`;
      shaft.frustumCulled = false;
      shaft.renderOrder = 8;
      meshes.push(shaft);
      shaftGroup.add(shaft);
      splay.push({
        angle: anchor.spread * (0.9 + (i % 3) * 0.75 + (i / SHAFT_COUNT) * 0.45),
        roll: (i / SHAFT_COUNT) * Math.PI * 2 + fanIndex * 0.7,
        rollRate: 0.035 + (i % 2) * 0.018
      });
    }
    const halo = new THREE.Sprite(haloMaterial);
    halo.name = `ocean_beach_kite_sun_halo_${fanIndex}`;
    halo.frustumCulled = false;
    halo.renderOrder = 9;
    shaftGroup.add(halo);
    return { anchor, meshes, halo, splay, strength: 0, haloStrength: 0, distance: 1 };
  });
  group.add(shaftGroup);

  const axis = new THREE.Vector3();
  const perpendicular = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const shaftDir = new THREE.Vector3();
  const shaftSide = new THREE.Vector3();
  const shaftNormal = new THREE.Vector3();
  const toCamera = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  let elapsed = 0;

  return {
    group,
    state,
    update(o) {
      const golden = o.enabled ? goldenHourAmount() : 0;
      state.golden = golden;
      if (golden <= 0.001) {
        if (group.visible) group.visible = false;
        state.backlight = 0;
        state.haze = 0;
        return;
      }
      group.visible = true;
      elapsed += o.dt;
      (sunDir.value as THREE.Vector3).copy(SUN_DIR);

      mistStrength.value = golden * o.mist;
      moteStrength.value = golden * o.mist * 0.85;
      state.haze = golden * o.mist;

      // Score every kite first: how squarely it sits between the camera and
      // the sun, and how far away it is. The best-aligned kite sets the scene's
      // backlight and the shared material's peak; the rest ride below it.
      let bestAlignment = 0;
      let peakShaft = 0;
      let peakHalo = 0;
      for (const fan of fans) {
        toCamera.copy(fan.anchor.position).sub(o.camera);
        const distance = Math.max(0.001, toCamera.length());
        const alignment = THREE.MathUtils.clamp(toCamera.dot(SUN_DIR) / distance, 0, 1);
        // The falloff is deliberately gentle: at sunset the sun is on the water
        // and the kite is high, so an exact line-up is rare — the shot people
        // actually get is the near miss, and it has to look like something.
        const range =
          THREE.MathUtils.smoothstep(distance, SHAFT_NEAR, SHAFT_NEAR_FULL) *
          (1 - THREE.MathUtils.smoothstep(distance, 130, 260));
        fan.distance = distance;
        fan.strength = Math.pow(alignment, 3.5) * golden * o.shafts * range * 0.34;
        fan.haloStrength = Math.pow(alignment, 7) * golden * o.shafts * range * 0.3;
        bestAlignment = Math.max(bestAlignment, alignment);
        peakShaft = Math.max(peakShaft, fan.strength);
        peakHalo = Math.max(peakHalo, fan.haloStrength);
      }
      state.backlight = Math.pow(bestAlignment, 3) * golden;
      shaftStrength.value = peakShaft;
      haloStrength.value = peakHalo;

      // The sun's travel direction, and a stable frame perpendicular to it to
      // roll each shaft around.
      axis.copy(SUN_DIR).negate().normalize();
      perpendicular.set(0, 1, 0);
      if (Math.abs(axis.y) > 0.92) perpendicular.set(1, 0, 0);
      perpendicular.crossVectors(axis, perpendicular).normalize();
      binormal.crossVectors(axis, perpendicular).normalize();

      for (const fan of fans) {
        // Relative brightness within the shared material: a fan the sun is not
        // behind narrows to nothing rather than needing its own uniform.
        const relative = peakShaft > 1e-5 ? fan.strength / peakShaft : 0;
        toCamera.copy(fan.anchor.position).sub(o.camera).normalize();

        fan.halo.position.copy(fan.anchor.position);
        // Small and faint on purpose: the halo is glare around the kite, and a
        // depth-ignoring sprite any larger simply erases the subject.
        const haloRelative = peakHalo > 1e-5 ? fan.haloStrength / peakHalo : 0;
        fan.halo.scale.setScalar((2.2 + fan.distance * 0.022) * haloRelative);

        for (let i = 0; i < fan.meshes.length; i++) {
          const splay = fan.splay[i];
          const roll = splay.roll + elapsed * splay.rollRate;
          const tilt = splay.angle * (0.85 + Math.sin(elapsed * 0.5 + i) * 0.15);
          shaftDir
            .copy(axis)
            .multiplyScalar(Math.cos(tilt))
            .addScaledVector(perpendicular, Math.sin(tilt) * Math.cos(roll))
            .addScaledVector(binormal, Math.sin(tilt) * Math.sin(roll))
            .normalize();

          const shaft = fan.meshes[i];
          shaft.position.copy(fan.anchor.position);
          shaftSide.copy(shaftDir).cross(toCamera);
          // |a x b| of two unit vectors is sin(angle): a beam aimed straight at
          // the camera has no length to show and its billboard roll is
          // undefined, so fade it out rather than let it snap to an edge-on
          // sliver that reads as a hard white line.
          const acrossView = THREE.MathUtils.smoothstep(shaftSide.length(), 0.12, 0.42);
          if (shaftSide.lengthSq() < 1e-6) shaftSide.copy(perpendicular);
          shaftSide.normalize();
          shaftNormal.crossVectors(shaftSide, shaftDir).normalize();
          shaft.quaternion.setFromRotationMatrix(basis.makeBasis(shaftSide, shaftDir, shaftNormal));
          // Breathe the width instead of the opacity. Width also grows with
          // range so a distant fan does not thin to sub-pixel slivers.
          shaft.scale.x =
            (0.6 + Math.sin(elapsed * 0.9 + i * 2.1) * 0.22 + tilt) *
            (1 + fan.distance / 150) *
            relative *
            acrossView;
        }
      }
    },
    dispose() {
      for (const material of ownedMaterials) material.dispose();
      for (const geometry of ownedGeometries) geometry.dispose();
      group.removeFromParent();
      group.clear();
    }
  };
}
