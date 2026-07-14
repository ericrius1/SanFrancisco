import type { Input } from "../../core/input";
import type { DriveSpec, ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { CarController } from "../car";
import { SCOOTER_RIDE_HEIGHT } from "./mesh";
import { SCOOTER_TUNING } from "./tuning";

/**
 * A light, punchy step-through scooter using the car's proven ramp/landing
 * state machine. Only the vehicle dimensions and handling multipliers differ,
 * so it inherits drift, boost, anti-snag suspension, real ramp takeoff, and
 * the allocation-free airborne attitude assist.
 */
export class ScooterController implements ModeController {
  /** Match mesh contact so teleports settle near the road, not a car-height float. */
  readonly spawnLift = SCOOTER_RIDE_HEIGHT;
  #drive = new CarController();

  get steerVis(): number {
    return this.#drive.steerVis;
  }

  get jumpDebug() {
    return this.#drive.jumpDebug;
  }

  get slideFeedback() {
    return this.#drive.slideFeedback;
  }

  #spec(): DriveSpec {
    const t = SCOOTER_TUNING.values;
    return {
      halfExtents: [0.52, 0.42, 1.35],
      // Chassis centre above road = -mesh contactY (tire bottoms). Vertical
      // half-extent is clearance-clamped at spawn (see driveHalfExtentsWithClearance).
      rideHeight: SCOOTER_RIDE_HEIGHT,
      maxFactor: t.maxFactor,
      accelFactor: t.accelFactor,
      steerFactor: t.steerFactor,
      voice: "electric"
    };
  }

  #withSpec<T>(ctx: PlayerCtx, run: () => T): T {
    const prior = ctx.driveSpec;
    ctx.driveSpec = this.#spec();
    try {
      return run();
    } finally {
      ctx.driveSpec = prior;
    }
  }

  spawnBody(ctx: PlayerCtx, facing: number): number {
    return this.#withSpec(ctx, () => this.#drive.spawnBody(ctx, facing));
  }

  enter(ctx: PlayerCtx): void {
    this.#drive.enter(ctx);
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame): void {
    this.#withSpec(ctx, () => this.#drive.update(ctx, dt, input, frame));
  }
}
