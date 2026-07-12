import * as THREE from "three/webgpu";
import type { AvatarTraits } from "../../player/avatar";
import { PickleballGame } from "./game";
import type { PickleballAudio } from "./audio";
import type {
  PickleballEvent,
  PickleballFrameResult,
  PickleballInputIntent,
  PickleballInteraction,
  PickleballLocalPose,
  PickleballSide
} from "./types";

/**
 * Ambient NPC pickleball: 2-3 extra LOCAL-ONLY matches on the other Goldman
 * mini courts, so the site reads like a real rec-center afternoon. Daytime:
 * every court rallies (distinct avatar seeds per court, so outfits vary).
 * Night: courts empty. Walk up to any NPC and press E to take over that seat —
 * same PickleballGame rules sim as the networked 14B court, just never synced.
 *
 * One update() drives the whole cluster and one setAwake(on) hangs it off the
 * existing pickleball site gate; asleep costs zero work (single boolean test).
 */

export type AmbientCourtAnchor = { x: number; y: number; z: number; yaw: number };

export type PickleballAmbientOptions = {
  /** Court refs + world anchors (goldenGateTennis courtAnchors entries). */
  anchors: { ref: string; anchor: AmbientCourtAnchor }[];
  /** True while NPCs should be out playing (e.g. sky.sunElevation > 0.05). */
  daylight: () => boolean;
  /** Shared court sound layer; ambient events are wired internally. */
  audio?: PickleballAudio;
};

export type PickleballAmbientInteraction = PickleballInteraction & { ref: string };

export type PickleballAmbientFrame = {
  /** Nearest joinable NPC across all ambient courts (null while seated). */
  interaction: PickleballAmbientInteraction | null;
  /** Frame result of the court the local player is seated on, if any. */
  seat: { ref: string; frame: PickleballFrameResult } | null;
};

type Court = {
  ref: string;
  game: PickleballGame;
  center: THREE.Vector3; // world-space court centre (audio fallback position)
};

const EMPTY_FRAME: PickleballAmbientFrame = Object.freeze({ interaction: null, seat: null });
const EMPTY_INPUT: Readonly<PickleballInputIntent> = Object.freeze({});

export class PickleballAmbient {
  /** Add once to the scene; each court's game root nests here. */
  readonly group = new THREE.Group();

  /** Events from the court the player is seated on (HUD wiring). */
  onSeatEvent: (event: PickleballEvent) => void = () => {};

  #courts: Court[] = [];
  #daylight: () => boolean;
  #audio: PickleballAudio | undefined;
  #awake = false;
  #playing = false; // awake && daylight — whether NPC matches actually run
  #seat: { ref: string; side: PickleballSide } | null = null;

