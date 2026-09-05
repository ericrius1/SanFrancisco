import * as THREE from "three/webgpu";
import type { pass } from "three/tsl";
import { tracer } from "../core/hitchTracer";
import { motionGate } from "../core/motionGate";

/** three/webgpu's typings do not re-export PassNode by name. */
export type ScenePass = ReturnType<typeof pass>;

// M11: an exclusive compile window HOLDS presented frames for its duration
// (C3), so a monster TSL codegen window (water sheets ~250 ms, facade family
// ~480 ms) is a visible freeze ONLY if the player was moving — while the view
// is still, the held frame shows an identical image and is imperceptible. Each
// serialized window therefore waits for visual stillness before starting, with
// a bounded per-window deadline (and the motionGate's global motion budget) so
// a player who never stops degrades to the ungated M10 behavior, never worse.
const COMPILE_STILL_DEADLINE_MS = 8000;
// Destination-exhibit (priority lane) windows trade stillness camouflage for
// latency: the player is watching an empty pad where the exhibit belongs, so
// waiting out the full stillness deadline hurts more than a visible window.
const COMPILE_STILL_PRIORITY_DEADLINE_MS = 250;
// Windows longer than a frame interval are what the stillness gate exists for;
// use the same threshold to classify hidden vs visible in the tracer.
const COMPILE_WINDOW_VISIBLE_MS = 33;

export type CompileGate = {
  /** True while an exclusive compile window is holding presented frames. */
  readonly held: boolean;
  /** Probe/debug visibility into serialized owner preparation backlog. */
  readonly queueDepth: number;
  /** Late-bind app-level arrival/reveal admission after the phase machine is
   *  constructed. Boot compilation remains unblocked before this binding. */
  setBlocker(blocker: () => boolean): void;
  /** Destination-exhibit compile lane: same exclusive-window serialization,
   *  but the request jumps queued scenery owners, bypasses the arrival/reveal
   *  compile blocker, and near-skips the stillness wait. */
  compileAsyncPrioritized: THREE.WebGPURenderer["compileAsync"];
  /** Wait for GPU owner compilation that was already admitted before a covered
   *  world relocation. Does not start or force any new work. */
  waitForCompileIdle(): Promise<void>;
  /** Prepare a detached object in the exact render context used by the live
   *  beauty scene pass. */
  prepareSceneOwner(owner: THREE.Object3D, priority?: boolean): Promise<void>;
  prepareOffscreenOwner(owner: THREE.Object3D, camera: THREE.Camera, target: THREE.RenderTarget): Promise<void>;
  /** Compile a PassNode behind a restoring boundary. */
  compilePass(node: ScenePass): Promise<void>;
  /** Compile every persistent fullscreen material in one traversal. */
  compileFullscreenQuads(quads: THREE.QuadMesh[]): Promise<void>;
};

/**
 * The two-lane serialized exclusive-compile gate.
 *
 * Extracted from pipeline.ts intact. It is orthogonal to post-processing — the
 * consumers are `tiles.isRenderHeld` (main.ts:301), `waitForRenderIdle`
 * (main.ts:367), region arrival compiles, `warmHiddenRoot`
 * (worldSystemsCore.ts:192) and three sites in worldSystemsNet.ts — and it lives
 * in its own file so a post-FX rebuild never has to reason about it again.
 *
 * The subtlest invariant, and the one that must survive any future edit:
 * **nested compiles inside an exclusive owner must not wait on the stillness
 * gate**, or the outer-await/inner-block deadlock returns.
 */
