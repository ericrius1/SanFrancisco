// The Wave Organ — Archetype A (always in scene once loaded, distance-LOD
// self-gating). An acoustic sculpture at the tip of the Marina breakwater:
// cemetery-salvage granite and marble scattered along the spit, five verdigris
// listening pipes that hum with the tide, a bronze plaque with the only clue,
// and a cairn at the heart. Keep still beside each pipe to wake its voice;
// wake all five and the organ remembers its song — the pipes swell into a
// slow D-minor hymn while bioluminescence blooms off the tip.
//
// GPU/CPU split (house idiom): pipe-mouth glow is ONE InstancedMesh whose
// per-instance `aGlow` attribute the CPU eases (5 floats); bloom/payoff is a
// single WO_BLOOM uniform read by the rings, cairn heart, water sheet and
// motes. No If()+noise anywhere.

import * as THREE from "three/webgpu";
import { color, float, length, mix, positionLocal, sin, smoothstep, uniform, attribute } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { formatInteractPrompt } from "../../core/input";
import type { WorldMap } from "../heightmap";
import type { NatureSoundscape } from "../../audio/natureSoundscape";
import { WaveOrganAudio, type PipeAudioState } from "./audio";
import { TideMotes } from "./motes";
import {
  BENCHES,
  buildStonePlacements,
  HEART,
  LISTEN,
  PIPES,
  PLAQUE,
  WAVE_ORGAN_CENTER
} from "./layout";

export { WAVE_ORGAN_CENTER, inWaveOrgan } from "./layout";

type N = any; // TSL node generics fight composition; `any` is the house idiom.

const DETAIL_RANGE = 650; // m from the site centre — draw nothing beyond

// ── shared, live-tunable uniforms ────────────────────────────────────────────
const WO_TIME = uniform(0); // the organ's own clock (frozen by pause)
const WO_BLOOM = uniform(0); // 0 → 1 payoff ramp once the song is remembered

const TEAL = 0x25e0c8;
const GOLD = 0xffc36b;

// ── shared materials (never per-build) ───────────────────────────────────────
const GRANITE = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0.0, flatShading: true });
  m.colorNode = color(0x7c766b); // weathered warm granite
  return m;
})();
const MARBLE = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.0, flatShading: true });
  m.colorNode = color(0xb8ab99); // old cemetery marble, rain-softened
  return m;
})();
const PIPE_METAL = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0.55 });
  m.colorNode = color(0x3e5a52); // verdigris copper
  return m;
})();
const BRONZE = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0.78 });
  m.colorNode = color(0x5e4a2c);
  return m;
})();
const THROAT = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = color(0x04070a); // the dark of the listening column
  return m;
})();

/** Mouth-ring glow: per-instance `aGlow` (0 dormant → 1 awake), warmed from
 *  tide-teal toward gold as the bloom lands. A faint dormant ember keeps the
 *  rings legible at dusk so the pipes read as something to approach. */
function ringMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.2 });
  mat.colorNode = color(0x1a2a28);
  const glow: N = attribute("aGlow", "float");
  const breathe: N = sin(WO_TIME.mul(1.7).add(glow.mul(9.0))).mul(0.16).add(0.84);
  const level: N = glow.mul(breathe).mul(WO_BLOOM.mul(0.5).add(1.0)).max(float(0.1));
  const col: N = mix(color(TEAL), color(GOLD), WO_BLOOM.mul(0.65));
  (mat as unknown as { emissiveNode: unknown }).emissiveNode = col.mul(level).mul(0.92 * LIGHT_SCALE);
  return mat;
}

/** The tide sheet: expanding glow rings on the water around the tip, alive
 *  only as the bloom lands. Pure ALU, additive, no depth write. */
