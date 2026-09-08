import * as THREE from "three/webgpu";
import { screenUV, texture, uniform, uv, wgslFn } from "three/tsl";
import { governorEffects } from "../render/adaptiveResolution";
import { laptopProfile } from "../render/laptopProfiles";
import { CLOUD_TUNING } from "./cloudSettings";
import { sampleCloudClimate } from "./cloudEvolution";
import cloudCode from "./volumetricClouds.wgsl?raw";
import resolveCode from "./cloudFrame.wgsl?raw";

/** First-use sky volume: a small HDR target + a dedicated reprojected history.
 * Composition stays on the depth-tested sky, so foreground geometry supplies
 * exact occlusion without upsampling a low-resolution foreground depth mask. */
export function createVolumetricCloudMaterial(backdrop: any, sun: any, atmosphereKeep: any) {
  const targets = [0,1].map(i => {
    const target = new THREE.RenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false,stencilBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:false});
    target.texture.name = `cloud_history_${i}`;
    return target;
  });
  const history = texture(targets[0].texture), output = texture(targets[1].texture, screenUV);
  const phase=uniform(0), coverage=uniform(0.56), base=uniform(680), steps=uniform(12);
  const structure=uniform(new THREE.Vector4(1,1,.65,.35)), thickness=uniform(420), drift=uniform(new THREE.Vector2()), morph=uniform(0);
  let climateTime=0,lastElapsed:number|null=null;
  const inverseProjection=uniform(new THREE.Matrix4()),cameraMatrix=uniform(new THREE.Matrix4()),previousViewProjection=uniform(new THREE.Matrix4());
  const origin=uniform(new THREE.Vector3()), historyWeight=uniform(0),frame=uniform(0),resolution=uniform(new THREE.Vector2(1,1));
  const rayMaterial = new THREE.MeshBasicNodeMaterial({depthTest:false,depthWrite:false,fog:false,toneMapped:false});
  rayMaterial.name = "cloud_volume_resolve";
  rayMaterial.fragmentNode = wgslFn(resolveCode+"\n"+cloudCode)({history,inverseProjection,cameraMatrix,previousViewProjection,coord:uv(),origin,sun,phase,coverage,base,steps,historyWeight,frame,resolution,structure,thickness,drift,morph});
  const quad = new THREE.QuadMesh(rayMaterial);
  const material = new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false});
  material.name = "sf-volumetric-clouds";
  const sample = output.toVar("cloudSample");
  const opacity = sample.a.mul(atmosphereKeep);
  material.colorNode = backdrop.mul(opacity.oneMinus()).add(sample.rgb.mul(atmosphereKeep));
  let index=0,valid=false,lastPhase=-Infinity,lastCoverage=-1,lastBase=-1,lastTimeOfDay=-1,lastThickness=-1;
  const lastStructure=new THREE.Vector4();
  const size=new THREE.Vector2(),lastOrigin=new THREE.Vector3(),lastRotation=new THREE.Quaternion(),viewProjection=new THREE.Matrix4();
  return {
    material,
    async prepare(compile:(quad:THREE.QuadMesh,target:THREE.RenderTarget)=>Promise<unknown>) { await compile(quad,targets[1]); },
    update(elapsed:number) {
      const settings=CLOUD_TUNING.values;
      const dt=lastElapsed===null?0:Math.max(0,Math.min(.25,elapsed-lastElapsed));lastElapsed=elapsed;
      phase.value=elapsed;
      if(settings.evolving)climateTime+=dt;
      const climate=sampleCloudClimate(climateTime,settings);
      coverage.value=climate.coverage;base.value=settings.altitude;thickness.value=climate.thickness;
      structure.value.set(climate.density,climate.scale,climate.billow,climate.wisps);
      const angle=settings.windDirection*Math.PI/180;
      drift.value.x+=Math.cos(angle)*settings.windSpeed*dt;drift.value.y+=Math.sin(angle)*settings.windSpeed*dt;
      morph.value+=settings.morphSpeed*dt;
      steps.value=governorEffects().level>=3?8:12;
    },
    invalidate() { valid=false; },
    render(renderer:THREE.WebGPURenderer,camera:THREE.Camera,timeOfDay:number) {
      renderer.getDrawingBufferSize(size);
      const scale=laptopProfile().hz===30 || governorEffects().level>=3 ? 0.2 : laptopProfile().hz===0 ? 0.333 : 0.25;
      const width=Math.max(1,Math.ceil(size.x*scale)),height=Math.max(1,Math.ceil(size.y*scale));
      if(targets[0].width!==width || targets[0].height!==height) {
        for(const target of targets)target.setSize(width,height);
        valid=false;
      }
      camera.updateMatrixWorld();
      if(lastOrigin.distanceToSquared(camera.position)>400 || Math.abs(lastRotation.dot(camera.quaternion))<0.985 ||
          Math.abs(phase.value-lastPhase)>0.25 || Math.abs(coverage.value-lastCoverage)>.02 || base.value!==lastBase || Math.abs(thickness.value-lastThickness)>10 || Math.max(Math.abs(structure.value.x-lastStructure.x),Math.abs(structure.value.y-lastStructure.y),Math.abs(structure.value.z-lastStructure.z),Math.abs(structure.value.w-lastStructure.w))>.05 || Math.abs(timeOfDay-lastTimeOfDay)>0.05) valid=false;
      origin.value.copy(camera.position);cameraMatrix.value.copy(camera.matrixWorld);inverseProjection.value.copy(camera.projectionMatrixInverse);
      history.value=targets[index].texture;
      const next=targets[1-index];
      resolution.value.set(width,height);historyWeight.value=valid?0.72:0;frame.value++;
      const oldTarget=renderer.getRenderTarget(),oldMRT=renderer.getMRT(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
      try { renderer.setRenderTarget(next);renderer.setMRT(null);quad.render(renderer); }
      finally { renderer.setRenderTarget(oldTarget,face,mip);renderer.setMRT(oldMRT); }
      index=1-index;output.value=next.texture;
      previousViewProjection.value.copy(viewProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
      lastOrigin.copy(camera.position);lastRotation.copy(camera.quaternion);lastPhase=phase.value;lastCoverage=coverage.value;lastBase=base.value;lastTimeOfDay=timeOfDay;lastThickness=thickness.value;lastStructure.copy(structure.value);valid=true;
    },
    stats() { return {width:targets[0].width,height:targets[0].height,bytes:targets[0].width*targets[0].height*8*2,historyValid:valid,frames:frame.value,coverage:coverage.value,density:structure.value.x,scale:structure.value.y,billow:structure.value.z,wisps:structure.value.w,thickness:thickness.value,climateTime,drift:drift.value.toArray(),morph:morph.value}; },
    dispose() { for(const target of targets)target.dispose();material.dispose();rayMaterial.dispose(); }
  };
}
