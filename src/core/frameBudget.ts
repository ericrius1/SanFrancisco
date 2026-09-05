// Frame-budget scheduler — the ONE place per-frame background work is metered.
//
// Problem it solves: every streaming system used to self-throttle with its own
// ad-hoc cap (N builds per scan, M bodies per tile, …). Each cap looked
// reasonable alone; three of them landing on the same frame still stacked into
// a visible hitch. Systems can't see each other — this scheduler can.
//
// Model: jobs are SMALL units of deferrable work (create one building's
// physics boxes, assemble one streamed mesh, warm one material). Systems
// enqueue instead of doing the work inline; once per frame main.ts calls
// run(budgetMs) which drains jobs in lane-priority order until the budget is
// spent. The budget comes from real headroom, so a loaded frame does less
// background work and a fast frame catches up.
//
// Rules of the road for new features (the extensible contract):
//   • A job should aim for ≲1 ms. Bigger work → split it (the job re-enqueues
//     its continuation by returning "again", or closes over a cursor).
//   • Jobs must be safe to run LATE: re-check your own state on entry (the
//     world may have streamed away since you were queued).
//   • Never loop createBox/geometry-upload style bursts inline — queue them.
//
// Lane order = priority. "physics" first (collision correctness degrades
// gracefully but should win headroom), then "build" (visible world assembly),
// then "upload"/"background".

import { laptopProfile } from "../render/laptopProfiles";
import { tracer } from "./hitchTracer";

export type Lane = "physics" | "build" | "upload" | "background";
const LANES: Lane[] = ["physics", "build", "upload", "background"];

/** Return "again" to be re-queued at the BACK of the same lane (multi-slice jobs). */
export type Job = () => void | "again";

export interface FrameScheduler {
  /** Queue one unit of deferrable work on a lane. */
  schedule(lane: Lane, job: Job): void;
  /** Drain jobs in priority order until budgetMs is spent. Call once per frame.
   *  `budgetMs <= 0` skips the frame entirely (no starvation job) so a CPU-hot
   *  tick cannot grow a 10 ms assemble into a hitch. */
  run(budgetMs: number): void;
  /** Queued job count (all lanes) — probes/debug. */
  readonly pending: number;
  /**
   * Of `pending`, how many jobs re-queued themselves ("again") on the last
   * run — parked work waiting on external state (anti-wedge retries wait for
   * the player to move) plus mid-flight multi-slice jobs. `pending - waiting`
   * is the backlog that has never had a turn; the boot settle gate keys on it
   * so a job parked on "player inside this footprint" can't wedge the reveal.
   */
  readonly waiting: number;
  /** Per-lane queue depths — probes/debug. */
  depths(): Record<Lane, number>;
}

/**
 * Headroom-scaled streaming budget. GPU-bound frames (big rAF dt, cheap CPU)
 * still drain — the meadow is 28–36 ms of grass fill with ~8 ms of CPU left.
 * A CPU-hot world/physics tick gets nothing this frame; the backlog waits.
 */
export function streamingBudgetMs(frameDt: number, revealed: boolean, cpuMs = 0): number {
  if (!revealed) return 24;
  if (cpuMs > 12) return 0;
  const scale = laptopProfile().streamBudgetScale;
  if (frameDt < 1 / 55) return 3 * scale;
  if (frameDt < 1 / 35) return 1.5 * scale;
  return 0.8 * scale;
}

/** O(1) dequeue for arrival backlogs that can exceed 10,000 collision jobs.
 * Release consumed closures immediately; compact only amortized, off the head. */
class WorkQueue {
  private items: (Job | undefined)[] = [];
  private head = 0;
  get length() { return this.items.length - this.head; }
  push(job: Job) { this.items.push(job); }
  shift(): Job | undefined {
    if (!this.length) return undefined;
    const job = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head === this.items.length) { this.items.length = 0; this.head = 0; }
    else if (this.head >= 4096 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head); this.head = 0;
    }
    return job;
  }
}

export function createFrameScheduler(): FrameScheduler {
  const queues: Record<Lane, WorkQueue> = { physics: new WorkQueue(), build: new WorkQueue(), upload: new WorkQueue(), background: new WorkQueue() };
  let pending = 0;
  let waiting = 0;

  return {
    schedule(lane, job) {
      queues[lane].push(job);
      pending++;
    },
    run(budgetMs) {
      if (pending === 0) {
        waiting = 0;
        return;
      }
      // Callers pass 0 when this tick is already CPU-late. Forcing a job then
      // is how assembleBuilding / hydrate slices become hitch spikes.
      // Positive budgets still guarantee one job so queues cannot wedge forever.
      if (budgetMs <= 0) return;
      const t0 = performance.now();
      const deadline = t0 + budgetMs;
      // Starvation guard: however tight the (positive) budget, run at least
      // one job so the queues always drain under sustained load.
      let ran = 0;
      const requeued: [Lane, Job][] = [];
      for (const lane of LANES) {
        const q = queues[lane];
        while (q.length && (ran === 0 || performance.now() < deadline)) {
          const job = q.shift()!;
          pending--;
          ran++;
          let verdict: void | "again";
          try {
            verdict = job();
          } catch (err) {
            console.warn("[frameBudget] job failed:", err);
            continue;
          }
          // "again" = continue NEXT frame — held out of the queues until the
          // drain ends so a multi-slice job never runs twice in one frame
          if (verdict === "again") requeued.push([lane, job]);
        }
        if (ran > 0 && performance.now() >= deadline) break;
      }
      for (const [lane, job] of requeued) {
        queues[lane].push(job);
        pending++;
      }
      waiting = requeued.length;
      const spent = performance.now() - t0;
      tracer.count("schedJobs", ran);
      if (spent > 0.05) tracer.count("schedMs", Math.round(spent * 100) / 100);
    },
    get pending() {
      return pending;
    },
    get waiting() {
      return waiting;
    },
    depths() {
      return { physics: queues.physics.length, build: queues.build.length, upload: queues.upload.length, background: queues.background.length };
    },
  };
}