export function createCompileGate(deps: {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** The beauty pass, for prepareSceneOwner's render-context capture. */
  scenePass: ScenePass;
}): CompileGate {
  const { renderer, scene, camera, scenePass } = deps;

  // compileAsync mutates shared renderer state (tone mapping, color space, …)
  // across an await. Live frames must not draw in that window or atmosphere/fog
  // briefly renders with the compile setup.
  let exclusiveCompileDepth = 0;
  let compileBlocked: () => boolean = () => false;
  let compileQueueDepth = () => 0;
  let waitForCompileIdle: () => Promise<void> = async () => {};
  let compileAsyncPrioritized: typeof renderer.compileAsync = (...args) =>
    renderer.compileAsync(...args);

  // The same hazard applies to every SCENE warmup (warmHiddenRoot, tile/site/
  // vehicle prepares call renderer.compileAsync directly): r185's compileAsync
  // updates shared node/binding bookkeeping across its awaits, and a live frame
  // drawn inside that window renders with the compile's fog/tone state. The
  // visible symptom is distant fog-hidden geometry — bay sailboats, the
  // ghost-ship horizon proxy — flashing unfaded for a single frame ("flickering
  // objects in the sky"). Route the renderer's own compileAsync through the
  // exclusive gate so a compile in flight holds the previous frame instead of
  // drawing a corrupted one, and serialize compiles so windows never overlap.
  {
    const original = renderer.compileAsync.bind(renderer);
    type PendingCompile = {
      promise: Promise<unknown>;
      started: boolean;
      priority: boolean;
      run: () => Promise<void>;
    };
    const pendingCompiles: PendingCompile[] = [];
    // Two admission lanes over ONE serialized worker (windows never overlap):
    // the priority lane carries the arrival destination's exhibit — it jumps
    // ahead of queued scenery owners and bypasses the reveal blocker, so the
    // thing the player teleported to compiles under the cover / materialize
    // sweep instead of queueing behind the whole city fill.
    const normalQueue: PendingCompile[] = [];
    const priorityQueue: PendingCompile[] = [];
    let draining = false;
    compileQueueDepth = () => pendingCompiles.length;
    const drain = async () => {
      draining = true;
      try {
        while (priorityQueue.length > 0 || normalQueue.length > 0) {
          let pending: PendingCompile;
          if (priorityQueue.length > 0) {
            pending = priorityQueue.shift()!;
          } else {
            pending = normalQueue[0];
            // Optional owners queued before a teleport stay queued until the
            // full point/fog reveal settles. A run that already crossed this
            // boundary is the sole non-cancellable owner the covered
            // relocation waits for. Nested compiles inside an exclusive owner
            // must proceed to avoid an outer-await/inner-block deadlock. A
            // priority owner arriving mid-park preempts the parked owner.
            while (
              exclusiveCompileDepth === 0 && compileBlocked() && priorityQueue.length === 0
            ) {
              // rAF raced with a timeout: a hidden tab presents no frames, and
              // an rAF-only park would freeze the whole queue — including the
              // priority lane this park is supposed to yield to.
              await new Promise<void>((resolve) => {
                let settled = false;
                const settle = () => {
                  if (!settled) {
                    settled = true;
                    resolve();
                  }
                };
                requestAnimationFrame(settle);
                setTimeout(settle, 250);
              });
            }
            if (priorityQueue.length > 0 && exclusiveCompileDepth === 0 && compileBlocked()) {
              continue;
            }
            normalQueue.shift();
          }
          await pending.run();
        }
      } finally {
        draining = false;
        if (priorityQueue.length > 0 || normalQueue.length > 0) pump();
      }
    };
    const pump = () => {
      if (!draining) void drain();
    };
    let enqueuePriority = false;
    compileAsyncPrioritized = ((
      compileScene: THREE.Object3D,
      compileCamera: THREE.Camera,
      targetScene: THREE.Scene | null = null
    ) => {
      // The wrapper below reads this flag synchronously at enqueue, so only
      // this call lands on the priority lane — not compiles that other tasks
      // enqueue while the prioritized one is awaited.
      enqueuePriority = true;
      try {
        return renderer.compileAsync(compileScene, compileCamera, targetScene);
      } finally {
        enqueuePriority = false;
      }
    }) as typeof renderer.compileAsync;
    renderer.compileAsync = ((
      compileScene: THREE.Object3D,
      compileCamera: THREE.Camera,
      targetScene: THREE.Scene | null = null
    ) => {
      // compileAsync keys render objects by the active render context. Capture
      // that context NOW, at the call site: the serialized run may begin many
      // frames later, after another pass has restored a different target. This
      // is what lets detached streamed owners warm the exact scene-pass cache
      // instead of compiling against the default framebuffer and rebuilding
      // synchronously on their first real frame.
      const requestedRenderTarget = renderer.getRenderTarget();
      const requestedCubeFace = renderer.getActiveCubeFace();
      const requestedMipmapLevel = renderer.getActiveMipmapLevel();
      const requestedMRT = renderer.getMRT();
      const requestedOpaque = renderer.opaque;
      const requestedTransparent = renderer.transparent;
      let resolveOuter!: (value: unknown) => void;
      let rejectOuter!: (reason: unknown) => void;
      const outer = new Promise<unknown>((resolve, reject) => {
        resolveOuter = resolve;
        rejectOuter = reject;
      });
      const run = async () => {
        pending.started = true;
        try {
          await runInner();
        } catch (error) {
          // A throw outside runInner's own compile handling (stillness gate,
          // attribution) must still settle the caller's promise — an
          // unsettled `outer` would hang the caller and waitForCompileIdle.
          rejectOuter(error);
        }
      };
      const runInner = async () => {
        // M11: start this window during stillness when possible (see
        // COMPILE_STILL_DEADLINE_MS). The wait happens BEFORE the exclusive
        // depth increments, so live frames keep presenting while we wait.
        // Nested calls (compileFullscreenQuads awaits the gated compileAsync
        // while already holding the exclusive depth) must NOT wait: frames are
        // already frozen, so waiting only lengthens the freeze. Priority
        // owners wait only briefly — the destination exhibit outranks hiding
        // its compile windows behind stillness.
        let stillAtStart = true;
        if (exclusiveCompileDepth === 0) {
          const gateWaitStartedAt = performance.now();
          stillAtStart = await motionGate.waitForStillness(
            pending.priority ? COMPILE_STILL_PRIORITY_DEADLINE_MS : COMPILE_STILL_DEADLINE_MS,
            // Frames became held by an outer window mid-wait: waiting can no
            // longer hide anything, it only lengthens the frozen image.
            () => exclusiveCompileDepth > 0
          );
          const gateWaitMs = Math.round(performance.now() - gateWaitStartedAt);
          if (gateWaitMs > 0) tracer.count("compileGateWaitMs", gateWaitMs);
          if (!stillAtStart && gateWaitMs > 50) tracer.count("compileGateForced");
        } else {
          stillAtStart = motionGate.isStill();
        }
        exclusiveCompileDepth++;
        const startedAt = performance.now();
        const liveRenderTarget = renderer.getRenderTarget();
        const liveCubeFace = renderer.getActiveCubeFace();
        const liveMipmapLevel = renderer.getActiveMipmapLevel();
        const liveMRT = renderer.getMRT();
        const liveOpaque = renderer.opaque;
        const liveTransparent = renderer.transparent;
        try {
          renderer.setRenderTarget(requestedRenderTarget, requestedCubeFace, requestedMipmapLevel);
          renderer.setMRT(requestedMRT);
          renderer.opaque = requestedOpaque;
          renderer.transparent = requestedTransparent;
          resolveOuter(await original(compileScene, compileCamera, targetScene));
        } catch (error) {
          rejectOuter(error);
        } finally {
          renderer.setRenderTarget(liveRenderTarget, liveCubeFace, liveMipmapLevel);
          renderer.setMRT(liveMRT);
          renderer.opaque = liveOpaque;
          renderer.transparent = liveTransparent;
          exclusiveCompileDepth--;
          // M6 attribution: bursty compiles are the prime hitch suspect. The
          // per-frame counts land on the spiking frame in tracer.spikes.
          tracer.count("gpuCompile");
          const windowMs = Math.round(performance.now() - startedAt);
          tracer.count("gpuCompileMs", windowMs);
          // M11 attribution: a long window is a perceived hitch only when the
          // view was moving at its start or moved during it.
          if (windowMs > COMPILE_WINDOW_VISIBLE_MS) {
            const movedDuring = motionGate.lastMovementAt() > startedAt;
            tracer.count(
              stillAtStart && !movedDuring
                ? "compileWindowStillHidden"
                : "compileWindowMotionVisible"
            );
          }
          // M10 attribution: name the owners of long exclusive windows.
          if (windowMs > 100) {
            const owner = compileScene as THREE.Object3D & { name?: string; type?: string };
            console.info(`[compile] ${owner.name || owner.type || "?"} window ${windowMs}ms`);
          }
        }
      };
      const pending: PendingCompile = {
        promise: outer,
        started: false,
        priority: enqueuePriority,
        run
      };
      pendingCompiles.push(pending);
      (pending.priority ? priorityQueue : normalQueue).push(pending);
      const removePending = () => {
        const index = pendingCompiles.indexOf(pending);
        if (index >= 0) pendingCompiles.splice(index, 1);
      };
      void outer.then(removePending, removePending);
      pump();
      return outer;
    }) as typeof renderer.compileAsync;

    // Published below for atomic relocations. A teleport paints its lightweight
    // DOM cover first, then waits for any already-admitted non-cancellable GPU
    // compile to drain before it cuts/restarts the point scan. Background
    // admission is arrival-aware, so no new optional owner should join once
    // that wait begins. Wait only for the run that already crossed the reveal
    // blocker; queued owners remain paused and never lengthen the cover.
    waitForCompileIdle = async () => {
      const admittedBeforeArrival = pendingCompiles.find((pending) => pending.started);
      if (!admittedBeforeArrival) return;
      await admittedBeforeArrival.promise.catch(() => {});
    };
  }

  /**
   * Prepare a detached object in the exact render context used by the live
   * beauty scene pass. Calling renderer.compileAsync() with the default target
   * warms a different r185 NodeManager cache key and does not prevent a
   * synchronous first-draw build inside PassNode.
   */
  const prepareSceneOwner = (owner: THREE.Object3D, priority = false): Promise<void> => {
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(scenePass.getMRT());
    try {
      // The wrapper above snapshots this target synchronously before enqueuing.
      return priority ? compileAsyncPrioritized(owner, camera, scene) : renderer.compileAsync(owner, camera, scene);
    } finally {
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
    }
  };

  const prepareOffscreenOwner = (owner:THREE.Object3D, ownerCamera:THREE.Camera, target:THREE.RenderTarget):Promise<void> => {
    const previous=renderer.getRenderTarget(),mrt=renderer.getMRT(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(target);
    renderer.setMRT(null);
    try { return compileAsyncPrioritized(owner,ownerCamera); }
    finally { renderer.setRenderTarget(previous,face,mip);renderer.setMRT(mrt); }
  };

  /**
   * PassNode.compileAsync does not restore its render state if compilation
   * rejects, so put a defensive boundary around the Three r185 API.
   */
  const compilePass = async (node: ScenePass) => {
    exclusiveCompileDepth++;
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();
    const renderOpaque = renderer.opaque;
    const renderTransparent = renderer.transparent;
    try {
      renderer.opaque = node.opaque;
      renderer.transparent = node.transparent;
      await node.compileAsync(renderer);
    } finally {
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
      renderer.opaque = renderOpaque;
      renderer.transparent = renderTransparent;
      exclusiveCompileDepth--;
    }
  };

  /**
   * Compile all persistent fullscreen materials in one traversal. RenderPipeline
   * has no public compile method in r185, so this narrowly adapts its quad after
   * asking the pipeline to configure it. Keeping this adapter here makes the
   * returned warmup API independent of Three's private shape.
   */
  const compileFullscreenQuads = async (quads: THREE.QuadMesh[]) => {
    if (quads.length === 0) return;
    exclusiveCompileDepth++;
    const group = new THREE.Group();
    group.add(...quads);

    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();
    const toneMapping = renderer.toneMapping;
    const outputColorSpace = renderer.outputColorSpace;
    const xrEnabled = renderer.xr.enabled;

    try {
      // Match RenderPipeline.render() so the compiled target/cache key is the
      // one used by live fullscreen draws, not the renderer's output-conversion
      // framebuffer.
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
      renderer.xr.enabled = false;
      await renderer.compileAsync(group, quads[0].camera);
    } finally {
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      renderer.xr.enabled = xrEnabled;
      group.remove(...quads);
      exclusiveCompileDepth--;
    }
  };

  return {
    get held() {
      return exclusiveCompileDepth > 0;
    },
    get queueDepth() {
      return compileQueueDepth();
    },
    setBlocker(blocker: () => boolean) {
      compileBlocked = blocker;
    },
    compileAsyncPrioritized: ((compileScene, compileCamera, targetScene) =>
      compileAsyncPrioritized(
        compileScene,
        compileCamera,
        targetScene
      )) as typeof renderer.compileAsync,
    waitForCompileIdle: () => waitForCompileIdle(),
    prepareSceneOwner,
    prepareOffscreenOwner,
    compilePass,
    compileFullscreenQuads
  };
}
