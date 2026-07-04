import * as THREE from "three/webgpu";
import { attribute, normalView, instancedBufferAttribute } from "three/tsl";
import { LIGHT_SCALE } from "../config";
import type { Physics } from "../core/physics";
import type { Graffiti } from "./graffiti";
import { splatShade } from "./graffiti";

type N = any;

const MAX_BALLS = 128;
const GRAVITY = -9.81;
const LIFE = 6; // seconds before an airborne ball gives up
const BALL_RADIUS = 0.11;
const SKIN_CAP = 20; // splats per painted vehicle/player before the oldest is overwritten
const SKIN_LIFT = 0.06;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export const PAINTBALL_SPEED = 52;

/** A paintable moving thing: splats parent to `obj`, hits test against the sphere. */
export type PaintTarget = {
  obj: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  r: number;
  /** Player id the target belongs to — balls never hit their own shooter. */
  owner: number;
};

type Ball = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  age: number;
  shooter: number;
};

/**
 * Paintballs: kinematic blobs of paint that actually fly — no physics bodies,
 * just a ballistic integrate + a per-step sweep against buildings/terrain
 * (physics.raycastWorld) and the moving targets the caller hands in. Impacts
 * are cosmetic only: walls get a Graffiti burst, vehicles/players get a splat
 * stuck to their mesh via PaintSkins.
 *
 * Every client simulates every shot locally (the net message is just origin +
 * velocity + color), so remote paint lands where *this* client sees the wall.
 */
export class Paintballs {
  mesh: THREE.InstancedMesh;
  /** Wall/ground impact hook (world splat + net-free extras like audio). */
  onWater: (x: number, y: number, z: number) => void = () => {};

  #balls: Ball[] = [];
  #tint: THREE.InstancedBufferAttribute;
  #mat4 = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #dir = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scl = new THREE.Vector3();
  #hit = new THREE.Vector3();
  #nrm = new THREE.Vector3();
  #ray = new THREE.Raycaster();
  #hits: THREE.Intersection[] = [];
  #normalMatrix = new THREE.Matrix3();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 12, 8);
    this.#tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BALLS * 3), 3);
    this.#tint.setUsage(THREE.DynamicDrawUsage);

