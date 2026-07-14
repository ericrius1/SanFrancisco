import * as THREE from "three/webgpu";
import { applyAvatarToRig, buildRig, poseAir, poseDrive, poseIdle, poseRide, poseScooter, poseWalk, type Rig } from "../player/rig";
import { avatarFromSeed, avatarKey, type AvatarTraits } from "../player/avatar";
import {
  activateCarAssets,
  animateCar,
  buildCarMesh,
  carFromSeed,
  carKey,
  normalizeCarConfig,
  type CarConfig
} from "../vehicles/car";
import { buildPlaneMesh, collectPlaneAnim, type PlaneAnim } from "../vehicles/plane";
import { buildBoatMesh, buildSpeedboatMesh } from "../vehicles/boat";
import { buildDroneMesh } from "../vehicles/drone";
import { buildBoardMesh, animateBoard, boardFromSeed, boardVisualKey, normalizeBoardConfig, type BoardConfig } from "../vehicles/board";
import { buildBirdMesh } from "../vehicles/bird";
import { activateSurfboardAssets, animateSurfboard, buildSurfboardMesh } from "../vehicles/surf";
import {
  normalizeSurfboardConfig,
  surfboardFromSeed,
  surfboardVisualKey,
  type SurfboardConfig
} from "../vehicles/surf/config";
import {
  activateScooterAssets,
  animateScooter,
  buildScooterMesh,
  normalizeScooterConfig,
  scooterFromSeed,
  scooterKey,
  type ScooterConfig
} from "../vehicles/scooter";
import type { Cockpit, PlayerMode } from "../player/types";
import type { NetSample, RemoteInfo } from "./net";
import { setEmbodimentVisible } from "../player/embodimentVisibility";
import { CANVAS_FONT_FAMILY } from "../core/typography";

/**
 * Visuals for everyone else in the world: one avatar per remote player, driven
 * by snapshot interpolation.
 *
 * Rendering rules (hard-won, see lightPool.ts): remote avatars carry NO
 * THREE.Light objects — adding/removing a light rebuilds every lit pipeline in
 * the scene (a multi-second freeze). Emissive headlight materials on the
 * cloned vehicle meshes still glow for free. Fixed vehicles are deep-cloned
 * from shared prototypes. Customizable hoverboards, scooters, and surfboards
 * are fresh per-player builds because their generated resources and userData
 * ownership contracts cannot safely be cloned. Character rigs are built per
 * remote (they share module-level materials already).
 *
 * Interpolation: samples arrive ~12 Hz timestamped on the server clock
 * (mapped to local time by Net). We render INTERP_DELAY behind the newest
 * sample and lerp/slerp between the two bracketing snapshots — the standard
 * "play the past smoothly" scheme. If the buffer runs dry (tab hiccup,
 * packet loss) the avatar holds its last pose instead of extrapolating into
 * walls.
 */

const INTERP_DELAY_MS = 150;
const BUFFER_KEEP_MS = 1200;

// name tags: one canvas texture per player, drawn once (and on rename)
function makeTag(name: string, hue: number): THREE.Sprite {
  const ss = 3; // supersample so text stays crisp when viewed close
  const pad = 14 * ss;
  const font = `600 ${34 * ss}px ${CANVAS_FONT_FAMILY}`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + pad * 2;
  canvas.width = Math.max(64 * ss, w);
  canvas.height = 52 * ss;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const r = 14 * ss;
  ctx.beginPath();
  ctx.roundRect(ss, ss, canvas.width - 2 * ss, canvas.height - 2 * ss, r);
  ctx.fillStyle = "rgba(8, 20, 30, 0.72)";
  ctx.fill();
  ctx.strokeStyle = `hsl(${hue} 75% 62%)`;
  ctx.lineWidth = 2.5 * ss;
  ctx.stroke();
  ctx.fillStyle = "#eaf4f8";
  ctx.fillText(name, canvas.width / 2, canvas.height / 2 + ss);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  // fixed world height so the font size reads the same for every name;
  // width follows the canvas aspect (long names get wider tags, not smaller text)
  const worldH = 0.42;
  sprite.scale.set((worldH * canvas.width) / canvas.height, worldH, 1);
  return sprite;
}

