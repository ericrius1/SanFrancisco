import type { PlayerMode } from "../player/types";
import { PHOENIX_PASSENGER_CAPACITY } from "./bird/saddleContract";

/**
 * Single source of truth for which player vehicles can carry passengers and
 * how many. Everything in the shared-ride system — boarding prompts, seat
 * claims, pose glue, wire clamps — reads this table, so adding a passenger
 * seat to a vehicle is: author its `userData.passengerSeat(s)` anchor in the
 * mesh builder and list its capacity here.
 *
 * Wire constraint: the deployed relay (server/server.mjs) rejects state rows
 * whose player-ride seat exceeds 2, so no entry may exceed
 * MAX_PASSENGER_SEATS without a coordinated server change.
 */
export const PASSENGER_CAPACITY: Partial<Record<PlayerMode, number>> = {
  drive: 1,
  scooter: 1,
  bird: PHOENIX_PASSENGER_CAPACITY,
  boat: 2,
  speedboat: 1,
  plane: 1
};

/** Highest per-vehicle capacity the wire protocol/relay accepts today. */
export const MAX_PASSENGER_SEATS = 2;

/** Seats a driver in `mode` can offer (0 = not a shared ride). */
export function passengerCapacity(mode: PlayerMode | null | undefined): number {
  return (mode && PASSENGER_CAPACITY[mode]) || 0;
}
