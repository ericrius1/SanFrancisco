// Boot stage: GPU / render core (docs/MAIN_DECOMPOSITION.md step 5).
//
// Creates the WebGPU renderer + scene + camera and wires the KTX2 transcoder.
// main.ts calls bootMark("gpu") immediately after this resolves.
import { createRenderCore, type RenderCore } from "../renderCore";
import { initTextures } from "../../render/textures";

export type BootGpuResult = RenderCore;

export async function bootGpu(app: HTMLElement): Promise<BootGpuResult> {
  const core = await createRenderCore(app);
  initTextures(core.renderer); // wire the KTX2 transcoder now that the renderer is initialized
  return core;
}
