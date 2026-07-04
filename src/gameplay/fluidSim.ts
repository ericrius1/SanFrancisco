import * as THREE from "three/webgpu";
import { float, instanceIndex, instancedArray, length, mix, saturate, smoothstep, uniform, uv, vec3, vec4, vertexStage } from "three/tsl";
import { LIGHT_SCALE } from "../config";

type N = any;

// This project's tsconfig doesn't pull in @webgpu/types; the values below are
// real runtime globals in a WebGPU browser. Declare just what we touch, locally
// (module-scoped, so nothing leaks and nothing clashes with the DOM lib).
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number; UNIFORM: number };
declare const GPUShaderStage: { COMPUTE: number };
type GPUDevice = any;
type GPUBuffer = any;
type GPUBindGroup = any;
type GPUBindGroupLayout = any;
type GPUComputePipeline = any;
type GPUBufferBindingType = any;

/**
 * The Water Works SPH tank — lifted straight from the "Particle Worlds" part 3
 * essay (the fast grid-sorted fluid). The whole simulation is *raw WGSL*: a GPU
 * counting sort over a fixed 256×256 grid (histogram → three-dispatch block
 * scan → scatter) followed by SPH density + pressure passes that only ever walk
 * the 3×3 neighbouring cells. Because the sort keeps every cell's occupancy
 * tiny, the neighbour walk is genuinely O(n), never the O(k²) blow-up the old
 * hand-written TSL port hit when a stir crowded particles into one cell (that
 * runaway loop is what hung the GPU and froze the whole tab).
 *
 * The sim runs on the SAME GPUDevice as the Three WebGPURenderer. Its particle
 * state lives in raw GPUBuffers; each frame the current buffer is copied into a
 * Three storage-buffer attribute so a SpriteNodeMaterial can draw the fluid in
 * the world, at the tank's panel, with the scene camera and depth.
 *
 * Everything is authored in the essay's normalised box (x,y ∈ [-1,1], walls at
 * ±0.95, floor at -wall.y, top 0.95). The render node linearly remaps that box
 * onto the tank rectangle — so the proven parameters stay byte-for-byte intact.
 */

const GRID = 256; // 256×256 cells → 65,536; block-scan wants exactly 256 blocks
const CELLS = GRID * GRID;
const WG = 256;
const BLOCKS = CELLS / WG; // 256 — the block sums fit one workgroup scan exactly
const H = 2 / GRID; // SPH kernel radius = one grid cell, in box units

// the box's inner walls (matches the shader's hard-coded top = 0.95); wall.y is
// picked so the tank interior keeps the panel's 5:3 aspect
const WALL_X = 0.95;
const WALL_Y = 0.19;
const BOX_X0 = -WALL_X; // left edge of the mapped region
const BOX_W = WALL_X * 2; // 1.9
const BOX_Y0 = -WALL_Y; // floor
const BOX_H = 0.95 + WALL_Y; // 1.14  (top − floor)

export type FluidFrame = {
  origin: THREE.Vector3; // tank rect min corner, in the parent group's space
  ax: THREE.Vector3; // unit axis for +x (tank width), length applied via w
  ay: THREE.Vector3; // unit axis for +y (tank height), length applied via h
  w: number; // tank width  (m)
  h: number; // tank height (m)
};

