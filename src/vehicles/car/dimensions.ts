import { rideHeightFromContact } from "../shared";
/** Wheel hub and actual tire radius in mesh space (root = physics body centre). */
export const CAR_WHEEL_HUB_Y = -0.38;
export const CAR_WHEEL_RADIUS = 0.43;
export const CAR_CONTACT_Y = CAR_WHEEL_HUB_Y - CAR_WHEEL_RADIUS;
export const CAR_RIDE_HEIGHT = rideHeightFromContact(CAR_CONTACT_Y);

