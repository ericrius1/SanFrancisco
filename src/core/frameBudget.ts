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

import { tracer } from "./hitchTracer";

export type Lane = "physics" | "build" | "upload" | "background";
const LANES: Lane[] = ["physics", "build", "upload", "background"];

/** Return "again" to be re-queued at the BACK of the same lane (multi-slice jobs). */
export type Job = () => void | "again";

export interface FrameScheduler {
  /** Queue one unit of deferrable work on a lane. */
  schedule(lane: Lane, job: Job): void;
  /** Drain jobs in priority order until budgetMs is spent. Call once per frame. */
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

export function createFrameScheduler(): FrameScheduler {
  const queues: Record<Lane, Job[]> = { physics: [], build: [], upload: [], background: [] };
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
      const t0 = performance.now();
      const deadline = t0 + budgetMs;
      // Starvation guard: however tight the frame, run at least one job so the
      // queues always drain under sustained load (a single job is ~1 ms — the
      // alternative, an ever-growing backlog, is worse than paying it).
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