// ---------------------------------------------------------------- WGSL: sort
// GPU counting sort over the uniform grid, verbatim from the essay.
const GRIDSORT_WGSL = /* wgsl */ `
struct GridParams { count: u32, grid: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> GP: GridParams;
@group(0) @binding(1) var<storage, read> partsIn: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> starts: array<u32>;
@group(0) @binding(4) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(5) var<storage, read_write> cursor: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> sorted: array<vec4f>;

fn cellOf(p: vec2f) -> u32 {
  let g = f32(GP.grid);
  let cx = u32(clamp((p.x + 1.0) * 0.5 * g, 0.0, g - 1.0));
  let cy = u32(clamp((p.y + 1.0) * 0.5 * g, 0.0, g - 1.0));
  return cy * GP.grid + cx;
}

@compute @workgroup_size(256)
fn count(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= GP.count) { return; }
  atomicAdd(&counts[cellOf(partsIn[gid.x].xy)], 1u);
}

var<workgroup> sa: array<u32, 256>;
var<workgroup> sb: array<u32, 256>;

fn scanShared(lid: u32) -> u32 {
  var fromA = true;
  var d = 1u;
  loop {
    if (d >= 256u) { break; }
    if (fromA) {
      var v = sa[lid];
      if (lid >= d) { v += sa[lid - d]; }
      sb[lid] = v;
    } else {
      var v = sb[lid];
      if (lid >= d) { v += sb[lid - d]; }
      sa[lid] = v;
    }
    workgroupBarrier();
    fromA = !fromA;
    d = d << 1u;
  }
  return sa[lid];
}

@compute @workgroup_size(256)
fn scan_blocks(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let v0 = atomicLoad(&counts[gid.x]);
  sa[lid.x] = v0;
  workgroupBarrier();
  let inclusive = scanShared(lid.x);
  starts[gid.x] = inclusive - v0;
  if (lid.x == 255u) { blockSums[wid.x] = inclusive; }
}

@compute @workgroup_size(256)
fn scan_sums(@builtin(local_invocation_id) lid: vec3u) {
  let v0 = blockSums[lid.x];
  sa[lid.x] = v0;
  workgroupBarrier();
  let inclusive = scanShared(lid.x);
  blockSums[lid.x] = inclusive - v0;
}

@compute @workgroup_size(256)
fn scan_add(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let start = starts[gid.x] + blockSums[wid.x];
  starts[gid.x] = start;
  atomicStore(&cursor[gid.x], start);
}

@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= GP.count) { return; }
  let p = partsIn[gid.x];
  let slot = atomicAdd(&cursor[cellOf(p.xy)], 1u);
  sorted[slot] = p;
}
`;

