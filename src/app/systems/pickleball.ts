import * as THREE from "three/webgpu";
import type { ChaseCamera } from "../../core/camera";
import { interactKeyLabel, type Input } from "../../core/input";
import type { FX } from "../../fx/fx";
import {
  createPickleball,
  PickleballAmbient,
  PickleballAudio,
  PickleballUI,
  PICKLEBALL_TUNING,
  type PickleballFrameResult,
  type PickleballInputIntent,
  type PickleballInteraction,
  type PickleballLocalPose,
  type PickleballSide
} from "../../gameplay/pickleball";
import type { GameSiteRegistration } from "../../gameplay/siteGate";
import type { createSiteGate } from "../../gameplay/siteGate";
import type { Net } from "../../net/net";
import type { RemotePlayers } from "../../net/remotes";
import type { AvatarTraits } from "../../player/avatar";
import type { Player } from "../../player/player";
import type { HUD } from "../../ui/hud";
import type { createNatureSoundscape } from "../../audio";
import {
  inGoldmanTennisSite,
  type GoldmanCourtAnchor,
  type GoldmanCourtRef
} from "../../world/goldenGateTennis";
import type { EmbodimentController } from "../player/embodimentController";

type GoldmanSite = {
  gameplayAnchor: GoldmanCourtAnchor;
  courtAnchors: ReadonlyMap<GoldmanCourtRef, GoldmanCourtAnchor>;
};

type Nature = ReturnType<typeof createNatureSoundscape>;
type SiteGate = ReturnType<typeof createSiteGate>;
type PickleballNetworkHandlers = Pick<
  Net,
  | "onPickleballSlots"
  | "onPickleballClaim"
  | "onPickleballRelease"
  | "onPickleballState"
  | "onPickleballInput"
>;

/**
 * Owns construction, local seating, relay authority, pose glue, HUD and audio
 * for the networked and ambient pickleball courts.
 */
export class PickleballController {
  game: ReturnType<typeof createPickleball> | null = null;
  ambient: PickleballAmbient | null = null;
  audio: PickleballAudio | null = null;
  ui: PickleballUI | null = null;

  #net: Net;
  #player: Player;
  #input: Input;
  #hud: HUD;
  #chase: ChaseCamera;
  #remotes: RemotePlayers;
  #embodiments: EmbodimentController;
  #getAvatar: () => AvatarTraits;
  #registration: GameSiteRegistration | null = null;

  #pendingClaim: PickleballSide | null = null;
  #pendingRelease: PickleballSide | null = null;
  #netSendAt = 0;
  #swingQueued = false;
  #promptSide: PickleballSide | null = null;
  #inputIntent: PickleballInputIntent = {};
  #localPose: PickleballLocalPose | null = null;
  #ambientSide: PickleballSide | null = null;
  #animationTime = 0;
  #up = new THREE.Vector3(0, 1, 0);
  #netPosition = new THREE.Vector3();
  #netQuaternion = new THREE.Quaternion();
  #networkHandlers: PickleballNetworkHandlers | null = null;

