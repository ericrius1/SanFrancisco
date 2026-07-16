import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { Physics } from "../../core/physics";
import { BodyType } from "../../core/box3dWorld";
import { Policy, type PolicyDef } from "../../creatures/policy.ts";
import { obsDim, actDim, type CreatureSpec, type Link } from "../../creatures/quadruped.ts";
import { CreatureRagdoll } from "../pup/creatureRagdoll.ts";
import { buildBrain, writeActivationColor, setActivationColor, BRAIN_LINE_GLOW, BRAIN_NODE_GLOW, type Brain } from "./brainViz";

/**
 * One fenced training pen holding N live RL creatures of one species — the
 * generic machinery behind every ranch experiment. Each creature is a private
 * box3d active-ragdoll driven by the pen's policy file; the pen re-fetches
 * that file while awake and hot-swaps every brain (and re-sizes every body:
 * the creatures literally grow up as the overnight trainer's generations
 * pass). Optional show-jump gates give trained bodies something to hop.
 */

const GOAL_EASE = 0.45;
const DOWN_SECONDS = 5;
const POLL_MS = 90_000;
const GATE_APPROACH_R = 14;
const JUMP_COMMIT_SPEED = 0.62;

export type PenConfig = {
  id: string;
  title: string; // sign headline
  center: { x: number; z: number };
  radius: number;
  count: number;
  spec: CreatureSpec;
  policyUrl: string; // e.g. /models/horse_policy.json
  dress: (spec: CreatureSpec) => THREE.Mesh[]; // base-dim geometry, scaled by scalar
  scaleForGen: (gen: number) => number;
  statusForGen: (gen: number) => string;
  /** sample a roaming gait speed (Froude) */
  roamSpeed: () => number;
  jumps?: { count: number; ringR: number; railTop: number };
  signAngle?: number; // radians; where the sign sits on the fence ring
  brainHeight?: number; // extra lift for the lattice above torso
  /** Milestone-earned accessories: a JSON of {key:{ok:boolean}} is polled and
   *  each earned key's accessory is built onto every creature's torso. */
  milestones?: {
    url: string; // e.g. /models/horse_milestones.json
    accessories: { key: string; label: string; build: (torso: THREE.Mesh) => void }[];
  };
};

type PenCreature = {
  rag: CreatureRagdoll;
  parts: THREE.Mesh[];
  brain: Brain;
  anchor: { x: number; z: number };
  wanderYaw: number;
  wanderTimer: number;
  speedNonDim: number;
  gx: number;
  gz: number;
  gateCd: number;
  downTimer: number;
  worn: Set<string>; // milestone accessory keys already built onto this body
};

