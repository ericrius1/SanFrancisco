import {
  Tensor,
  isWebGPUSupported,
  loadAndCompile,
  loadLiteRt,
  unloadLiteRt,
  type CompiledModel
} from "@litertjs/core";
import { LANDMARK_COUNT, type PoseLandmark } from "./landmarks";

type Roi = { centerX: number; centerY: number; size: number };
type OutputMap = { screen: number; world: number; score: number };
export type PoseTrackingMode = "full-body" | "upper-body";

export type PoseDetection = {
  world: PoseLandmark[];
  /** Video-frame-normalized landmarks (0..1), for debug overlays. */
  screen: PoseLandmark[];
  score: number;
  inferenceMs: number;
  trackingMode: PoseTrackingMode;
};

const MODEL_URL = "/models/pose_landmark_full.tflite";
// Directory, not a file: loadLiteRt picks the right runtime variant itself
// (litert_wasm_internal.js on relaxed-SIMD browsers, the compat build
// otherwise). Forcing one file skips that feature detection.
const WEBGPU_RUNTIME_URL = "/litert-wasm/";

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** LiteRT BlazePose inference. The only compiled accelerator is WebGPU. */
export class PoseDetector {
  #model: CompiledModel | null = null;
  #runtimeLoaded = false;
  #inputWidth = 256;
  #inputHeight = 256;
  #outputMap: OutputMap | null = null;
  #roi: Roi | null = null;
  #trackingMode: PoseTrackingMode = "upper-body";
  #fullBodyStreak = 0;
  #partialBodyStreak = 0;
  #missStreak = 0;
  #canvas = document.createElement("canvas");
  #context: CanvasRenderingContext2D;
  #rgb = new Float32Array(this.#inputWidth * this.#inputHeight * 3);

  constructor() {
    const context = this.#canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The browser could not create a camera preprocessing canvas.");
    this.#context = context;
  }

  async initialize(onProgress: (fraction: number, label: string) => void): Promise<void> {
    if (!isWebGPUSupported()) throw new Error("WebGPU pose capture is not available in this browser.");

    onProgress(0.04, "Loading LiteRT WebGPU runtime");
    await loadLiteRt(WEBGPU_RUNTIME_URL);
    this.#runtimeLoaded = true;

    const bytes = await this.#fetchModel((fraction) =>
      onProgress(0.08 + fraction * 0.64, "Downloading pose model")
    );
    onProgress(0.76, "Compiling pose model for WebGPU");
    // Full precision: fp16 visibly degrades the landmark regression head —
    // joints collapse toward the crop centre and the presence score flickers.
    const compiled = await loadAndCompile(bytes, { accelerator: "webgpu" });

    if (!compiled.isFullyAccelerated) {
      compiled.delete();
      throw new Error("The pose model could not run fully on WebGPU on this device.");
    }

    const input = compiled.getInputDetails()[0];
    if (!input || input.shape.length !== 4) {
      compiled.delete();
      throw new Error("The pose model has an unsupported input layout.");
    }
    this.#inputHeight = input.shape[1];
    this.#inputWidth = input.shape[2];
    this.#canvas.width = this.#inputWidth;
    this.#canvas.height = this.#inputHeight;
    this.#rgb = new Float32Array(this.#inputWidth * this.#inputHeight * 3);

