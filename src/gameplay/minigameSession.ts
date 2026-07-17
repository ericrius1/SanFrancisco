import type { PlayerMode } from "../player/types";

export type MinigameOrigin = {
  x: number;
  y: number;
  z: number;
  facing: number;
  mode: PlayerMode;
};

export type MinigameSessionSnapshot = {
  id: string;
  label: string;
  origin: MinigameOrigin;
};

export type MinigameParticipant = {
  id: string;
  label: string;
  isActive(): boolean;
  /** Release activity-owned UI, props, poses, movement modifiers, and input. */
  release(): void;
};

const copyOrigin = (origin: Readonly<MinigameOrigin>): MinigameOrigin => ({ ...origin });

/**
 * Tracks the pre-input pose for whichever registered minigame becomes active.
 * Navigation and the HUD exit button both call releaseForNavigation(), so every
 * player-state mutation follows one teardown path before relocation commits.
 */
export class MinigameSessionController {
  #participants: MinigameParticipant[] = [];
  #session: MinigameSessionSnapshot | null = null;
  #frameOrigin: MinigameOrigin | null = null;
  #resetPlayerState: () => void;
  #onChange: (session: Readonly<MinigameSessionSnapshot> | null) => void;

  constructor(options: {
    resetPlayerState: () => void;
    onChange?: (session: Readonly<MinigameSessionSnapshot> | null) => void;
  }) {
    this.#resetPlayerState = options.resetPlayerState;
    this.#onChange = options.onChange ?? (() => {});
  }

  register(participant: MinigameParticipant): void {
    if (this.#participants.some(({ id }) => id === participant.id)) {
      throw new Error(`Minigame participant already registered: ${participant.id}`);
    }
    this.#participants.push(participant);
  }

  /** Snapshot the player's pose before this frame's interactions can start a game. */
  beginFrame(origin: Readonly<MinigameOrigin>): void {
    this.#frameOrigin = copyOrigin(origin);
    this.#sync(origin);
  }

  /** Detect starts/exits caused by this frame and update the HUD affordance. */
  endFrame(origin: Readonly<MinigameOrigin>): void {
    this.#sync(this.#frameOrigin ?? origin);
    this.#frameOrigin = null;
  }

  get current(): Readonly<MinigameSessionSnapshot> | null {
    return this.#session;
  }

  /**
   * Canonical teardown for both teleports and the explicit minigame exit button.
   * Always applies the player-level reset, even when an activity forgot to
   * report itself active, so stale held gear cannot survive a relocation.
   */
  releaseForNavigation(fallbackOrigin: Readonly<MinigameOrigin>): MinigameSessionSnapshot | null {
    this.#sync(this.#frameOrigin ?? fallbackOrigin);
    const snapshot = this.#session
      ? { ...this.#session, origin: copyOrigin(this.#session.origin) }
      : null;

    for (const participant of this.#participants) {
      if (!participant.isActive()) continue;
      try {
        participant.release();
      } catch (error) {
        console.warn(`[minigame] failed to release ${participant.id}`, error);
      }
    }
    this.#resetPlayerState();
    this.#setSession(null);
    this.#frameOrigin = null;
    return snapshot;
  }

  #sync(origin: Readonly<MinigameOrigin>): void {
    const active = this.#participants.find((participant) => participant.isActive());
    if (!active) {
      this.#setSession(null);
      return;
    }
    if (this.#session) return;
    this.#setSession({
      id: active.id,
      label: active.label,
      origin: copyOrigin(origin)
    });
  }

  #setSession(session: MinigameSessionSnapshot | null): void {
    if (
      this.#session?.id === session?.id &&
      this.#session?.origin.x === session?.origin.x &&
      this.#session?.origin.y === session?.origin.y &&
      this.#session?.origin.z === session?.origin.z &&
      this.#session?.origin.facing === session?.origin.facing &&
      this.#session?.origin.mode === session?.origin.mode
    ) {
      return;
    }
    this.#session = session;
    this.#onChange(session);
  }
}
