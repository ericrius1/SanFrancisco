import * as THREE from "three/webgpu";
import {
  Fn, uv, vec2, vec3, vec4, float, uniform, sin, fract,
  abs as tslAbs, smoothstep, length, atan
} from "three/tsl";
import { buildRig, applyAvatarToRig, type Rig } from "../../player/rig";
import { avatarFromSeed } from "../../player/avatar";
import { emoteById } from "../../player/emotes";
import { SUN_STATE } from "../sky";
import {
  CENTER_X, CENTER_Z, FLOOR_Y, YAW, PLAZA_TOP,
  CUPOLA_HALF, SHELL_Z0, SHELL_TOP, ARM_TIP_Z, ARM_HALF, GLASS_HW,
  localToWorld
} from "./geometry";

const LOCAL_Y = new THREE.Vector3(0, 1, 0);

/** Projector positions on the plaza (local metres), each aimed at the cupola. */
const PROJECTORS = [
  { x: -30, y: 30, aim: 34 },
  { x: 30, y: 30, aim: 34 },
  { x: -34, y: -6, aim: 30 },
  { x: 34, y: -6, aim: 30 },
  { x: -20, y: -38, aim: 38 },
  { x: 20, y: -38, aim: 38 }
] as const;

const BEAM_TINTS = [0xff2d6f, 0x2de1ff, 0xffc63a, 0x8b5cff, 0x36ff9e, 0xff6a2d] as const;

export interface StMarysRave {
  readonly group: THREE.Group;
  update(playerPosition: THREE.Vector3, elapsed: number, dt: number): void;
  dispose(): void;
}

/**
 * The projection surface: the cupola's outer saddle rebuilt at a small offset,
 * so the show sits ON the eight hypar shells instead of floating in front of
 * them. Mirrors the Blender generator's ruling exactly.
 */
