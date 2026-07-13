// The Lands End Labyrinth — a spiral of beach cobbles you light by walking.
//
// Walk the groove between the two lines of stones and a bioluminescent wave of
// light follows your feet inward (teal, breathing). Reach the centre cairn and
// the whole labyrinth floods gold and a ring of sea-lanterns lifts off the
// heart and drifts out over the ocean.
//
// GPU vs CPU (per the codebase's per-instance idiom): the "which stone is lit"
// signal is ONE uniform `uProgress` (arc position 0..1) read against a per-
// instance `aSeq` attribute — no branch, no per-stone CPU writes. The pulse and
// hue shift are pure ALU in the shader. CPU only nudges four uniforms and, once,
// animates ~26 lanterns. No If()+noise anywhere (WGSL→Metal branch hazard).

import * as THREE from "three/webgpu";
import { attribute, color, float, mix, sin, smoothstep, uniform } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../heightmap";
import { buildLabyrinthPath, LABYRINTH, type LabyrinthPath } from "./layout";

type N = any; // TSL node generics fight composition; `any` is the house idiom.

// ── shared, live-tunable uniforms ────────────────────────────────────────────
const LE_TIME = uniform(0); // the labyrinth's own clock (frozen by pause)
const LAB_PROGRESS = uniform(0); // 0 rim … 1 centre — furthest the walker reached
const LAB_HEAD = uniform(0); // the walker's current arc position (bright edge)
const LAB_COMPLETE = uniform(0); // 0 → 1 payoff ramp
const LAB_INTENSITY = uniform(1.2 * LIGHT_SCALE); // master glow brightness

const TEAL = 0x1fd8be;
const GOLD = 0xffab33;

/** Build the emissive glow graph shared by every cobble. Colour arrives via
 *  uniforms/attribute so a single compiled pipeline serves all instances. */
function stoneMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.0, flatShading: true });
  mat.colorNode = color(0x3c4247); // dark wet basalt; the magic is the emissive

  const seq: N = attribute("aSeq", "float");
  const time: N = LE_TIME;

  // Trail: lit where seq <= progress. smoothstep keeps lo<hi then .oneMinus()
  // inverts (reversed edges silently return 0 under this renderer).
  const trail: N = smoothstep(LAB_PROGRESS.sub(0.015), LAB_PROGRESS.add(0.004), seq).oneMinus();
  // Bright leading edge riding the walker's head.
  const dHead: N = LAB_HEAD.sub(seq).abs();
  const head: N = smoothstep(float(0.0), float(0.035), dHead).oneMinus();
  // Breathing shimmer (noise-free ALU, safe outside any branch).
  const breathe: N = sin(time.mul(2.1).add(seq.mul(42.0))).mul(0.18).add(0.82);

  // Faint dormant presence so the sleeping spiral still reads at dusk, then the
  // trail ramps it to full and the leading edge flares.
  const dormant: N = float(0.08);
  const litAmt: N = mix(trail, float(1.0), LAB_COMPLETE);
  const level: N = litAmt.mul(breathe).add(head.mul(trail).mul(0.85)).max(dormant);
  // Completion floods every stone and warms the hue teal → gold.
  const col: N = mix(color(TEAL), color(GOLD), LAB_COMPLETE);

  (mat as unknown as { emissiveNode: unknown }).emissiveNode = col.mul(level).mul(LAB_INTENSITY);
  return mat;
}

type Lantern = {
  mesh: THREE.Mesh;
  seed: number;
  driftX: number;
  driftZ: number;
  spin: number;
};

export class Labyrinth {
  /** Static-ish subtree: stones + centre cairn. */
  readonly group = new THREE.Group();
  /** Animated subtree: the payoff sea-lanterns. */
  readonly activity = new THREE.Group();

  #path: LabyrinthPath;
  #progress = 0;
  #head = 0;
  #started = false;
  #completed = false;
  #completeElapsed = 0;
  #lanterns: Lantern[] = [];
  #centerY = 0;
  /** Set true by a demo/cinematic to drive progress externally (setProgress). */
  #scripted = false;

  constructor(map: WorldMap) {
    this.group.name = "landsEnd.labyrinth";
    this.#path = buildLabyrinthPath();
    this.activity.name = "landsEnd.lanterns";
    this.#buildStones(map);
    this.#buildCairn(map);
    this.#buildLanterns(map);
    // NOTE: activity is NOT parented under group — the region keeps it live
    // while freezing the static stone/cairn matrices.
  }