function tideSheet(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(64, 64, 1, 1);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const d: N = length(positionLocal.xy);
  const crest: N = sin(d.mul(1.35).sub(WO_TIME.mul(2.0))).mul(0.5).add(0.5);
  const thin: N = crest.mul(crest).mul(crest);
  const inner: N = smoothstep(float(5.0), float(11.0), d);
  const outer: N = smoothstep(float(19.0), float(30.0), d).oneMinus();
  mat.colorNode = color(0x49f0d4).mul(0.9 * LIGHT_SCALE);
  (mat as unknown as { opacityNode: unknown }).opacityNode = thin
    .mul(inner)
    .mul(outer)
    .mul(WO_BLOOM)
    .mul(0.42);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(HEART.x, 0.34, HEART.z);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

type PipeRuntime = {
  mouth: THREE.Vector3;
  listen: number; // seconds accumulated beside the mouth
  glow: number; // eased display value mirrored into aGlow
  awakened: boolean;
};

export class WaveOrgan {
  readonly group = new THREE.Group();
  /** Live subtree (kept unfrozen): the payoff motes. */
  readonly activity = new THREE.Group();

  #audio: WaveOrganAudio;
  #motes: TideMotes;
  #pipes: PipeRuntime[] = [];
  #audioStates: PipeAudioState[] = [];
  #glowAttr: THREE.InstancedBufferAttribute;
  #ringMesh: THREE.InstancedMesh;
  #completed = false;
  #bloomTarget = 0;
  #wokenCount = 0;
  #listenHintShown = false;
  #plaquePromptShown = false;

  constructor(map: WorldMap, nature: NatureSoundscape) {
    this.group.name = "waveOrgan";
    this.activity.name = "waveOrgan.motes";
    this.#audio = new WaveOrganAudio(nature);

    this.#buildStones(map);
    this.#buildBenches(map);
    const { ringMesh, glowAttr } = this.#buildPipes(map);
    this.#ringMesh = ringMesh;
    this.#glowAttr = glowAttr;
    this.#buildCairn(map);
    this.#buildPlaque(map);
    this.group.add(tideSheet());

    this.#motes = new TideMotes(map.groundTop(HEART.x, HEART.z), WO_BLOOM, WO_TIME);
    this.activity.add(this.#motes.group);
    this.group.add(this.activity);

    // Freeze the static subtrees (everything except the live motes).
    for (const child of this.group.children) {
      if (child === this.activity) continue;
      child.updateMatrixWorld(true);
      child.matrixWorldAutoUpdate = false;
    }
  }

  // ── construction ───────────────────────────────────────────────────────────

  #buildStones(map: WorldMap) {
    const placements = buildStonePlacements();
    const blocks = placements.filter((p) => p.kind === 0);
    const balusters = placements.filter((p) => p.kind === 1);

    // Rough granite salvage: chunky squashed dodecahedra, one draw.
    const blockGeo = new THREE.DodecahedronGeometry(0.5, 0);
    blockGeo.scale(1, 0.62, 1);
    const blockMesh = new THREE.InstancedMesh(blockGeo, GRANITE, blocks.length);
    blockMesh.name = "waveOrgan.blocks";
    blockMesh.frustumCulled = false;
    blockMesh.castShadow = false;
    blockMesh.receiveShadow = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < blocks.length; i++) {
      const s = blocks[i];
      const gy = map.groundTop(s.x, s.z);
      pos.set(s.x, gy - 0.08 + s.scale * 0.18, s.z);
      q.setFromAxisAngle(up, s.yaw);
      scl.set(s.scale, s.scale, s.scale);
      m.compose(pos, q, scl);
      blockMesh.setMatrixAt(i, m);
    }
    blockMesh.instanceMatrix.needsUpdate = true;
    this.group.add(blockMesh);

    // Carved balusters — the cemetery's signature — standing or toppled.
    const balGeo = new THREE.CylinderGeometry(0.13, 0.19, 1.05, 10);
    const balMesh = new THREE.InstancedMesh(balGeo, MARBLE, balusters.length);
    balMesh.name = "waveOrgan.balusters";
    balMesh.frustumCulled = false;
    balMesh.castShadow = false;
    balMesh.receiveShadow = false;
    const e = new THREE.Euler();
    for (let i = 0; i < balusters.length; i++) {
      const s = balusters[i];
      const gy = map.groundTop(s.x, s.z);
      if (s.fallen) {
        e.set(Math.PI / 2, 0, s.yaw);
        pos.set(s.x, gy + 0.16 * s.scale, s.z);
      } else {
        e.set(0, s.yaw, 0);
        pos.set(s.x, gy + 0.5 * s.scale, s.z);
      }
      q.setFromEuler(e);
      scl.setScalar(s.scale * 0.9);
      m.compose(pos, q, scl);
      balMesh.setMatrixAt(i, m);
    }
    balMesh.instanceMatrix.needsUpdate = true;
    this.group.add(balMesh);
  }

  #buildBenches(map: WorldMap) {
    const geo = new THREE.BoxGeometry(1.95, 0.42, 0.6);
    for (const b of BENCHES) {
      const gy = map.groundTop(b.x, b.z);
      const bench = new THREE.Mesh(geo, GRANITE);
      bench.position.set(b.x, gy + 0.14, b.z);
      bench.rotation.y = b.yaw;
      bench.castShadow = false;
      bench.receiveShadow = false;
      this.group.add(bench);
    }
  }

  #buildPipes(map: WorldMap): { ringMesh: THREE.InstancedMesh; glowAttr: THREE.InstancedBufferAttribute } {
    const elbowR = 0.34;
    const bodyGeoCache = new Map<number, THREE.CylinderGeometry>();
    const elbowGeo = new THREE.TorusGeometry(elbowR, 0.22, 10, 14, Math.PI / 2);
    elbowGeo.rotateZ(Math.PI / 2); // arc now spans body-top (vertical) → mouth (horizontal)
    const mouthGeo = new THREE.CylinderGeometry(0.24, 0.22, 0.42, 12);
    mouthGeo.rotateZ(Math.PI / 2); // axis along local +X
    const collarGeo = new THREE.DodecahedronGeometry(0.34, 0);
    collarGeo.scale(1, 0.6, 1);

    // Glow rings + throat discs: world-space instances, one draw each.
    const ringGeo = new THREE.TorusGeometry(0.3, 0.05, 10, 24);
    ringGeo.rotateY(Math.PI / 2); // ring axis along +X
    const ringMesh = new THREE.InstancedMesh(ringGeo, ringMaterial(), PIPES.length);
    ringMesh.name = "waveOrgan.rings";
    ringMesh.frustumCulled = false;
    ringMesh.castShadow = false;
    const throatGeo = new THREE.CircleGeometry(0.21, 16);
    throatGeo.rotateY(Math.PI / 2); // face along +X
    const throatMesh = new THREE.InstancedMesh(throatGeo, THROAT, PIPES.length);
    throatMesh.name = "waveOrgan.throats";
    throatMesh.frustumCulled = false;
    throatMesh.castShadow = false;

    const glowArr = new Float32Array(PIPES.length);
    const glowAttr = new THREE.InstancedBufferAttribute(glowArr, 1);
    ringGeo.setAttribute("aGlow", glowAttr);

    const m = new THREE.Matrix4();
    const scl = new THREE.Vector3(1, 1, 1);
    const qYaw = new THREE.Quaternion();
    const qLean = new THREE.Quaternion();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);

    for (let i = 0; i < PIPES.length; i++) {
      const spec = PIPES[i];
      const gy = map.groundTop(spec.x, spec.z);

      // Pipe assembly: outer yaw, inner lean toward the mouth.
      const outer = new THREE.Group();
      outer.position.set(spec.x, gy, spec.z);
      outer.rotation.y = -spec.yaw; // local +X → world (cos yaw, 0, sin yaw)
      const tilt = new THREE.Group();
      tilt.rotation.z = -spec.lean;
      outer.add(tilt);

      let bodyGeo = bodyGeoCache.get(spec.height);
      if (!bodyGeo) {
        bodyGeo = new THREE.CylinderGeometry(0.22, 0.26, spec.height, 12);
        bodyGeoCache.set(spec.height, bodyGeo);
      }
      const body = new THREE.Mesh(bodyGeo, PIPE_METAL);
      body.position.y = spec.height / 2;
      const elbow = new THREE.Mesh(elbowGeo, PIPE_METAL);
      elbow.position.set(elbowR, spec.height, 0);
      const mouth = new THREE.Mesh(mouthGeo, PIPE_METAL);
      mouth.position.set(elbowR + 0.21, spec.height + elbowR, 0);
      for (const part of [body, elbow, mouth]) {
        part.castShadow = false;
        part.receiveShadow = false;
        tilt.add(part);
      }

      // Rubble collar so the pipe grows out of the salvage, not the lawn.
      for (let c = 0; c < 3; c++) {
        const chunk = new THREE.Mesh(collarGeo, GRANITE);
        const a = (c / 3) * Math.PI * 2 + i;
        chunk.position.set(Math.cos(a) * 0.34, 0.06, Math.sin(a) * 0.34);
        chunk.rotation.y = a * 2.3;
        chunk.scale.setScalar(0.8 + ((i + c) % 3) * 0.25);
        chunk.castShadow = false;
        outer.add(chunk);
      }
      this.group.add(outer);

      // Mouth pose in world space for the glow ring, throat, audio and the
      // listening check: world = Ry(-yaw)·Rz(-lean)·local + base.
      qYaw.setFromAxisAngle(up, -spec.yaw);
      qLean.setFromAxisAngle(zAxis, -spec.lean);
      q.copy(qYaw).multiply(qLean);
      const mouthLocal = new THREE.Vector3(elbowR + 0.42, spec.height + elbowR, 0);
      const mouthWorld = mouthLocal.applyQuaternion(q).add(outer.position);
      m.compose(mouthWorld, q, scl);
      ringMesh.setMatrixAt(i, m);
      const throatLocal = new THREE.Vector3(elbowR + 0.4, spec.height + elbowR, 0);
      const throatWorld = throatLocal.applyQuaternion(q).add(outer.position);
      m.compose(throatWorld, q, scl);
      throatMesh.setMatrixAt(i, m);

      this.#pipes.push({ mouth: mouthWorld.clone(), listen: 0, glow: 0, awakened: false });
      this.#audioStates.push({
        x: mouthWorld.x,
        y: mouthWorld.y,
        z: mouthWorld.z,
        listen: 0,
        awakened: false
      });
    }
    ringMesh.instanceMatrix.needsUpdate = true;
    throatMesh.instanceMatrix.needsUpdate = true;
    this.group.add(ringMesh);
    this.group.add(throatMesh);
    return { ringMesh, glowAttr };
  }

  #buildCairn(map: WorldMap) {
    const gy = map.groundTop(HEART.x, HEART.z);
    const cairn = new THREE.Group();
    cairn.position.set(HEART.x, gy, HEART.z);

    const stack: [number, number, number][] = [
      [0.0, 0.26, 0.9],
      [0.1, 0.66, 0.64],
      [-0.05, 0.98, 0.48],
      [0.04, 1.22, 0.36]
    ];
    for (const [dx, y, r] of stack) {
      const g = new THREE.DodecahedronGeometry(r, 0);
      g.scale(1, 0.68, 1);
      const s = new THREE.Mesh(g, GRANITE);
      s.position.set(dx, y, dx * 0.3);
      s.rotation.y = y * 2.7;
      s.castShadow = false;
      cairn.add(s);
    }

    // The heart — a sea-glass capstone that breathes while the organ sleeps
    // and blazes gold when the song is remembered.
    const heartMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.38, metalness: 0 });
    heartMat.colorNode = color(0x0b1a18);
    const idle: N = sin(WO_TIME.mul(1.4)).mul(0.16).add(0.42);
    const heartGlow: N = mix(idle, float(1.4), WO_BLOOM);
    const heartCol: N = mix(color(TEAL), color(GOLD), WO_BLOOM);
    (heartMat as unknown as { emissiveNode: unknown }).emissiveNode = heartCol
      .mul(heartGlow)
      .mul(1.25 * LIGHT_SCALE);
    const heart = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 1), heartMat);
    heart.position.set(0.03, 1.56, 0);
    heart.castShadow = false;
    cairn.add(heart);

    this.group.add(cairn);
  }

  #buildPlaque(map: WorldMap) {
    const gy = map.groundTop(PLAQUE.x, PLAQUE.z);
    const g = new THREE.Group();
    g.position.set(PLAQUE.x, gy, PLAQUE.z);
    g.rotation.y = -PLAQUE.yaw;

    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.95, 0.4), GRANITE);
    pedestal.position.y = 0.45;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.04), BRONZE);
    plate.position.set(0, 1.0, 0.17);
    plate.rotation.x = -0.35;
    for (const part of [pedestal, plate]) {
      part.castShadow = false;
      part.receiveShadow = false;
      g.add(part);
    }
    this.group.add(g);
  }

  // ── runtime ──────────────────────────────────────────────────────────────

  get completed() {
    return this.#completed;
  }

  /** Force the payoff (demo/debug). */
  /** Full teardown for a distance unload — audio graph first (it holds the
   * shared nature context awake), then every locally built mesh. */
  dispose() {
    this.#audio.dispose();
    this.group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh && !(object as THREE.Points).isPoints) return;
      geometries.add(mesh.geometry);
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) {
        materials.add(material);
        const map = (material as THREE.MeshBasicMaterial).map;
        if (map) textures.add(map);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    this.group.clear();
  }

  triggerComplete(hud?: { message(t: string, s?: number): void }) {
    for (const [i, pipe] of this.#pipes.entries()) {
      pipe.awakened = true;
      this.#audioStates[i].awakened = true;
    }
    this.#wokenCount = this.#pipes.length;
    this.#complete(hud ?? null);
  }

  #complete(hud: { message(t: string, s?: number): void } | null) {
    if (this.#completed) return;
    this.#completed = true;
    this.#bloomTarget = 1;
    this.#motes.group.visible = true;
    this.#audio.startHymn();
    hud?.message("The organ remembers its song.", 6);
  }

  /** E near the plaque. Returns true if it consumed the press. */
  tryInteract(
    player: { renderPosition: { x: number; z: number }; mode: string },
    hud: { message(t: string, s?: number): void }
  ): boolean {
    if (player.mode !== "walk") return false;
    const dx = player.renderPosition.x - PLAQUE.x;
    const dz = player.renderPosition.z - PLAQUE.z;
    if (dx * dx + dz * dz > PLAQUE.reach * PLAQUE.reach) return false;
    hud.message(
      this.#completed
        ? "Stones of a silent city — and the tide, still singing through them."
        : "Stones of a silent city, set here to listen. Five voices sleep along the jetty — keep still beside each, and the tide will remember its song.",
      8
    );
    return true;
  }

  update(
    dt: number,
    elapsed: number,
    playerPos: { x: number; z: number },
    hud: { message(t: string, s?: number): void } | null
  ) {
    const dist = Math.hypot(playerPos.x - WAVE_ORGAN_CENTER.x, playerPos.z - WAVE_ORGAN_CENTER.z);
    const near = dist < DETAIL_RANGE;
    this.group.visible = near;
    // Audio gates itself at 130 m and needs the far branch to wind down.
    this.#audio.update(dt, playerPos, this.#audioStates);
    if (!near) return;

    WO_TIME.value += dt;

    // Listening: the nearest sleeping mouth within reach accumulates; walking
    // away lets it drain. Only a walker can put an ear to a pipe (hud is null
    // while driving/boarding, which doubles as the mode gate).
    let listeningIndex = -1;
    if (!this.#completed && hud) {
      let bestD2 = LISTEN.radius * LISTEN.radius;
      for (let i = 0; i < this.#pipes.length; i++) {
        if (this.#pipes[i].awakened) continue;
        const mouth = this.#pipes[i].mouth;
        const dx = playerPos.x - mouth.x;
        const dz = playerPos.z - mouth.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          listeningIndex = i;
        }
      }
    }

    let glowDirty = false;
    for (let i = 0; i < this.#pipes.length; i++) {
      const pipe = this.#pipes[i];
      if (!pipe.awakened) {
        if (i === listeningIndex) {
          pipe.listen += dt;
          if (!this.#listenHintShown) {
            this.#listenHintShown = true;
            hud?.message("Be still, and listen…", 2.5);
          }
          if (pipe.listen >= LISTEN.holdSeconds) {
            pipe.awakened = true;
            this.#wokenCount++;
            this.#audio.chime(i);
            if (this.#wokenCount < this.#pipes.length) {
              hud?.message(`A voice remembers · ${this.#wokenCount} of ${this.#pipes.length}`, 3);
            } else {
              this.#complete(hud);
            }
          }
        } else {
          pipe.listen = Math.max(0, pipe.listen - dt * 0.8);
        }
      }
      this.#audioStates[i].listen = Math.min(1, pipe.listen / LISTEN.holdSeconds);
      this.#audioStates[i].awakened = pipe.awakened;

      const target = pipe.awakened ? 1 : (pipe.listen / LISTEN.holdSeconds) * 0.85;
      const eased = pipe.glow + (target - pipe.glow) * Math.min(1, dt * 5);
      if (Math.abs(eased - pipe.glow) > 0.0005) {
        pipe.glow = eased;
        (this.#glowAttr.array as Float32Array)[i] = eased;
        glowDirty = true;
      }
    }
    if (glowDirty) this.#glowAttr.needsUpdate = true;

    // Plaque proximity nudge (one-shot per approach, keeper idiom).
    if (hud) {
      const dx = playerPos.x - PLAQUE.x;
      const dz = playerPos.z - PLAQUE.z;
      const nearPlaque = dx * dx + dz * dz < PLAQUE.reach * PLAQUE.reach;
      if (nearPlaque && !this.#plaquePromptShown) {
        this.#plaquePromptShown = true;
        hud.message(formatInteractPrompt("read the weathered plaque"), 2.2);
      } else if (!nearPlaque && this.#plaquePromptShown) {
        this.#plaquePromptShown = false;
      }
    }

    WO_BLOOM.value += (this.#bloomTarget - WO_BLOOM.value) * Math.min(1, dt / 2.2);
    this.#motes.update(dt, elapsed);
    void this.#ringMesh;
  }
}