  constructor(opts: {
    goldman: GoldmanSite | null;
    scene: THREE.Scene;
    nature: Nature;
    daylight: () => boolean;
    fx: FX;
    siteGate: SiteGate;
    net: Net;
    player: Player;
    input: Input;
    hud: HUD;
    chase: ChaseCamera;
    remotes: RemotePlayers;
    embodiments: EmbodimentController;
    getAvatar: () => AvatarTraits;
  }) {
    this.#net = opts.net;
    this.#player = opts.player;
    this.#input = opts.input;
    this.#hud = opts.hud;
    this.#chase = opts.chase;
    this.#remotes = opts.remotes;
    this.#embodiments = opts.embodiments;
    this.#getAvatar = opts.getAvatar;

    const anchor = opts.goldman?.gameplayAnchor;
    if (anchor) {
      try {
        this.game = createPickleball({
          origin: { x: anchor.x, y: anchor.y, z: anchor.z },
          yaw: anchor.yaw,
          authoritative: true,
          seed: 1402
        });
        opts.scene.add(this.game.root);
        this.audio = new PickleballAudio(opts.nature);
        this.ui = new PickleballUI();
        const netCenter = new THREE.Vector3(anchor.x, anchor.y + 1, anchor.z);
        this.game.onEvent = (event) => {
          this.audio?.handle(event, netCenter);
          if (event.kind === "paddle") opts.fx.impactPuff(event.worldPosition);
          else if (event.kind === "point" || event.kind === "game") {
            this.ui?.applyEvent(event, this.game?.localSide ?? null);
          }
        };

        const refs: readonly GoldmanCourtRef[] = ["14A", "14C", "14D", "15"];
        const ambientAnchors = refs
          .map((ref) => ({ ref, anchor: opts.goldman?.courtAnchors.get(ref) }))
          .filter((entry): entry is { ref: GoldmanCourtRef; anchor: GoldmanCourtAnchor } => Boolean(entry.anchor));
        if (ambientAnchors.length > 0) {
          this.ambient = new PickleballAmbient({
            anchors: ambientAnchors,
            daylight: opts.daylight,
            audio: this.audio
          });
          this.ambient.onSeatEvent = (event) => this.ui?.applyEvent(event, this.#ambientSide);
          opts.scene.add(this.ambient.group);
        }

        const game = this.game;
        game.setActive(false);
        this.#registration = opts.siteGate.register({
          id: "pickleball",
          contains: (x, z, pad) => inGoldmanTennisSite(x, z, pad),
          activatePad: PICKLEBALL_TUNING.activateSitePad,
          deactivatePad: PICKLEBALL_TUNING.deactivateSitePad,
          keepAwake: () => game.localSide !== null || this.ambient?.seatedRef != null,
          setAwake: (on) => {
            game.setActive(on);
            this.ambient?.setAwake(on);
          },
          onWake: () => {
            if (this.#net.status === "online") this.#net.replayPickleball();
          }
        });
      } catch (error) {
        console.warn("[boot] pickleball game unavailable:", error);
        this.dispose();
        return;
      }
    }

    this.#installNetworkHandlers();
    this.syncSlots();
  }

  get playing(): boolean {
    return (this.game?.localSide != null) || this.ambient?.seatedRef != null;
  }

  get localPose(): PickleballLocalPose | null {
    return this.#localPose;
  }

  /** Prepare every normally sleeping court during the caller-owned quiet window. */
  async prepareRender(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene
  ): Promise<void> {
    const game = this.game;
    if (!game) return;
    const gameParent = game.root.parent;
    const ambientParent = this.ambient?.group.parent ?? null;
    game.root.removeFromParent();
    this.ambient?.group.removeFromParent();
    const gameWasActive = game.active;
    const restoreAmbient = this.ambient?.prepareWarmup();
    game.setActive(true);
    try {
      await renderer.compileAsync(game.root, camera, scene);
      if (this.ambient) await renderer.compileAsync(this.ambient.group, camera, scene);
    } finally {
      game.setActive(gameWasActive);
      restoreAmbient?.();
      gameParent?.add(game.root);
      if (this.ambient) ambientParent?.add(this.ambient.group);
    }
  }