// ----------------------------------------------------------------- WGSL: SPH
// Density + pressure over the sorted buffer, verbatim from the essay.
const SPH_WGSL = /* wgsl */ `
struct SphParams {
  count: u32, grid: u32, cell: f32, dt: f32,
  gravity: f32, stiffness: f32, restDensity: f32, nearStiffness: f32,
  xsph: f32, wallK: f32, mouseRadius: f32, mouseStrength: f32,
  mouse: vec2f, mouseVel: vec2f, wall: vec2f, _pad: vec2f,
}

@group(0) @binding(0) var<uniform> SP: SphParams;
@group(0) @binding(1) var<storage, read_write> parts: array<vec4f>;
@group(0) @binding(2) var<storage, read> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read> cellCount: array<u32>;
@group(0) @binding(4) var<storage, read_write> density: array<vec2f>;

fn cellCoord(p: vec2f) -> vec2i {
  let g = f32(SP.grid);
  return vec2i(
    i32(clamp((p.x + 1.0) * 0.5 * g, 0.0, g - 1.0)),
    i32(clamp((p.y + 1.0) * 0.5 * g, 0.0, g - 1.0)),
  );
}

@compute @workgroup_size(256)
fn densityPass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= SP.count) { return; }
  let pi = parts[i].xy;
  let h = SP.cell;
  let h2 = h * h;
  let cc = cellCoord(pi);
  var rho = 0.0;
  var rhoNear = 0.0;
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      let c = cc + vec2i(ox, oy);
      if (c.x < 0 || c.y < 0 || c.x >= i32(SP.grid) || c.y >= i32(SP.grid)) { continue; }
      let ci = u32(c.y) * SP.grid + u32(c.x);
      let s = cellStart[ci];
      let n = cellCount[ci];
      for (var k = s; k < s + n; k++) {
        let d = parts[k].xy - pi;
        let r2 = dot(d, d);
        if (r2 < h2) {
          let q = sqrt(r2) / h;
          let w = 1.0 - q;
          rho += w * w;
          rhoNear += w * w * w;
        }
      }
    }
  }
  density[i] = vec2f(rho, rhoNear);
}

@compute @workgroup_size(256)
fn forcePass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= SP.count) { return; }
  var p = parts[i];
  let h = SP.cell;
  let h2 = h * h;
  let di = density[i];
  let pressI = SP.stiffness * (di.x - SP.restDensity);
  let nearI = SP.nearStiffness * di.y;
  let cc = cellCoord(p.xy);

  var acc = vec2f(0.0, -SP.gravity);
  var dv = vec2f(0.0);
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      let c = cc + vec2i(ox, oy);
      if (c.x < 0 || c.y < 0 || c.x >= i32(SP.grid) || c.y >= i32(SP.grid)) { continue; }
      let ci = u32(c.y) * SP.grid + u32(c.x);
      let s = cellStart[ci];
      let n = cellCount[ci];
      for (var k = s; k < s + n; k++) {
        if (k == i) { continue; }
        let d = parts[k].xy - p.xy;
        let r2 = dot(d, d);
        if (r2 < h2 && r2 > 1e-14) {
          let r = sqrt(r2);
          let q = r / h;
          let dj = density[k];
          let press = 0.5 * (pressI + SP.stiffness * (dj.x - SP.restDensity));
          let near = 0.5 * (nearI + SP.nearStiffness * dj.y);
          let w = 1.0 - q;
          acc -= (d / r) * (press * w + near * w * w);
          dv += (parts[k].zw - p.zw) * w;
        }
      }
    }
  }

  let md = p.xy - SP.mouse;
  let mr = length(md);
  if (mr < SP.mouseRadius) {
    acc += SP.mouseVel * SP.mouseStrength * (1.0 - mr / SP.mouseRadius);
  }

  if (p.x < -SP.wall.x) { acc.x += (-SP.wall.x - p.x) * SP.wallK; }
  if (p.x > SP.wall.x) { acc.x -= (p.x - SP.wall.x) * SP.wallK; }
  if (p.y < -SP.wall.y) { acc.y += (-SP.wall.y - p.y) * SP.wallK; }
  if (p.y > 0.95) { acc.y -= (p.y - 0.95) * SP.wallK; }

  var vel = (p.zw + acc * SP.dt) * 0.9998;
  vel += dv * SP.xsph;
  let speed = length(vel);
  if (speed > 3.0) { vel *= 3.0 / speed; }
  parts[i] = vec4f(p.xy + vel * SP.dt, vel);
}
`;

/**
 * A full-width body of fluid resting on the floor, in box coordinates. Seeding
 * the whole width (rather than a left-hand dam) means the tank reads as a filled
 * aquarium that settles with a little slosh, not a puddle that drains to a slope.
 */
function seedDam(count: number): Float32Array {
  const s = H * 0.5;
  const cols = Math.max(1, Math.floor((BOX_W * 0.94) / s));
  const x0 = BOX_X0 + (BOX_W - (cols - 1) * s) * 0.5;
  const state = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    state[i * 4] = x0 + col * s + (Math.random() - 0.5) * s * 0.4;
    state[i * 4 + 1] = BOX_Y0 + s * (row + 0.7) + (Math.random() - 0.5) * s * 0.4;
  }
  return state;
}

/**
 * A grid-sorted SPH tank. Implements the same tiny surface GrainSim exposes
 * (mesh / active / setActive / stir / update / dispatches) so the museum can
 * drive it like any other exhibit.
 */
export class FluidSim {
  mesh!: THREE.Sprite;
  dispatches = 0;
  stirs = 0; // count of stir() calls — headless proof the interaction fires

  #device: GPUDevice;
  #count: number;
  #frame: FluidFrame;
  #steps: number;

  #active = false;

  // raw compute buffers
  #bufs: [GPUBuffer, GPUBuffer];
  #counts: GPUBuffer;
  #starts: GPUBuffer;
  #blockSums: GPUBuffer;
  #cursor: GPUBuffer;
  #density: GPUBuffer;
  #gridParams: GPUBuffer;
  #sphParams: GPUBuffer;
  #renderBuf: GPUBuffer; // Three-owned attribute buffer the sprite draws from