    const outputs = compiled.getOutputDetails();
    const elements = (shape: Int32Array) => shape.reduce((total, value) => total * value, 1);
    this.#outputMap = {
      screen: outputs.findIndex((output) => elements(output.shape) === 195),
      world: outputs.findIndex((output) => elements(output.shape) === 117),
      score: outputs.findIndex((output) => elements(output.shape) === 1)
    };
    if (this.#outputMap.screen < 0 || this.#outputMap.world < 0 || this.#outputMap.score < 0) {
      compiled.delete();
      throw new Error("The downloaded model is not the expected BlazePose landmark model.");
    }

    this.#model = compiled;
    onProgress(0.9, "Warming WebGPU pose pipelines");
    await this.#run(new Float32Array(this.#rgb.length));
    onProgress(1, "WebGPU pose ready");
  }

  async detect(video: HTMLVideoElement): Promise<PoseDetection | null> {
    if (!this.#model || !this.#outputMap) return null;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) return null;

    this.#roi ??= this.#fullFrameRoi(videoWidth, videoHeight);
    const roi = this.#roi;
    const outputs = await this.#run(this.#crop(video, roi, videoWidth, videoHeight));
    const rawScore = outputs.score[0];
    const score = rawScore >= 0 && rawScore <= 1 ? rawScore : sigmoid(rawScore);
    if (score < 0.5) {
      this.#handleMiss(videoWidth, videoHeight);
      return null;
    }
    this.#missStreak = 0;

    const screen: PoseLandmark[] = [];
    const world: PoseLandmark[] = [];
    const presence = new Float32Array(LANDMARK_COUNT);
    for (let index = 0; index < LANDMARK_COUNT; index++) {
      const cropX = outputs.screen[index * 5] / this.#inputWidth;
      const cropY = outputs.screen[index * 5 + 1] / this.#inputHeight;
      // This model's fourth channel is the landmark confidence used by the
      // reference implementation. Folding the separate presence channel into
      // it made body joints disappear while face points remained confident,
      // allowing the tracked crop to collapse onto the face.
      const visibility = sigmoid(outputs.screen[index * 5 + 3]);
      presence[index] = sigmoid(outputs.screen[index * 5 + 4]);
      screen.push({
        x: (roi.centerX - roi.size * 0.5 + cropX * roi.size) / videoWidth,
        y: (roi.centerY - roi.size * 0.5 + cropY * roi.size) / videoHeight,
        z: (outputs.screen[index * 5 + 2] / this.#inputWidth) * (roi.size / videoWidth),
        visibility,
        presence: presence[index]
      });
      world.push({
        x: outputs.world[index * 3],
        y: outputs.world[index * 3 + 1],
        z: outputs.world[index * 3 + 2],
        visibility,
        presence: presence[index]
      });
    }
    this.#updateRoi(screen, world, presence, videoWidth, videoHeight);
    return {
      world,
      screen,
      score,
      inferenceMs: outputs.inferenceMs,
      trackingMode: this.#trackingMode
    };
  }

  /** Current tracking crop in video pixels, for debug overlays. */
  get roi(): Roi | null {
    return this.#roi;
  }

  dispose(): void {
    this.#model?.delete();
    this.#model = null;
    this.#outputMap = null;
    this.#roi = null;
    this.#trackingMode = "upper-body";
    this.#fullBodyStreak = 0;
    this.#partialBodyStreak = 0;
    this.#missStreak = 0;
    if (this.#runtimeLoaded) {
      unloadLiteRt();
      this.#runtimeLoaded = false;
    }
  }

  async #fetchModel(onProgress: (fraction: number) => void): Promise<Uint8Array> {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`Pose model download failed (${response.status}).`);
    const total = Number(response.headers.get("content-length")) || 0;
    if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const bytes = new Uint8Array(total);
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.set(value, received);
      received += value.length;
      onProgress(received / total);
    }
    return bytes;
  }

  async #run(pixels: Float32Array): Promise<{
    screen: Float32Array;
    world: Float32Array;
    score: Float32Array;
    inferenceMs: number;
  }> {
    const model = this.#model;
    const map = this.#outputMap;
    if (!model || !map) throw new Error("Pose model is not ready.");

    let input = new Tensor(pixels, [1, this.#inputHeight, this.#inputWidth, 3]);
    let results: Tensor[] = [];
    try {
      input = await input.moveTo("webgpu");
      const startedAt = performance.now();
      results = await model.run([input]);
      const [screen, world, score] = await Promise.all([
        this.#read(results[map.screen]),
        this.#read(results[map.world]),
        this.#read(results[map.score])
      ]);
      // Include output synchronization/readback, as the reference HUD does;
      // timing only model.run() reported a misleading ~1 ms on an otherwise
      // normal frame.
      const inferenceMs = performance.now() - startedAt;
      return { screen, world, score, inferenceMs };
    } finally {
      for (const result of results) result.delete();
      input.delete();
    }
  }

  async #read(tensor: Tensor): Promise<Float32Array> {
    try {
      return Float32Array.from(await tensor.data());
    } catch {
      // Some LiteRT/WebGPU combinations require an explicit CPU copy before
      // tensor contents can be accessed.
      const cpu = await tensor.copyTo("wasm");
      try {
        return Float32Array.from(cpu.toTypedArray());
      } finally {
        cpu.delete();
      }
    }
  }

  #fullFrameRoi(width: number, height: number): Roi {
    return { centerX: width * 0.5, centerY: height * 0.5, size: Math.max(width, height) };
  }

  #updateRoi(
    screen: PoseLandmark[],
    world: PoseLandmark[],
    presence: Float32Array,
    width: number,
    height: number
  ): void {
    const shoulderY = (screen[11].y + screen[12].y) * 0.5 * height;
    const hipY = (screen[23].y + screen[24].y) * 0.5 * height;
    const torsoMeters = (world[23].y + world[24].y - world[11].y - world[12].y) * 0.5;
    const torsoPixels = hipY - shoulderY;
    const wasFullBody = this.#trackingMode === "full-body";
    const visibilityFloor = wasFullBody ? 0.36 : 0.5;
    const presenceFloor = wasFullBody ? 0.32 : 0.55;
    const plausibleTorso =
      torsoMeters > (wasFullBody ? 0.18 : 0.25) &&
      torsoPixels > this.#roi!.size * (wasFullBody ? 0.09 : 0.12);
    const distance3 = (a: number, b: number) => Math.hypot(
      world[a].x - world[b].x,
      world[a].y - world[b].y,
      world[a].z - world[b].z
    );
    const distance2Pixels = (a: number, b: number) => Math.hypot(
      (screen[a].x - screen[b].x) * width,
      (screen[a].y - screen[b].y) * height
    );
    const kneesInFrame = [25, 26].every((index) =>
      screen[index].x >= -0.05 && screen[index].x <= 1.05 &&
      screen[index].y >= -0.05 && screen[index].y <= 1.05
    );
    const plausibleLegs = kneesInFrame && [
      [23, 25],
      [24, 26]
    ].every(([hip, knee]) =>
      distance3(hip, knee) > (wasFullBody ? 0.18 : 0.24) &&
      distance2Pixels(hip, knee) > this.#roi!.size * (wasFullBody ? 0.035 : 0.05)
    );
    // Hip landmarks remain spuriously confident in a close-up. Requiring the
    // first leg segment distinguishes a genuinely body-centred crop from the
    // model merely extrapolating hips beneath a face.
    const bodyObserved = [11, 12, 23, 24, 25, 26].every((index) =>
      screen[index].visibility >= visibilityFloor && presence[index] >= presenceFloor
    );

    if (plausibleTorso && plausibleLegs && bodyObserved) {
      this.#fullBodyStreak++;
      this.#partialBodyStreak = 0;
    } else {
      this.#partialBodyStreak++;
      this.#fullBodyStreak = 0;
    }

    if (!wasFullBody && this.#fullBodyStreak >= 3) {
      this.#trackingMode = "full-body";
      this.#partialBodyStreak = 0;
    } else if (wasFullBody && this.#partialBodyStreak >= 2) {
      this.#trackingMode = "upper-body";
      this.#fullBodyStreak = 0;
    }

    if (this.#trackingMode === "full-body") {
      this.#updateFullBodyRoi(screen, width, height);
    } else {
      this.#updateUpperBodyRoi(screen, presence, width, height);
    }
  }

  #updateFullBodyRoi(screen: PoseLandmark[], width: number, height: number): void {
    // The landmark model expects a person-centred crop. Match the working
    // LiteRT.js-Mocap tracker: anchor the square at the model's hip centre and
    // size it by the furthest visible joint. A confidence bounding box has no
    // stable anatomical anchor; when arms leave frame, confident face points
    // can ratchet that box down until the face is treated as a whole person.
    const centerX = (screen[23].x + screen[24].x) * 0.5 * width;
    const centerY = (screen[23].y + screen[24].y) * 0.5 * height;
    let radius = 0;
    for (const point of screen) {
      if (point.visibility < 0.5) continue;
      radius = Math.max(
        radius,
        Math.hypot(point.x * width - centerX, point.y * height - centerY)
      );
    }
    const frameSize = Math.max(width, height);
    const size = Math.min(Math.max(radius * 2 * 1.25, frameSize * 0.3), frameSize * 1.5);
    const smoothing = 0.35;
    this.#roi = {
      centerX: this.#roi!.centerX + (centerX - this.#roi!.centerX) * smoothing,
      centerY: this.#roi!.centerY + (centerY - this.#roi!.centerY) * smoothing,
      size: this.#roi!.size + (size - this.#roi!.size) * smoothing
    };
  }

  #updateUpperBodyRoi(
    screen: PoseLandmark[],
    presence: Float32Array,
    width: number,
    height: number
  ): void {
    // Close-camera mode deliberately creates a virtual full-person crop that
    // extends below the physical frame. This scales a large face/hands back
    // toward the proportions the BlazePose landmark model was trained on,
    // without letting hallucinated hips steer the crop.
    const upperIndices = [0, 3, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let observed = 0;
    for (const index of upperIndices) {
      const point = screen[index];
      if (point.visibility < 0.35 || presence[index] < 0.3) continue;
      const x = point.x * width;
      const y = point.y * height;
      // Ignore runaway predictions far outside the frame when measuring the
      // crop, but retain a modest margin for a hand crossing an edge.
      if (x < -width * 0.2 || x > width * 1.2 || y < -height * 0.2 || y > height * 1.2) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      observed++;
    }

    const frameSize = Math.max(width, height);
    if (observed < 2) {
      this.#growTowardSearchRoi(width, height, frameSize * 1.25);
      return;
    }

    const distance = (a: number, b: number) =>
      Math.hypot((screen[a].x - screen[b].x) * width, (screen[a].y - screen[b].y) * height);
    const earsObserved = [7, 8].every((index) => screen[index].visibility >= 0.35 && presence[index] >= 0.3);
    const eyesObserved = [3, 6].every((index) => screen[index].visibility >= 0.35 && presence[index] >= 0.3);
    const shouldersObserved = [11, 12].every((index) =>
      screen[index].visibility >= 0.35 && presence[index] >= 0.3
    );
    const faceSpan = earsObserved ? distance(7, 8) : eyesObserved ? distance(3, 6) * 1.85 : 0;
    const shoulderSpan = shouldersObserved ? distance(11, 12) : 0;
    const observedSpan = Math.max(maxX - minX, maxY - minY);
    const size = Math.min(
      Math.max(frameSize, faceSpan * 8.5, shoulderSpan * 3.25, observedSpan * 1.45),
      frameSize * 1.8
    );
    const half = size * 0.5;
    const unclampedX = (minX + maxX) * 0.5;
    const minCenterX = width - half;
    const maxCenterX = half;
    const centerX = minCenterX <= maxCenterX
      ? Math.min(maxCenterX, Math.max(minCenterX, unclampedX))
      : width * 0.5;
    // Keep 10% breathing room above the highest observed head/hand and spend
    // the remaining padded crop below it, where the missing torso would be.
    const desiredCenterY = minY - size * 0.1 + half;
    const minCenterY = height - half;
    const maxCenterY = half;
    // The upper-body crop may add black space below the camera image, but it
    // must never discard real pixels at the top or bottom while tracking only
    // partial evidence.
    const centerY = minCenterY <= maxCenterY
      ? Math.min(maxCenterY, Math.max(minCenterY, desiredCenterY))
      : height * 0.5;
    const grow = size > this.#roi!.size;
    const sizeAlpha = grow ? 0.65 : 0.14;
    const centerAlpha = grow ? 0.5 : 0.24;
    this.#roi = {
      centerX: this.#roi!.centerX + (centerX - this.#roi!.centerX) * centerAlpha,
      centerY: this.#roi!.centerY + (centerY - this.#roi!.centerY) * centerAlpha,
      size: this.#roi!.size + (size - this.#roi!.size) * sizeAlpha
    };
  }

  #handleMiss(width: number, height: number): void {
    this.#missStreak++;
    if (this.#trackingMode === "full-body" && this.#missStreak < 2) {
      // One bad full-body frame should reacquire broadly without changing
      // modes; require a consecutive miss before abandoning leg tracking.
      this.#roi = this.#fullFrameRoi(width, height);
      this.#fullBodyStreak = 0;
      return;
    }
    this.#trackingMode = "upper-body";
    this.#fullBodyStreak = 0;
    this.#partialBodyStreak = 0;
    if (this.#missStreak > 10) {
      this.#roi = this.#fullFrameRoi(width, height);
      this.#missStreak = 0;
      return;
    }
    this.#growTowardSearchRoi(width, height, Math.max(width, height) * 1.25);
  }

  #growTowardSearchRoi(width: number, height: number, targetSize: number): void {
    const full = this.#fullFrameRoi(width, height);
    this.#roi ??= full;
    this.#roi = {
      centerX: this.#roi.centerX + (full.centerX - this.#roi.centerX) * 0.28,
      centerY: this.#roi.centerY + (full.centerY - this.#roi.centerY) * 0.28,
      size: this.#roi.size + (targetSize - this.#roi.size) * 0.42
    };
  }

  #crop(video: HTMLVideoElement, roi: Roi, width: number, height: number): Float32Array {
    const context = this.#context;
    context.fillStyle = "#000";
    context.fillRect(0, 0, this.#inputWidth, this.#inputHeight);

    const sourceX = roi.centerX - roi.size * 0.5;
    const sourceY = roi.centerY - roi.size * 0.5;
    const clipX0 = Math.max(0, sourceX);
    const clipY0 = Math.max(0, sourceY);
    const clipX1 = Math.min(width, sourceX + roi.size);
    const clipY1 = Math.min(height, sourceY + roi.size);
    if (clipX1 > clipX0 && clipY1 > clipY0) {
      const scale = this.#inputWidth / roi.size;
      context.drawImage(
        video,
        clipX0,
        clipY0,
        clipX1 - clipX0,
        clipY1 - clipY0,
        (clipX0 - sourceX) * scale,
        (clipY0 - sourceY) * scale,
        (clipX1 - clipX0) * scale,
        (clipY1 - clipY0) * scale
      );
    }

    const rgba = context.getImageData(0, 0, this.#inputWidth, this.#inputHeight).data;
    for (let source = 0, target = 0; source < rgba.length; source += 4) {
      this.#rgb[target++] = rgba[source] / 255;
      this.#rgb[target++] = rgba[source + 1] / 255;
      this.#rgb[target++] = rgba[source + 2] / 255;
    }
    return this.#rgb;
  }
}