  syncSlots(
    slots: readonly [number, number] = this.#net.pickleballSlots,
    authorityId = this.#net.pickleballAuthority
  ): void {
    if (!this.game) return;
    this.game.setSlotOwner(0, this.#ownerName(slots[0]));
    this.game.setSlotOwner(1, this.#ownerName(slots[1]));
    this.game.setAuthoritative(authorityId === 0 || authorityId === this.#net.selfId);
  }

  onWelcome(): void {
    this.syncSlots();
    this.#net.replayPickleball();
    const side = this.game?.localSide;
    if (side !== null && side !== undefined) {
      this.#pendingClaim = side;
      this.#net.claimPickleball(side);
    }
  }

  onOffline(): void {
    this.#pendingClaim = null;
    this.#pendingRelease = null;
    this.syncSlots();
  }

  releaseForNavigation(): boolean {
    if (this.ambient?.seatedRef != null) {
      const pose = this.ambient.exitCourt();
      this.#ambientSide = null;
      this.#localPose = null;
      if (pose) this.#restorePlayer(pose);
      else this.#player.setExternalEmbodimentHidden(false);
      return true;
    }
    const side = this.game?.localSide;
    if (side === null || side === undefined || !this.game) return false;
    if (this.#net.status === "online" && this.#net.selfId && this.#net.pickleballSlots[side] === this.#net.selfId) {
      this.#pendingRelease = side;
      this.#net.releasePickleball(side);
    }
    this.#finishExit(side);
    return true;
  }

  update(dt: number): boolean {
    const game = this.game;
    if (!game) return false;
    if (!game.active) {
      this.#localPose = null;
      this.#promptSide = null;
      this.#inputIntent = {};
      this.#ambientSide = null;
      this.ui?.setVisible(false);
      return false;
    }

    this.#animationTime += dt;
    let consumed = false;
    let seatFrame: PickleballFrameResult | null = null;
    let seatSide: PickleballSide | null = null;
    let prompt: PickleballInteraction | null = null;

    const netSide = game.localSide;
    const netInput = this.#buildInput(netSide ?? 0);
    this.#inputIntent = netInput;
    if (netInput.swing) this.#swingQueued = true;
    const netFrame = game.update(dt, this.#animationTime, this.#player.position, netInput);
    if (netSide !== null) {
      seatFrame = netFrame;
      seatSide = netSide;
    } else if (netFrame.interaction) {
      prompt = netFrame.interaction;
    }
    if (netFrame.requestedRelease !== null) consumed = this.#releaseSide();
    else if (netFrame.requestedSide !== null) {
      consumed = true;
      this.#requestSide(netFrame.requestedSide);
    }

    if (this.ambient) {
      const seated = this.ambient.seatedRef != null && this.#ambientSide !== null;
      const ambientInput = seated ? this.#buildInput(this.#ambientSide!) : undefined;
      const frame = this.ambient.update(dt, this.#animationTime, this.#player.position, ambientInput);
      if (frame.seat) {
        this.#inputIntent = ambientInput ?? this.#inputIntent;
        if (ambientInput?.swing) this.#swingQueued = true;
        if (frame.seat.frame.requestedRelease !== null && !consumed) {
          const pose = this.ambient.exitCourt();
          this.#ambientSide = null;
          consumed = true;
          if (pose) this.#restorePlayer(pose);
          else this.#player.setExternalEmbodimentHidden(false);
          this.#hud.message("Back to exploring", 1.8);
        } else {
          seatFrame = frame.seat.frame;
          seatSide = frame.seat.frame.localPose?.side ?? this.#ambientSide;
        }
      } else if (netSide === null && !prompt && frame.interaction) {
        prompt = frame.interaction;
        if (!consumed && this.#input.pressed("KeyE") && frame.interaction.available) {
          this.#embodiments.exitToWalk();
          if (this.ambient.enterCourt(frame.interaction.ref, frame.interaction.side, this.#getAvatar())) {
            this.#ambientSide = frame.interaction.side;
            this.#player.setExternalEmbodimentHidden(true);
            consumed = true;
            prompt = null;
            this.#hud.message(`You’re playing · WASD move · click/Space swings · ${interactKeyLabel()} leaves`, 3.4);
          }
        }
      }
    }

    this.#localPose = seatFrame?.localPose ?? null;
    const hudFrame = seatFrame ?? netFrame;
    this.ui?.setVisible(true);
    this.ui?.setScore(hudFrame.score, hudFrame.server, hudFrame.rally);
    this.ui?.setSeated(seatSide !== null, this.#input.padConnected);
    if (seatSide === null && prompt?.available) {
      if (this.#promptSide !== prompt.side) {
        this.#promptSide = prompt.side;
        this.#hud.message(prompt.prompt, 2.2);
      }
    } else {
      this.#promptSide = null;
    }
    return consumed;
  }

  applyPlayerPose(): void {
    const pose = this.#localPose;
    if (!pose) return;
    const y = pose.worldPosition.y + 0.58;
    this.#player.position.set(pose.worldPosition.x, y, pose.worldPosition.z);
    this.#player.renderPosition.copy(this.#player.position);
    this.#player.heading = pose.worldHeading + Math.PI;
    this.#player.velocity.set(0, 0, 0);
    this.#netQuaternion.setFromAxisAngle(this.#up, pose.worldHeading);
    this.#player.quaternion.copy(this.#netQuaternion);
    this.#player.renderQuaternion.copy(this.#netQuaternion);
    const mesh = this.#player.meshes.walk;
    mesh.position.copy(this.#player.renderPosition);
    mesh.quaternion.copy(this.#netQuaternion);
    this.#player.setExternalEmbodimentHidden(true);
  }

  hideClaimedRemoteAvatars(): void {
    const claimed = new Set(this.#net.pickleballSlots.filter((id) => id && id !== this.#net.selfId));
    for (const [id, remote] of this.#remotes.avatars) {
      const body = remote.mode ? remote.bodies[remote.mode] : undefined;
      if (body) body.visible = !claimed.has(id);
      remote.root.visible = Boolean(remote.mode);
    }
  }

  sendLocalPresence(speed = this.#player.speed): void {
    if (this.#localPose) {
      this.#netPosition.copy(this.#player.renderPosition);
      this.#netQuaternion.setFromAxisAngle(this.#up, this.#localPose.worldHeading);
      this.#net.sendState("walk", this.#netPosition, this.#netQuaternion, 0, 0);
      return;
    }
    this.#net.sendState(
      this.#player.mode,
      this.#player.meshes[this.#player.mode].position,
      this.#player.meshes[this.#player.mode].quaternion,
      speed,
      this.#embodiments.passengerOf ?? 0
    );
  }

  sendNetwork(): void {
    const game = this.game;
    if (!game || !game.active || this.#net.status !== "online") return;
    const now = performance.now() / 1000;
    if (now < this.#netSendAt) return;
    this.#netSendAt = now + 1 / 12;
    const side = game.localSide;
    if (this.#net.pickleballAuthority === this.#net.selfId) {
      this.#net.sendPickleballState(game.serializeState());
    } else if (side !== null && this.#net.pickleballSlots[side] === this.#net.selfId) {
      this.#net.sendPickleballInput(side, [
        this.#inputIntent.moveX ?? 0,
        this.#inputIntent.moveZ ?? 0,
        this.#swingQueued ? 1 : 0,
        this.#inputIntent.sprint ? 1 : 0,
        this.#inputIntent.aimX ?? 0,
        this.#inputIntent.aimZ ?? 0
      ]);
    }
    this.#swingQueued = false;
  }

  dispose(): void {
    if (this.#pendingClaim !== null && this.#net.status === "online" && this.#net.selfId) {
      // WebSocket messages are ordered: a release queued behind the in-flight
      // claim prevents an orphaned server slot after callbacks are detached.
      this.#net.releasePickleball(this.#pendingClaim);
    }
    this.releaseForNavigation();
    this.#detachNetworkHandlers();
    this.#registration?.dispose();
    this.#registration = null;
    this.#pendingClaim = null;
    this.#pendingRelease = null;
    this.#localPose = null;
    this.#ambientSide = null;
    this.#promptSide = null;
    this.#inputIntent = {};
    this.#swingQueued = false;
    this.#player.setExternalEmbodimentHidden(false);
    this.ambient?.dispose();
    this.ambient = null;
    this.game?.dispose();
    this.game = null;
    this.audio?.dispose();
    this.audio = null;
    this.ui?.dispose();
    this.ui = null;
  }

  #buildInput(side: PickleballSide): PickleballInputIntent {
    const moveX = this.#input.axis("KeyA", "KeyD");
    const moveTowardNet = this.#input.axis("KeyS", "KeyW");
    return {
      moveX,
      moveZ: moveTowardNet * (side === 1 ? -1 : 1),
      swing: this.#input.firePressed || this.#input.pressed("Space"),
      sprint: this.#input.down("ShiftLeft") || this.#input.down("ShiftRight"),
      aimX: moveX,
      aimZ: this.#input.down("KeyS") ? -0.35 : this.#input.down("KeyW") ? 0.78 : 0.42,
      interact: this.#input.pressed("KeyE"),
      exit: this.#input.pressed("KeyE")
    };
  }

  #restorePlayer(pose: PickleballLocalPose): void {
    this.#player.restoreState({
      mode: "walk",
      x: pose.worldPosition.x,
      y: pose.worldPosition.y + 0.58,
      z: pose.worldPosition.z,
      heading: pose.worldHeading + Math.PI
    });
    this.#chase.yaw = pose.worldHeading;
    this.#player.setExternalEmbodimentHidden(false);
  }

  #ownerName(id: number): string | null {
    if (!id) return null;
    if (id === this.#net.selfId) return this.#net.name;
    return this.#net.roster.get(id)?.name ?? `Player ${id}`;
  }

  #enterSide(side: PickleballSide): boolean {
    if (!this.game) return false;
    this.#embodiments.exitToWalk();
    if (!this.game.enterSide(side, this.#net.name)) return false;
    this.#player.setExternalEmbodimentHidden(true);
    return true;
  }

  #finishExit(side: PickleballSide): void {
    if (!this.game) return;
    const pose = this.#localPose;
    this.game.exitSide(side);
    this.#localPose = null;
    if (pose) this.#restorePlayer(pose);
    this.#player.setExternalEmbodimentHidden(false);
  }

  #requestSide(side: PickleballSide): void {
    if (!this.game || this.#pendingClaim !== null || this.game.localSide !== null) return;
    if (this.#net.status === "online" && this.#net.selfId) {
      this.#pendingClaim = side;
      this.#net.claimPickleball(side);
      this.#hud.message("Claiming pickleball side…", 1.4);
    } else if (this.#enterSide(side)) {
      this.#hud.message(`You’re playing · WASD move · click/Space swings · ${interactKeyLabel()} leaves`, 3.4);
    }
  }

  #releaseSide(): boolean {
    const side = this.game?.localSide;
    if (side === null || side === undefined || !this.game) return false;
    if (this.#net.status === "online" && this.#net.selfId && this.#net.pickleballSlots[side] === this.#net.selfId) {
      if (this.#pendingRelease === null) {
        this.#pendingRelease = side;
        this.#net.releasePickleball(side);
      }
    } else {
      this.#finishExit(side);
      this.#hud.message("Back to exploring", 1.8);
    }
    return true;
  }

  #installNetworkHandlers(): void {
    const handlers: PickleballNetworkHandlers = {
      onPickleballSlots: (slots, authorityId) => this.syncSlots(slots, authorityId),
      onPickleballClaim: (side, ownerId, ok) => {
        if (ok && ownerId === this.#net.selfId) {
          this.#pendingClaim = null;
          this.#enterSide(side);
          this.#hud.message(`You’re playing · WASD move · click/Space swings · ${interactKeyLabel()} leaves`, 3.4);
        } else if (!ok && this.#pendingClaim === side) {
          this.#pendingClaim = null;
          if (this.game?.localSide === side) this.#finishExit(side);
          this.#hud.message(`${this.#ownerName(ownerId) ?? "Another player"} already has that side`, 2.6);
        }
      },
      onPickleballRelease: (side, ownerId, ok) => {
        if (ok && (ownerId === this.#net.selfId || this.#pendingRelease === side)) {
          this.#pendingRelease = null;
          this.#finishExit(side);
          this.#hud.message("Back to exploring", 1.8);
        } else if (!ok && this.#pendingRelease === side) {
          this.#pendingRelease = null;
        }
      },
      onPickleballState: (ownerId, state) => {
        if (ownerId !== this.#net.selfId && this.game?.active) this.game.applyState(state);
      },
      onPickleballInput: (side, _ownerId, data) => {
        if (!this.game?.active) return;
        this.game.setRemoteInput(side, {
          moveX: data[0] ?? 0,
          moveZ: data[1] ?? 0,
          swing: (data[2] ?? 0) > 0.5,
          sprint: (data[3] ?? 0) > 0.5,
          aimX: data[4] ?? 0,
          aimZ: data[5] ?? 0
        });
      }
    };
    this.#networkHandlers = handlers;
    this.#net.onPickleballSlots = handlers.onPickleballSlots;
    this.#net.onPickleballClaim = handlers.onPickleballClaim;
    this.#net.onPickleballRelease = handlers.onPickleballRelease;
    this.#net.onPickleballState = handlers.onPickleballState;
    this.#net.onPickleballInput = handlers.onPickleballInput;
  }

  #detachNetworkHandlers(): void {
    const handlers = this.#networkHandlers;
    if (!handlers) return;
    if (this.#net.onPickleballSlots === handlers.onPickleballSlots) this.#net.onPickleballSlots = () => {};
    if (this.#net.onPickleballClaim === handlers.onPickleballClaim) this.#net.onPickleballClaim = () => {};
    if (this.#net.onPickleballRelease === handlers.onPickleballRelease) this.#net.onPickleballRelease = () => {};
    if (this.#net.onPickleballState === handlers.onPickleballState) this.#net.onPickleballState = () => {};
    if (this.#net.onPickleballInput === handlers.onPickleballInput) this.#net.onPickleballInput = () => {};
    this.#networkHandlers = null;
  }
}
