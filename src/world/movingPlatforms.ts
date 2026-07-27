/**
 * The moving surface a walker is currently standing on — the ghost ship deck
 * today, any future lift or ferry deck tomorrow.
 *
 * A velocity-driven walk controller and a moving kinematic floor are a bad
 * pair by default. The controller writes the capsule's world velocity outright
 * every fixed step, so a walker who is not pressing a key is asking to stand
 * still *in the world* while the deck slides out from under them at the ship's
 * speed. Teleporting the capsule back onto its deck spot each frame — the
 * obvious fix, and the one this replaced — does not work either: a hard
 * `setBodyTransform` re-injects whatever overlap the previous step left, so the
 * capsule burrows into the deck, the solver's overlap push-out fires as an
 * upward impulse, and the walker is launched off a deck they were standing on.
 *
 * So the platform publishes the world velocity of the deck-fixed point under
 * the walker, and the walk controller works in the deck's frame instead: input
 * and gravity are relative to the deck, and the platform's own motion is added
 * back at the end. The capsule and the floor then move together, the solver
 * only ever resolves the small residual, and the ship's speed stops being
 * something that can knock anybody off.
 *
 * Registration is a per-frame runtime write rather than a static table: the
 * ghost ship is an optional lazily-loaded chunk (docs/LAZY_LOADING.md), and a
 * walker who is not aboard anything costs one null check.
 */

export type MovingPlatform = {
  readonly id: string;
  /**
   * True for a world point standing on this deck — or falling far enough down
   * the deck's own footprint that it is going to land there.
   */
  aboard(x: number, y: number, z: number): boolean;
};

const platforms: MovingPlatform[] = [];

/** Register a rideable deck; call the returned function to remove it again. */
export function registerMovingPlatform(platform: MovingPlatform): () => void {
  if (!platforms.includes(platform)) platforms.push(platform);
  return () => {
    const index = platforms.indexOf(platform);
    if (index >= 0) platforms.splice(index, 1);
  };
}

/**
 * The deck a world point is riding, or null. Asked by anything that would
 * otherwise treat the column under a rider as open world — the walk entry's
 * shore hop most of all, since the ghost ship spends much of its route over
 * the bay and hopping a rider ashore from its deck drops them a few hundred
 * metres inland and several hundred down.
 */
export function movingPlatformAt(x: number, y: number, z: number): MovingPlatform | null {
  for (const platform of platforms) {
    if (platform.aboard(x, y, z)) return platform;
  }
  return null;
}

export type PlatformCarry = {
  /** World velocity of the platform-fixed point under the walker (m/s). */
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  /** Platform yaw rate (rad/s) — an idle rider's facing turns with the deck. */
  readonly yawRate: number;
};

const carry = { vx: 0, vy: 0, vz: 0, yawRate: 0 };
let riding = false;

/**
 * Publish (or clear) this frame's carry. The owning platform must call this
 * every frame it is alive — including with `null` the moment its rider steps
 * off — and once more from its dispose path, since a stale carry would keep
 * pushing a walker who is no longer standing on anything.
 */
export function setWalkerPlatformCarry(next: PlatformCarry | null): void {
  riding = next !== null;
  if (!next) return;
  carry.vx = next.vx;
  carry.vy = next.vy;
  carry.vz = next.vz;
  carry.yawRate = next.yawRate;
}

/** The deck under the walker's feet this step, or null when they are on land. */
export function walkerPlatformCarry(): PlatformCarry | null {
  return riding ? carry : null;
}