  #sortLayout: GPUBindGroupLayout;
  #simLayout: GPUBindGroupLayout;
  #pipes: Record<string, GPUComputePipeline> = {};
  #sortGroups: [GPUBindGroup, GPUBindGroup];
  #simGroups: [GPUBindGroup, GPUBindGroup];
  #cur = 0;

  // stir state (cursor drag), in box coords
  #mouse: [number, number] = [99, 99];
  #mouseVel: [number, number] = [0, 0];
  #prev: [number, number] = [0, 0];
  #held = false;
  #lastStir = 0;
  #pendingStir = false; // a stir was requested since the last update()

  constructor(renderer: THREE.WebGPURenderer, parent: THREE.Object3D, frame: FluidFrame, count: number, size: number, steps = 4) {
    this.#device = (renderer as N).backend.device as GPUDevice;
    this.#count = count;
    this.#frame = frame;
    this.#steps = steps;
    const dev = this.#device;
    const n = count;

    // ---- buffers
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.#bufs = [dev.createBuffer({ size: n * 16, usage: storage }), dev.createBuffer({ size: n * 16, usage: storage })];
    this.#counts = dev.createBuffer({ size: CELLS * 4, usage: storage });
    this.#starts = dev.createBuffer({ size: CELLS * 4, usage: storage });
    this.#blockSums = dev.createBuffer({ size: BLOCKS * 4, usage: storage });
    this.#cursor = dev.createBuffer({ size: CELLS * 4, usage: storage });
    this.#density = dev.createBuffer({ size: n * 8, usage: GPUBufferUsage.STORAGE });
    this.#gridParams = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#sphParams = dev.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.#bufs[0], 0, seedDam(n) as BufferSource);
    dev.queue.writeBuffer(this.#gridParams, 0, new Uint32Array([n, GRID, 0, 0]));

    // ---- render bridge: a Three storage attribute the sprite reads, whose GPU
    // buffer we blit into every frame (see #buildSprite for the alloc dance)
    const posNode = this.#buildSprite(size);
    parent.add(this.mesh);
    const attr = (posNode as N).value;
    (renderer as N).backend.createStorageAttribute(attr);
    this.#renderBuf = (renderer as N).backend.get(attr).buffer as GPUBuffer;

    // ---- pipelines
    const sortMod = dev.createShaderModule({ code: GRIDSORT_WGSL });
    const simMod = dev.createShaderModule({ code: SPH_WGSL });
    const b = (type: GPUBufferBindingType) => ({ type });
    this.#sortLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: b("uniform") },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: b("read-only-storage") },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: b("storage") },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: b("storage") },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: b("storage") },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: b("storage") },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: b("storage") }
      ]
    });
    this.#simLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: b("uniform") },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: b("storage") },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: b("read-only-storage") },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: b("read-only-storage") },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: b("storage") }
      ]
    });
    const sortPl = dev.createPipelineLayout({ bindGroupLayouts: [this.#sortLayout] });
    const simPl = dev.createPipelineLayout({ bindGroupLayouts: [this.#simLayout] });
    for (const e of ["count", "scan_blocks", "scan_sums", "scan_add", "scatter"])
      this.#pipes[e] = dev.createComputePipeline({ layout: sortPl, compute: { module: sortMod, entryPoint: e } });
    for (const e of ["densityPass", "forcePass"])
      this.#pipes[e] = dev.createComputePipeline({ layout: simPl, compute: { module: simMod, entryPoint: e } });

    // ---- bind groups (ping-pong): sort reads bufs[cur] → bufs[1-cur];
    // the SPH pass then runs in place on that sorted output
    const sortBind = (partsIn: GPUBuffer, sorted: GPUBuffer) =>
      dev.createBindGroup({
        layout: this.#sortLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#gridParams } },
          { binding: 1, resource: { buffer: partsIn } },
          { binding: 2, resource: { buffer: this.#counts } },
          { binding: 3, resource: { buffer: this.#starts } },
          { binding: 4, resource: { buffer: this.#blockSums } },
          { binding: 5, resource: { buffer: this.#cursor } },
          { binding: 6, resource: { buffer: sorted } }
        ]
      });
    const simBind = (sorted: GPUBuffer) =>
      dev.createBindGroup({
        layout: this.#simLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#sphParams } },
          { binding: 1, resource: { buffer: sorted } },
          { binding: 2, resource: { buffer: this.#starts } },
          { binding: 3, resource: { buffer: this.#counts } },
          { binding: 4, resource: { buffer: this.#density } }
        ]
      });
    this.#sortGroups = [sortBind(this.#bufs[0], this.#bufs[1]), sortBind(this.#bufs[1], this.#bufs[0])];
    this.#simGroups = [simBind(this.#bufs[1]), simBind(this.#bufs[0])];

    this.mesh.visible = false;
  }

  /* ------------------------------------------------------------- rendering */

  #buildSprite(size: number): N {
    const posNode = instancedArray(this.#count, "vec4");
    const p = posNode.element(instanceIndex) as N;

    const origin = uniform(this.#frame.origin.clone()) as N;
    const ax = uniform(this.#frame.ax.clone()) as N;
    const ay = uniform(this.#frame.ay.clone()) as N;

    // box coords → tank metres → world (parent-local)
    const lx = p.x.add(WALL_X).div(BOX_W).mul(this.#frame.w);
    const ly = p.y.add(WALL_Y).div(BOX_H).mul(this.#frame.h);

    const mat = new THREE.SpriteNodeMaterial();
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.transparent = true;
    mat.fog = false;
    mat.positionNode = origin.add(ax.mul(lx)).add(ay.mul(ly));

    const speed = vertexStage(length(p.zw)) as N;
    const deep = vec3(0.02, 0.14, 0.38);
    const shallow = vec3(0.1, 0.55, 0.85);
    const foam = vec3(0.75, 0.95, 1.0);
    let col: N = mix(deep, shallow, saturate(speed.mul(0.8)));
    col = mix(col, foam, saturate(speed.sub(1.4).mul(0.5)));
    col = col.mul(LIGHT_SCALE * 0.85);

    const d2 = (uv() as N).sub(0.5).length().mul(2);
    const disc = smoothstep(1.0, 0.15, d2);
    mat.colorNode = vec4(col, disc);
    mat.scaleNode = float(size);

    this.mesh = new THREE.Sprite(mat);
    this.mesh.count = this.#count;
    this.mesh.frustumCulled = false;
    // Never a paintball target; skip during Exploratorium.raycast (which never
    // sets raycaster.camera) so Sprite.raycast doesn't crash on a null camera.
    this.mesh.raycast = () => {};
    return posNode;
  }

  /* --------------------------------------------------------------- control */

  get active() {
    return this.#active;
  }

  setActive(on: boolean) {
    if (this.#active === on) return;
    this.#active = on;
    this.mesh.visible = on;
    if (!on) {
      this.#mouse = [99, 99];
      this.#mouseVel = [0, 0];
      this.#held = false;
    }
  }

  /**
   * Disturb the tank at tank-local metres (x ∈ [0,w], y ∈ [0,h]). Called every
   * frame the visitor is interacting — by the crosshair drag (sweep the aim over
   * the tank while firing) or by walking up close (proximity). `on` is kept for
   * signature parity with GrainSim; any call is treated as a stir this frame and
   * update() clears it if nothing asks again.
   */
  stir(x: number, y: number, on: boolean) {
    if (!on) return;
    const sx = BOX_X0 + (x / this.#frame.w) * BOX_W;
    const sy = BOX_Y0 + (y / this.#frame.h) * BOX_H;
    const now = performance.now();
    const dtm = Math.min((now - this.#lastStir) / 1000, 0.1) || 0.016;
    this.#lastStir = now;
    if (this.#held) {
      const vx = (sx - this.#prev[0]) / dtm;
      const vy = (sy - this.#prev[1]) / dtm;
      const mag = Math.hypot(vx, vy);
      const clamp = mag > 4 ? 4 / mag : 1;
      // smooth the drag, and add a gentle upward bias so a slow sweep or a
      // still hold still bubbles the surface
      this.#mouseVel = [this.#mouseVel[0] * 0.6 + vx * clamp * 0.4, this.#mouseVel[1] * 0.6 + vy * clamp * 0.4 + 0.35];
    } else {
      this.#mouseVel = [0, 0.35];
    }
    this.#mouse = [sx, sy];
    this.#prev = [sx, sy];
    this.#held = true;
    this.#pendingStir = true;
    this.stirs++;
  }

  #writeParams() {
    const dv = new DataView(new ArrayBuffer(80));
    dv.setUint32(0, this.#count, true);
    dv.setUint32(4, GRID, true);
    dv.setFloat32(8, H, true); // cell / kernel radius
    dv.setFloat32(12, 0.0016, true); // dt
    dv.setFloat32(16, 3.0, true); // gravity
    dv.setFloat32(20, 60.0, true); // stiffness
    dv.setFloat32(24, 2.2, true); // rest density
    dv.setFloat32(28, 240.0, true); // near stiffness — keeps droplets apart
    dv.setFloat32(32, 0.03, true); // xsph
    dv.setFloat32(36, 2000.0, true); // wallK
    dv.setFloat32(40, 0.18, true); // mouse radius
    dv.setFloat32(44, 60.0, true); // mouse strength
    dv.setFloat32(48, this.#mouse[0], true);
    dv.setFloat32(52, this.#mouse[1], true);
    dv.setFloat32(56, this.#mouseVel[0], true);
    dv.setFloat32(60, this.#mouseVel[1], true);
    dv.setFloat32(64, WALL_X, true);
    dv.setFloat32(68, WALL_Y, true);
    this.#device.queue.writeBuffer(this.#sphParams, 0, dv.buffer);
  }

  update(_dt: number) {
    if (!this.#active) return;
    // no stir requested since the last frame → let the cursor go
    if (!this.#pendingStir) {
      this.#mouse = [99, 99];
      this.#mouseVel = [0, 0];
      this.#held = false;
    }
    this.#writeParams();
    const dev = this.#device;
    const wgs = Math.ceil(this.#count / WG);
    const enc = dev.createCommandEncoder();
    for (let s = 0; s < this.#steps; s++) {
      // counting sort (histogram → block scan → scatter)
      enc.clearBuffer(this.#counts);
      const sp = enc.beginComputePass();
      sp.setBindGroup(0, this.#sortGroups[this.#cur]);
      sp.setPipeline(this.#pipes.count);
      sp.dispatchWorkgroups(wgs);
      sp.setPipeline(this.#pipes.scan_blocks);
      sp.dispatchWorkgroups(BLOCKS);
      sp.setPipeline(this.#pipes.scan_sums);
      sp.dispatchWorkgroups(1);
      sp.setPipeline(this.#pipes.scan_add);
      sp.dispatchWorkgroups(BLOCKS);
      sp.setPipeline(this.#pipes.scatter);
      sp.dispatchWorkgroups(wgs);
      sp.end();
      // SPH density + force, in place on the sorted buffer
      const fp = enc.beginComputePass();
      fp.setBindGroup(0, this.#simGroups[this.#cur]);
      fp.setPipeline(this.#pipes.densityPass);
      fp.dispatchWorkgroups(wgs);
      fp.setPipeline(this.#pipes.forcePass);
      fp.dispatchWorkgroups(wgs);
      fp.end();
      this.#cur = 1 - this.#cur; // sorted output becomes next frame's input
      this.dispatches += 7;
    }
    // hand the freshest state to the renderer's attribute buffer
    enc.copyBufferToBuffer(this.#bufs[this.#cur], 0, this.#renderBuf, 0, this.#count * 16);
    dev.queue.submit([enc.finish()]);
    this.#pendingStir = false; // consumed; a fresh stir() must re-arm it
  }

  dispose() {
    for (const b of [...this.#bufs, this.#counts, this.#starts, this.#blockSums, this.#cursor, this.#density, this.#gridParams, this.#sphParams])
      b.destroy();
  }
}
