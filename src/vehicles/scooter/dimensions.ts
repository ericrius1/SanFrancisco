import { rideHeightFromContact } from "../shared";
/** Wheel hub Y and tire outer radius in scooter-local space. */
export const SCOOTER_WHEEL_HUB_Y = 0.055;
export const SCOOTER_WHEEL_OUTER_RADIUS = 0.39 + 0.105;
export const SCOOTER_CONTACT_Y = SCOOTER_WHEEL_HUB_Y - SCOOTER_WHEEL_OUTER_RADIUS;
export const SCOOTER_RIDE_HEIGHT = rideHeightFromContact(SCOOTER_CONTACT_Y);

