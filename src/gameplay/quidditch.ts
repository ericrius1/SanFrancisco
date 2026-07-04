import * as THREE from "three/webgpu";
import type { WorldMap } from "../world/heightmap";
import { buildBroomMesh, broomRiderGeometry } from "../vehicles/broom/mesh";

/**
 * Quidditch pitch in Golden Gate Park. Two teams of three fly on broomsticks
 * when a player is nearby; otherwise the pitch sits idle. Walk into the
 * glowing join circle and press E to take over a flyer (drone controls);
 * E again to dismount and hand back to the AI.
 */

export const QUIDDITCH_PITCH = { x: -3431, z: 2322, name: "Quidditch Pitch" };

const ACTIVATE_RADIUS = 380;
const JOIN_ZONE_RADIUS = 9;
const PITCH_LENGTH = 110;
const PITCH_WIDTH = 62;
const HOOP_HEIGHT = 16;
const HOOP_MAJOR = 2.55;
const HOOP_TUBE = 0.16;
const HOOP_SCORE_RADIUS = HOOP_MAJOR - HOOP_TUBE * 1.15;
const THROW_SPEED = 44;
const MAX_THROWS = 8;
const THROW_LIFE = 9;
const PLAYERS_PER_TEAM = 3;
const TEAM_COLORS = { red: 0x9b1c1c, blue: 0x1e4a8c } as const;
const ROLES = ["Keeper", "Chaser", "Seeker"] as const;

export type QuidditchTeam = keyof typeof TEAM_COLORS;
export type QuidditchRole = (typeof ROLES)[number];

type Flyer = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  role: QuidditchRole;
  homeX: number;
  homeZ: number;
};

type TeamState = {
  flyers: Flyer[];
  mesh: THREE.InstancedMesh;
  robe: THREE.Color;
};

type Hoop = {
  side: -1 | 1;
  wx: number;
  wy: number;
  wz: number;
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  glow: number;
};

type ThrownQuaffle = {
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  mesh: THREE.Mesh;
};

export class Quidditch {
  onMessage: (msg: string, secs?: number) => void = () => {};

  #root: THREE.Group;
  #groundY = 0;
  #active = false;
  #teams: Record<QuidditchTeam, TeamState>;
  #quaffle = { x: 0, y: 12, z: 0, vx: 0, vy: 0, vz: 0 };
  #snitch = { x: 0, y: 18, z: 0, vx: 0, vy: 0, vz: 0, phase: 0 };
  #quaffleMesh: THREE.Mesh;
  #snitchMesh: THREE.Mesh;
  #joinGlow: THREE.Mesh;
  #joinRing: THREE.Mesh;
  #joinMat: THREE.MeshBasicMaterial;
  #joinRingMat: THREE.MeshBasicMaterial;
  #playerInJoinZone = false;
  #mat4 = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #euler = new THREE.Euler();
  #scale = new THREE.Vector3(1, 1, 1);
  #riddenMeshes = new Map<QuidditchTeam, THREE.Group>();
  #hoops: Hoop[] = [];
  #throws: ThrownQuaffle[] = [];
  #throwPool: THREE.Mesh[] = [];
  #throwGeo = new THREE.SphereGeometry(0.38, 14, 12);
  #throwMat = new THREE.MeshStandardMaterial({ color: 0xc83828, roughness: 0.42, metalness: 0.12 });

