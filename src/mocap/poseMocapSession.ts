import type { MocapPoseDriver } from "../player/player";
import { AvatarRetargeter } from "./avatarRetargeter";
import { clearPoseDebug, drawPoseDebug } from "./debugOverlay";
import { LANDMARK_COUNT, mirrorAndExtendLandmarks } from "./landmarks";
import { PoseDetector } from "./poseDetector";
import { LandmarkSmoother } from "./smoothing";

export type MocapSessionState = "loading" | "searching" | "tracking" | "error";

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
  #smoother = new LandmarkSmoother(LANDMARK_COUNT);
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

  constructor(options: SessionOptions) {
    this.#video = options.video;
    this.#debugCanvas = options.debugCanvas;
    this.#onState = options.onState;
    this.#onFatal = options.onFatal;
    this.poseDriver = (rig, dt) => this.#retargeter.apply(rig, dt);
  }

  async start(): Promise<void> {
    this.#running = true;
    this.#onState("loading", "Requesting camera");
    try {
      this.#stream = await this.#openCamera();
      this.#video.srcObject = this.#stream;
      await this.#waitForVideo();
      await this.#video.play();

      this.#detector = new PoseDetector();
      await this.#detector.initialize((fraction, label) => {
        this.#onState("loading", `${label} · ${Math.round(fraction * 100)}%`);
      });
      if (!this.#running) return;
      this.#onState("searching", "Step into view");
      this.#scheduleInference();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.#running = false;
    if (this.#frameCallback && "cancelVideoFrameCallback" in this.#video) {
      this.#video.cancelVideoFrameCallback(this.#frameCallback);
    }
    this.#frameCallback = 0;
    if (this.#inferenceActive) this.#disposePending = true;
    else this.#disposeDetector();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#video.pause();
    this.#video.srcObject = null;
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
      const cleanup = () => {
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

  #scheduleInference(): void {
    if (!this.#running) return;
    if ("requestVideoFrameCallback" in this.#video) {
      this.#frameCallback = this.#video.requestVideoFrameCallback(() => void this.#infer());
    } else {
      this.#frameCallback = requestAnimationFrame(() => void this.#infer());
    }
  }

  async #infer(): Promise<void> {
    if (!this.#running || !this.#detector) return;
    this.#inferenceActive = true;
    try {
      const detection = await this.#detector.detect(this.#video);
      const now = performance.now();
      const dt = this.#lastInferenceAt ? Math.min((now - this.#lastInferenceAt) / 1000, 0.25) : 1 / 30;
      this.#lastInferenceAt = now;
      if (this.#debugCanvas) {
        drawPoseDebug(
          this.#debugCanvas,
          detection?.screen ?? null,
          this.#detector?.roi ?? null,
          this.#video.videoWidth,
          this.#video.videoHeight
        );
      }
      if (detection) {
        const smooth = this.#smoother.apply(detection.world, dt);
        this.#retargeter.update(mirrorAndExtendLandmarks(smooth), true);
        this.#lastPoseAt = now;
        const ms = detection.inferenceMs;
        this.#inferenceMsEma = this.#inferenceMsEma ? this.#inferenceMsEma * 0.8 + ms * 0.2 : ms;
        if (!this.#tracking) {
          this.#tracking = true;
          this.#lastStatusAt = now;
          this.#onState("tracking", `Tracking · ${Math.max(1, Math.round(this.#inferenceMsEma))} ms`);
        } else if (now - this.#lastStatusAt >= 500) {
          this.#lastStatusAt = now;
          this.#onState("tracking", `Tracking · ${Math.max(1, Math.round(this.#inferenceMsEma))} ms`);
        }
      } else if (now - this.#lastPoseAt > 500) {
        this.#retargeter.setFresh(false);
        if (this.#tracking) {
          this.#tracking = false;
          this.#onState("searching", "Step into view");
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
