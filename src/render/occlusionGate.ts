import * as THREE from "three/webgpu";
import { SHADOW_LAYERS } from "../world/shadows/shadowLayers";

/**
 * Kill switch for the whole occlusion-gate experiment. Flip to `false` in this
 * one place to make every gate a no-op (content stays permanently visible, no
 * proxy is created, no query is issued). Kept a module const rather than a "/"
 * tunable because it is a coarse on/off, not a per-frame artistic knob.
 */
export const OCCLUSION_GATES_ENABLED = true;

/** Consecutive occluded frames before the gated content is hidden. */
const DEFAULT_HIDE_AFTER = 10;
/** Metres of slack added around the measured bounds for the invisible proxy box. */
const DEFAULT_PADDING = 1;

/** `occlusionTest` is a live three.js Object3D flag with no @types declaration. */
type OcclusionTestable = THREE.Object3D & { occlusionTest?: boolean };

export interface OcclusionGateOptions {
  /** WebGPU renderer whose `isOccluded()` result drives the gate. */
  renderer: THREE.WebGPURenderer;
  /**
   * The object whose `.visible` is toggled. It MUST NOT be an ancestor of the
   * proxy — otherwise hiding it would stop the query and the gate could never
   * un-hide. Hide it after K confirmed-occluded frames; reveal it immediately.
   */
  content: THREE.Object3D;
  /**
   * Parent the invisible proxy is attached under. The proxy inherits this
   * transform, so a moving landmark (the ghost ship root) keeps its proxy
   * aligned for free. Usually a sibling container of `content`.
   */
  proxyParent: THREE.Object3D;
  /** Consecutive occluded frames before hiding (default 10). Reveal is instant. */
  hideAfter?: number;
  /** Metres of slack around the measured bounds for the proxy box (default 1). */
  padding?: number;
  /**
   * Extra metres beyond `padding` for the camera-inside force-visible volume
   * (default padding + 2). A viewer within this padded box always sees the
   * content, since a box whose faces surround the camera reads as occluded.
   */
  insidePad?: number;
  /**
   * Explicit proxy-parent-local bounds. When omitted they are measured from
   * `content` at construction (instances included) in the proxy-parent frame.
   */
  bounds?: THREE.Box3;
  /** Debug name for the proxy mesh/material. */
  name?: string;
}

export interface OcclusionGateStats {
  /** False when the kill switch is off — the gate is an always-visible no-op. */
  enabled: boolean;
  /** Current `.visible` state the gate is asserting on the content. */
  contentVisible: boolean;
  /** Last raw occlusion verdict (an unsampled/unresolved query reads as false). */
  occluded: boolean;
  /** Consecutive frames the proxy has read occluded. */
  occludedFrames: number;
  /** Viewer was inside the padded bounds this frame (forces visible). */
  cameraInside: boolean;
}

export interface OcclusionGate {
  /**
   * Cheap per-frame poll, driven from the site's existing update(). `viewer` is
   * the world position tested against the force-visible volume (the render
   * camera, or the local player for a ridden landmark). `forceVisible` is an
   * extra unconditional override (e.g. the local rider is aboard).
   */
  update(viewer: THREE.Vector3, forceVisible?: boolean): void;
  /** The invisible query proxy, or null when the gate is disabled. */
  readonly proxy: THREE.Mesh | null;
  readonly stats: OcclusionGateStats;
  dispose(): void;
}

/** Measure `content`'s world bounds and re-express them in `frame`'s local space. */
function measureLocalBounds(content: THREE.Object3D, frame: THREE.Object3D): THREE.Box3 {
  content.updateWorldMatrix(true, true);
  frame.updateWorldMatrix(true, false);
  // setFromObject accounts for InstancedMesh instances via the object-level
  // boundingBox; the result is a WORLD AABB.
  const world = new THREE.Box3().setFromObject(content);
  if (world.isEmpty()) return world;
  // Re-express in the proxy-parent frame. Exact for an axis-aligned frame
  // (both call sites are yaw-0 / identity at build time); conservative — and
  // therefore safe — for any rotated frame.
  const toLocal = frame.matrixWorld.clone().invert();
  return world.applyMatrix4(toLocal);
}

/**
 * Hardware occlusion-query render-visibility gate for a single coarse, expensive,
 * often-hidden object. An always-rendered invisible proxy box (depth-tested, but
 * writing no colour or depth) rides the content's transform; the renderer's
 * per-frame occlusion query on that proxy decides whether the real content could
 * possibly be on screen. The content is hidden only after K consecutive occluded
 * frames and revealed on the first frame the proxy is not fully covered — the
 * query readback is async, so a reveal trails by a frame or two rather than by K.
 * This gates DRAW VISIBILITY ONLY — the caller keeps every sim, audio, and
 * gameplay system running regardless of the gate's verdict.
 */