  constructor(map: WorldMap, scene: THREE.Scene) {
    this.#groundY = map.effectiveGround(QUIDDITCH_PITCH.x, QUIDDITCH_PITCH.z);
    this.#root = new THREE.Group();
    this.#root.position.set(QUIDDITCH_PITCH.x, this.#groundY, QUIDDITCH_PITCH.z);
    scene.add(this.#root);
    this.#buildPitch();

    const geo = broomRiderGeometry();
    this.#teams = {
      red: {
        flyers: this.#spawnTeam("red"),
        mesh: new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }), PLAYERS_PER_TEAM),
        robe: new THREE.Color(TEAM_COLORS.red)
      },
      blue: {
        flyers: this.#spawnTeam("blue"),
        mesh: new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }), PLAYERS_PER_TEAM),
        robe: new THREE.Color(TEAM_COLORS.blue)
      }
    };
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      const t = this.#teams[team];
      t.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      t.mesh.frustumCulled = false;
      t.mesh.castShadow = true;
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) t.mesh.setColorAt(i, t.robe);
      if (t.mesh.instanceColor) t.mesh.instanceColor.needsUpdate = true;
      this.#root.add(t.mesh);
    }

    this.#quaffleMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0xc83828, roughness: 0.45, metalness: 0.1 })
    );
    this.#root.add(this.#quaffleMesh);

    this.#snitchMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0xffb300, emissiveIntensity: 0.55, roughness: 0.2 })
    );
    this.#root.add(this.#snitchMesh);
    this.#resetBall();

    this.#joinMat = new THREE.MeshBasicMaterial({
      color: 0x6ef0c8,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.#joinGlow = new THREE.Mesh(new THREE.CircleGeometry(JOIN_ZONE_RADIUS, 48), this.#joinMat);
    this.#joinGlow.rotation.x = -Math.PI / 2;
    this.#joinGlow.position.y = 0.14;
    this.#root.add(this.#joinGlow);

    this.#joinRingMat = new THREE.MeshBasicMaterial({
      color: 0xfff6b8,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.#joinRing = new THREE.Mesh(new THREE.RingGeometry(JOIN_ZONE_RADIUS - 0.55, JOIN_ZONE_RADIUS, 48), this.#joinRingMat);
    this.#joinRing.rotation.x = -Math.PI / 2;
    this.#joinRing.position.y = 0.16;
    this.#root.add(this.#joinRing);
  }

  get inJoinZone() {
    return this.#playerInJoinZone;
  }

  /** Label for the HUD prompt while standing in the join circle. */
  joinLabel(): string | null {
    if (!this.#playerInJoinZone) return null;
    const slot = this.#findJoinSlot();
    if (!slot) return null;
    const side = slot.team === "red" ? "Scarlet" : "Azure";
    return `${side} ${slot.role}`;
  }

  get active() {
    return this.#active;
  }

  /** On the pitch while a match is running — click to throw the quaffle. */
  canThrow(pos: THREE.Vector3): boolean {
    if (!this.#active) return false;
    const dx = pos.x - QUIDDITCH_PITCH.x;
    const dz = pos.z - QUIDDITCH_PITCH.z;
    return Math.abs(dx) < PITCH_LENGTH * 0.52 && Math.abs(dz) < PITCH_WIDTH * 0.52;
  }

  throwQuaffle(origin: THREE.Vector3, dir: THREE.Vector3, inherit: THREE.Vector3): boolean {
    if (!this.canThrow(origin) || this.#throws.length >= MAX_THROWS) return false;
    let mesh = this.#throwPool.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.#throwGeo, this.#throwMat);
      this.#root.add(mesh);
    }
    mesh.visible = true;
    const d = dir.clone();
    if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
    d.normalize().multiplyScalar(THROW_SPEED);
    d.x += inherit.x * 0.65;
    d.y += inherit.y * 0.65;
    d.z += inherit.z * 0.65;
    const x = origin.x;
    const y = origin.y;
    const z = origin.z;
    this.#throws.push({
      x,
      y,
      z,
      px: x,
      py: y,
      pz: z,
      vx: d.x,
      vy: d.y,
      vz: d.z,
      life: THROW_LIFE,
      mesh
    });
    return true;
  }

  /** Player's broom mesh tinted to their team. */
  buildRiddenMesh(team: QuidditchTeam): THREE.Group {
    let mesh = this.#riddenMeshes.get(team);
    if (!mesh) {
      mesh = buildBroomMesh(team === "red" ? 0x6b2f1a : 0x2a3f6e);
      this.#riddenMeshes.set(team, mesh);
    }
    return mesh;
  }

  inJoinZoneAt(pos: THREE.Vector3): boolean {
    const dx = pos.x - QUIDDITCH_PITCH.x;
    const dz = pos.z - QUIDDITCH_PITCH.z;
    if (Math.hypot(dx, dz) > JOIN_ZONE_RADIUS) return false;
    return pos.y < this.#groundY + 8;
  }

  /** Walk into the join circle and press E — takes over an AI flyer. */
  tryJoin(pos: THREE.Vector3): {
    team: QuidditchTeam;
    role: QuidditchRole;
    label: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    vx: number;
    vy: number;
    vz: number;
  } | null {
    if (!this.inJoinZoneAt(pos)) return null;
    if (!this.#active) {
      this.#active = true;
      this.#resetBall();
    }
    const slot = this.#findJoinSlot();
    if (!slot) return null;
    const info = this.consume({ team: slot.team, index: slot.index });
    const side = slot.team === "red" ? "Scarlet" : "Azure";
    return { ...info, label: `${side} ${info.role}` };
  }

  #findJoinSlot(): { team: QuidditchTeam; index: number; role: QuidditchRole } | null {
    const order: { team: QuidditchTeam; role: QuidditchRole }[] = [
      { team: "red", role: "Chaser" },
      { team: "blue", role: "Chaser" },
      { team: "red", role: "Keeper" },
      { team: "blue", role: "Keeper" },
      { team: "red", role: "Seeker" },
      { team: "blue", role: "Seeker" }
    ];
    for (const want of order) {
      const flyers = this.#teams[want.team].flyers;
      const index = flyers.findIndex((f) => f.role === want.role);
      if (index >= 0) return { team: want.team, index, role: want.role };
    }
    return null;
  }

  consume(pick: { team: QuidditchTeam; index: number }) {
    const team = this.#teams[pick.team];
    const f = team.flyers.splice(pick.index, 1)[0];
    team.mesh.count = team.flyers.length;
    return {
      team: pick.team,
      role: f.role,
      x: f.x,
      y: f.y,
      z: f.z,
      heading: f.yaw + Math.PI,
      vx: f.vx,
      vy: f.vy,
      vz: f.vz
    };
  }

  dropFlyer(
    team: QuidditchTeam,
    role: QuidditchRole,
    x: number,
    y: number,
    z: number,
    heading: number,
    motion: { vx?: number; vy?: number; vz?: number } = {}
  ) {
    const state = this.#teams[team];
    if (state.flyers.length >= PLAYERS_PER_TEAM) return;
    const yaw = heading - Math.PI;
    const home = this.#homeFor(team, role);
    state.flyers.push({
      x,
      y,
      z,
      vx: motion.vx ?? 0,
      vy: motion.vy ?? 0,
      vz: motion.vz ?? 0,
      yaw,
      pitch: 0,
      role,
      homeX: home.x,
      homeZ: home.z
    });
    state.mesh.count = state.flyers.length;
  }

  update(dt: number, playerPos: THREE.Vector3, elapsed: number) {
    const dist = Math.hypot(playerPos.x - QUIDDITCH_PITCH.x, playerPos.z - QUIDDITCH_PITCH.z);
    const wantActive = dist < ACTIVATE_RADIUS;
    if (wantActive && !this.#active) {
      this.#active = true;
      this.#resetBall();
      this.onMessage("Quidditch match on — step into the glowing circle", 3.2);
    } else if (!wantActive && this.#active) {
      this.#active = false;
      this.#parkFlyers();
    }

    this.#root.visible = dist < ACTIVATE_RADIUS * 1.4;
    this.#playerInJoinZone = this.inJoinZoneAt(playerPos);
    const pulse = 0.36 + Math.sin(elapsed * 3.1) * 0.14;
    const hot = this.#playerInJoinZone && this.#active;
    this.#joinMat.opacity = hot ? pulse + 0.22 : pulse;
    this.#joinRingMat.opacity = hot ? 0.95 : 0.55 + Math.sin(elapsed * 2.4) * 0.15;
    const glowScale = 1 + Math.sin(elapsed * 2.2) * 0.035 + (hot ? 0.06 : 0);
    this.#joinGlow.scale.setScalar(glowScale);
    this.#joinRing.scale.setScalar(glowScale);

    if (!this.#active) {
      this.#quaffleMesh.visible = false;
      this.#snitchMesh.visible = false;
      for (const team of ["red", "blue"] as QuidditchTeam[]) {
        this.#teams[team].mesh.visible = false;
      }
      for (const t of this.#throws) t.mesh.visible = false;
      return;
    }

    this.#quaffleMesh.visible = true;
    this.#snitchMesh.visible = true;
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      this.#teams[team].mesh.visible = true;
      this.#simulateTeam(team, dt, elapsed);
    }
    this.#simulateBall(dt, elapsed);
    this.#simulateThrows(dt);
    this.#updateHoops(dt);
    this.#drawFlyers();
    this.#quaffleMesh.position.set(this.#quaffle.x - QUIDDITCH_PITCH.x, this.#quaffle.y - this.#groundY, this.#quaffle.z - QUIDDITCH_PITCH.z);
    this.#snitchMesh.position.set(this.#snitch.x - QUIDDITCH_PITCH.x, this.#snitch.y - this.#groundY, this.#snitch.z - QUIDDITCH_PITCH.z);
  }

  #buildPitch() {
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2f6e8, transparent: true, opacity: 0.55 });
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8f94, metalness: 0.4, roughness: 0.5 });

    const turf = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_LENGTH, PITCH_WIDTH),
      new THREE.MeshStandardMaterial({ color: 0x4a8f42, roughness: 0.92 })
    );
    turf.rotation.x = -Math.PI / 2;
    turf.position.y = 0.08;
    turf.receiveShadow = true;
    this.#root.add(turf);

    const center = new THREE.Mesh(new THREE.RingGeometry(4, 4.35, 32), lineMat);
    center.rotation.x = -Math.PI / 2;
    center.position.y = 0.12;
    this.#root.add(center);

    const hoopX = PITCH_LENGTH / 2 - 6;
    for (const side of [-1, 1] as const) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.35, PITCH_WIDTH), lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(side * (PITCH_LENGTH / 2 - 2), 0.11, 0);
      this.#root.add(line);

      for (let h = 0; h < 3; h++) {
        const z = (h - 1) * 18;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, HOOP_HEIGHT, 8), poleMat);
        pole.position.set(side * hoopX, HOOP_HEIGHT / 2, z);
        pole.castShadow = true;
        this.#root.add(pole);

        const mat = new THREE.MeshStandardMaterial({
          color: 0xffd54a,
          metalness: 0.55,
          roughness: 0.32,
          emissive: 0x332200,
          emissiveIntensity: 0.08
        });
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(HOOP_MAJOR, HOOP_TUBE, 12, 32), mat);
        hoop.rotation.y = Math.PI / 2;
        hoop.position.set(side * hoopX, HOOP_HEIGHT, z);
        hoop.castShadow = true;
        this.#root.add(hoop);

        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(HOOP_MAJOR + 0.35, 0.09, 8, 32),
          new THREE.MeshBasicMaterial({
            color: 0xfff0a0,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
          })
        );
        halo.rotation.y = Math.PI / 2;
        halo.position.copy(hoop.position);
        this.#root.add(halo);

        this.#hoops.push({
          side,
          wx: QUIDDITCH_PITCH.x + side * hoopX,
          wy: this.#groundY + HOOP_HEIGHT,
          wz: QUIDDITCH_PITCH.z + z,
          mesh: hoop,
          halo,
          mat,
          glow: 0
        });
      }
    }

    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(8, 2.2, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x2a3a2e, roughness: 0.85 })
    );
    sign.position.set(0, 1.4, -(PITCH_WIDTH / 2 + 4));
    this.#root.add(sign);
  }

  #spawnTeam(team: QuidditchTeam): Flyer[] {
    const out: Flyer[] = [];
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
      const role = ROLES[i];
      const home = this.#homeFor(team, role);
      out.push({
        x: home.x,
        y: home.y,
        z: home.z,
        vx: 0,
        vy: 0,
        vz: 0,
        yaw: team === "red" ? 0 : Math.PI,
        pitch: 0,
        role,
        homeX: home.x,
        homeZ: home.z
      });
    }
    return out;
  }

  #homeFor(team: QuidditchTeam, role: QuidditchRole) {
    const side = team === "red" ? -1 : 1;
    const baseX = QUIDDITCH_PITCH.x + side * (PITCH_LENGTH * 0.22);
    const alt = role === "Keeper" ? 16 : role === "Seeker" ? 22 : 14;
    const zOff = role === "Keeper" ? 0 : role === "Chaser" ? 12 : -14;
    return {
      x: baseX,
      y: this.#groundY + alt,
      z: QUIDDITCH_PITCH.z + zOff
    };
  }

  #parkFlyers() {
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      const state = this.#teams[team];
      state.flyers = this.#spawnTeam(team);
      state.mesh.count = state.flyers.length;
    }
    this.#clearThrows();
    this.#resetBall();
    for (const hoop of this.#hoops) hoop.glow = 0;
  }

  #clearThrows() {
    for (const t of this.#throws) {
      t.mesh.visible = false;
      this.#throwPool.push(t.mesh);
    }
    this.#throws.length = 0;
  }

  #resetBall() {
    this.#quaffle.x = QUIDDITCH_PITCH.x;
    this.#quaffle.y = this.#groundY + 12;
    this.#quaffle.z = QUIDDITCH_PITCH.z;
    this.#quaffle.vx = 0;
    this.#quaffle.vy = 0;
    this.#quaffle.vz = 0;
    this.#snitch.x = QUIDDITCH_PITCH.x + 8;
    this.#snitch.y = this.#groundY + 20;
    this.#snitch.z = QUIDDITCH_PITCH.z - 6;
    this.#snitch.vx = 0;
    this.#snitch.vy = 0;
    this.#snitch.vz = 0;
    this.#snitch.phase = Math.random() * Math.PI * 2;
  }

  #simulateTeam(team: QuidditchTeam, dt: number, elapsed: number) {
    const state = this.#teams[team];
    const attack = team === "red" ? 1 : -1;
    for (const f of state.flyers) {
      let tx = this.#quaffle.x;
      let ty = this.#quaffle.y;
      let tz = this.#quaffle.z;
      if (f.role === "Keeper") {
        tx = QUIDDITCH_PITCH.x - attack * (PITCH_LENGTH * 0.38);
        ty = this.#groundY + HOOP_HEIGHT - 1;
        tz = QUIDDITCH_PITCH.z + Math.sin(elapsed * 0.7 + f.homeZ) * 4;
      } else if (f.role === "Seeker") {
        tx = this.#snitch.x;
        ty = this.#snitch.y;
        tz = this.#snitch.z;
      } else {
        tx += attack * 6;
      }

      const dx = tx - f.x;
      const dy = ty - f.y;
      const dz = tz - f.z;
      const dist = Math.hypot(dx, dy, dz) || 1;
      const speed = f.role === "Seeker" ? 26 : f.role === "Chaser" ? 20 : 14;
      const ax = (dx / dist) * speed;
      const ay = (dy / dist) * speed;
      const az = (dz / dist) * speed;
      f.vx += (ax - f.vx) * Math.min(1, dt * 2.2);
      f.vy += (ay - f.vy) * Math.min(1, dt * 2.2);
      f.vz += (az - f.vz) * Math.min(1, dt * 2.2);
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;

      const minY = this.#groundY + 8;
      const maxY = this.#groundY + 38;
      if (f.y < minY) {
        f.y = minY;
        f.vy = Math.abs(f.vy) * 0.4;
      }
      if (f.y > maxY) {
        f.y = maxY;
        f.vy = -Math.abs(f.vy) * 0.4;
      }

      f.yaw = Math.atan2(-(tx - f.x), -(tz - f.z));
      f.pitch = THREE.MathUtils.clamp(Math.atan2(ty - f.y, Math.hypot(tx - f.x, tz - f.z)), -0.55, 0.55);

      const qd = Math.hypot(f.x - this.#quaffle.x, f.y - this.#quaffle.y, f.z - this.#quaffle.z);
      if (f.role !== "Seeker" && qd < 2.2) {
        this.#quaffle.vx += f.vx * 0.08;
        this.#quaffle.vy += f.vy * 0.08;
        this.#quaffle.vz += f.vz * 0.08;
      }
      const sd = Math.hypot(f.x - this.#snitch.x, f.y - this.#snitch.y, f.z - this.#snitch.z);
      if (f.role === "Seeker" && sd < 1.4) {
        this.#snitch.vx += (Math.random() - 0.5) * 18;
        this.#snitch.vy += 8 + Math.random() * 6;
        this.#snitch.vz += (Math.random() - 0.5) * 18;
        this.#snitch.phase = elapsed;
      }
    }
  }

  #simulateBall(dt: number, elapsed: number) {
    const q = this.#quaffle;
    q.vy -= 4.5 * dt;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.z += q.vz * dt;
    q.vx *= 1 - dt * 0.35;
    q.vz *= 1 - dt * 0.35;
    const floor = this.#groundY + 1.2;
    if (q.y < floor) {
      q.y = floor;
      q.vy = Math.abs(q.vy) * 0.55;
    }
    const bx = QUIDDITCH_PITCH.x;
    const bz = QUIDDITCH_PITCH.z;
    if (Math.abs(q.x - bx) > PITCH_LENGTH * 0.48) q.vx *= -0.72;
    if (Math.abs(q.z - bz) > PITCH_WIDTH * 0.48) q.vz *= -0.72;

    const s = this.#snitch;
    s.phase += dt * 2.4;
    const orbitR = 28 + Math.sin(elapsed * 0.9) * 8;
    const tx = bx + Math.cos(s.phase) * orbitR;
    const ty = this.#groundY + 18 + Math.sin(elapsed * 1.7) * 6;
    const tz = bz + Math.sin(s.phase * 1.3) * orbitR * 0.7;
    s.vx += (tx - s.x) * dt * 3.5;
    s.vy += (ty - s.y) * dt * 3.5;
    s.vz += (tz - s.z) * dt * 3.5;
    s.vx *= 1 - dt * 0.8;
    s.vy *= 1 - dt * 0.8;
    s.vz *= 1 - dt * 0.8;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;
  }

  #simulateThrows(dt: number) {
    const floor = this.#groundY + 0.8;
    let i = 0;
    while (i < this.#throws.length) {
      const b = this.#throws[i];
      b.px = b.x;
      b.py = b.y;
      b.pz = b.z;
      b.vy -= 9.2 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.vx *= 1 - dt * 0.08;
      b.vz *= 1 - dt * 0.08;
      b.life -= dt;

      this.#checkHoopScores(b);

      if (b.y < floor || b.life <= 0) {
        b.mesh.visible = false;
        this.#throwPool.push(b.mesh);
        this.#throws.splice(i, 1);
        continue;
      }

      b.mesh.position.set(b.x - QUIDDITCH_PITCH.x, b.y - this.#groundY, b.z - QUIDDITCH_PITCH.z);
      i++;
    }
  }

  #checkHoopScores(b: ThrownQuaffle) {
    for (const hoop of this.#hoops) {
      const ax = b.x - b.px;
      if (Math.abs(ax) < 1e-5) continue;
      const t = (hoop.wx - b.px) / ax;
      if (t < 0 || t > 1) continue;
      const y = b.py + t * (b.y - b.py);
      const z = b.pz + t * (b.z - b.pz);
      if (Math.hypot(y - hoop.wy, z - hoop.wz) > HOOP_SCORE_RADIUS) continue;
      hoop.glow = 2.8;
      this.onMessage("Through the hoop!", 2.2);
      b.life = Math.min(b.life, 0.05);
      return;
    }
  }

  #updateHoops(dt: number) {
    for (const hoop of this.#hoops) {
      if (hoop.glow > 0) hoop.glow -= dt;
      const lit = hoop.glow > 0;
      const k = lit ? Math.min(1, hoop.glow / 2.8) : 0;
      hoop.mat.emissive.setHex(0xffc400);
      hoop.mat.emissiveIntensity = 0.08 + k * 2.4;
      hoop.mat.color.setHex(lit ? 0xfff4a8 : 0xffd54a);
      const haloMat = hoop.halo.material as THREE.MeshBasicMaterial;
      haloMat.opacity = k * 0.92;
      hoop.halo.scale.setScalar(1 + k * 0.12);
    }
  }

  #drawFlyers() {
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      const state = this.#teams[team];
      for (let i = 0; i < state.flyers.length; i++) {
        const f = state.flyers[i];
        this.#euler.set(f.pitch, f.yaw, team === "red" ? 0.08 : -0.08, "YXZ");
        this.#quat.setFromEuler(this.#euler);
        this.#pos.set(f.x - QUIDDITCH_PITCH.x, f.y - this.#groundY, f.z - QUIDDITCH_PITCH.z);
        this.#mat4.compose(this.#pos, this.#quat, this.#scale);
        state.mesh.setMatrixAt(i, this.#mat4);
      }
      if (state.flyers.length) state.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