/** Tag height above the avatar origin, per embodiment. */
const TAG_Y: Record<PlayerMode, number> = {
  walk: 2.1,
  drive: 2.8,
  scooter: 2.4,
  plane: 2.6,
  boat: 7.6, // above the mast
  speedboat: 2.4,
  drone: 1.6,
  board: 2.3,
  surf: 2.2,
  bird: 2.2
};

type Avatar = {
  info: RemoteInfo;
  root: THREE.Group; // positioned/rotated by interpolation
  tag: THREE.Sprite;
  mode: PlayerMode | null;
  bodies: Partial<Record<PlayerMode, THREE.Group>>; // lazily built embodiments
  rig: Rig | null; // character rig of the current embodiment (walk/board/drive)
  buffer: NetSample[];
  strideT: number;
  animT: number;
  speed: number; // from the last snapshot (drives the walk cycle)
  vy: number; // vertical velocity estimate (air poses)
  ride: number; // driver id while riding shotgun (0 = not riding)
  avatar: AvatarTraits;
  avatarKey: string;
  board: BoardConfig;
  boardKey: string;
  scooter: ScooterConfig;
  scooterKey: string;
  car: CarConfig;
  carKey: string;
  surfboard: SurfboardConfig;
  surfboardKey: string;
};

const TMP = {
  pa: new THREE.Vector3(),
  pb: new THREE.Vector3(),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion()
};

function avatarForInfo(info: RemoteInfo): AvatarTraits {
  return info.avatar ?? avatarFromSeed(info.id);
}

function boardForInfo(info: RemoteInfo): BoardConfig {
  return info.board ? normalizeBoardConfig(info.board) : boardFromSeed(info.id);
}

function scooterForInfo(info: RemoteInfo): ScooterConfig {
  return info.scooter ? normalizeScooterConfig(info.scooter) : scooterFromSeed(info.id);
}

function carForInfo(info: RemoteInfo): CarConfig {
  return info.car ? normalizeCarConfig(info.car) : carFromSeed(info.id);
}

function surfboardForInfo(info: RemoteInfo): SurfboardConfig {
  return info.surfboard ? normalizeSurfboardConfig(info.surfboard) : surfboardFromSeed(info.id);
}

export class RemotePlayers {
  readonly avatars = new Map<number, Avatar>();

  /** My server id — lets ridePose resolve "riding MY car" via localDriveMesh. */
  selfId = 0;
  /** The local player's car mesh while driving (null otherwise), set by main. */
  localDriveMesh: () => THREE.Group | null = () => null;
  /** Local render position for distance-gating optional remote cosmetics. */
  localPlayerPosition: () => THREE.Vector3 | null = () => null;