  // ── construction ───────────────────────────────────────────────────────────

  #buildStones(map: WorldMap) {
    const stones = this.#path.stones;
    const n = stones.length;
    // A chunky low-poly cobble; flatShading + per-instance yaw/scale hides the
    // repeat. One shared geometry, one shared material, one draw.
    const geo = new THREE.DodecahedronGeometry(0.42, 0);
    geo.scale(1, 0.66, 1); // squashed river cobble
    const mesh = new THREE.InstancedMesh(geo, stoneMaterial(), n);
    mesh.name = "labyrinth.stones";
    mesh.frustumCulled = false; // instances spread from origin; region gate culls
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const seqArr = new Float32Array(n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const s = stones[i];
      const gy = map.groundTop(s.x, s.z);
      // seated proud of the ground so the cobbles catch light and read as a path
      pos.set(s.x, gy - 0.05 + s.scale * 0.16, s.z);
      q.setFromAxisAngle(up, s.yaw);
      scl.set(s.scale, s.scale, s.scale);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
      seqArr[i] = s.t;
    }
    mesh.instanceMatrix.needsUpdate = true;
    geo.setAttribute("aSeq", new THREE.InstancedBufferAttribute(seqArr, 1));
    this.group.add(mesh);
  }

  #buildCairn(map: WorldMap) {
    const cx = this.#path.center.x;
    const cz = this.#path.center.z;
    const gy = map.groundTop(cx, cz);
    this.#centerY = gy;
    const cairn = new THREE.Group();
    cairn.position.set(cx, gy, cz);

    // stacked base stones (plain dark rock)
    const baseMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, flatShading: true });
    baseMat.colorNode = color(0x30363b);
    const stack: [number, number, number][] = [
      [0.0, 0.28, 0.95],
      [0.12, 0.72, 0.7],
      [-0.06, 1.06, 0.52],
      [0.04, 1.32, 0.4]
    ];
    for (const [dx, y, r] of stack) {
      const g = new THREE.DodecahedronGeometry(r, 0);
      g.scale(1, 0.7, 1);
      const s = new THREE.Mesh(g, baseMat);
      s.position.set(dx, y, dx * 0.3);
      s.rotation.y = y * 3.1;
      s.castShadow = false;
      cairn.add(s);
    }

    // the heart — a glowing capstone that pulses always and blazes on completion
    const heartMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0 });
    heartMat.colorNode = color(0x0c1a1c);
    const idle: N = sin(LE_TIME.mul(1.6)).mul(0.18).add(0.5);
    const heartGlow: N = mix(idle, float(1.35), LAB_COMPLETE);
    const heartCol: N = mix(color(TEAL), color(GOLD), LAB_COMPLETE);
    (heartMat as unknown as { emissiveNode: unknown }).emissiveNode = heartCol.mul(heartGlow).mul(LAB_INTENSITY);
    const heart = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), heartMat);
    heart.position.set(0.04, 1.72, 0);
    heart.castShadow = false;
    cairn.add(heart);

    this.group.add(cairn);
  }

  #buildLanterns(map: WorldMap) {
    const cx = this.#path.center.x;
    const cz = this.#path.center.z;
    const count = 26;
    const geo = new THREE.SphereGeometry(0.22, 10, 8);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0 });
      mat.colorNode = color(0x2a1607);
      const flick: N = sin(LE_TIME.mul(3.0 + i * 0.13).add(i)).mul(0.25).add(0.9);
      (mat as unknown as { emissiveNode: unknown }).emissiveNode = color(0xff9c3a).mul(flick).mul(1.5 * LIGHT_SCALE);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = false;
      mesh.visible = false;
      const ang = (i / count) * Math.PI * 2;
      // drift out toward the ocean (WNW) with a per-lantern spread
      const bias = -0.75 + (i % 5) * 0.06;
      this.#lanterns.push({
        mesh,
        seed: i,
        driftX: Math.cos(ang) * 0.5 + bias,
        driftZ: Math.sin(ang) * 0.5 - 0.35,
        spin: (i % 2 ? 1 : -1) * (0.4 + (i % 3) * 0.15)
      });
      mesh.position.set(cx, this.#centerY + 1.7, cz);
      this.activity.add(mesh);
    }
    void map;
  }

  // ── runtime ──────────────────────────────────────────────────────────────

  /** Drive progress directly (cinematic / scripted). t in 0..1. */
  setProgress(t: number) {
    this.#scripted = true;
    const c = Math.max(0, Math.min(1, t));
    this.#progress = Math.max(this.#progress, c);
    this.#head = c;
    if (c >= 0.985 && !this.#completed) this.#complete();
  }

  /** Force the payoff (demo). */
  triggerComplete() {
    if (!this.#completed) this.#complete();
  }

  reset() {
    this.#progress = 0;
    this.#head = 0;
    this.#started = false;
    this.#completed = false;
    this.#completeElapsed = 0;
    this.#scripted = false;
    LAB_PROGRESS.value = 0;
    LAB_HEAD.value = 0;
    LAB_COMPLETE.value = 0;
    for (const l of this.#lanterns) l.mesh.visible = false;
  }

  #complete() {
    this.#completed = true;
    this.#completeElapsed = 0;
    this.#progress = 1;
    for (const l of this.#lanterns) l.mesh.visible = true;
  }

  get completed() {
    return this.#completed;
  }

  /** Live glow uniforms for dev tuning (values in the app's exposure space). */
  get glow() {
    return { intensity: LAB_INTENSITY, complete: LAB_COMPLETE, progress: LAB_PROGRESS, head: LAB_HEAD, time: LE_TIME };
  }

  #nearestT(px: number, pz: number): number {
    // nearest centreline sample within the groove → its arc position
    const samples = this.#path.samples;
    const grooveR2 = 1.35 * 1.35;
    let best = -1;
    let bestD2 = grooveR2;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const dx = px - s.x;
      const dz = pz - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best >= 0 ? samples[best].t : -1;
  }

  update(dt: number, px: number, pz: number) {
    LE_TIME.value += dt;

    if (!this.#scripted && !this.#completed) {
      const t = this.#nearestT(px, pz);
      if (t >= 0) {
        this.#head = t;
        // advance only forward and only when near-contiguous (ignore teleports)
        if (!this.#started && t < 0.14) this.#started = true;
        if (this.#started && t > this.#progress && t - this.#progress < 0.12) {
          this.#progress = t;
        } else if (this.#started && t < 0.06 && this.#progress > 0.9) {
          // wrapped back to rim after finishing a lap without completing — hold
        }
        if (this.#progress >= 0.965) this.#complete();
      }
    }

    // ease uniforms toward logical state
    const k = Math.min(1, dt * 6);
    LAB_PROGRESS.value += (this.#progress - LAB_PROGRESS.value) * k;
    LAB_HEAD.value += (this.#head - LAB_HEAD.value) * Math.min(1, dt * 10);

    if (this.#completed) {
      this.#completeElapsed += dt;
      LAB_COMPLETE.value = Math.min(1, LAB_COMPLETE.value + dt / 1.8);
      this.#animateLanterns(this.#completeElapsed);
    }
  }

  #animateLanterns(elapsed: number) {
    const cx = this.#path.center.x;
    const cz = this.#path.center.z;
    for (const l of this.#lanterns) {
      const launch = 0.15 + (l.seed % 8) * 0.14; // staggered lift-off
      const age = elapsed - launch;
      if (age <= 0) {
        l.mesh.position.set(cx, this.#centerY + 1.7, cz);
        continue;
      }
      const rise = Math.min(age * 2.7, 42 + (l.seed % 8)); // metres up, capped
      const bob = Math.sin(elapsed * 1.6 + l.seed) * 0.5;
      const sway = Math.sin(elapsed * 0.7 + l.seed * 1.3) * 1.8;
      l.mesh.position.set(
        cx + l.driftX * age * 2.7 + sway,
        this.#centerY + 1.7 + rise + bob,
        cz + l.driftZ * age * 2.7
      );
      // gentle fade as they climb into the marine haze
      const fade = Math.max(0, 1 - age / 20);
      l.mesh.scale.setScalar(0.7 + fade * 0.6);
      l.mesh.visible = fade > 0.02;
    }
  }
}

export { LABYRINTH };