  constructor(options: PickleballAmbientOptions) {
    this.group.name = "pickleball-ambient";
    this.#daylight = options.daylight;
    this.#audio = options.audio;
    for (const { ref, anchor } of options.anchors) {
      const game = new PickleballGame({
        origin: { x: anchor.x, y: anchor.y, z: anchor.z },
        yaw: anchor.yaw,
        authoritative: true,
        // distinct seed per court: different outfits AND decorrelated AI aim
        seed: 4200 + hashRef(ref) * 17
      });
      const court: Court = { ref, game, center: new THREE.Vector3(anchor.x, anchor.y + 1, anchor.z) };
      game.onEvent = (event) => {
        this.#audio?.handle(event, court.center);
        if (this.#seat?.ref === ref) this.onSeatEvent(event);
      };
      // register-asleep invariant (games construct active; the gate transitions)
      game.setActive(false);
      this.group.add(game.root);
      this.#courts.push(court);
    }
    this.#applyActivity();
  }

  /** Site-gate hook: main's existing pickleball GameSite drives the cluster. */
  setAwake(on: boolean): void {
    if (this.#awake === on) return;
    this.#awake = on;
    this.#applyActivity();
  }

  /** A live ambient seat must keep the site awake (gate keepAwake OR-term). */
  get seatedRef(): string | null {
    return this.#seat?.ref ?? null;
  }

  /** Nearest joinable athlete across the ambient courts (E-prompt source). */
  getInteraction(worldPosition: THREE.Vector3): PickleballAmbientInteraction | null {
    let nearest: PickleballAmbientInteraction | null = null;
    for (const court of this.#courts) {
      if (!court.game.active) continue;
      const hit = court.game.getInteraction(worldPosition);
      if (hit && (!nearest || hit.distance < nearest.distance)) {
        nearest = { ...hit, ref: court.ref };
      }
    }
    return nearest;
  }

  /** Take over a seat on an ambient court (local-only — no relay claim). The
   *  athlete puts on the player's own traits so you visibly become them. */
  enterCourt(ref: string, side: PickleballSide, traits?: AvatarTraits): boolean {
    const court = this.#courts.find((c) => c.ref === ref);
    if (!court || !court.game.active) return false;
    if (this.#seat) this.exitCourt();
    if (!court.game.enterSide(side, "You")) return false;
    if (traits) court.game.setAthleteTraits(side, traits);
    this.#seat = { ref, side };
    return true;
  }

  /** Leave the ambient seat; the NPC gets its seeded outfit back. Returns the
   *  athlete's last pose so the caller can restore the walking player there. */
  exitCourt(): PickleballLocalPose | null {
    const seat = this.#seat;
    if (!seat) return null;
    const court = this.#courts.find((c) => c.ref === seat.ref)!;
    const pose = court.game.localPose(seat.side);
    court.game.setAthleteTraits(seat.side, null);
    court.game.exitSide(seat.side);
    this.#seat = null;
    this.#applyActivity(); // a night seat kept its court alive — re-evaluate
    return pose;
  }

  /**
   * Single per-frame driver. `input` reaches only the seated court; all other
   * matches run pure AI. Asleep (and unseated) this is one boolean test.
   */
  update(
    dt: number,
    elapsed: number,
    playerPos: THREE.Vector3,
    input: PickleballInputIntent = EMPTY_INPUT
  ): PickleballAmbientFrame {
    if (!this.#awake && !this.#seat) return EMPTY_FRAME;
    const playing = this.#awake && this.#daylight();
    if (playing !== this.#playing) this.#applyActivity();

    let seat: PickleballAmbientFrame["seat"] = null;
    let interaction: PickleballAmbientInteraction | null = null;
    for (const court of this.#courts) {
      if (!court.game.active) continue;
      const seated = this.#seat?.ref === court.ref;
      // pass the player position only where it matters: the seated court (for
      // its own prompt/exit flow) — cross-court prompts come from the single
      // getInteraction scan below, not two extra world-matrix passes per court
      const frame = court.game.update(dt, elapsed, seated ? playerPos : null, seated ? input : EMPTY_INPUT);
      if (seated) seat = { ref: court.ref, frame };
    }
    if (!this.#seat) interaction = this.getInteraction(playerPos);
    return { interaction, seat };
  }

  dispose(): void {
    for (const court of this.#courts) court.game.dispose();
    this.#courts.length = 0;
    this.group.removeFromParent();
  }

  /** Awake + day = matches on. A live seat keeps ITS court on regardless.
   *  Sleeping/empty courts hide their roots and freeze the matrix pass. */
  #applyActivity(): void {
    this.#playing = this.#awake && this.#daylight();
    for (const court of this.#courts) {
      const on = (this.#playing || this.#seat?.ref === court.ref) && this.#awake;
      const wasOn = court.game.active;
      court.game.setActive(on);
      court.game.root.matrixWorldAutoUpdate = on;
      if (on && !wasOn) court.game.root.updateMatrixWorld(true);
    }
    this.group.visible = this.#awake;
  }
}

function hashRef(ref: string): number {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) | 0;
  return Math.abs(h) % 97;
}
