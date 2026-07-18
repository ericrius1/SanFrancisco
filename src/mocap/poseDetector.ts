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

export type PoseDetection = {
  world: PoseLandmark[];
  /** Video-frame-normalized landmarks (0..1), for debug overlays. */
  screen: PoseLandmark[];
  score: number;
  inferenceMs: number;
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
      // Losing the person must not snap the crop to full frame immediately:
      // a raised hand dips the score for a few frames, and a full-frame crop
      // shrinks the person so much that re-acquisition itself fails,
      // producing a tracking↔searching flicker loop. Grow the crop outward
      // from where the person just was, and only give up to a full-frame
      // search after a sustained miss streak.
      this.#missStreak++;
      if (this.#missStreak > 12) {
        this.#roi = this.#fullFrameRoi(videoWidth, videoHeight);
      } else {
        const full = this.#fullFrameRoi(videoWidth, videoHeight);
        roi.size += (full.size - roi.size) * 0.12;
        roi.centerX += (full.centerX - roi.centerX) * 0.08;
        roi.centerY += (full.centerY - roi.centerY) * 0.08;
      }
      return null;
    }
    this.#missStreak = 0;

    const screen: PoseLandmark[] = [];
    const world: PoseLandmark[] = [];
    for (let index = 0; index < LANDMARK_COUNT; index++) {
      const cropX = outputs.screen[index * 5] / this.#inputWidth;
      const cropY = outputs.screen[index * 5 + 1] / this.#inputHeight;
      // visibility alone is not trustworthy: the model happily hallucinates
      // below-frame hips at chest height with visibility ~0.9. The fifth
      // channel is MediaPipe's per-landmark presence ("is this inside the
      // crop at all") — multiplying the two kills phantom joints for
      // waist-up webcam framing while leaving in-frame confidences intact.
      const visibility =
        sigmoid(outputs.screen[index * 5 + 3]) * sigmoid(outputs.screen[index * 5 + 4]);
      screen.push({
        x: (roi.centerX - roi.size * 0.5 + cropX * roi.size) / videoWidth,
        y: (roi.centerY - roi.size * 0.5 + cropY * roi.size) / videoHeight,
        z: outputs.screen[index * 5 + 2] / this.#inputWidth,
        visibility
      });
      world.push({
        x: outputs.world[index * 3],
        y: outputs.world[index * 3 + 1],
        z: outputs.world[index * 3 + 2],
        visibility
      });
    }
    this.#updateRoi(screen, videoWidth, videoHeight);
    return { world, screen, score, inferenceMs: outputs.inferenceMs };
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
      const inferenceMs = performance.now() - startedAt;
      const read = async (index: number) => Float32Array.from(await results[index].data());
      const [screen, world, score] = await Promise.all([
        read(map.screen),
        read(map.world),
        read(map.score)
      ]);
      return { screen, world, score, inferenceMs };
    } finally {
      for (const result of results) result.delete();
      input.delete();
    }
  }

  #fullFrameRoi(width: number, height: number): Roi {
    return { centerX: width * 0.5, centerY: height * 0.5, size: Math.max(width, height) };
  }

  #updateRoi(screen: PoseLandmark[], width: number, height: number): void {
    // Track the bounding box of the joints the model is actually confident
    // about. Anchoring on the hip estimate (the MediaPipe default) drags the
    // crop toward hallucinated below-frame hips whenever the webcam frames
    // the player from the waist up, which starves the crop of the upper body.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const point of screen) {
      // Deliberately looser than the retarget gates: a raised hand whose
      // wrist confidence is sagging must still hold the crop open, or the
      // crop tightens onto the torso, pushes the hand further out of frame,
      // and detection spirals into a loss loop.
      if (point.visibility < 0.3) continue;
      count++;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    if (count < 4) return; // too little signal — keep the previous crop
    const centerX = (minX + maxX) * 0.5 * width;
    const centerY = (minY + maxY) * 0.5 * height;
    const radius = Math.hypot((maxX - minX) * width, (maxY - minY) * height) * 0.5;
    const frameSize = Math.max(width, height);
    const size = Math.min(Math.max(radius * 2.6, frameSize * 0.3), frameSize * 1.5);
    const smoothing = 0.35;
    this.#roi = {
      centerX: this.#roi!.centerX + (centerX - this.#roi!.centerX) * smoothing,
      centerY: this.#roi!.centerY + (centerY - this.#roi!.centerY) * smoothing,
      size: this.#roi!.size + (size - this.#roi!.size) * smoothing
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