function buildProjectionShell(): THREE.BufferGeometry {
  const OFFSET = 0.22;
  const SEG_T = 40;
  const SEG_U = 10;
  const half = CUPOLA_HALF + OFFSET;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const seam = (t: number) => {
    const x = half + (ARM_HALF - half) * Math.pow(t, 1.55);
    return { x, z: SHELL_Z0 + (ARM_TIP_Z - SHELL_Z0) * t };
  };
  const corner = (t: number) => {
    const r = GLASS_HW + (half - GLASS_HW) * Math.cos((t * Math.PI) / 2);
    return { r, z: SHELL_Z0 + (SHELL_TOP - SHELL_Z0) * t };
  };

  const world = new THREE.Vector3();
  let patch = 0;
  for (let quarter = 0; quarter < 4; quarter++) {
    for (const mirror of [1, -1] as const) {
      const base = positions.length / 3;
      for (let it = 0; it <= SEG_T; it++) {
        const t = it / SEG_T;
        const s = seam(t);
        const c = corner(t);
        for (let iu = 0; iu <= SEG_U; iu++) {
          const u = iu / SEG_U;
          let x = s.x + (c.r - s.x) * u;
          let y = (GLASS_HW + (c.r - GLASS_HW) * u) * mirror;
          const z = s.z + (c.z - s.z) * u;
          for (let q = 0; q < quarter; q++) {
            const nx = -y;
            y = x;
            x = nx;
          }
          localToWorld(x, y, z, world);
          positions.push(world.x, world.y, world.z);
          // u wraps once around the eight patches, v climbs to the crown, so
          // the show's bars sweep up the shells and its bloom centres on the
          // apex cross.
          uvs.push((patch + u) / 8, t);
        }
      }
      for (let it = 0; it < SEG_T; it++) {
        for (let iu = 0; iu < SEG_U; iu++) {
          const a = base + it * (SEG_U + 1) + iu;
          const b = a + 1;
          const c = a + (SEG_U + 1) + 1;
          const d = a + (SEG_U + 1);
          if (mirror < 0) indices.push(a, b, c, a, c, d);
          else indices.push(a, c, b, a, d, c);
        }
      }
      patch++;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.name = "St Marys projection shell";
  return geometry;
}

/**
 * The show itself, in TSL: three stacked layers keyed to a running beat —
 * chromatic sweeping bars, a radial kaleidoscope bloom, and a scanline shimmer
 * — resolved against the shell's own UV so the pattern wraps the saddle.
 */
function buildShowMaterial(timeU: any, gainU: any): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;

  const show = Fn(() => {
    const st = uv();
    const t = timeU;
    const beat = fract(t.mul(0.62));
    const pulse = smoothstep(float(0.0), float(0.18), beat)
      .mul(smoothstep(float(1.0), float(0.42), beat));

    // sweeping chromatic bars climbing the shell
    const bar = fract(st.y.mul(7.0).sub(t.mul(0.55)));
    const barMask = smoothstep(float(0.5), float(0.0), tslAbs(bar.sub(0.5)).mul(2.0)).pow(2.4);
    const hue = st.y.mul(2.6).add(t.mul(0.21));
    const bars = vec3(
      sin(hue.mul(6.283)).mul(0.5).add(0.5),
      sin(hue.mul(6.283).add(2.094)).mul(0.5).add(0.5),
      sin(hue.mul(6.283).add(4.188)).mul(0.5).add(0.5)
    ).mul(barMask);

    // kaleidoscope bloom radiating from the crown
    const centred = st.sub(vec2(0.5, 1.0));
    const ang = atan(centred.y, centred.x);
    const rad = length(centred);
    const petals = sin(ang.mul(9.0).add(t.mul(0.9))).mul(0.5).add(0.5);
    const ring = smoothstep(float(0.06), float(0.0), tslAbs(fract(rad.mul(4.0).sub(t.mul(0.5))).sub(0.5)));
    const bloom = vec3(0.35, 0.85, 1.0).mul(petals.mul(ring).mul(1.4));

    // fine scanline shimmer so the surface never reads flat
    const scan = sin(st.y.mul(180.0).add(t.mul(6.0))).mul(0.5).add(0.5).mul(0.16);

    const colour = bars.add(bloom).add(vec3(scan));
    return vec4(colour.mul(gainU).mul(pulse.mul(0.55).add(0.65)), 1.0);
  });

  material.colorNode = show();
  material.opacity = 1;
  return material;
}

function makeConeMaterial(color: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  material.color.setHex(color);
  material.transparent = true;
  material.opacity = opacity;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return material;
}

/**
 * Plaza rave: six projector rigs throwing an animated show onto the cupola,
 * a crowd dancing in front of them, and beams that sweep with the music. It
 * runs day and night — daylight washes the projection down to a shimmer, and
 * after dusk the gain comes up and the beams and lamps take over.
 */
export function createStMarysRave(scene: THREE.Scene): StMarysRave {
  const group = new THREE.Group();
  group.name = "st_marys_plaza_rave";
  group.visible = false;
  scene.add(group);

  const timeU = uniform(0);
  const gainU = uniform(1);
  const disposables: { dispose(): void }[] = [];

  // ---- projection show on the shell --------------------------------------
  const shellGeometry = buildProjectionShell();
  const showMaterial = buildShowMaterial(timeU, gainU);
  const projection = new THREE.Mesh(shellGeometry, showMaterial);
  projection.name = "St Marys projection mapping";
  projection.renderOrder = 6;
  group.add(projection);
  disposables.push(shellGeometry, showMaterial);

  // ---- projector rigs + sweeping beams -----------------------------------
  const housingGeometry = new THREE.BoxGeometry(1.5, 0.85, 2.1);
  const legGeometry = new THREE.CylinderGeometry(0.07, 0.09, 1.5, 6);
  const lensGeometry = new THREE.CircleGeometry(0.34, 14);
  const housingMaterial = new THREE.MeshStandardNodeMaterial();
  housingMaterial.color.setHex(0x14161c);
  housingMaterial.roughness = 0.55;
  housingMaterial.metalness = 0.35;
  disposables.push(housingGeometry, legGeometry, lensGeometry, housingMaterial);

  type Beam = { mesh: THREE.Mesh; material: THREE.MeshBasicNodeMaterial; phase: number; pivot: THREE.Object3D };
  const beams: Beam[] = [];
  const lensMaterials: THREE.MeshBasicNodeMaterial[] = [];

  PROJECTORS.forEach((spec, index) => {
    const tint = BEAM_TINTS[index % BEAM_TINTS.length];
    const base = localToWorld(spec.x, spec.y, PLAZA_TOP + 1.5, new THREE.Vector3());

    const housing = new THREE.Mesh(housingGeometry, housingMaterial);
    housing.position.copy(base);
    housing.lookAt(localToWorld(0, 0, spec.aim, new THREE.Vector3()));
    group.add(housing);
    for (const side of [-0.5, 0.5]) {
      const leg = new THREE.Mesh(legGeometry, housingMaterial);
      leg.position.copy(base).y -= 0.75;
      leg.position.x += side;
      group.add(leg);
    }

    const lensMaterial = makeConeMaterial(tint, 0.9);
    lensMaterials.push(lensMaterial);
    const lens = new THREE.Mesh(lensGeometry, lensMaterial);
    lens.position.copy(base);
    lens.lookAt(localToWorld(0, 0, spec.aim, new THREE.Vector3()));
    lens.translateZ(1.06);
    lens.renderOrder = 7;
    group.add(lens);
    disposables.push(lensMaterial);

    // Beam volume: pivots at the lens so it can sweep across the facade.
    const target = localToWorld(0, 0, spec.aim, new THREE.Vector3());
    const length_ = base.distanceTo(target);
    const beamGeometry = new THREE.CylinderGeometry(2.6, 0.26, length_, 10, 1, true);
    const beamMaterial = makeConeMaterial(tint, 0.05);
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.position.set(0, length_ / 2, 0);
    const pivot = new THREE.Object3D();
    pivot.position.copy(base);
    pivot.quaternion.setFromUnitVectors(LOCAL_Y, target.clone().sub(base).normalize());
    pivot.add(beam);
    beam.renderOrder = 6;
    group.add(pivot);
    beams.push({ mesh: beam, material: beamMaterial, phase: index * 1.07, pivot });
    disposables.push(beamGeometry, beamMaterial);
  });

  // ---- the crowd ----------------------------------------------------------
  type Dancer = {
    rig: Rig;
    phase: number;
    speed: number;
    bob: number;
    home: THREE.Vector3;
    sway: number;
  };
  const dancers: Dancer[] = [];
  const dancePose = emoteById("dance")?.pose ?? null;
  const DANCERS = 26;
  for (let index = 0; index < DANCERS; index++) {
    // Deterministic scatter across the plaza OUTSIDE the north doors — the
    // curtain wall stands at y = 35.65, so the crowd fills the forecourt
    // between the doors and the Geary stair.
    const golden = index * 2.39996;
    const radius = ((index * 7919) % 1000) / 1000;
    const lx = Math.cos(golden) * (7 + radius * 22);
    const ly = 41.5 + Math.abs(Math.sin(golden)) * 11 + radius * 2.5;
    const rig = buildRig(avatarFromSeed(`st-marys-raver-${index}`));
    applyAvatarToRig(rig, avatarFromSeed(`st-marys-raver-${index}`));
    const home = localToWorld(lx, ly, PLAZA_TOP, new THREE.Vector3());
    // rig.group's origin sits at hip height, not the feet.
    home.y += 0.92;
    rig.group.position.copy(home);
    // Face the cupola: the show is what they are all watching.
    rig.group.rotation.y = -YAW + Math.atan2(-lx, -ly) + (((index * 37) % 40) - 20) * 0.012;
    group.add(rig.group);
    dancers.push({
      rig,
      phase: ((index * 613) % 1000) / 1000 * Math.PI * 2,
      speed: 0.92 + ((index * 271) % 100) / 100 * 0.3,
      bob: ((index * 149) % 100) / 100,
      home,
      sway: ((index * 83) % 100) / 100
    });
  }

  const worldToLocal = (position: THREE.Vector3) => {
    const dx = position.x - CENTER_X;
    const dz = position.z - CENTER_Z;
    const c = Math.cos(YAW);
    const s = Math.sin(YAW);
    return { x: c * dx - s * dz, y: -s * dx - c * dz };
  };

  let clock = 0;
  return {
    group,
    update(playerPosition, elapsed, dt) {
      const local = worldToLocal(playerPosition);
      // A projection show on a 190 ft cupola is a neighbourhood event: it stays
      // lit from several blocks out, not just from the forecourt.
      const distance = Math.hypot(local.x, local.y);
      const visible = distance < 430 &&
        playerPosition.y > FLOOR_Y - 40 && playerPosition.y < FLOOR_Y + 220;
      group.visible = visible;
      if (!visible) return;

      clock += dt;
      timeU.value = elapsed;

      // Night gain: the show is always running, but daylight washes it out.
      const elevation = SUN_STATE.elevationDeg;
      const night = Math.min(1, Math.max(0, (6 - elevation) / 14));
      gainU.value = 0.16 + night * 0.84;

      const beat = elapsed * 0.62;
      for (const entry of beams) {
        entry.material.opacity = (0.012 + night * 0.055) *
          (0.65 + 0.35 * Math.sin(beat * 6.283 + entry.phase));
        entry.pivot.rotation.z = Math.sin(elapsed * 0.55 + entry.phase) * 0.13;
        entry.pivot.rotation.x = Math.sin(elapsed * 0.37 + entry.phase * 1.7) * 0.05;
      }
      for (const material of lensMaterials) {
        material.opacity = 0.35 + night * 0.6;
      }

      // Dancers: the shared dance emote pose, each on its own phase, with a
      // little travel so the crowd breathes instead of standing in a grid.
      // Past ~200 m they are specks — hold the last pose instead of re-solving
      // 26 skeletons every frame.
      if (distance > 200) return;
      for (const dancer of dancers) {
        const t = elapsed * dancer.speed + dancer.phase;
        if (dancePose) dancePose(dancer.rig, t);
        dancer.rig.group.position.set(
          dancer.home.x + Math.sin(t * 0.31 + dancer.sway * 6.0) * 0.5,
          dancer.home.y + Math.abs(Math.sin(t * 3.14)) * 0.06 * dancer.bob,
          dancer.home.z + Math.cos(t * 0.27 + dancer.sway * 6.0) * 0.5
        );
        dancer.rig.group.rotation.y += Math.sin(t * 0.4) * 0.004;
      }
    },
    dispose() {
      group.removeFromParent();
      for (const item of disposables) item.dispose();
      for (const dancer of dancers) {
        dancer.rig.group.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material?.dispose();
        });
      }
      group.clear();
    }
  };
}
