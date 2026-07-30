import type { MocapPoseDriver } from "../player/player";
import { AvatarRetargeter } from "./avatarRetargeter";
import { clearPoseDebug, drawPoseDebug } from "./debugOverlay";
import { LANDMARK_COUNT, mirrorAndExtendLandmarks } from "./landmarks";
import { PoseDetector } from "./poseDetector";
import { LandmarkSmoother } from "./smoothing";

export type MocapSessionState = "loading" | "searching" | "tracking" | "error";

/** A camera that opens but never produces a frame must fail, not hang. */
const VIDEO_START_TIMEOUT_MS = 12000;

type SessionOptions = {
  video: HTMLVideoElement;
  /** Optional joint-debug canvas layered over the preview video. */
  debugCanvas?: HTMLCanvasElement;
  onState: (state: MocapSessionState, message: string) => void;
  onFatal: (error: Error) => void;
};

export class PoseMocapSession {
  readonly poseDriver: MocapPoseDriver;

  #video: HTMLVideoElement;
  #debugCanvas?: HTMLCanvasElement;
  #onState: SessionOptions["onState"];
  #onFatal: SessionOptions["onFatal"];
  #detector: PoseDetector | null = null;
  #stream: MediaStream | null = null;
  // Keep independent filters as in LiteRT.js-Mocap: screen coordinates feed
  // the diagnostic overlay, while world coordinates feed retargeting.
  #screenSmoother = new LandmarkSmoother(LANDMARK_COUNT, { minCutoff: 1.5, beta: 0.06 });
  #worldSmoother = new LandmarkSmoother(LANDMARK_COUNT, { minCutoff: 1, beta: 0.05 });
  #retargeter = new AvatarRetargeter();
  #running = false;
  #frameCallback = 0;
  #lastInferenceAt = 0;
  #lastPoseAt = 0;
  #tracking = false;
  #inferenceActive = false;
  #disposePending = false;
  #inferenceMsEma = 0;
  #lastStatusAt = 0;
  #trackingMode = "";
  #pageVisible = document.visibilityState === "visible";

  #onVisibilityChange = () => {
    this.#pageVisible = document.visibilityState === "visible";
    if (!this.#pageVisible) {
      if (this.#frameCallback && "cancelVideoFrameCallback" in this.#video) {
        this.#video.cancelVideoFrameCallback(this.#frameCallback);
      } else if (this.#frameCallback) {
        cancelAnimationFrame(this.#frameCallback);
      }
      this.#frameCallback = 0;
      for (const track of this.#stream?.getVideoTracks() ?? []) track.enabled = false;
      this.#video.pause();
      this.#retargeter.reset();
      if (this.#debugCanvas) clearPoseDebug(this.#debugCanvas);
      return;
    }
    for (const track of this.#stream?.getVideoTracks() ?? []) track.enabled = true;
    this.#lastInferenceAt = 0;
    if (this.#running && this.#detector) {
      void this.#video.play().then(() => this.#scheduleInference()).catch(() => {});
    }
  };

  constructor(options: SessionOptions) {
    this.#video = options.video;
    this.#debugCanvas = options.debugCanvas;
    this.#onState = options.onState;
    this.#onFatal = options.onFatal;
    this.poseDriver = (rig, dt) => this.#retargeter.apply(rig, dt);
  }

  /**
   * Start the camera and the WebGPU detector. Resolves early and silently when
   * `stop()` lands mid-start — a cancelled start is not a failure, so callers
   * must treat "resolved but not running" as "the user backed out".
   */
  async start(): Promise<void> {
    this.#running = true;
    this.#pageVisible = document.visibilityState === "visible";
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
    this.#emit("loading", "Requesting camera");
    try {
      const stream = await this.#openCamera();
      // The permission prompt can outlive a cancel; never keep a camera the
      // session no longer owns (the recording light would stay on).
      if (!this.#running) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.#stream = stream;
      this.#video.srcObject = stream;
      if (!this.#pageVisible) {
        for (const track of stream.getVideoTracks()) track.enabled = false;
      }
      await this.#waitForVideo();
      if (!this.#running) return;
      if (this.#pageVisible) await this.#video.play();
      if (!this.#running) return;

      // Held locally until it is ready: tearing the LiteRT runtime down from
      // stop() while initialize() is still loading it can poison the next
      // attempt, so a cancelled load is disposed once it settles instead.
      const detector = new PoseDetector();
      await detector.initialize((fraction, label) => {
        this.#emit("loading", `${label} · ${Math.round(fraction * 100)}%`);
      });
      if (!this.#running) {
        detector.dispose();
        return;
      }
      this.#detector = detector;
      this.#emit("searching", "Step into view");
      this.#scheduleInference();
    } catch (error) {
      const cancelled = !this.#running;
      this.stop();
      if (cancelled) return;
      throw error;
    }
  }

  stop(): void {
    this.#running = false;
    document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    if (this.#frameCallback && "cancelVideoFrameCallback" in this.#video) {
      this.#video.cancelVideoFrameCallback(this.#frameCallback);
    } else if (this.#frameCallback) {
      cancelAnimationFrame(this.#frameCallback);
    }
    this.#frameCallback = 0;
    if (this.#inferenceActive) this.#disposePending = true;
    else this.#disposeDetector();
    const stream = this.#stream;
    this.#stream = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    // The preview <video> is shared by every session. Release it only while
    // this session's stream is the one attached — otherwise a late stop from an
    // abandoned start would blank the preview of the session that replaced it.
    if (stream && this.#video.srcObject === stream) {
      this.#video.pause();
      this.#video.srcObject = null;
    }
    this.#retargeter.reset();
    if (this.#debugCanvas) clearPoseDebug(this.#debugCanvas);
  }

  async #openCamera(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support webcam access.");
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error("Camera permission was denied — allow it in the browser and try again.");
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new Error("No usable webcam was found.");
      }
      throw new Error(`Could not open the webcam${error instanceof Error ? `: ${error.message}` : "."}`);
    }
  }

  #waitForVideo(): Promise<void> {
    if (this.#video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.#video.videoWidth) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      // A camera that opens but never delivers a frame (busy in another app,
      // asleep in a dock) fires neither event. Without this the start hangs in
      // "loading" forever.
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("The webcam did not deliver a frame — it may be in use by another app."));
      }, VIDEO_START_TIMEOUT_MS);
      const cleanup = () => {
        window.clearTimeout(timer);
        this.#video.removeEventListener("loadeddata", loaded);
        this.#video.removeEventListener("error", failed);
      };
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("The webcam stream did not start."));
      };
      this.#video.addEventListener("loadeddata", loaded, { once: true });
      this.#video.addEventListener("error", failed, { once: true });
    });
  }