    // gloss ball: lit-from-camera shading with a hot specular dot, unlit so it
    // reads day and night without taxing the light pool
    const mat = new THREE.MeshBasicNodeMaterial();
    const tint = instancedBufferAttribute(this.#tint) as unknown as N;
    const facing = (normalView as N).z.clamp(0.0, 1.0);
    const gloss = facing.pow(9.0).mul(0.7);
    mat.colorNode = tint.mul(facing.mul(0.5).add(0.62)).add(gloss).mul(LIGHT_SCALE * 0.85);
    mat.fog = true;

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_BALLS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Launch one ball. `shooter` is the net id (0 = local while offline). */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, shooter: number) {
    if (this.#balls.length >= MAX_BALLS) this.#balls.shift();
    this.#balls.push({ x, y, z, vx, vy, vz, r: color.r, g: color.g, b: color.b, age: 0, shooter });
  }

  /** Integrate, collide, splat. Call once per rendered frame. */
  update(
    dt: number,
    physics: Physics,
    graffiti: Graffiti,
    skins: PaintSkins,
    targets: PaintTarget[],
    surfaceRay?: (origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => { point: THREE.Vector3; normal: THREE.Vector3 } | null
  ) {
    for (let i = this.#balls.length - 1; i >= 0; i--) {
      const ball = this.#balls[i];
      ball.age += dt;
      if (ball.age > LIFE || ball.y < -60) {
        this.#balls.splice(i, 1);
        continue;
      }

      const stepX = ball.vx * dt;
      const stepY = ball.vy * dt;
      const stepZ = ball.vz * dt;
      const stepLen = Math.hypot(stepX, stepY, stepZ);

      // moving targets first: segment-vs-sphere along this frame's flight
      let consumed = false;
      for (const tg of targets) {
        if (tg.owner === ball.shooter) continue;
        const rx = tg.x - ball.x;
        const ry = tg.y - ball.y;
        const rz = tg.z - ball.z;
        const t = stepLen < 1e-6 ? 0 : Math.max(0, Math.min(1, (rx * stepX + ry * stepY + rz * stepZ) / (stepLen * stepLen)));
        const cx = ball.x + stepX * t - tg.x;
        const cy = ball.y + stepY * t - tg.y;
        const cz = ball.z + stepZ * t - tg.z;
        if (cx * cx + cy * cy + cz * cz > tg.r * tg.r) continue;
        if (stepLen < 1e-6) continue;

        tg.obj.updateWorldMatrix(true, true);
        this.#pos.set(ball.x, ball.y, ball.z);
        this.#dir.set(stepX / stepLen, stepY / stepLen, stepZ / stepLen);
        this.#ray.set(this.#pos, this.#dir);
        this.#ray.near = 0;
        this.#ray.far = stepLen;
        this.#hits.length = 0;
        this.#ray.intersectObject(tg.obj, true, this.#hits);
        const hit = this.#hits[0];
        if (!hit) continue;

        this.#hit.copy(hit.point);
        if (hit.face) {
          this.#normalMatrix.getNormalMatrix(hit.object.matrixWorld);
          this.#nrm.copy(hit.face.normal).applyMatrix3(this.#normalMatrix).normalize();
        } else {
          this.#nrm.set(this.#hit.x - tg.x, this.#hit.y - tg.y, this.#hit.z - tg.z);
          if (this.#nrm.lengthSq() < 1e-6) this.#nrm.set(0, 1, 0);
          this.#nrm.normalize();
        }
        skins.stamp(tg.obj, this.#hit, this.#nrm, ball.r, ball.g, ball.b, 0.3 + Math.min(tg.r, 3) * 0.14);
        this.#balls.splice(i, 1);
        consumed = true;
        break;
      }
      if (consumed) continue;

      // world: buildings + terrain along the step; custom interiors (museum)
      // race the OSM colliders. Water swallows the ball.
      if (stepLen > 1e-6) {
        this.#pos.set(ball.x, ball.y, ball.z);
        this.#dir.set(stepX / stepLen, stepY / stepLen, stepZ / stepLen);
        const worldHit = physics.raycastWorld(this.#pos, this.#dir, stepLen);
        const customHit = surfaceRay?.(this.#pos, this.#dir, stepLen) ?? null;
        let hitT = Infinity;
        let hitKind: "water" | "surface" | null = null;
        if (worldHit) {
          hitT = this.#pos.distanceTo(worldHit.point);
          hitKind = worldHit.kind === "water" ? "water" : "surface";
          this.#hit.copy(worldHit.point);
          this.#nrm.copy(worldHit.normal);
        }
        if (customHit) {
          const t = this.#pos.distanceTo(customHit.point);
          if (t < hitT) {
            hitT = t;
            hitKind = "surface";
            this.#hit.copy(customHit.point);
            this.#nrm.copy(customHit.normal);
          }
        }
        if (hitKind) {
          if (hitKind === "water") this.onWater(this.#hit.x, this.#hit.y, this.#hit.z);
          else graffiti.burst(this.#hit, this.#nrm, TMP_COLOR.setRGB(ball.r, ball.g, ball.b));
          this.#balls.splice(i, 1);
          continue;
        }
      }

      ball.x += stepX;
      ball.y += stepY;
      ball.z += stepZ;
      ball.vy += GRAVITY * dt;
    }

    // pose the instances: stretched slightly along flight so fast balls streak
    const n = this.#balls.length;
    this.mesh.count = n;
    for (let i = 0; i < n; i++) {
      const ball = this.#balls[i];
      const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
      if (speed > 1) this.#dir.set(ball.vx / speed, ball.vy / speed, ball.vz / speed);
      else this.#dir.copy(Z_AXIS);
      this.#quat.setFromUnitVectors(Z_AXIS, this.#dir);
      this.#scl.set(1, 1, 1 + Math.min(speed * 0.012, 0.8));
      this.#pos.set(ball.x, ball.y, ball.z);
      this.#mat4.compose(this.#pos, this.#quat, this.#scl);
      this.mesh.setMatrixAt(i, this.#mat4);
      this.#tint.setXYZ(i, ball.r, ball.g, ball.b);
    }
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.#tint.needsUpdate = true;
    }
  }
}

const TMP_COLOR = new THREE.Color();

type Skin = {
  mesh: THREE.InstancedMesh;
  tint: THREE.InstancedBufferAttribute;
  write: number;
};

/**
 * Paint stuck to moving things: per-target InstancedMesh of splat quads
 * parented to the vehicle/avatar mesh, so the paint rides along (and hides
 * with the embodiment when a remote player switches modes). One shared
 * material for every skin — the tint lives in a geometry-attached instanced
 * attribute, so no new pipelines compile per painted target.
 */
export class PaintSkins {
  #mat: THREE.MeshBasicNodeMaterial;
  #skins = new Map<THREE.Object3D, Skin>();
  #sweepT = 0;
  #mat4 = new THREE.Matrix4();
  #inv = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #x = new THREE.Vector3();
  #y = new THREE.Vector3();
  #z = new THREE.Vector3();
  #tmp = new THREE.Vector3();

  constructor() {
    this.#mat = new THREE.MeshBasicNodeMaterial();
    const shade = splatShade(attribute("splatTint", "vec4") as unknown as N);
    this.#mat.colorNode = shade.colorNode;
    this.#mat.opacityNode = shade.opacityNode;
    this.#mat.transparent = true;
    this.#mat.depthWrite = false;
    this.#mat.side = THREE.DoubleSide; // curved bodies show splats from grazing angles
    this.#mat.fog = true;
  }

  /** Stamp one splat onto `target` at the world-space hit. */
  stamp(target: THREE.Object3D, point: THREE.Vector3, normal: THREE.Vector3, r: number, g: number, b: number, size: number) {
    let skin = this.#skins.get(target);
    if (!skin) {
      const geo = new THREE.PlaneGeometry(1, 1);
      const tint = new THREE.InstancedBufferAttribute(new Float32Array(SKIN_CAP * 4), 4);
      tint.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("splatTint", tint);
      const mesh = new THREE.InstancedMesh(geo, this.#mat, SKIN_CAP);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.userData.paintSkin = true;
      mesh.raycast = () => {};
      target.add(mesh);
      skin = { mesh, tint, write: 0 };
      this.#skins.set(target, skin);
    }

    const i = skin.write;
    skin.write = (skin.write + 1) % SKIN_CAP;
    skin.mesh.count = Math.max(skin.mesh.count, Math.min(SKIN_CAP, i + 1));

    // world-space quad basis on the surface, then into the target's local frame
    this.#z.copy(normal);
    const a = Math.random() * Math.PI * 2;
    this.#tmp.set(Math.cos(a), 0.31, Math.sin(a));
    this.#y.crossVectors(this.#z, this.#tmp);
    if (this.#y.lengthSq() < 1e-4) this.#y.set(1, 0, 0);
    this.#y.normalize();
    this.#x.crossVectors(this.#y, this.#z).normalize();
    this.#mat4.makeBasis(this.#x, this.#y, this.#z);
    const s = size * (0.8 + Math.random() * 0.5);
    this.#mat4.scale(this.#tmp.set(s, s, 1));
    this.#pos.copy(point).addScaledVector(normal, SKIN_LIFT);
    this.#mat4.setPosition(this.#pos);

    target.updateWorldMatrix(true, false);
    this.#inv.copy(target.matrixWorld).invert();
    this.#mat4.premultiply(this.#inv);
    skin.mesh.setMatrixAt(i, this.#mat4);
    // negative seed = never drip (bodies move; gravity-aligned drips would lie)
    skin.tint.setXYZW(i, r, g, b, -(0.05 + Math.random() * 0.95));

    skin.mesh.instanceMatrix.needsUpdate = true;
    skin.tint.needsUpdate = true;
  }

  /** Reclaim skins whose targets left the scene (despawned traffic, leavers). */
  update(dt: number, scene: THREE.Scene) {
    this.#sweepT += dt;
    if (this.#sweepT < 2.5) return;
    this.#sweepT = 0;
    for (const [target, skin] of this.#skins) {
      let root: THREE.Object3D = target;
      while (root.parent) root = root.parent;
      if (root === (scene as THREE.Object3D)) continue;
      skin.mesh.removeFromParent();
      skin.mesh.geometry.dispose(); // per-skin geometry owns the tint buffer
      this.#skins.delete(target);
    }
  }
}
