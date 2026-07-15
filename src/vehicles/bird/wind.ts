import { uniform } from "three/tsl";

/** GPU plumage inputs, written once per bird-controller update. */
export const featherWind = uniform(0.3);
export const featherAirspeed = uniform(0.2);
export const featherBeat = uniform(0);