  /** State updates from a session the caller already stopped are dropped. */
  #emit(state: MocapSessionState, message: string): void {
    if (this.#running) this.#onState(state, message);
  }

  #scheduleInference(): void {
    if (!this.#running || !this.#pageVisible || this.#frameCallback) return;
    if ("requestVideoFrameCallback" in this.#video) {
      this.#frameCallback = this.#video.requestVideoFrameCallback(() => {
        this.#frameCallback = 0;
        void this.#infer();
      });
    } else {
      this.#frameCallback = requestAnimationFrame(() => {
        this.#frameCallback = 0;
        void this.#infer();
      });
    }
  }

  async #infer(): Promise<void> {
    if (!this.#running || !this.#pageVisible || !this.#detector) return;
    this.#inferenceActive = true;
    try {
      const detection = await this.#detector.detect(this.#video);
      if (!this.#running || !this.#pageVisible) return;
      const now = performance.now();
      const dt = this.#lastInferenceAt ? Math.min((now - this.#lastInferenceAt) / 1000, 0.25) : 1 / 30;
      this.#lastInferenceAt = now;
      if (this.#debugCanvas) {
        drawPoseDebug(
          this.#debugCanvas,
          detection ? this.#screenSmoother.apply(detection.screen, dt) : null,
          this.#detector?.roi ?? null,
          this.#video.videoWidth,
          this.#video.videoHeight,
          detection?.trackingMode ?? null
        );
      }
      if (detection) {
        const smooth = this.#worldSmoother.apply(detection.world, dt);
        this.#retargeter.update(mirrorAndExtendLandmarks(smooth), true);
        this.#lastPoseAt = now;
        const ms = detection.inferenceMs;
        this.#inferenceMsEma = this.#inferenceMsEma ? this.#inferenceMsEma * 0.8 + ms * 0.2 : ms;
        const modeLabel = detection.trackingMode === "upper-body" ? "Upper body" : "Full body";
        if (!this.#tracking) {
          this.#tracking = true;
          this.#lastStatusAt = now;
          this.#trackingMode = detection.trackingMode;
          this.#emit("tracking", `${modeLabel} · ${Math.max(1, Math.round(this.#inferenceMsEma))} ms`);
        } else if (now - this.#lastStatusAt >= 500 || this.#trackingMode !== detection.trackingMode) {
          this.#lastStatusAt = now;
          this.#trackingMode = detection.trackingMode;
          this.#emit("tracking", `${modeLabel} · ${Math.max(1, Math.round(this.#inferenceMsEma))} ms`);
        }
      } else if (now - this.#lastPoseAt > 500) {
        this.#retargeter.setFresh(false);
        if (this.#tracking) {
          this.#tracking = false;
          this.#emit("searching", "Step into view");
        }
      }
    } catch (error) {
      if (!this.#running) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.stop();
      this.#onFatal(failure);
      return;
    } finally {
      this.#inferenceActive = false;
      if (this.#disposePending) this.#disposeDetector();
    }
    this.#scheduleInference();
  }

  #disposeDetector(): void {
    this.#disposePending = false;
    this.#detector?.dispose();
    this.#detector = null;
  }
}
