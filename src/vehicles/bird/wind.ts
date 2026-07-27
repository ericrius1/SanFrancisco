import { uniform } from "three/tsl";

/** GPU plumage inputs, written once per phoenix update (see `publishFeatherDrive`). */
export const featherWind = uniform(0.3);
export const featherAirspeed = uniform(0.2);
export const featherBeat = uniform(0);

/** What one phoenix wants the shared plumage uniforms to read this step. */
export type FeatherDrive = {
  /** 0..1 how hard the bird is working — broad feather energy */
  wind: number;
  /** 0..1 airspeed — the aft stream bias on the tips */
  airspeed: number;
  /** 0..1 power-stroke impulse, the beat the primaries chatter on */
  beat: number;
};

/** Who gets to drive the shared uniforms. Higher wins. */
export const FEATHER_RANK = { nearby: 0, local: 1 } as const;

// A phoenix material graph is compiled per loaded GLB, but every one of them
// reads THESE uniform nodes, so only one bird can drive the feathers at a time.
// The bird you are flying outranks any you are merely watching (or sitting on);
// among the rest, the caller nominates one — normally the nearest. A claim
// lapses shortly after its owner stops publishing, so dismounting or flying out
// of range hands the feathers over without any explicit release.
const CLAIM_HOLD_MS = 300;
let claimRank = -1;
let claimAt = -Infinity;

export function publishFeatherDrive(rank: number, drive: FeatherDrive) {
  const now = performance.now();
  if (rank < claimRank && now - claimAt < CLAIM_HOLD_MS) return;
  claimRank = rank;
  claimAt = now;
  featherWind.value = drive.wind;
  featherAirspeed.value = drive.airspeed;
  featherBeat.value = drive.beat;
}
