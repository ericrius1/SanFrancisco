import * as THREE from "three/webgpu";
import {
  float,
  normalize,
  positionLocal,
  positionWorld,
  texture,
  textureLevel,
  transformNormalToView,
  uv,
  vec2,
  vec3,
  color,
  mix,
  saturate
} from "three/tsl";
import { OceanCascades } from "./oceanSim";
import { DEFAULT_OCEAN_SPECTRUM, type OceanSpectrumConfig } from "./spectrum";

/**
 * Standalone spectral-ocean lab (`?oceanlab=1`, optionally `&fft=test`).
 *
 * A bare WebGPU scene — displaced grid + per-cascade texture monitors + a ms
 * readout — for validating the FFT sim in isolation before it touches the bay:
 *   • `fft=test` swaps every spectrum for a single travelling wave; the grid
 *     must show exactly 3 clean diagonal-free periods per patch (any garbling
 *     = butterfly indexing bug, any checkerboard = sign fix-up bug).
 *   • default mode shows the real JONSWAP wind sea; watch for tiling (should
 *     be none across the 420 m plane) and foam appearing on breaking crests.
 * The readout at top-left tracks frame ms EMA so sim cost is measurable alone.
 */
export async function runOceanLab(): Promise<void> {
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;background:#0a1622;overflow:hidden";

  const stats = document.createElement("div");
  stats.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:10;color:#9fe8ff;font:12px/1.5 monospace;white-space:pre;pointer-events:none";
  document.body.appendChild(stats);

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  if (backend.isWebGPUBackend !== true) {
    stats.textContent = "FATAL: WebGPU backend unavailable (project is WebGPU-only)";
    throw new Error("oceanlab: WebGPU unavailable");
  }

  const params = new URLSearchParams(location.search);
  const config: OceanSpectrumConfig = {
    ...DEFAULT_OCEAN_SPECTRUM,
    ...(params.get("fft") === "test"
      ? { debugDelta: { cyclesX: 3, cyclesZ: 0, amplitude: 0.5 } }
      : {})
  };
  const ocean = new OceanCascades(config);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e2233);
  const sun = new THREE.DirectionalLight(0xfff2df, 2.4);
  sun.position.set(-160, 140, 60);
  scene.add(sun, new THREE.HemisphereLight(0xbfe3ff, 0x0a2030, 0.65));

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 4000);

  // --- displaced ocean grid -------------------------------------------------
  const PLANE = 420;
  const SEG = 512;
  const geo = new THREE.PlaneGeometry(PLANE, PLANE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0 });

  {
    const pxz = positionLocal.xz;
    let disp: any = vec3(0);
    let slope: any = vec2(0);
    let foam: any = float(0);
    for (const c of ocean.cascades) {
      const cUv = pxz.div(c.spec.patchSize);
      const d = textureLevel(c.dispTex, cUv, float(0));
      disp = disp.add(vec3(d.x, d.y, d.z));
      const g = texture(c.derivTex, cUv);
      slope = slope.add(g.xy);
      foam = foam.add(g.w);
    }
    mat.positionNode = positionLocal.add(disp);
    mat.normalNode = transformNormalToView(normalize(vec3(slope.x.negate(), 1, slope.y.negate())));
    const foamC = saturate(foam);
    const deep = mix(color(0x06344a), color(0x0f6f8a), saturate(positionWorld.y.mul(0.8).add(0.5)));
    mat.colorNode = mix(deep, color(0xdcf5f2), foamC);
    mat.roughnessNode = mix(float(0.24), float(0.7), foamC);
  }
  const water = new THREE.Mesh(geo, mat);
  water.frustumCulled = false;
  scene.add(water);

  // --- cascade texture monitors --------------------------------------------
  ocean.cascades.forEach((c, i) => {
    const mk = (tex: THREE.Texture, row: number) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = texture(tex, uv()).mul(0.5).add(0.5);
      const q = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), m);
      q.position.set(-60 + i * 40, 42 + row * 40, -140);
      scene.add(q);
    };
    mk(c.dispTex, 1);
    mk(c.derivTex, 0);
  });

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  let last = performance.now();
  let ema = 16.6;
  let simMs = 0;
  const t0 = performance.now();
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    ema += ((now - (frame as any).prev || 16.6) - ema) * 0.05;
    (frame as any).prev = now;
    const t = (now - t0) / 1000;

    const orbit = t * 0.08;
    const alt = 26 + Math.sin(t * 0.11) * 22; // sweep low chop view ↔ high view
    camera.position.set(Math.cos(orbit) * 120, alt, Math.sin(orbit) * 120);
    camera.lookAt(0, 0, 0);

    const s0 = performance.now();
    ocean.update(renderer, t, dt);
    simMs += (performance.now() - s0 - simMs) * 0.05;

    void renderer.render(scene, camera);

    stats.textContent =
      `frame  ${ema.toFixed(2)} ms (ema)\n` +
      `dispatch(cpu) ${simMs.toFixed(2)} ms\n` +
      `draws  ${renderer.info.render.drawCalls}  tris ${(renderer.info.render.triangles / 1e6).toFixed(2)}M\n` +
      `mode   ${config.debugDelta ? "FFT TEST (expect 3 clean periods)" : "JONSWAP wind sea"}`;
  };
  frame();
}
