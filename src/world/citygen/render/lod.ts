// Merged landscape buildings preserve roof volumes, projecting bays and the
// cornice silhouette, with filtered analytic windows instead of window modules.
// Per-vertex body colours let a whole tile of buildings share ONE mesh
// + ONE material (see chunkLod.ts) — the far city is a couple dozen draw calls,
// not thousands. `appendPrism` is the shared primitive; buildBuildingLOD wraps it
// for a single building.
import * as THREE from "three/webgpu";
import {
  attribute, normalWorld, positionGeometry, uv, float, color, mix, step, fract,
  floor as tslFloor, hash, uniform, vec3, smoothstep, fwidth,
} from "three/tsl";
import type { BuildingSpec } from "../core/types";
import {
  EXPOSURE_REBASE, WINDOW_LIT_BRIGHTNESS_MEAN, WINDOW_LIT_DENSITY,
  WINDOW_LIT_DIM, WINDOW_LIT_EMISSIVE,
} from "../../../config";
import { WINDOW_GLOW_W } from "../../facade";
import { appendPrism, emptyArrays, LOD_WINDOW_STYLE_STRIDE, LOD_BASE_OFFSET, LOD_BASE_SCALE, type PrismArrays } from "./lodGeometry";
export { appendPrism, emptyArrays, type PrismArrays, type PrismConform } from "./lodGeometry";
import { cameraCutawayMask } from "../../../render/cameraCutaway";
import { applyBirthFade, buildingGrowAmount } from "../../../render/materialize";
import {
  materialDisposeListenerCount,
  registerSharedMaterialLeakCounter,
} from "../../../render/renderObjectRegistry";

// self-lit body tint — MATCHES makeWallMaterial (theme/materials.ts), both
// carrying the exposure re-anchor factor (config.EXPOSURE_REBASE)
const BODY_EMISSIVE = 0.3 * EXPOSURE_REBASE;
// Window rect inside one cell and its area — the
// analytic average the grid collapses to once a cell falls under a pixel.
const WIN_U0 = 0.25, WIN_U1 = 0.75, WIN_V0 = 0.15, WIN_V1 = 0.91;
// Authored lit fraction for the far tier, scaled by the citywide density knob.
const LIT_FRACTION = 0.3 * WINDOW_LIT_DENSITY;

const LOD_BIRTH_UNSET = -1e9;

let sharedMat: THREE.MeshStandardNodeMaterial | null = null;

// M9 leak metric: retired chunk cells must not accumulate in this shared
// material's dispose-listener array (chunkLod dispose releases them).
registerSharedMaterialLeakCounter("cityGenChunkLodBeauty", () =>
  materialDisposeListenerCount(sharedMat)
);

/** The one material every LOD building shares — per-vertex body colour with a
 *  darkened window grid + a deterministic slice of windows lit warm, at the same
 *  peak/density as every near tier (config.WINDOW_LIT_*) so a district doesn't
 *  change character as the detail ring reaches it. Carries the SAME faint
 *  self-lit body tint as the near mesh's wall material so the far building reads
 *  as the same colour, not a dark olive silhouette. */