  #scene: THREE.Scene;
  #protos: Partial<Record<PlayerMode, THREE.Group>> = {};
  #passengerSeat = new THREE.Vector3(0.42, 0.55, 0.66); // driver seat mirrored across x
  #tagsVisible = true;
  #surfAssetsEnabled = false;
  #scooterAssetsEnabled = false;
  #carAssetsEnabled = false;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    // prototypes share the exact material instances the clones will use;
    // built up front so nothing compiles at first join
    // boards are NOT prototyped: each remote builds its own from their config
    // (same material classes as the local player's board, so nothing compiles)
    this.#protos = {
      plane: buildPlaneMesh(),
      boat: buildBoatMesh(),
      speedboat: buildSpeedboatMesh(),
      drone: buildDroneMesh()
    };
  }

  #walkScratch: { x: number; z: number }[] = [];

  /** Walking avatars' XZ for the per-frame personal-space pass — reuses one
   *  scratch array + slot objects so the hot loop allocates nothing (the old
   *  positions().filter() built two arrays + N objects every frame). */
  walkingPositions(): readonly { x: number; z: number }[] {
    const out = this.#walkScratch;
    let n = 0;
    for (const a of this.avatars.values()) {
      if (a.mode !== "walk") continue;
      const slot = out[n] ?? (out[n] = { x: 0, z: 0 });
      slot.x = a.root.position.x;
      slot.z = a.root.position.z;
      n++;
    }
    out.length = n;
    return out;
  }

  /** Everything the minimap needs, no THREE types. */
  positions(): { id: number; name: string; hue: number; x: number; z: number; mode: PlayerMode }[] {
    const out = [];
    for (const a of this.avatars.values()) {
      if (!a.mode) continue; // no snapshot yet
      out.push({ id: a.info.id, name: a.info.name, hue: a.info.hue, x: a.root.position.x, z: a.root.position.z, mode: a.mode });
    }
    return out;
  }

  /** HUD locator targets, including altitude for screen projection. */
  locatorTargets(): { id: number; name: string; hue: number; x: number; y: number; z: number; mode: PlayerMode }[] {
    const out = [];
    for (const a of this.avatars.values()) {
      if (!a.mode || !a.root.visible) continue;
      const p = a.root.position;
      out.push({ id: a.info.id, name: a.info.name, hue: a.info.hue, x: p.x, y: p.y, z: p.z, mode: a.mode });
    }
    return out;
  }

  /** World position of one player (teleport target), or null. */
  positionOf(id: number): THREE.Vector3 | null {
    const a = this.avatars.get(id);
    return a?.mode ? a.root.position : null;
  }

  /** Live pose + mode of one player — teleport matches their altitude and embodiment. */
  stateOf(id: number): { x: number; y: number; z: number; mode: PlayerMode } | null {
    const a = this.avatars.get(id);
    if (!a?.mode || !a.root.visible) return null;
    const p = a.root.position;
    return { x: p.x, y: p.y, z: p.z, mode: a.mode };
  }

  /** Whether a remote avatar is currently occupying this driver's rear seat. */
  hasPassenger(driverId: number): boolean {
    if (driverId <= 0) return false;
    for (const avatar of this.avatars.values()) {
      if (avatar.ride === driverId && avatar.root.visible) return true;
    }
    return false;
  }

  /** Nearest player driving a vehicle with a passenger seat. */
  nearestDriver(pos: THREE.Vector3, maxDist: number): { id: number; name: string } | null {
    let best: { id: number; name: string } | null = null;
    let bestD = maxDist;
    for (const a of this.avatars.values()) {
      if ((a.mode !== "drive" && a.mode !== "scooter") || !a.root.visible) continue;
      const d = a.root.position.distanceTo(pos);
      if (d < bestD) {
        bestD = d;
        best = { id: a.info.id, name: a.info.name };
      }
    }
    return best;
  }

  /**
   * Passenger-seat world pose of a driver's car — this viewer's live view of
   * it (interpolated remote car, or the local player's own mesh when riding
   * MY car), so a glued passenger never lags out of the cabin. False when the
   * driver is gone or not driving; callers treat that as "ride over".
   */
  ridePose(driverId: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    if (driverId === this.selfId && this.selfId) {
      const m = this.localDriveMesh();
      if (!m) return false;
      const passenger = m.userData.passengerSeat as [number, number, number] | undefined;
      const c = m.userData.cockpit as Cockpit | undefined;
      if (passenger) outPos.set(...passenger);
      else if (c) outPos.set(-c.seat[0], c.seat[1], c.seat[2]);
      else outPos.copy(this.#passengerSeat);
      outQuat.copy(m.quaternion);
      outPos.applyQuaternion(outQuat).add(m.position);
      return true;
    }
    const a = this.avatars.get(driverId);
    if (!a || (a.mode !== "drive" && a.mode !== "scooter") || !a.root.visible) return false;
    const body = a.bodies[a.mode];
    const passenger = body?.userData.passengerSeat as [number, number, number] | undefined;
    if (passenger) outPos.set(...passenger);
    else outPos.copy(this.#passengerSeat);
    outPos.applyQuaternion(a.root.quaternion).add(a.root.position);
    outQuat.copy(a.root.quaternion);
    return true;
  }

  /** Voice indicator: tint the name tag green while that player is speaking. */
  setSpeaking(id: number, on: boolean) {
    const a = this.avatars.get(id);
    if (a) a.tag.material.color.set(on ? 0x8cffa4 : 0xffffff);
  }

  /** Immersive mode: hide every name tag (world sprites, not HUD). */
  setTagsVisible(on: boolean) {
    if (this.#tagsVisible === on) return;
    this.#tagsVisible = on;
    for (const a of this.avatars.values()) a.tag.visible = on;
  }

  /**
   * Unlock remote surfboard art only after this client activates surfing.
   * Individual boards still hydrate only inside the immediate 180 m space;
   * distant roster entries keep their procedural fallback and request nothing.
   */
  setSurfboardAssetsEnabled(enabled: boolean) {
    this.#surfAssetsEnabled = enabled;
  }

  /** Remote scooter art follows the same local-first, nearby-only contract. */
  setScooterAssetsEnabled(enabled: boolean) {
    this.#scooterAssetsEnabled = enabled;
  }

  /** Remote car art follows the same local-first, nearby-only contract. */
  setCarAssetsEnabled(enabled: boolean) {
    this.#carAssetsEnabled = enabled;
  }

  add(info: RemoteInfo) {
    if (this.avatars.has(info.id)) return;
    const root = new THREE.Group();
    root.visible = false; // until the first snapshot places it
    const tag = makeTag(info.name, info.hue);
    tag.visible = this.#tagsVisible;
    tag.position.y = TAG_Y.walk;
    root.add(tag);
    this.#scene.add(root);
    const av = avatarForInfo(info);
    const bd = boardForInfo(info);
    const sc = scooterForInfo(info);
    const car = carForInfo(info);
    const surf = surfboardForInfo(info);
    this.avatars.set(info.id, {
      info,
      root,
      tag,
      mode: null,
      bodies: {},
      rig: null,
      buffer: [],
      strideT: 0,
      animT: Math.random() * 10,
      speed: 0,
      vy: 0,
      ride: 0,
      avatar: av,
      avatarKey: avatarKey(av),
      board: bd,
      boardKey: boardVisualKey(bd),
      scooter: sc,
      scooterKey: scooterKey(sc),
      car,
      carKey: carKey(car),
      surfboard: surf,
      surfboardKey: surfboardVisualKey(surf)
    });
  }

  rename(info: RemoteInfo) {
    const a = this.avatars.get(info.id);
    if (!a) return;
    a.info = info;
    const y = a.tag.position.y;
    a.root.remove(a.tag);
    a.tag.material.map?.dispose();
    a.tag.material.dispose();
    a.tag = makeTag(info.name, info.hue);
    a.tag.visible = this.#tagsVisible;
    a.tag.position.y = y;
    a.root.add(a.tag);
  }

  updateAvatar(info: RemoteInfo) {
    const a = this.avatars.get(info.id);
    if (!a) return;
    a.info = info;
    const next = avatarForInfo(info);
    const key = avatarKey(next);
    if (key === a.avatarKey) return;
    a.avatar = next;
    a.avatarKey = key;
    for (const body of Object.values(a.bodies)) {
      const rig = body?.userData.remoteRig as Rig | undefined;
      if (rig) applyAvatarToRig(rig, next);
    }
  }

  /** They recustomized their hoverboard: tear down the old build, and if
   * they're riding it right now, re-embody so the swap is instant. */
  updateBoard(info: RemoteInfo) {
    const a = this.avatars.get(info.id);
    if (!a) return;
    a.info = info;
    const next = boardForInfo(info);
    const key = boardVisualKey(next);
    a.board = next;
    if (key === a.boardKey) return;
    a.boardKey = key;
    const old = a.bodies.board;
    if (!old) return;
    a.root.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    delete a.bodies.board;
    if (a.mode === "board") {
      a.mode = null; // force #embody to rebuild from the new config
      this.#embody(a, "board");
    }
  }

  updateScooter(info: RemoteInfo) {
    const a = this.avatars.get(info.id);
    if (!a) return;
    a.info = info;
    const next = scooterForInfo(info);
    const key = scooterKey(next);
    a.scooter = next;
    if (key === a.scooterKey) return;
    a.scooterKey = key;
    const old = a.bodies.scooter;
    if (!old) return;
    a.root.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    delete a.bodies.scooter;
    if (a.mode === "scooter") {
      a.mode = null;
      this.#embody(a, "scooter");
    }
  }

  updateCar(info: RemoteInfo) {
    const a = this.avatars.get(info.id);
    if (!a) return;
    a.info = info;
    const next = carForInfo(info);
    const key = carKey(next);
    a.car = next;
    if (key === a.carKey) return;
    a.carKey = key;
    const old = a.bodies.drive;
    if (!old) return;
    a.root.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    delete a.bodies.drive;
    if (a.mode === "drive") {
      a.mode = null;
      this.#embody(a, "drive");
    }
  }

  /** They changed their surfboard. Surfboards are built per remote rather than
   * cloned from a prototype so userData, generated decals, and owned GPU
   * resources cannot leak between players. */
  updateSurfboard(info: RemoteInfo) {
    const a = this.avatars.get(info.id);
    if (!a) return;
    a.info = info;
    const next = surfboardForInfo(info);
    const key = surfboardVisualKey(next);
    a.surfboard = next;
    if (key === a.surfboardKey) return;
    a.surfboardKey = key;
    const old = a.bodies.surf;
    if (!old) return;
    a.root.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    delete a.bodies.surf;
    if (a.mode === "surf") {
      a.mode = null;
      this.#embody(a, "surf");
    }
  }

  remove(id: number) {
    const a = this.avatars.get(id);
    if (!a) return;
    this.avatars.delete(id);
    this.#scene.remove(a.root);
    a.tag.material.map?.dispose();
    a.tag.material.dispose();
    // Per-player customizable vehicle builds own their resources.
    (a.bodies.drive?.userData.dispose as (() => void) | undefined)?.();
    (a.bodies.board?.userData.dispose as (() => void) | undefined)?.();
    (a.bodies.scooter?.userData.dispose as (() => void) | undefined)?.();
    (a.bodies.surf?.userData.dispose as (() => void) | undefined)?.();
  }

  sample(id: number, s: NetSample) {
    const a = this.avatars.get(id);
    if (!a) return;
    const buf = a.buffer;
    // server timestamps are monotonic per tick; guard against reordering anyway
    if (buf.length && s.t <= buf[buf.length - 1].t) return;
    buf.push(s);
  }

  /** Lazily build/show the embodiment for a mode; hide the previous one. */
  #embody(a: Avatar, mode: PlayerMode) {
    if (a.mode === mode) return;
    if (a.mode) {
      const prev = a.bodies[a.mode];
      if (prev) setEmbodimentVisible(prev, false);
    }
    a.mode = mode;
    a.rig = null;
    let body = a.bodies[mode];
    if (!body) {
      body = this.#buildBody(a, mode);
      a.bodies[mode] = body;
      a.root.add(body);
    }
    setEmbodimentVisible(body, true);
    a.rig = (body.userData.remoteRig as Rig) ?? null;
    a.tag.position.y = TAG_Y[mode];
  }

  #buildBody(a: Avatar, mode: PlayerMode): THREE.Group {
    if (mode === "walk") {
      const g = new THREE.Group();
      const rig = buildRig(a.avatar);
      g.add(rig.group);
      g.userData.remoteRig = rig;
      return g;
    }
    if (mode === "bird") {
      // GLB with its own skeleton — clone() breaks skinning, so each remote
      // loads its own copy (served from HTTP cache after the first)
      return buildBirdMesh();
    }
    if (mode === "board") {
      // built fresh from their config (not cloned) — clone() JSON-snapshots
      // userData, which would sever the boardAnim/dispose contracts
      const g = buildBoardMesh(a.board);
      const rig = buildRig(a.avatar);
      rig.group.rotation.order = "ZYX";
      rig.group.rotation.y = 1.05; // surf stance across the deck (player.ts)
      rig.group.position.y = 0.93;
      g.add(rig.group);
      g.userData.remoteRig = rig;
      return g;
    }
    if (mode === "surf") {
      // Fresh build: surfboard materials may contain player-selected generated
      // textures/decals and the root's dispose callback owns those resources.
      const g = buildSurfboardMesh(a.surfboard);
      // Roster/embodiment hydration stays allocation-only. Optional PNG art is
      // distance-gated in update() after the local surfing experience unlocks it.
      const rig = buildRig(a.avatar);
      rig.group.rotation.order = "ZYX";
      rig.group.rotation.y = 1.05;
      rig.group.position.y = 0.93;
      g.add(rig.group);
      g.userData.remoteRig = rig;
      return g;
    }
    if (mode === "scooter") {
      const g = buildScooterMesh(a.scooter);
      const rig = buildRig(a.avatar);
      const cockpit = g.userData.cockpit as Cockpit;
      rig.group.position.set(...cockpit.seat);
      g.add(rig.group);
      g.userData.remoteRig = rig;
      return g;
    }
    if (mode === "drive") {
      const g = buildCarMesh(a.car);
      const cockpit = g.userData.cockpit as Cockpit | undefined;
      if (cockpit && !cockpit.hide) {
        const rig = buildRig(a.avatar);
        rig.group.position.set(...cockpit.seat);
        g.add(rig.group);
        g.userData.remoteRig = rig;
      }
      return g;
    }
    const proto = this.#protos[mode]!;
    const g = proto.clone(true);
    if (mode === "plane" || mode === "speedboat") {
      const c = proto.userData.cockpit as Cockpit | undefined;
      if (c && !c.hide) {
        const rig = buildRig(a.avatar);
        rig.group.position.set(c.seat[0], c.seat[1], c.seat[2]);
        g.add(rig.group);
        g.userData.remoteRig = rig;
      }
    }
    // the clone's own animated parts (props/yoke) — resolved by name, the
    // userData route would have JSON-snapshotted THREE refs through clone()
    if (mode === "plane") g.userData.planeAnim = collectPlaneAnim(g);
    return g;
  }

  /** Advance interpolation + rig animation. Call once per rendered frame. */
  update(dt: number) {
    const renderT = performance.now() - INTERP_DELAY_MS;
    for (const a of this.avatars.values()) {
      const buf = a.buffer;
      if (buf.length === 0) continue;

      // drop history we've already played past
      while (buf.length > 2 && buf[1].t < renderT - BUFFER_KEEP_MS) buf.shift();

      // bracketing pair around renderT
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > renderT) i--;
      const b = buf[Math.min(i, buf.length - 1)];
      const prev = buf[Math.max(0, Math.min(i - 1, buf.length - 2))];
      let alpha = 1;
      let from = b;
      if (prev !== b && b.t > prev.t) {
        if (renderT <= b.t) {
          from = prev;
          alpha = THREE.MathUtils.clamp((renderT - prev.t) / (b.t - prev.t), 0, 1);
        }
        // renderT past the newest sample: hold the last pose (no extrapolation)
      }

      this.#embody(a, b.mode);
      TMP.pa.set(from.x, from.y, from.z);
      TMP.pb.set(b.x, b.y, b.z);
      a.root.position.lerpVectors(TMP.pa, TMP.pb, alpha);
      TMP.qa.set(from.qx, from.qy, from.qz, from.qw);
      TMP.qb.set(b.qx, b.qy, b.qz, b.qw);
      a.root.quaternion.slerpQuaternions(TMP.qa, TMP.qb, alpha);
      // riding shotgun: snap to this viewer's live view of the driver's car
      // (the transmitted pose stays as the fallback when the driver isn't
      // visible here). Drivers processed later in the map use last frame's
      // root — one render frame of lag, invisible at 12 Hz sampling.
      a.ride = b.ride ?? 0;
      if (a.ride && this.ridePose(a.ride, TMP.pa, TMP.qa)) {
        a.root.position.copy(TMP.pa);
        a.root.quaternion.copy(TMP.qa);
      }
      a.root.visible = true;

      if (a.mode === "surf" && this.#surfAssetsEnabled) {
        const local = this.localPlayerPosition();
        const body = a.bodies.surf;
        if (
          local &&
          body &&
          !body.userData.surfAssetsActivated &&
          a.root.position.distanceToSquared(local) <= 180 * 180
        ) {
          body.userData.surfAssetsActivated = true;
          void activateSurfboardAssets(body);
        }
      }
      if (a.mode === "scooter" && this.#scooterAssetsEnabled) {
        const local = this.localPlayerPosition();
        const body = a.bodies.scooter;
        if (
          local &&
          body &&
          !body.userData.scooterAssetsActivated &&
          a.root.position.distanceToSquared(local) <= 180 * 180
        ) {
          body.userData.scooterAssetsActivated = true;
          void activateScooterAssets(body);
        }
      }
      if (a.mode === "drive" && this.#carAssetsEnabled) {
        const local = this.localPlayerPosition();
        const body = a.bodies.drive;
        if (
          local &&
          body &&
          !body.userData.carAssetsActivated &&
          a.root.position.distanceToSquared(local) <= 180 * 180
        ) {
          body.userData.carAssetsActivated = true;
          void activateCarAssets(body);
        }
      }

      // motion estimate for animation (from the buffer, not frame deltas)
      a.speed = b.speed;
      a.vy = prev !== b && b.t > prev.t ? ((b.y - prev.y) / (b.t - prev.t)) * 1000 : 0;
      this.#animate(a, dt);
    }
  }

  #animate(a: Avatar, dt: number) {
    a.animT += dt;
    if (a.mode === "plane") {
      const anim = a.bodies.plane?.userData.planeAnim as PlaneAnim | undefined;
      if (anim) for (const p of anim.props) p.rotation.z += dt * (7 + a.speed * 0.55);
    }
    if (a.mode === "surf") {
      const body = a.bodies.surf;
      if (body) animateSurfboard(body, dt, a.animT);
    }
    if (a.mode === "drive") {
      const body = a.bodies.drive;
      if (body) animateCar(body, dt, a.speed, 0);
    }
    const rig = a.rig;
    if (!rig || !a.mode) return;
    if (a.mode === "walk") {
      if (a.ride) {
        // passenger: seated, no wheel — before the vy check (a car on a hill
        // would read as airborne)
        poseDrive(rig, 0, a.animT, false);
        return;
      }
      const h = a.speed;
      if (Math.abs(a.vy) > 3.2) {
        poseAir(rig);
      } else if (h > 0.35) {
        a.strideT += dt * (3.0 + h * 1.05);
        poseWalk(rig, a.strideT, THREE.MathUtils.clamp((h - 5.2) / 6.3, 0, 1));
      } else {
        poseIdle(rig, a.animT);
      }
    } else if (a.mode === "board") {
      const crouch = Math.min(1, a.speed / 34);
      poseRide(rig, 0, crouch, Math.abs(a.vy) > 4, a.animT);
      const body = a.bodies.board;
      if (body) animateBoard(body, dt, a.animT, a.speed);
    } else if (a.mode === "surf") {
      const crouch = Math.min(1, a.speed / 28);
      poseRide(rig, 0, crouch, Math.abs(a.vy) > 3.5, a.animT);
    } else if (a.mode === "scooter") {
      poseScooter(rig, 0, a.animT, Math.abs(a.vy) > 3.5);
      const body = a.bodies.scooter;
      if (body) animateScooter(body, dt, a.speed, 0, a.speed > 34);
    } else if (a.mode === "drive") {
      poseDrive(rig, 0, a.animT, false);
    } else if (a.mode === "plane") {
      poseDrive(rig, 0, a.animT, true);
    }
  }
}