function partMesh(geo: THREE.BufferGeometry, color: number, rough: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: 0.03,
    emissive: new THREE.Color(color).multiplyScalar(0.28),
    emissiveIntensity: 0.014 * LIGHT_SCALE
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

type PenPolicyFile = PolicyDef & { meta?: { gen: number; robust: number; at: number } };

export class CreaturePen {
  readonly root = new THREE.Group();
  readonly cfg: PenConfig;
  #physics: Physics;
  #groundY: number;
  #awake = false;
  #creatures: PenCreature[] = [];
  #gates: { x: number; z: number }[] = [];
  #policy: PenPolicyFile | null = null;
  #gen = 0;
  #robust = 0;
  #scale: number;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #fetching = false;
  #signCanvas: HTMLCanvasElement;
  #signCtx: CanvasRenderingContext2D;
  #signTex: THREE.CanvasTexture;
  #earned = new Set<string>();
  #camPos = new THREE.Vector3();
  #nodeColor = new THREE.Color();
  #haloColor = new THREE.Color();

  constructor(cfg: PenConfig, groundY: number, physics: Physics) {
    this.cfg = cfg;
    this.#physics = physics;
    this.#groundY = groundY;
    this.#scale = cfg.scaleForGen(0);
    this.#signCanvas = document.createElement("canvas");
    this.#signCanvas.width = 512;
    this.#signCanvas.height = 288;
    this.#signCtx = this.#signCanvas.getContext("2d")!;
    this.#signTex = new THREE.CanvasTexture(this.#signCanvas);
    this.#signTex.colorSpace = THREE.SRGBColorSpace;
    this.#buildPen();
    if (cfg.jumps) this.#buildGates(cfg.jumps);
    void this.#loadPolicy(true);
  }

  get gen(): number {
    return this.#gen;
  }

  setAwake(on: boolean): void {
    if (this.#awake === on) return;
    this.#awake = on;
    if (on) {
      void this.#loadPolicy(false);
      void this.#loadMilestones();
      this.#pollTimer = setInterval(() => {
        void this.#loadPolicy(false);
        void this.#loadMilestones();
      }, POLL_MS);
    } else if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  debugState(): { id: string; gen: number; robust: number; scale: number; creatures: { upY: number; tall: number; speed: number; down: number; wx: number; wy: number; wz: number }[] } {
    return {
      id: this.cfg.id,
      gen: this.#gen,
      robust: this.#robust,
      scale: this.#scale,
      creatures: this.#creatures.map((c) => {
        const t = c.rag.torsoLink;
        const q = t.quat;
        return {
          upY: 1 - 2 * (q[0] * q[0] + q[2] * q[2]),
          tall: t.pos[1] / c.rag.standY,
          speed: Math.hypot(t.vel[0], t.vel[2]),
          down: c.downTimer,
          wx: c.anchor.x + t.pos[0],
          wy: this.#groundY + 0.06 + t.pos[1],
          wz: c.anchor.z + t.pos[2]
        };
      })
    };
  }

  // ------------------------------------------------------------- build
  #buildPen(): void {
    const { center, radius } = this.cfg;
    const y = this.#groundY;
    const lawn = new THREE.Mesh(
      new THREE.CircleGeometry(radius + 1.8, 48),
      new THREE.MeshStandardMaterial({ color: 0x86b24c, roughness: 0.9, emissive: 0x1d3812, emissiveIntensity: 0.035 * LIGHT_SCALE })
    );
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(center.x, y + 0.04, center.z);
    lawn.receiveShadow = true;
    this.root.add(lawn);

    const posts = Math.max(16, Math.round(radius * 2.4));
    const postGeo = new THREE.BoxGeometry(0.11, 1.05, 0.08);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.6, emissive: 0x30302a, emissiveIntensity: 0.045 * LIGHT_SCALE });
    const im = new THREE.InstancedMesh(postGeo, postMat, posts);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * Math.PI * 2;
      p.set(center.x + Math.sin(a) * radius, y + 0.52, center.z + Math.cos(a) * radius);
      q.setFromAxisAngle(up, a);
      m.compose(p, q, s);
      im.setMatrixAt(i, m);
    }
    im.castShadow = true;
    this.root.add(im);
    for (const railY of [0.38, 0.78]) {
      const rail = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.04, 6, Math.max(48, radius * 5)), postMat);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(center.x, y + railY, center.z);
      this.root.add(rail);
    }

    const sa = this.cfg.signAngle ?? Math.PI * 0.78;
    const sx = center.x + Math.sin(sa) * (radius + 1.0);
    const sz = center.z + Math.cos(sa) * (radius + 1.0);
    const signPost = partMesh(new THREE.BoxGeometry(0.1, 1.5, 0.1), 0x7a5a38, 0.8);
    signPost.position.set(sx, y + 0.75, sz);
    this.root.add(signPost);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.95, 0.06),
      new THREE.MeshStandardMaterial({
        map: this.#signTex,
        emissive: 0xffffff,
        emissiveMap: this.#signTex,
        emissiveIntensity: 0.4,
        roughness: 0.7
      })
    );
    board.position.set(sx, y + 1.66, sz);
    board.rotation.y = sa;
    this.root.add(board);
    this.#drawSign();
  }

  /** Show-jump gates in a ring inside the pen: two standards + striped rails,
   *  plus a loose static collider so the PLAYER has to hop them too (the
   *  creatures live in private sims and jump the visual in world space). */
  #buildGates(j: NonNullable<PenConfig["jumps"]>): void {
    const { center } = this.cfg;
    const y = this.#groundY;
    for (let i = 0; i < j.count; i++) {
      const th = (i / j.count) * Math.PI * 2 + 0.4;
      const gx = center.x + Math.sin(th) * j.ringR;
      const gz = center.z + Math.cos(th) * j.ringR;
      const yaw = th + Math.PI / 2;
      const railTop = j.railTop + (i % 3) * 0.12;
      const ax = Math.cos(yaw);
      const az = Math.sin(yaw);
      const halfW = 1.3;
      const postH = railTop + 0.4;
      const postMat = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.62, emissive: 0x30302a, emissiveIntensity: 0.045 * LIGHT_SCALE });
      const postGeo = new THREE.BoxGeometry(0.16, postH, 0.16);
      for (const sgn of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(gx + ax * halfW * sgn, y + postH / 2, gz + az * halfW * sgn);
        post.castShadow = true;
        this.root.add(post);
      }
      const railGeo = new THREE.BoxGeometry(halfW * 2 + 0.18, 0.12, 0.12);
      const rails = [
        { h: railTop, c: 0xf4f1e8 },
        { h: railTop - 0.28, c: 0xc0392b },
        { h: railTop - 0.56, c: 0xf4f1e8 }
      ];
      for (const r of rails) {
        if (r.h < 0.16) continue;
        const rail = new THREE.Mesh(railGeo, new THREE.MeshStandardMaterial({ color: r.c, roughness: 0.55, emissive: new THREE.Color(r.c).multiplyScalar(0.14), emissiveIntensity: 0.05 * LIGHT_SCALE }));
        rail.position.set(gx, y + r.h, gz);
        rail.rotation.y = -yaw;
        rail.castShadow = true;
        this.root.add(rail);
      }
      this.#physics.world.createBox({
        type: BodyType.Static,
        position: [gx, y + railTop * 0.5, gz],
        halfExtents: [Math.abs(ax) * halfW + 0.2, railTop * 0.5 + 0.1, Math.abs(az) * halfW + 0.2],
        friction: 0.6
      });
      this.#gates.push({ x: gx, z: gz });
    }
  }

  #gateAhead(wx: number, wz: number, hx: number, hz: number): { x: number; z: number; d: number } | null {
    let best: { x: number; z: number; d: number } | null = null;
    let bd = GATE_APPROACH_R;
    for (const g of this.#gates) {
      const dx = g.x - wx;
      const dz = g.z - wz;
      const d = Math.hypot(dx, dz);
      if (d > GATE_APPROACH_R || d < 0.4) continue;
      if ((dx / d) * hx + (dz / d) * hz < 0.25) continue;
      if (d < bd) {
        bd = d;
        best = { x: g.x, z: g.z, d };
      }
    }
    return best;
  }

  #drawSign(): void {
    const ctx = this.#signCtx;
    const w = this.#signCanvas.width;
    const h = this.#signCanvas.height;
    ctx.fillStyle = "#2c2016";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#e8ddc4";
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = "#ffe9b8";
    ctx.font = "bold 58px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText(this.cfg.title, w / 2, 88);
    ctx.font = "34px Georgia, serif";
    ctx.fillStyle = "#d9ecff";
    ctx.fillText(this.cfg.statusForGen(this.#gen), w / 2, 158);
    ctx.font = "30px Georgia, serif";
    ctx.fillStyle = "#a8c8a0";
    const fit = this.#robust > 0 ? `   ·   fitness ${Math.round(this.#robust)}` : "";
    ctx.fillText(`generation ${this.#gen}${fit}`, w / 2, 216);
    const ms = this.cfg.milestones;
    if (ms) {
      ctx.font = "26px Georgia, serif";
      ctx.fillStyle = "#f2cd6e";
      const badges = ms.accessories.map((a) => `${this.#earned.has(a.key) ? "★" : "☆"} ${a.label}`).join("   ");
      ctx.fillText(badges, w / 2, 262);
    }
    this.#signTex.needsUpdate = true;
  }

  // ------------------------------------------------------------- creatures
  #newbornDef(): PenPolicyFile {
    let seed = 424242 + this.cfg.id.length * 7919;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const sizes = [obsDim(this.cfg.spec), 32, 32, actDim(this.cfg.spec)];
    return Policy.random(sizes, rng, this.cfg.id).toDef();
  }

  async #loadPolicy(allowNewborn: boolean): Promise<void> {
    if (this.#fetching) return;
    this.#fetching = true;
    try {
      const res = await fetch(`${this.cfg.policyUrl}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const def = (await res.json()) as PenPolicyFile;
      const gen = def.meta?.gen ?? 0;
      if (this.#policy && gen === this.#gen) return;
      this.#policy = def;
      this.#gen = gen;
      this.#robust = def.meta?.robust ?? 0;
      this.#applyPolicy(def);
    } catch {
      if (allowNewborn && !this.#policy) {
        this.#policy = this.#newbornDef();
        this.#applyPolicy(this.#policy);
      }
    } finally {
      this.#fetching = false;
    }
  }

  /** Poll the milestone file and dress every creature with newly-earned gear. */
  async #loadMilestones(): Promise<void> {
    const ms = this.cfg.milestones;
    if (!ms) return;
    try {
      const res = await fetch(`${ms.url}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, { ok?: boolean }>;
      let changed = false;
      for (const acc of ms.accessories) {
        if (data[acc.key]?.ok && !this.#earned.has(acc.key)) {
          this.#earned.add(acc.key);
          changed = true;
        }
      }
      if (changed) {
        this.#applyAccessories();
        this.#drawSign();
      }
    } catch {
      /* milestone file not written yet */
    }
  }

  #applyAccessories(): void {
    const ms = this.cfg.milestones;
    if (!ms) return;
    for (const c of this.#creatures) {
      for (const acc of ms.accessories) {
        if (!this.#earned.has(acc.key) || c.worn.has(acc.key)) continue;
        acc.build(c.parts[0]); // attaches to the torso; children inherit its scale
        c.worn.add(acc.key);
      }
    }
  }

  #applyPolicy(def: PenPolicyFile): void {
    const wanted = this.cfg.scaleForGen(this.#gen);
    if (this.#creatures.length === 0 || Math.abs(wanted - this.#scale) > 0.04) {
      this.#scale = wanted;
      this.#rebuildCreatures(def);
    } else {
      for (const c of this.#creatures) c.rag.setPolicy(def);
    }
    this.#drawSign();
  }

  #rebuildCreatures(def: PenPolicyFile): void {
    const first = this.#creatures.length === 0;
    if (first) {
      for (let i = 0; i < this.cfg.count; i++) {
        const a = (i / this.cfg.count) * Math.PI * 2 + 0.7;
        const r = Math.min(this.cfg.radius - 3, 2.5 + i * 2.2);
        const anchor = { x: this.cfg.center.x + Math.sin(a) * r, z: this.cfg.center.z + Math.cos(a) * r };
        const rag = new CreatureRagdoll(this.#physics.box3d, this.cfg.spec, def, this.#scale);
        const yaw = Math.random() * Math.PI * 2;
        rag.setGoal(Math.sin(yaw), Math.cos(yaw));
        const parts = this.cfg.dress(this.cfg.spec);
        for (const part of parts) this.root.add(part);
        const brain = buildBrain(rag.layers().map((l) => l.length), 0.55);
        this.root.add(brain.group);
        this.#creatures.push({ rag, parts, brain, anchor, wanderYaw: yaw, wanderTimer: 2 + Math.random() * 3, speedNonDim: this.cfg.roamSpeed(), gx: Math.sin(yaw), gz: Math.cos(yaw), gateCd: 0, downTimer: 0, worn: new Set() });
      }
      this.#applyAccessories();
    } else {
      for (const c of this.#creatures) {
        c.rag.dispose();
        c.rag = new CreatureRagdoll(this.#physics.box3d, this.cfg.spec, def, this.#scale);
        c.rag.setGoal(c.gx, c.gz);
        c.downTimer = 0;
      }
    }
    for (const c of this.#creatures) for (const part of c.parts) part.scale.setScalar(this.#scale);
  }

  #poseMesh(mesh: THREE.Mesh, link: Link, ax: number, oy: number, az: number): void {
    mesh.position.set(ax + link.pos[0], oy + link.pos[1], az + link.pos[2]);
    mesh.quaternion.set(link.quat[0], link.quat[1], link.quat[2], link.quat[3]);
  }

  // ------------------------------------------------------------- per frame
  update(dt: number, camera: THREE.Camera): void {
    if (!this.#awake || this.#creatures.length === 0) return;
    camera.getWorldPosition(this.#camPos);
    const oy = this.#groundY + 0.06;
    for (const c of this.#creatures) {
      const rag = c.rag;
      if (c.downTimer > 0) {
        c.downTimer -= dt;
        rag.update(dt);
        if (c.downTimer <= 0) {
          rag.setDowned(false);
          rag.reset();
        }
      } else if (rag.fallen) {
        c.downTimer = DOWN_SECONDS;
        rag.setDowned(true);
      } else {
        c.wanderTimer -= dt;
        const t = rag.torsoLink;
        const wx = c.anchor.x + t.pos[0];
        const wz = c.anchor.z + t.pos[2];
        const toCx = this.cfg.center.x - wx;
        const toCz = this.cfg.center.z - wz;
        const roam = this.cfg.radius - 2.2;
        let tx: number;
        let tz: number;
        let spd = c.speedNonDim;
        if (Math.hypot(toCx, toCz) > roam) {
          c.wanderYaw = Math.atan2(toCx, toCz);
          c.wanderTimer = 2 + Math.random() * 2;
        } else if (c.wanderTimer <= 0) {
          c.wanderYaw += (Math.random() - 0.5) * 1.5;
          c.wanderTimer = 3 + Math.random() * 4;
          c.speedNonDim = this.cfg.roamSpeed();
        }
        tx = Math.sin(c.wanderYaw);
        tz = Math.cos(c.wanderYaw);
        // show-jumping: run at a gate that's close and ahead, hop the rail
        if (this.#gates.length > 0) {
          if (c.gateCd > 0) c.gateCd -= dt;
          const ga = this.#gateAhead(wx, wz, tx, tz);
          if (ga && c.gateCd <= 0) {
            tx = (ga.x - wx) / ga.d;
            tz = (ga.z - wz) / ga.d;
            spd = JUMP_COMMIT_SPEED;
            if (ga.d < 2.2 * this.#scale + 1.6 && rag.grounded) {
              rag.jump();
              c.gateCd = 4;
            }
          }
        }
        const k = 1 - Math.exp(-dt / GOAL_EASE);
        c.gx += (tx - c.gx) * k;
        c.gz += (tz - c.gz) * k;
        rag.setGoal(c.gx, c.gz);
        rag.setSpeed(spd);
        rag.update(dt);
      }

      this.#poseMesh(c.parts[0], rag.torsoLink, c.anchor.x, oy, c.anchor.z);
      const legs = rag.legLinks;
      for (let i = 0; i < legs.length; i++) {
        this.#poseMesh(c.parts[1 + i * 2], legs[i].thigh, c.anchor.x, oy, c.anchor.z);
        this.#poseMesh(c.parts[2 + i * 2], legs[i].shank, c.anchor.x, oy, c.anchor.z);
      }
      this.#updateBrain(c, oy);
    }
  }

  #updateBrain(c: PenCreature, oy: number): void {
    const b = c.brain;
    const layers = c.rag.layers();
    for (let v = 0; v < b.lineLayer.length; v++) {
      writeActivationColor(b.lineColors, v * 3, layers[b.lineLayer[v]][b.lineNode[v]], b.lineLayer[v], BRAIN_LINE_GLOW);
    }
    for (let v = 0; v < b.pointLayer.length; v++) {
      const layer = b.pointLayer[v];
      setActivationColor(this.#nodeColor, layers[layer][b.pointNode[v]], layer, BRAIN_NODE_GLOW);
      b.nodes.setColorAt(v, this.#nodeColor);
      this.#haloColor.copy(this.#nodeColor).multiplyScalar(0.68);
      b.halos.setColorAt(v, this.#haloColor);
    }
    b.lineAttr.needsUpdate = true;
    if (b.nodes.instanceColor) b.nodes.instanceColor.needsUpdate = true;
    if (b.halos.instanceColor) b.halos.instanceColor.needsUpdate = true;
    const t = c.rag.torsoLink;
    const wx = c.anchor.x + t.pos[0];
    const wy = oy + t.pos[1];
    const wz = c.anchor.z + t.pos[2];
    const yaw = Math.atan2(this.#camPos.x - wx, this.#camPos.z - wz);
    b.group.position.set(wx, wy + (this.cfg.brainHeight ?? 0.55) * this.#scale + 0.38, wz);
    b.group.rotation.set(-0.18, yaw + 0.22, 0);
  }
}

export { partMesh };
