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
  score: number;
  inferenceMs: number;
};

const MODEL_URL = "/models/pose_landmark_full.tflite";
const WEBGPU_RUNTIME_URL = "/litert-wasm/litert_wasm_internal.js";

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** LiteRT BlazePose inference. The only compiled accelerator is WebGPU. */
export class PoseDetector {
  #model: CompiledModel | null = null;
  #runtimeLoaded = false;
  #inputWidth = 256;
  #inputHeight = 256;
  #outputMap: OutputMap | null = null;
  #roi: Roi | null = null;
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
    const compiled = await loadAndCompile(bytes, {
      accelerator: "webgpu",
      gpuOptions: { precision: "fp16" }
    });

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
      this.#roi = this.#fullFrameRoi(videoWidth, videoHeight);
      return null;
    }

    const screen: PoseLandmark[] = [];
    const world: PoseLandmark[] = [];
    for (let index = 0; index < LANDMARK_COUNT; index++) {
      const cropX = outputs.screen[index * 5] / this.#inputWidth;
      const cropY = outputs.screen[index * 5 + 1] / this.#inputHeight;
      const visibility = sigmoid(outputs.screen[index * 5 + 3]);
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
    return { world, score, inferenceMs: outputs.inferenceMs };
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
    const hipX = (screen[23].x + screen[24].x) * 0.5 * width;
    const hipY = (screen[23].y + screen[24].y) * 0.5 * height;
    let radius = 0;
    for (const point of screen) {
      if (point.visibility < 0.5) continue;
      radius = Math.max(radius, Math.hypot(point.x * width - hipX, point.y * height - hipY));
    }
    const frameSize = Math.max(width, height);
    const size = Math.min(Math.max(radius * 2.5, frameSize * 0.3), frameSize * 1.5);
    const smoothing = 0.35;
    this.#roi = {
      centerX: this.#roi!.centerX + (hipX - this.#roi!.centerX) * smoothing,
      centerY: this.#roi!.centerY + (hipY - this.#roi!.centerY) * smoothing,
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
