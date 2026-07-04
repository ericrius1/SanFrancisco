import * as THREE from "three/webgpu";
import type { WorldMap } from "../world/heightmap";
import { buildBroomMesh, broomRiderGeometry } from "../vehicles/broom/mesh";

/**
 * Quidditch pitch in Golden Gate Park. Two full seven-a-side teams fly on
 * broomsticks whenever a player is nearby; otherwise the pitch sits idle.
 *
 * Rules, mirrored from the real game:
 *   • 3 Chasers per side pass the red Quaffle and hurl it through a hoop (10 pts)
 *   • 1 Keeper guards their three hoops
 *   • 2 Beaters swat the two black Bludgers to knock riders off course
 *   • 1 Seeker chases the Golden Snitch — catching it scores 150 and ENDS the
 *     match, so the leader-at-catch wins.
 *
 * The AI plays a real game on its own: chasers take possession and shoot,
 * keepers patrol, beaters redirect bludgers, seekers hunt the snitch. Walk into
 * the glowing circle and press E to take over any open role (drone controls);
 * E again to dismount and hand the broom back to the AI.
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
const THROW_SPEED = 46;
const MAX_THROWS = 10;
const THROW_LIFE = 9;
const SNITCH_POINTS = 150;
const GOAL_POINTS = 10;
const CATCH_RADIUS = 1.9;
// the snitch darts about untouchably for the opening minute of quaffle play,
// then tires and becomes catchable — keeps matches from ending at the whistle
const SNITCH_ARM_TIME = 28;

// A full side: 1 Keeper, 3 Chasers, 2 Beaters, 1 Seeker.
const ROSTER = ["Keeper", "Chaser", "Chaser", "Chaser", "Beater", "Beater", "Seeker"] as const;
const PLAYERS_PER_TEAM = ROSTER.length;
const TEAM_COLORS = { red: 0x9b1c1c, blue: 0x1e4a8c } as const;
const ROLES = ["Keeper", "Chaser", "Beater", "Seeker"] as const;

export type QuidditchTeam = keyof typeof TEAM_COLORS;
export type QuidditchRole = (typeof ROLES)[number];
export type MatchState = "idle" | "playing" | "ended";

export const ROLE_INFO: Record<QuidditchRole, { blurb: string; count: number }> = {
  Chaser: { blurb: "Sling the Quaffle through an enemy hoop — 10 points a goal.", count: 3 },
  Keeper: { blurb: "Guard your three hoops and swat shots away.", count: 1 },
  Beater: { blurb: "Bat the black Bludgers into rival riders. Click to swing.", count: 2 },
  Seeker: { blurb: "Chase the Golden Snitch — catch it for 150 and win.", count: 1 }
};

type Flyer = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  roll: number;
  role: QuidditchRole;
  slot: number; // index within the role, for spreading homes/behaviour
  homeX: number;
  homeZ: number;
  stun: number; // >0 = reeling from a bludger, steering suspended
  batCd: number; // beater swing cooldown
};

type TeamState = {
  flyers: Flyer[];
  mesh: THREE.InstancedMesh;
  robe: THREE.Color;
};

type Hoop = {
  side: -1 | 1;
  scoringTeam: QuidditchTeam; // whoever puts the quaffle through this hoop
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

type Bludger = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mesh: THREE.Mesh;
  hitCd: number; // grace so one swipe isn't ten hits
};

export class Quidditch {
  onMessage: (msg: string, secs?: number) => void = () => {};
  /** A hoop goal landed. */
  onScore: (team: QuidditchTeam, red: number, blue: number) => void = () => {};
  /** Snitch caught — match over. */
  onSnitchCaught: (team: QuidditchTeam, red: number, blue: number, winner: QuidditchTeam | "draw") => void = () => {};
  /** Referee whistle moments (kickoff / match end). */
  onWhistle: () => void = () => {};
  /** A bludger clobbered someone at (x,y,z); hitPlayer = it was the human. */
  onBludgerHit: (x: number, y: number, z: number, hitPlayer: boolean) => void = () => {};
  /** Pitch woke up / went idle — toggles the scoreboard. */
  onActiveChange: (active: boolean) => void = () => {};

  #root: THREE.Group;
  #groundY = 0;
  #active = false;
  #teams: Record<QuidditchTeam, TeamState>;
  #quaffle = { x: 0, y: 12, z: 0, vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, grabCd: 0 };
  #holder: Flyer | null = null;
  #snitch = { x: 0, y: 18, z: 0, vx: 0, vy: 0, vz: 0, phase: 0 };
  #quaffleMesh: THREE.Mesh;
  #snitchMesh: THREE.Mesh;
  #snitchWings: THREE.Mesh;
  #bludgers: Bludger[] = [];
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

  // match bookkeeping
  #scores: Record<QuidditchTeam, number> = { red: 0, blue: 0 };
  #state: MatchState = "idle";
  #clock = 0; // seconds of play in the current match (gates the snitch)
  #endTimer = 0;
  #winner: QuidditchTeam | "draw" = "draw";
  #player: { team: QuidditchTeam; role: QuidditchRole } | null = null;
  #pendingKick: { x: number; y: number; z: number } | null = null;

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
      new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0xffb300, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.6 })
    );
    this.#snitchWings = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.34),
      new THREE.MeshBasicMaterial({ color: 0xfff4c8, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
    );
    this.#snitchMesh.add(this.#snitchWings);
    this.#root.add(this.#snitchMesh);

    // two black bludgers
    const bludgerGeo = new THREE.SphereGeometry(0.34, 14, 12);
    const bludgerMat = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.55, metalness: 0.35 });
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(bludgerGeo, bludgerMat);
      mesh.castShadow = true;
      this.#root.add(mesh);
      this.#bludgers.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mesh, hitCd: 0 });
    }

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

  get active() {
    return this.#active;
  }

  get scores() {
    return { ...this.#scores };
  }

  get matchState() {
    return this.#state;
  }

  get playerRole(): { team: QuidditchTeam; role: QuidditchRole } | null {
    return this.#player;
  }

  /** Roles still open to take over, in join-priority order, per team. */
  openRoles(): { team: QuidditchTeam; role: QuidditchRole; label: string }[] {
    const out: { team: QuidditchTeam; role: QuidditchRole; label: string }[] = [];
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      const side = team === "red" ? "Scarlet" : "Azure";
      for (const role of ROLES) {
        if (this.#teams[team].flyers.some((f) => f.role === role)) {
          out.push({ team, role, label: `${side} ${role}` });
        }
      }
    }
    return out;
  }

  /** Label for the HUD prompt while standing in the join circle. */
  joinLabel(): string | null {
    if (!this.#playerInJoinZone) return null;
    const slot = this.#findJoinSlot();
    if (!slot) return null;
    const side = slot.team === "red" ? "Scarlet" : "Azure";
    return `${side} ${slot.role}`;
  }

  /** On the pitch while a match is running — click to throw the quaffle. */
  canThrow(pos: THREE.Vector3): boolean {
    if (!this.#active || this.#state === "ended") return false;
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
    this.#throws.push({ x, y, z, px: x, py: y, pz: z, vx: d.x, vy: d.y, vz: d.z, life: THROW_LIFE, mesh });
    return true;
  }

  /** Player-as-Beater swing: knock the nearest bludger off toward midfield. */
  swingBat(pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (!this.#active) return false;
    let best: Bludger | null = null;
    let bestD = 7 * 7;
    for (const b of this.#bludgers) {
      const d2 = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2 + (b.z - pos.z) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        best = b;
      }
    }
    if (!best) return false;
    const d = dir.clone();
    if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
    d.normalize().multiplyScalar(38);
    best.vx = d.x;
    best.vy = d.y + 3;
    best.vz = d.z;
    best.hitCd = 0.35;
    this.onBludgerHit(best.x, best.y, best.z, false);
    return true;
  }

  /** After a bludger tags the human rider, main reads & clears the knockback. */
  takeBludgerKick(): { x: number; y: number; z: number } | null {
    const k = this.#pendingKick;
    this.#pendingKick = null;
    return k;
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

  #ensurePlaying() {
    if (this.#state !== "playing") {
      this.#scores.red = 0;
      this.#scores.blue = 0;
      this.#state = "playing";
      this.#clock = 0;
      this.#resetBall();
      this.onWhistle();
    }
    if (!this.#active) {
      this.#active = true;
      this.onActiveChange(true);
    }
  }

  /** Walk into the join circle and press E — takes over the best open role. */
  tryJoin(pos: THREE.Vector3) {
    if (!this.inJoinZoneAt(pos)) return null;
    const slot = this.#findJoinSlot();
    if (!slot) return null;
    return this.joinAs(slot.team, slot.role, pos);
  }

  /** Take over a specific open role (the role picker calls this). */
  joinAs(team: QuidditchTeam, role: QuidditchRole, pos: THREE.Vector3) {
    if (!this.inJoinZoneAt(pos)) return null;
    const index = this.#teams[team].flyers.findIndex((f) => f.role === role);
    if (index < 0) return null;
    this.#ensurePlaying();
    const info = this.consume({ team, index });
    const side = team === "red" ? "Scarlet" : "Azure";
    this.#player = { team, role };
    return { ...info, label: `${side} ${info.role}` };
  }

  #findJoinSlot(): { team: QuidditchTeam; index: number; role: QuidditchRole } | null {
    const order: { team: QuidditchTeam; role: QuidditchRole }[] = [];
    for (const role of ["Seeker", "Chaser", "Beater", "Keeper"] as QuidditchRole[]) {
      order.push({ team: "red", role }, { team: "blue", role });
    }
    for (const want of order) {
      const index = this.#teams[want.team].flyers.findIndex((f) => f.role === want.role);
      if (index >= 0) return { team: want.team, index, role: want.role };
    }
    return null;
  }

  consume(pick: { team: QuidditchTeam; index: number }) {
    const team = this.#teams[pick.team];
    const f = team.flyers.splice(pick.index, 1)[0];
    if (this.#holder === f) this.#holder = null;
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
    const slot = state.flyers.filter((f) => f.role === role).length;
    const home = this.#homeFor(team, role, slot);
    state.flyers.push({
      x, y, z,
      vx: motion.vx ?? 0,
      vy: motion.vy ?? 0,
      vz: motion.vz ?? 0,
      yaw,
      pitch: 0,
      roll: 0,
      role,
      slot,
      homeX: home.x,
      homeZ: home.z,
      stun: 0,
      batCd: 0
    });
    state.mesh.count = state.flyers.length;
    this.#player = null;
  }

  update(dt: number, playerPos: THREE.Vector3, elapsed: number) {
    const dist = Math.hypot(playerPos.x - QUIDDITCH_PITCH.x, playerPos.z - QUIDDITCH_PITCH.z);
    const wantActive = dist < ACTIVATE_RADIUS;
    if (wantActive && !this.#active) {
      this.#active = true;
      this.#state = "playing";
      this.#scores.red = 0;
      this.#scores.blue = 0;
      this.#clock = 0;
      this.#resetBall();
      this.onActiveChange(true);
      this.onWhistle();
      this.onMessage("Quidditch match on — step into the glowing circle to fly", 3.4);
    } else if (!wantActive && this.#active) {
      this.#active = false;
      this.#parkFlyers();
      this.onActiveChange(false);
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
      for (const b of this.#bludgers) b.mesh.visible = false;
      for (const team of ["red", "blue"] as QuidditchTeam[]) this.#teams[team].mesh.visible = false;
      for (const t of this.#throws) t.mesh.visible = false;
      return;
    }

    // celebration freeze: hold the final tableau, then whistle in a fresh match
    if (this.#state === "ended") {
      this.#endTimer -= dt;
      if (this.#endTimer <= 0) {
        this.#state = "playing";
        this.#scores.red = 0;
        this.#scores.blue = 0;
        this.#clock = 0;
        this.#respawnAll();
        this.#resetBall();
        this.onWhistle();
        this.onMessage("New match! First to catch the Snitch wins", 2.8);
      }
    }

    const playing = this.#state === "playing";
    this.#quaffleMesh.visible = true;
    this.#snitchMesh.visible = true;
    for (const b of this.#bludgers) b.mesh.visible = true;
    if (playing) this.#resolvePossession();
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      this.#teams[team].mesh.visible = true;
      if (playing) this.#simulateTeam(team, dt, elapsed);
    }
    if (playing) {
      this.#clock += dt;
      this.#simulateBall(dt, elapsed);
      this.#simulateBludgers(dt, playerPos);
      this.#simulateThrows(dt);
      this.#checkPlayerCatch(playerPos);
    }
    this.#updateHoops(dt);
    this.#drawFlyers();
    this.#snitchWings.lookAt(0, this.#snitch.y + 40, 0);
    this.#snitchWings.scale.x = 0.6 + Math.abs(Math.sin(elapsed * 22)) * 0.9;

    this.#quaffleMesh.position.set(this.#quaffle.x - QUIDDITCH_PITCH.x, this.#quaffle.y - this.#groundY, this.#quaffle.z - QUIDDITCH_PITCH.z);
    this.#snitchMesh.position.set(this.#snitch.x - QUIDDITCH_PITCH.x, this.#snitch.y - this.#groundY, this.#snitch.z - QUIDDITCH_PITCH.z);
    for (const b of this.#bludgers) {
      b.mesh.position.set(b.x - QUIDDITCH_PITCH.x, b.y - this.#groundY, b.z - QUIDDITCH_PITCH.z);
    }
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

      // real pitches stagger the three hoops at different heights
      const heights = [HOOP_HEIGHT - 3, HOOP_HEIGHT + 2, HOOP_HEIGHT - 1];
      for (let h = 0; h < 3; h++) {
        const z = (h - 1) * 18;
        const top = heights[h];
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, top, 8), poleMat);
        pole.position.set(side * hoopX, top / 2, z);
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
        hoop.position.set(side * hoopX, top, z);
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
          scoringTeam: side === 1 ? "red" : "blue",
          wx: QUIDDITCH_PITCH.x + side * hoopX,
          wy: this.#groundY + top,
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
    const counters: Record<string, number> = {};
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
      const role = ROSTER[i];
      const slot = counters[role] ?? 0;
      counters[role] = slot + 1;
      const home = this.#homeFor(team, role, slot);
      out.push({
        x: home.x,
        y: home.y,
        z: home.z,
        vx: 0,
        vy: 0,
        vz: 0,
        yaw: team === "red" ? 0 : Math.PI,
        pitch: 0,
        roll: 0,
        role,
        slot,
        homeX: home.x,
        homeZ: home.z,
        stun: 0,
        batCd: 0
      });
    }
    return out;
  }

  #homeFor(team: QuidditchTeam, role: QuidditchRole, slot: number) {
    const side = team === "red" ? -1 : 1;
    const baseX = QUIDDITCH_PITCH.x + side * (PITCH_LENGTH * 0.24);
    const alt =
      role === "Keeper" ? HOOP_HEIGHT : role === "Seeker" ? 26 : role === "Beater" ? 18 : 14;
    // spread the three chasers / two beaters across the width
    const spread = role === "Chaser" ? (slot - 1) * 14 : role === "Beater" ? (slot === 0 ? -16 : 16) : 0;
    return {
      x: baseX,
      y: this.#groundY + alt,
      z: QUIDDITCH_PITCH.z + spread
    };
  }

  #parkFlyers() {
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      const state = this.#teams[team];
      state.flyers = this.#spawnTeam(team);
      state.mesh.count = state.flyers.length;
    }
    this.#holder = null;
    this.#player = null;
    this.#state = "idle";
    this.#clearThrows();
    this.#resetBall();
    for (const hoop of this.#hoops) hoop.glow = 0;
  }

  /** Refill the AI ranks for a fresh match, leaving any human-held slot open. */
  #respawnAll() {
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      const state = this.#teams[team];
      const humanRole = this.#player?.team === team ? this.#player.role : null;
      state.flyers = this.#spawnTeam(team);
      if (humanRole) {
        const idx = state.flyers.findIndex((f) => f.role === humanRole);
        if (idx >= 0) state.flyers.splice(idx, 1);
      }
      state.mesh.count = state.flyers.length;
    }
    this.#holder = null;
    this.#clearThrows();
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
    const q = this.#quaffle;
    q.x = QUIDDITCH_PITCH.x;
    q.y = this.#groundY + 16;
    q.z = QUIDDITCH_PITCH.z;
    q.vx = 0;
    q.vy = 0;
    q.vz = 0;
    q.grabCd = 0.6;
    this.#holder = null;

    // spawn dead-centre and high so both seekers start ~equidistant and far —
    // the chase should last, not end at the opening whistle
    this.#snitch.x = QUIDDITCH_PITCH.x;
    this.#snitch.y = this.#groundY + 34;
    this.#snitch.z = QUIDDITCH_PITCH.z;
    this.#snitch.vx = 0;
    this.#snitch.vy = 0;
    this.#snitch.vz = 0;
    this.#snitch.phase = Math.random() * Math.PI * 2;

    for (let i = 0; i < this.#bludgers.length; i++) {
      const b = this.#bludgers[i];
      b.x = QUIDDITCH_PITCH.x + (i === 0 ? -12 : 12);
      b.y = this.#groundY + 16;
      b.z = QUIDDITCH_PITCH.z + (i === 0 ? 10 : -10);
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      b.hitCd = 0;
    }
  }

  // ── AI ──────────────────────────────────────────────────────────────────
  #simulateTeam(team: QuidditchTeam, dt: number, elapsed: number) {
    const state = this.#teams[team];
    const attack = team === "red" ? 1 : -1; // red drives toward +x hoops
    for (const f of state.flyers) {
      if (f.batCd > 0) f.batCd -= dt;
      // reeling from a bludger: coast, bleed speed, no steering
      if (f.stun > 0) {
        f.stun -= dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.z += f.vz * dt;
        f.vx *= 1 - dt * 1.6;
        f.vy *= 1 - dt * 1.6;
        f.vz *= 1 - dt * 1.6;
        f.roll = THREE.MathUtils.lerp(f.roll, Math.sin(elapsed * 18) * 0.6, Math.min(1, dt * 8));
        this.#clampFlyer(f);
        continue;
      }
      f.roll = THREE.MathUtils.lerp(f.roll, team === "red" ? 0.08 : -0.08, Math.min(1, dt * 4));

      let tx = this.#quaffle.x;
      let ty = this.#quaffle.y;
      let tz = this.#quaffle.z;
      let speed = 20;

      if (f.role === "Keeper") {
        tx = QUIDDITCH_PITCH.x - attack * (PITCH_LENGTH * 0.42);
        ty = this.#groundY + HOOP_HEIGHT;
        // slide to intercept the quaffle's height/line when it threatens our end
        const threat = Math.sign(this.#quaffle.x - QUIDDITCH_PITCH.x) === -attack;
        tz = threat ? THREE.MathUtils.clamp(this.#quaffle.z, QUIDDITCH_PITCH.z - 20, QUIDDITCH_PITCH.z + 20) : QUIDDITCH_PITCH.z + Math.sin(elapsed * 0.7 + f.homeZ) * 6;
        if (threat) ty = THREE.MathUtils.clamp(this.#quaffle.y, this.#groundY + 12, this.#groundY + HOOP_HEIGHT + 3);
        speed = 20;
      } else if (f.role === "Seeker") {
        tx = this.#snitch.x;
        ty = this.#snitch.y;
        tz = this.#snitch.z;
        speed = 27;
      } else if (f.role === "Beater") {
        // fly at the nearest bludger; bat it toward an enemy when in reach
        const b = this.#nearestBludger(f.x, f.y, f.z);
        if (b) {
          tx = b.x;
          ty = b.y;
          tz = b.z;
          const bd = Math.hypot(f.x - b.x, f.y - b.y, f.z - b.z);
          if (bd < 3 && f.batCd <= 0 && b.hitCd <= 0) {
            const enemy = this.#nearestEnemy(team, b.x, b.y, b.z);
            if (enemy) {
              const ex = enemy.x - b.x;
              const ey = enemy.y - b.y;
              const ez = enemy.z - b.z;
              const el = Math.hypot(ex, ey, ez) || 1;
              b.vx = (ex / el) * 40;
              b.vy = (ey / el) * 40 + 3;
              b.vz = (ez / el) * 40;
              b.hitCd = 0.4;
              f.batCd = 0.8;
            }
          }
        }
        speed = 22;
      } else {
        // Chaser
        if (this.#holder === f) {
          // carry toward an enemy hoop, shoot when lined up
          const hoop = this.#targetHoop(team, f);
          tx = hoop.wx;
          ty = hoop.wy;
          tz = hoop.wz;
          speed = 26;
          const gap = Math.abs(f.x - hoop.wx);
          const lined = Math.abs(f.z - hoop.wz) < 16;
          if (gap < 32 && lined && this.#quaffle.grabCd <= 0) {
            this.#shootQuaffle(f, hoop);
          }
        } else if (this.#holder && this.#holder !== f && this.#sameTeam(this.#holder, team)) {
          // support: spread out ahead of our carrier toward the goal
          tx = this.#holder.x + attack * 18;
          ty = this.#holder.y + (f.slot - 1) * 6;
          tz = this.#holder.z + (f.slot - 1) * 12;
          speed = 24;
        } else {
          // chase the loose quaffle (possession is resolved globally, fairly)
          speed = 25;
        }
      }

      const dx = tx - f.x;
      const dy = ty - f.y;
      const dz = tz - f.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const ax = (dx / d) * speed;
      const ay = (dy / d) * speed;
      const az = (dz / d) * speed;
      // seekers turn less sharply, so the snitch's jukes actually shake them
      const resp = f.role === "Seeker" ? 1.7 : 2.4;
      f.vx += (ax - f.vx) * Math.min(1, dt * resp);
      f.vy += (ay - f.vy) * Math.min(1, dt * resp);
      f.vz += (az - f.vz) * Math.min(1, dt * resp);
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      this.#clampFlyer(f);

      f.yaw = Math.atan2(-(tx - f.x), -(tz - f.z));
      f.pitch = THREE.MathUtils.clamp(Math.atan2(ty - f.y, Math.hypot(tx - f.x, tz - f.z)), -0.55, 0.55);

      // AI seeker snags the snitch on contact — that ends the match
      if (f.role === "Seeker") {
        const sd = Math.hypot(f.x - this.#snitch.x, f.y - this.#snitch.y, f.z - this.#snitch.z);
        if (sd < CATCH_RADIUS) this.#catchSnitch(team);
      }
    }
  }

  #clampFlyer(f: Flyer) {
    const minY = this.#groundY + 8;
    const maxY = this.#groundY + 44;
    if (f.y < minY) {
      f.y = minY;
      f.vy = Math.abs(f.vy) * 0.4;
    }
    if (f.y > maxY) {
      f.y = maxY;
      f.vy = -Math.abs(f.vy) * 0.4;
    }
    const bx = QUIDDITCH_PITCH.x;
    const bz = QUIDDITCH_PITCH.z;
    if (Math.abs(f.x - bx) > PITCH_LENGTH * 0.54) {
      f.x = bx + Math.sign(f.x - bx) * PITCH_LENGTH * 0.54;
      f.vx *= -0.4;
    }
    if (Math.abs(f.z - bz) > PITCH_WIDTH * 0.54) {
      f.z = bz + Math.sign(f.z - bz) * PITCH_WIDTH * 0.54;
      f.vz *= -0.4;
    }
  }

  #sameTeam(f: Flyer, team: QuidditchTeam) {
    return this.#teams[team].flyers.includes(f);
  }

  #targetHoop(team: QuidditchTeam, f: Flyer): Hoop {
    // aim at whichever of our attacking hoops is closest in z
    let best = this.#hoops[0];
    let bestD = Infinity;
    for (const h of this.#hoops) {
      if (h.scoringTeam !== team) continue;
      const d = Math.abs(h.wz - f.z);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  /** Award a loose quaffle to the single nearest chaser — no team-order bias. */
  #resolvePossession() {
    if (this.#holder || this.#quaffle.grabCd > 0) return;
    let best: Flyer | null = null;
    let bestD = 2.4 * 2.4;
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      for (const f of this.#teams[team].flyers) {
        if (f.role !== "Chaser" || f.stun > 0) continue;
        const d = (f.x - this.#quaffle.x) ** 2 + (f.y - this.#quaffle.y) ** 2 + (f.z - this.#quaffle.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
    }
    if (best) this.#holder = best;
  }

  #shootQuaffle(f: Flyer, hoop: Hoop) {
    const q = this.#quaffle;
    const dx = hoop.wx - q.x;
    const dy = hoop.wy - q.y + 0.5;
    const dz = hoop.wz - q.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const speed = 42;
    // modest aim scatter so keepers still get the odd save, but shots convert
    const jitter = () => (Math.random() - 0.5) * 3;
    q.vx = (dx / d) * speed + jitter();
    q.vy = (dy / d) * speed + 2 + jitter() * 0.3;
    q.vz = (dz / d) * speed + jitter();
    q.grabCd = 0.9;
    this.#holder = null;
  }

  #nearestBludger(x: number, y: number, z: number): Bludger | null {
    let best: Bludger | null = null;
    let bestD = Infinity;
    for (const b of this.#bludgers) {
      const d = (b.x - x) ** 2 + (b.y - y) ** 2 + (b.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  #nearestEnemy(team: QuidditchTeam, x: number, y: number, z: number): Flyer | null {
    const enemy = team === "red" ? "blue" : "red";
    let best: Flyer | null = null;
    let bestD = Infinity;
    for (const f of this.#teams[enemy].flyers) {
      const d = (f.x - x) ** 2 + (f.y - y) ** 2 + (f.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  #simulateBall(dt: number, elapsed: number) {
    const q = this.#quaffle;
    if (q.grabCd > 0) q.grabCd -= dt;
    q.px = q.x;
    q.py = q.y;
    q.pz = q.z;

    if (this.#holder) {
      // glued to the carrier, riding just ahead of the broom
      const h = this.#holder;
      q.x = h.x - Math.sin(h.yaw) * 0.9;
      q.y = h.y - 0.4;
      q.z = h.z - Math.cos(h.yaw) * 0.9;
      q.vx = h.vx;
      q.vy = h.vy;
      q.vz = h.vz;
    } else {
      q.vy -= 3.2 * dt; // light "quaffle float" so it lingers in reach
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.z += q.vz * dt;
      q.vx *= 1 - dt * 0.25;
      q.vz *= 1 - dt * 0.25;
      // bounce off an invisible floor at broom altitude — a loose quaffle must
      // stay in the band chasers can actually fly to (they can't dive to grass)
      const floor = this.#groundY + 9;
      if (q.y < floor) {
        q.y = floor;
        q.vy = Math.abs(q.vy) * 0.5 + 2;
      }
      const ceil = this.#groundY + 34;
      if (q.y > ceil) {
        q.y = ceil;
        q.vy = -Math.abs(q.vy) * 0.5;
      }
      const bx = QUIDDITCH_PITCH.x;
      const bz = QUIDDITCH_PITCH.z;
      if (Math.abs(q.x - bx) > PITCH_LENGTH * 0.5) q.vx *= -0.72;
      if (Math.abs(q.z - bz) > PITCH_WIDTH * 0.5) q.vz *= -0.72;
      // the AI-driven quaffle can score through a hoop too
      this.#checkQuaffleGoal();
    }

    const s = this.#snitch;
    s.phase += dt * 2.4;
    // snitch flees the nearest seeker but is SPEED-CAPPED just under seeker pace,
    // so a committed seeker slowly reels it in (30–90s) while it jukes to survive.
    const seeker = this.#nearestSeeker(s.x, s.y, s.z);
    const seekerD = seeker ? Math.hypot(seeker.x - s.x, seeker.y - s.y, seeker.z - s.z) : 999;
    const chased = seeker && seekerD < 18;
    let tx: number, ty: number, tz: number;
    if (chased && seeker) {
      const fx = s.x - seeker.x;
      const fy = s.y - seeker.y;
      const fz = s.z - seeker.z;
      const fl = Math.hypot(fx, fy, fz) || 1;
      // flee direction plus a hard lateral juke so it isn't a trivial stern chase
      const lx = -fz / Math.hypot(fx, fz) || 0;
      const lz = fx / Math.hypot(fx, fz) || 0;
      const juke = Math.sin(s.phase * 2.3) * 20;
      tx = s.x + (fx / fl) * 24 + lx * juke;
      ty = THREE.MathUtils.clamp(s.y + (fy / fl) * 10 + Math.sin(s.phase * 3.1) * 4, this.#groundY + 12, this.#groundY + 40);
      tz = s.z + (fz / fl) * 24 + lz * juke;
    } else {
      const bx = QUIDDITCH_PITCH.x;
      const bz = QUIDDITCH_PITCH.z;
      const orbitR = 30 + Math.sin(elapsed * 0.9) * 10;
      tx = bx + Math.cos(s.phase) * orbitR;
      ty = this.#groundY + 20 + Math.sin(elapsed * 1.7) * 8;
      tz = bz + Math.sin(s.phase * 1.3) * orbitR * 0.7;
    }
    const accel = chased ? 5 : 3;
    s.vx += (tx - s.x) * dt * accel;
    s.vy += (ty - s.y) * dt * accel;
    s.vz += (tz - s.z) * dt * accel;
    s.vx *= 1 - dt * 1.4;
    s.vy *= 1 - dt * 1.4;
    s.vz *= 1 - dt * 1.4;
    // before it arms, the snitch outruns any seeker (30) so play develops; once
    // tired (armed) it drops below seeker pace (23.5) and gets slowly reeled in
    const armed = this.#clock >= SNITCH_ARM_TIME;
    const maxSp = chased ? (armed ? 23.5 : 30) : armed ? 15 : 18;
    const sp = Math.hypot(s.vx, s.vy, s.vz);
    if (sp > maxSp) {
      const k = maxSp / sp;
      s.vx *= k;
      s.vy *= k;
      s.vz *= k;
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;
    // keep the chase inside the pitch bubble
    const sdx = s.x - QUIDDITCH_PITCH.x;
    const sdz = s.z - QUIDDITCH_PITCH.z;
    if (Math.abs(sdx) > PITCH_LENGTH * 0.5) {
      s.x = QUIDDITCH_PITCH.x + Math.sign(sdx) * PITCH_LENGTH * 0.5;
      s.vx *= -0.6;
    }
    if (Math.abs(sdz) > PITCH_WIDTH * 0.5) {
      s.z = QUIDDITCH_PITCH.z + Math.sign(sdz) * PITCH_WIDTH * 0.5;
      s.vz *= -0.6;
    }
  }

  #nearestSeeker(x: number, y: number, z: number): Flyer | null {
    let best: Flyer | null = null;
    let bestD = Infinity;
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      for (const f of this.#teams[team].flyers) {
        if (f.role !== "Seeker") continue;
        const d = (f.x - x) ** 2 + (f.y - y) ** 2 + (f.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
    }
    return best;
  }

  #simulateBludgers(dt: number, playerPos: THREE.Vector3) {
    for (const b of this.#bludgers) {
      if (b.hitCd > 0) b.hitCd -= dt;
      // drift toward the nearest active rider — but gently, and only after a
      // post-hit cooldown, so bludgers menace without smothering every carrier
      const target = b.hitCd <= 0 ? this.#nearestRider(b.x, b.y, b.z, playerPos) : null;
      if (target) {
        const dx = target.x - b.x;
        const dy = target.y - b.y;
        const dz = target.z - b.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const seek = 11;
        // a little wander keeps two bludgers from stacking on the same victim
        const wob = Math.sin(b.x * 0.3 + b.z * 0.2) * 4;
        b.vx += ((dx / d) * seek + wob - b.vx) * Math.min(1, dt * 0.7);
        b.vy += ((dy / d) * seek - b.vy) * Math.min(1, dt * 0.7);
        b.vz += ((dz / d) * seek - wob - b.vz) * Math.min(1, dt * 0.7);
      }
      b.vy -= 1.2 * dt; // slight heaviness
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      // spin the mesh for menace
      b.mesh.rotation.x += dt * 3;
      b.mesh.rotation.y += dt * 2.3;

      // walls
      const minY = this.#groundY + 6;
      if (b.y < minY) {
        b.y = minY;
        b.vy = Math.abs(b.vy) * 0.5 + 4;
      }
      if (b.y > this.#groundY + 46) {
        b.y = this.#groundY + 46;
        b.vy = -Math.abs(b.vy) * 0.5;
      }
      if (Math.abs(b.x - QUIDDITCH_PITCH.x) > PITCH_LENGTH * 0.52) b.vx *= -0.8;
      if (Math.abs(b.z - QUIDDITCH_PITCH.z) > PITCH_WIDTH * 0.52) b.vz *= -0.8;

      if (b.hitCd <= 0) this.#bludgerContact(b, playerPos);
    }
  }

  /** Nearest thing a bludger would chase: any AI rider or the human in a role. */
  #nearestRider(x: number, y: number, z: number, playerPos: THREE.Vector3): { x: number; y: number; z: number } | null {
    let best: { x: number; y: number; z: number } | null = null;
    let bestD = Infinity;
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      for (const f of this.#teams[team].flyers) {
        if (f.role === "Beater") continue; // beaters aren't easy prey
        const d = (f.x - x) ** 2 + (f.y - y) ** 2 + (f.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
    }
    if (this.#player && this.#player.role !== "Beater") {
      const d = (playerPos.x - x) ** 2 + (playerPos.y - y) ** 2 + (playerPos.z - z) ** 2;
      if (d < bestD) best = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    }
    return best;
  }

  #bludgerContact(b: Bludger, playerPos: THREE.Vector3) {
    // AI riders
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      for (const f of this.#teams[team].flyers) {
        if (f.stun > 0) continue;
        const d = Math.hypot(f.x - b.x, f.y - b.y, f.z - b.z);
        if (d < 1.9) {
          const nx = (f.x - b.x) / (d || 1);
          const ny = (f.y - b.y) / (d || 1);
          const nz = (f.z - b.z) / (d || 1);
          f.vx += nx * 13;
          f.vy += ny * 9 + 4;
          f.vz += nz * 13;
          f.stun = 0.75;
          if (this.#holder === f) {
            this.#holder = null;
            this.#quaffle.grabCd = 0.5;
          }
          b.vx = -nx * 20;
          b.vy = 5;
          b.vz = -nz * 20;
          b.hitCd = 1.5; // bounce clear and wander before hunting again
          this.onBludgerHit(f.x, f.y, f.z, false);
          return;
        }
      }
    }
    // human rider
    if (this.#player && this.#player.role !== "Beater") {
      const d = Math.hypot(playerPos.x - b.x, playerPos.y - b.y, playerPos.z - b.z);
      if (d < 2.6) {
        const nx = (playerPos.x - b.x) / (d || 1);
        const ny = (playerPos.y - b.y) / (d || 1);
        const nz = (playerPos.z - b.z) / (d || 1);
        this.#pendingKick = { x: nx * 16, y: ny * 10 + 5, z: nz * 16 };
        b.vx = -nx * 18;
        b.vy = 4;
        b.vz = -nz * 18;
        b.hitCd = 0.7;
        this.onBludgerHit(playerPos.x, playerPos.y, playerPos.z, true);
      }
    }
  }

  #checkPlayerCatch(playerPos: THREE.Vector3) {
    if (this.#player?.role !== "Seeker") return;
    const d = Math.hypot(playerPos.x - this.#snitch.x, playerPos.y - this.#snitch.y, playerPos.z - this.#snitch.z);
    if (d < CATCH_RADIUS + 0.5) this.#catchSnitch(this.#player.team);
  }

  #catchSnitch(team: QuidditchTeam) {
    if (this.#state !== "playing") return;
    if (this.#clock < SNITCH_ARM_TIME) return; // still too spry to grab

    this.#scores[team] += SNITCH_POINTS;
    this.#state = "ended";
    this.#endTimer = 6.5;
    const { red, blue } = this.#scores;
    this.#winner = red === blue ? "draw" : red > blue ? "red" : "blue";
    this.onSnitchCaught(team, red, blue, this.#winner);
    this.onWhistle();
    const side = team === "red" ? "Scarlet" : "Azure";
    const champ = this.#winner === "draw" ? "It's a draw!" : `${this.#winner === "red" ? "Scarlet" : "Azure"} win ${Math.max(red, blue)}–${Math.min(red, blue)}!`;
    this.onMessage(`${side} Seeker catches the Snitch! ${champ}`, 5);
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

      const scored = this.#checkHoopScores(b.px, b.py, b.pz, b.x, b.y, b.z);

      if (b.y < floor || b.life <= 0 || scored) {
        b.mesh.visible = false;
        this.#throwPool.push(b.mesh);
        this.#throws.splice(i, 1);
        continue;
      }

      b.mesh.position.set(b.x - QUIDDITCH_PITCH.x, b.y - this.#groundY, b.z - QUIDDITCH_PITCH.z);
      i++;
    }
  }

  #checkQuaffleGoal() {
    const q = this.#quaffle;
    if (this.#checkHoopScores(q.px, q.py, q.pz, q.x, q.y, q.z)) this.#resetBall();
  }

  /** Segment-vs-hoop test; on a clean pass, award the goal. Returns true if scored. */
  #checkHoopScores(px: number, py: number, pz: number, x: number, y: number, z: number): boolean {
    for (const hoop of this.#hoops) {
      const ax = x - px;
      if (Math.abs(ax) < 1e-5) continue;
      const t = (hoop.wx - px) / ax;
      if (t < 0 || t > 1) continue;
      const yy = py + t * (y - py);
      const zz = pz + t * (z - pz);
      if (Math.hypot(yy - hoop.wy, zz - hoop.wz) > HOOP_SCORE_RADIUS) continue;
      hoop.glow = 2.8;
      this.#scoreGoal(hoop.scoringTeam);
      return true;
    }
    return false;
  }

  #scoreGoal(team: QuidditchTeam) {
    if (this.#state !== "playing") return;
    this.#scores[team] += GOAL_POINTS;
    const { red, blue } = this.#scores;
    this.onScore(team, red, blue);
    const side = team === "red" ? "Scarlet" : "Azure";
    this.onMessage(`GOAL! ${side} score — ${red}–${blue}`, 2.4);
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
        this.#euler.set(f.pitch, f.yaw, f.roll, "YXZ");
        this.#quat.setFromEuler(this.#euler);
        this.#pos.set(f.x - QUIDDITCH_PITCH.x, f.y - this.#groundY, f.z - QUIDDITCH_PITCH.z);
        this.#mat4.compose(this.#pos, this.#quat, this.#scale);
        state.mesh.setMatrixAt(i, this.#mat4);
      }
      if (state.flyers.length) state.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