export function lodMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedMat) return sharedMat;
  // This is an exterior shell. Keeping it front-sided prevents its gray roof
  // caps from reading as a second, primitive city when the camera clips below
  // the world or enters a detailed building drawn just outside this LOD prism.
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.FrontSide });
  m.envMapIntensity = 5.5;
  // A merged chunk remains one draw call, but detailed buildings must be able to
  // punch their own prism away—otherwise its solid wall sits directly behind an
  // operable doorway. Per-vertex visibility + alpha test gives the streamer that
  // selective discard without rebuilding indices or splitting the chunk.
  m.alphaTest = 0.5;
  m.maskNode = cameraCutawayMask();
  const packedVisibility = attribute("lodVisibility", "float") as unknown as any;
  const birth = uniform(LOD_BIRTH_UNSET).onObjectUpdate(({ object }) =>
    (object?.userData.materializeBirthTime as number | undefined) ?? LOD_BIRTH_UNSET
  ) as unknown as any;
  const baseY = (tslFloor as any)(packedVisibility)
    .sub(1)
    .div(LOD_BASE_SCALE)
    .sub(LOD_BASE_OFFSET);
  const grow = buildingGrowAmount(birth, (fract as any)(packedVisibility));
  const p = positionGeometry as unknown as any;
  m.positionNode = (vec3 as any)(
    p.x,
    baseY.add(p.y.sub(baseY).mul(grow)),
    p.z
  );
  m.opacityNode = (step as any)(0.5, packedVisibility);
  const body = attribute("color", "vec3") as unknown as ReturnType<typeof color>;
  const isRoof = step(0.5, normalWorld.y.abs());
  const wall = float(1).sub(isRoof);
  const u = uv().x, v = uv().y;              // already in window-cell units
  const cu = fract(u), cv = fract(v);
  const profile = tslFloor(u.div(LOD_WINDOW_STYLE_STRIDE));
  const shaft = step(0.5, profile).sub(step(1.5, profile)).max(0);
  const commercial = step(0.5, profile).sub(step(2.5, profile)).max(0);
  // Match faceWindow's inset glass and the narrower Chicago shaft window.
  // These are the common 3.4 m / 3.8 m grammar bays expressed in cell units.
  const u0 = mix(float(WIN_U0), float(0.30), shaft), u1 = mix(float(WIN_U1), float(0.70), shaft);
  const v0 = mix(float(WIN_V0), float(0.17), shaft), v1 = mix(float(WIN_V1), float(0.87), shaft);
  // Screen-space size of one window cell. Everything below is written against it
  // because this tier spans 150 m → 2.8 km: the same grid is a crisp rectangle on
  // the next block and a small fraction of a pixel across the bay.
  const du = (fwidth as any)(u), dv = (fwidth as any)(v);
  const halfU = du.mul(0.5).clamp(1e-4, 0.25);
  const halfV = dv.mul(0.5).clamp(1e-4, 0.25);
  // Pixel-wide edges instead of step(): a hard grid this small crawls badly once
  // its lit panes are bright enough to see.
  const spanU = smoothstep(u0.sub(halfU), u0.add(halfU), cu)
    .mul(smoothstep(u1.sub(halfU), u1.add(halfU), cu).oneMinus());
  const spanV = smoothstep(v0.sub(halfV), v0.add(halfV), cv)
    .mul(smoothstep(v1.sub(halfV), v1.add(halfV), cv).oneMinus());
  const windowRect = spanU.mul(spanV);
  // The real faceWindow module has a 4 cm muntin cross; shaftWindow has one
  // 6 cm vertical mullion. Keep that division analytically, including its
  // subpixel area, so distant lit windows don't become large solid light cards.
  const mullionHalfU = mix(float(0.006), float(0.009), shaft);
  const mullionHalfV = float(0.006);
  const mullionU = smoothstep(mullionHalfU.sub(halfU), mullionHalfU.add(halfU), cu.sub(0.5).abs()).oneMinus();
  const mullionV = smoothstep(mullionHalfV.sub(halfV), mullionHalfV.add(halfV), cv.sub(v0.add(v1).mul(0.5)).abs()).oneMinus().mul(shaft.oneMinus());
  const mullions = windowRect.mul(mullionU.oneMinus().mul(mullionV.oneMinus()).oneMinus());
  const winCell = windowRect.sub(mullions);
  const width = u1.sub(u0), height = v1.sub(v0);
  const barU = mullionHalfU.mul(2), barV = mullionHalfV.mul(2).mul(shaft.oneMinus());
  const mullionArea = barU.mul(height).add(barV.mul(width)).sub(barU.mul(barV));
  const winArea = width.mul(height).sub(mullionArea);
  // Painted window surrounds stay visible in the landscape tier without the
  // close module's frame/mullion/sill boxes. Filter their area with the panes so
  // a subpixel frame settles to a stable average instead of flickering.
  const trimU = 0.018, trimV = 0.015;
  const frameU = smoothstep(u0.sub(trimU).sub(halfU), u0.sub(trimU).add(halfU), cu)
    .mul(smoothstep(u1.add(trimU).sub(halfU), u1.add(trimU).add(halfU), cu).oneMinus());
  const frameV = smoothstep(v0.sub(trimV).sub(halfV), v0.sub(trimV).add(halfV), cv)
    .mul(smoothstep(v1.add(trimV).sub(halfV), v1.add(trimV).add(halfV), cv).oneMinus());
  const frameCell = frameU.mul(frameV).sub(windowRect).max(0).add(mullions);
  const frameArea = width.add(trimU * 2).mul(height.add(trimV * 2)).sub(width.mul(height)).add(mullionArea);
  // Past ~1 cell/pixel no filter can recover the grid — dissolve to its analytic
  // average so a far district reads as an even glow, not a field of fireflies,
  // and resolves back into individual panes as you walk in.
  const resolve = smoothstep(0.4, 1.1, du.max(dv)).oneMinus();
  const winMask = mix(winArea, winCell, resolve).mul(wall);
  const frameMask = mix(frameArea, frameCell, resolve).mul(wall);
  const trim = color(new THREE.Color(0xf4efe5));
  const painted = mix(body, trim, frameMask);
  const glass = mix(color(new THREE.Color(0x20262b)), color(new THREE.Color(0x28323a)), commercial);
  m.colorNode = mix(painted, glass, winMask);
  const cellId = tslFloor(u).add(tslFloor(v).mul(31.0));
  // Which panes are lit, and how brightly — a second hash so brightness doesn't
  // correlate with the lit/dark draw. Same curve as the near tiers
  // (config.windowLitBrightness).
  const litSel = step(float(1 - LIT_FRACTION), hash(cellId));
  const hb = hash(cellId.add(17.0));
  const brightness = mix(float(WINDOW_LIT_DIM), float(1), hb.mul(hb));
  const litCell = winCell.mul(litSel).mul(brightness);
  const litAvg = winArea.mul(LIT_FRACTION * WINDOW_LIT_BRIGHTNESS_MEAN);
  // lit windows gate on the sky's twilight weight, same as the near facades
  const litWin = mix(color(new THREE.Color(0xffdca0)), color(new THREE.Color(0xeef0e6)), commercial)
    .mul(mix(litAvg, litCell, resolve).mul(wall))
    .mul(WINDOW_LIT_EMISSIVE)
    .mul(WINDOW_GLOW_W);
  // faint self-lit body tint on the SOLID wall only (not the glass) so shaded
  // façades don't read near-black — the near mesh's wall material does the same.
  // Negative U belongs to a solid surface and carries that material's original
  // emissive intensity (roof .5, clay .4, trim .16), avoiding a night-time swap.
  const surfaceEmissive = mix(float(BODY_EMISSIVE), u.negate().sub(1).mul(EXPOSURE_REBASE), step(0, u).oneMinus());
  const bodyTint = mix(body.mul(surfaceEmissive), trim.mul(0.16 * EXPOSURE_REBASE), frameMask).mul(float(1).sub(winMask));
  m.emissiveNode = bodyTint.add(litWin);
  // M5/M6: every chunk shares this exact material. `birth` is object-scoped,
  // so a cell re-shown after a far-arrival gate can fade/grow without per-cell
  // material clones; ordinary post-reveal CityGen publication leaves the
  // sentinel untouched and remains an atomic refinement of the baked city.
  applyBirthFade(m, { birth });
  sharedMat = m;
  return m;
}

/** Build a THREE geometry from accumulated arrays sharing the LOD material. */
export function geometryFrom(a: PrismArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(a.pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(a.nor), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(a.uvs), 2));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(a.col), 3));
  g.setAttribute("lodVisibility", new THREE.BufferAttribute(new Float32Array(a.vis), 1));
  g.setIndex(a.idx.length > 65535 ? new THREE.BufferAttribute(new Uint32Array(a.idx), 1) : a.idx);
  g.computeBoundingSphere();
  return g;
}

export interface BuiltLOD { mesh: THREE.Mesh; triangles: number; dispose(): void; }

/** Single-building LOD mesh (used for spot checks / the demo). */
export function buildBuildingLOD(spec: BuildingSpec): BuiltLOD {
  const a = emptyArrays();
  appendPrism(spec, a);
  const g = geometryFrom(a);
  const mesh = new THREE.Mesh(g, lodMaterial());
  mesh.name = "cityGenLOD";
  mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = true;
  return { mesh, triangles: a.idx.length / 3, dispose() { g.dispose(); } };
}