export function createOcclusionGate(options: OcclusionGateOptions): OcclusionGate {
  const stats: OcclusionGateStats = {
    enabled: OCCLUSION_GATES_ENABLED,
    contentVisible: true,
    occluded: false,
    occludedFrames: 0,
    cameraInside: false
  };

  if (!OCCLUSION_GATES_ENABLED) {
    // No-op gate: never build a proxy, never hide anything.
    options.content.visible = true;
    return {
      proxy: null,
      stats,
      update() {
        options.content.visible = true;
        stats.contentVisible = true;
      },
      dispose() {}
    };
  }

  const { renderer, content, proxyParent } = options;
  const hideAfter = options.hideAfter ?? DEFAULT_HIDE_AFTER;
  const padding = options.padding ?? DEFAULT_PADDING;
  const insidePad = options.insidePad ?? padding + 2;

  const bounds = options.bounds ?? measureLocalBounds(content, proxyParent);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  // A padded box for the proxy geometry, plus a slightly larger box for the
  // force-visible test so the content is already shown before the box edges can
  // flicker as the viewer crosses into the volume.
  const proxySize = size.clone().addScalar(padding * 2).max(new THREE.Vector3(0.1, 0.1, 0.1));
  const insideBounds = bounds.clone().expandByScalar(insidePad);

  const geometry = new THREE.BoxGeometry(proxySize.x, proxySize.y, proxySize.z);
  const material = new THREE.MeshBasicMaterial({
    // The proxy must rasterize so the query counts samples, but contribute
    // nothing to the frame: no colour, no depth write. It stays depth-TESTED so
    // scene occluders (buildings, the basilica shell) hide it, and transparent
    // so it draws after all opaque geometry — the full occluder depth is present
    // when its query runs.
    colorWrite: false,
    depthWrite: false,
    transparent: true
  });
  material.name = options.name ? `${options.name}_occlusion_proxy` : "occlusion_proxy";
  const proxy = new THREE.Mesh(geometry, material);
  proxy.name = material.name;
  proxy.position.copy(center);
  proxy.castShadow = false;
  proxy.receiveShadow = false;
  // Stay out of any sibling static-merge pass that keys on this flag.
  proxy.userData.keepGhostShipMesh = true;
  proxy.userData.keepMissionDoloresMesh = true;
  (proxy as OcclusionTestable).occlusionTest = true;
  // Never CPU-frustum-culled. A culled proxy contributes no query that frame, and
  // three only rebuilds the backend's resolved-occluder set on frames that issued
  // at least one query — so a culled proxy would keep re-reading an older verdict.
  proxy.frustumCulled = false;
  // Beauty camera only. `frustumCulled = false` means this proxy is pushed into
  // the render list of EVERY camera that includes its layer, and a pass that
  // lists an occlusionTest object it will not draw costs a GPU query set per
  // frame (shadow cameras skip non-casters; the ink prepass skips transparents).
  // Layer 0 is what those secondary cameras select, so stay off it — the render
  // camera enables BEAUTY_ONLY, so the query itself still runs and resolves.
  proxy.layers.set(SHADOW_LAYERS.BEAUTY_ONLY);
  proxyParent.add(proxy);

  const inverseParent = new THREE.Matrix4();
  const localViewer = new THREE.Vector3();
  let disposed = false;

  // `renderer.isOccluded()` reads the renderer's CURRENT render context, which is
  // only live inside a render pass — calling it from the site's update() (which
  // runs in the game phase, before the frame renders) always returns null, i.e.
  // "never occluded". So sample it from the proxy's onAfterRender instead: three
  // invokes that from renderObject, with the scene pass's context installed. The
  // verdict is one resolved frame behind (the query readback is async); the
  // K-frame hysteresis below already absorbs that.
  //
  // `samples` counts the passes that drew the proxy since the last update(); when
  // the proxy drew in more than one (the ink look renders the scene a second time
  // for its normal/depth prepass) any pass that could see it wins, so a secondary
  // pass can only ever force VISIBLE — never a false hide.
  let samples = 0;
  let sampledOccluded = true;
  proxy.onAfterRender = () => {
    sampledOccluded = sampledOccluded && renderer.isOccluded(proxy) === true;
    samples++;
  };

  const show = () => {
    stats.occludedFrames = 0;
    content.visible = true;
    stats.contentVisible = true;
  };

  return {
    proxy,
    stats,
    update(viewer, forceVisible = false) {
      if (disposed) return;

      proxyParent.updateWorldMatrix(true, false);
      inverseParent.copy(proxyParent.matrixWorld).invert();
      localViewer.copy(viewer).applyMatrix4(inverseParent);
      const inside = insideBounds.containsPoint(localViewer);
      stats.cameraInside = inside;

      if (forceVisible || inside) {
        stats.occluded = false;
        samples = 0;
        sampledOccluded = true;
        show();
        return;
      }

      // A frame that never drew the proxy (an ancestor was hidden, no pass ran)
      // carries no verdict at all and reads as VISIBLE — deliberately
      // conservative, and it keeps a stale verdict from surviving the gap.
      const occluded = samples > 0 && sampledOccluded;
      samples = 0;
      sampledOccluded = true;
      stats.occluded = occluded;
      if (occluded) {
        stats.occludedFrames++;
        if (stats.occludedFrames >= hideAfter) {
          content.visible = false;
          stats.contentVisible = false;
        }
      } else {
        show();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      proxy.onAfterRender = () => {};
      proxy.removeFromParent();
      geometry.dispose();
      material.dispose();
      content.visible = true;
    }
  };
}
