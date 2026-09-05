export const SKATE_RIDE_HEIGHT = 0.45;
/** How far the deck top hangs below the mesh origin. */
export const SKATE_DECK_DROP = 0.275;
/** Deck top down to the bottom of the wheels. */
export const SKATE_DECK_TO_WHEEL = 0.175;
/** Wheel bottoms relative to the mesh origin — exactly the ride height, so the
 *  urethane touches the road and nothing hovers. */
export const SKATE_CONTACT_Y = -(SKATE_DECK_DROP + SKATE_DECK_TO_WHEEL);
/** Rig root → sole bottom, for the equal-and-opposite leg pose (see poseSkate).
 *  hip pivot 0.08 + thigh 0.40 + shin-to-sole 0.425, minus the hip's own lift. */
const SOLE_DROP = 0.822;
/** Where a rider's rig root belongs so both soles land on the griptape. */
export const SKATE_RIG_ROOT_Y = SOLE_DROP - SKATE_DECK_DROP + 0.005;

