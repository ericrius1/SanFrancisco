# Audit — citygen atomic collider swap (drive-stuck regression)

## Files changed
- `src/world/citygen/stream/ring.ts` (modified)
- `tools/drive-stuck-probe.mjs` (created)

(Only files touched. A throwaway diagnostic script lives in the session scratchpad, outside the repo.)

## What changed per file

### src/world/citygen/stream/ring.ts
1. **Atomic coll-tier swap (fix A):** `ensureExactCollider` no longer calls
   `ctx.tiles.suppressBuilding` at enqueue time. `e.state = "coll"` remains the
   in-flight marker; the queued physics-lane job now does suppress + wall
   creation together in the same frame. Job guard is `e.state !== "coll" ||
   e.bodies.length` (drop/unload/detail-upgrade make it a no-op).
   `dropExactCollider` on a still-queued entry verified safe: `clearBodies` is a
   no-op on empty, and `unsuppressBuilding` on a never-suppressed building is an
   idempotent alive-texel write + `onBuildingAlive(true)` re-fire (tiles.ts).
2. **Sync detail walls (fix B):** `createSolidWalls` (queued) split into
   `buildSolidWallsNow` (inline). `finishDetail` now builds solid walls
   synchronously whenever `e.bodies.length === 0` — same frame as its own
   `suppressBuilding`. Covers both lod→detail and coll-with-job-still-queued.
   The stale queued coll job no-ops afterward via the bodies-length guard.
3. **Anti-wedge guard (fix C):** `lastPlayer` closure vec stashed at the top of
   `update()`. The coll job returns `"again"` (scheduler retry next frame) while
   the player's XZ is inside the entry bb inflated 3.5 m and y ∈ [base−5, top+5].
4. **Stale-assembly guard (fix D):** the buildWorker reply's build-lane job
   skips `finishDetail` (after clearing `pendingBuild`) when the entry centre is
   farther than `CT.detailRadius + 40` from `lastPlayer`.
5. **Debug (probe support):** added read-only `debugEntriesNear(x, z, r)` to the
   ring interface/return — state, live body count, pendingBuild, insideBB per
   entry within r. No behavioural change.

### tools/drive-stuck-probe.mjs (new)
Headless WebGPU stuck-detector probe (own vite :5198 + SF_RELAY_PORT, CDP).
Three drive legs (Castro / downtown-grid / marina). Castro anchors are midpoints
of real road segments from `public/data/roads.json` (0.1 m ints ÷10) with facing
solved from segment direction (forward = (−sin f, −cos f)). Stuck = <1.2 m moved
over 2.5 s with KeyW held in drive mode; on stuck it logs position, ring stats,
`debugEntriesNear(25 m)`, then auto-unsticks (15 m hop avoiding footprints).
Self-healing helper install (survives headless page reloads). Writes
`.data/drive-stuck-probe/stuck-report.json`.

## Deviations from the plan
- Fix B additionally covers the "came from coll but job still queued" case
  (plan text only called out `e.bodies.length === 0`, which is what was
  implemented — the point is it replaces the old `hadColl` shortcut that left a
  gap).
- Verification incomplete: coordinator ordered stand-down before the fade-probe
  and hitch-leg runs (steps 4b/5). `npx tsc --noEmit` passes.

## Test results
- **Pre-fix repro:** castro 8 stuck events, downtown 3 (2 wedged INSIDE a
  citygen footprint — direct confirmation of the wedge class), marina 0.
- **Post-fix:** castro 9, downtown 3 (2 inside-footprint), marina 0 — at
  IDENTICAL coordinates to pre-fix. The stuck events are deterministic and
  position-fixed, so the dominant blocker is NOT the transient suppress gap.
- `npx tsc --noEmit`: clean.
- citygen-fade-probe / hitch-probe: NOT run (stand-down order).

## Key diagnostic findings (beyond stuck-report.json)
At stuck positions (scratchpad diagnose script, forward raycasts at h=0.3/0.8/1.5
+ collider dumps):
- Street-centre Castro events: forward ray at 0.3 m hits only "ground" (uphill
  terrain, ny≈1) 5–10 m out; NOTHING at 0.8/1.5 m; nearest citygen wall 8–12 m
  away; `nearBaked` empty. Car crawls ~0.1–0.4 m/2.5 s up 8–9 % grades.
- Later events: forward rays at ALL heights hit "building" 2.3 m ahead, and the
  car sits 2.2–2.8 m ABOVE terrain — riding an invisible ledge.
- `debugColliders` shows thin horizontal slabs among the door-gapped wall sets:
  hy=0.1 boxes with hz up to 8.8 (17.6 m deep) centred in the ROADWAY, e.g.
  (62, 83, 3194.9) hx4.1×hy0.1×hz7 spanning the full street, plus tilted quat
  (stoop-ramp) boxes. These come from `buildingColliders`' door landing/stoop
  path (`openDoorway` → `appendStoop`, sized off sill − frontGround) — on steep
  Castro fronts the rise is large and the landing/ramp extends into the street.
  Suspect root cause for the deterministic street blockers; lives in
  `src/world/citygen/core/collider.ts` (NOT in my files-touched list — not
  edited, reported instead).
- Unrelated: transient `nearAnyWildRegion is not defined` page exception during
  one run — mid-edit HMR artifact from a parallel task's wildlands files;
  export exists in the current tree.

## Open risks
- The landed atomic-swap fix closes the multi-frame no-collider hole (real —
  proven by the pre-fix INSIDE-footprint wedges downtown), but the dominant,
  deterministic Castro blockers persist and appear to be oversized door
  landing/stoop colliders reaching the road centre on steep streets.
- Anti-wedge "again" under the portable no-scheduler fallback can spin its
  10000-guard and drop the job, leaving state "coll" with baked collider still
  live (safe but prism/collider mismatch). SF host uses the real scheduler.
- Fix B makes 1–3 inline `buildingColliders`+createBox bursts per scan
  (~30–60 boxes worst case); expected sub-ms but not yet hitch-profiled
  (stand-down before step 5).
