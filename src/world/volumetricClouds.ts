import * as THREE from "three/webgpu";
import { cameraPosition, normalize, positionLocal, screenCoordinate, uniform, wgslFn } from "three/tsl";
import { governorEffects } from "../render/adaptiveResolution";
import { CLOUD_TUNING } from "./cloudSettings";
import cloudCode from "./volumetricClouds.wgsl?raw";
/** Ray-marched volume on the existing sky draw: no extra render target/pass,
 * no texture downloads, and no cloud work in every grass/building fragment. */
export function createVolumetricCloudMaterial(backdrop: any, sun: any, atmosphereKeep: any) {
    const phase = uniform(0), coverage = uniform(0.52), base = uniform(680), steps = uniform(12);
    const sample = (wgslFn(cloudCode)({ origin: cameraPosition, direction: normalize(positionLocal), sun,
        pixel: (screenCoordinate as any).xy, phase, coverage, base, steps }) as any).toVar("cloudSample");
    const opacity = sample.a.mul(atmosphereKeep);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    material.name = "sf-volumetric-clouds";
    material.colorNode = backdrop.mul(opacity.oneMinus()).add(sample.rgb.mul(atmosphereKeep));
    return { material, update(elapsed: number) {
            phase.value = elapsed;
            coverage.value = Number(CLOUD_TUNING.values.coverage);
            base.value = Number(CLOUD_TUNING.values.altitude);
            steps.value = governorEffects().level >= 3 ? 8 : 12;
        }, dispose() { material.dispose(); } };
}
