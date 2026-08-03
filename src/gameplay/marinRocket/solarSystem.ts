import * as THREE from "three/webgpu";
import type { RocketFlightTelemetry } from "../../vehicles/plane";
import { MARIN_ROCKET_FLIGHT } from "../../vehicles/plane/rocketFlight";
import { MARIN_ROCKET_SITE } from "./meta";
import {
  CELESTIAL_ROUTE,
  formatMissionTime,
  type CelestialRouteStop
} from "./route";

const ATLAS_URL = "/space/celestial-atlas.webp";
const ATLAS_COLUMNS = 5;
const ATLAS_ROWS = 2;
const MARKER_EDGE = 0.82;
export const MARIN_SPACE_LAYER = 29;

type CelestialBody = {
  stop: CelestialRouteStop;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  position: THREE.Vector3;
  routeIndex: number;
};

export type CelestialRouteStatus = {
  id: string;
  label: string;
  state: "home" | "visited" | "target" | "ahead";
  plannedTime: string;
};

export type CelestialWorldMarker = {
  id: string;
  label: string;
  distance: number;
  x: number;
  y: number;
  onScreen: boolean;
  selected: boolean;
  visited: boolean;
};

export type CelestialNavigation = {
  targetLabel: string;
  targetDistance: number;
  targetPlannedSeconds: number;
  elapsedSeconds: number;
  markerX: number;
  markerY: number;
  markerAngle: number;
  markerOnScreen: boolean;
  overlaysVisible: boolean;
  bodyMarkers: readonly CelestialWorldMarker[];
  route: readonly CelestialRouteStatus[];
  reached: CelestialRouteStop | null;
  complete: boolean;
};

function setAtlasUv(geometry: THREE.PlaneGeometry, column: number, row: number): void {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const u0 = column / ATLAS_COLUMNS;
  const u1 = (column + 1) / ATLAS_COLUMNS;
  const v0 = (ATLAS_ROWS - row - 1) / ATLAS_ROWS;
  const v1 = (ATLAS_ROWS - row) / ATLAS_ROWS;
  uv.setXY(0, u0, v1);
  uv.setXY(1, u1, v1);
  uv.setXY(2, u0, v0);
  uv.setXY(3, u1, v0);
  uv.needsUpdate = true;
}

export class MarinSolarSystem {
  readonly root = new THREE.Group();
  readonly ready: Promise<void>;

  #bodies: CelestialBody[] = [];
  #visited = new Set<string>(["earth"]);
  #targetIndex = 1;
  #insideTargetId: string | null = null;
  #active = false;
  #launch = new THREE.Vector3();
  #direction = new THREE.Vector3();
  #cameraSpace = new THREE.Vector3();
  #projected = new THREE.Vector3();
  #lastNavigation: CelestialNavigation | null = null;
  #texture: THREE.Texture | null = null;

  constructor(launchY: number) {
    this.root.name = "marin_compressed_solar_system";
    this.root.visible = false;
    this.#launch.set(MARIN_ROCKET_SITE.x, launchY, MARIN_ROCKET_SITE.z);
    this.ready = this.#load();
  }

  get debugState() {
    return {
      active: this.#active,
      assetUrl: ATLAS_URL,
      bodyCount: this.#bodies.length,
      currentTarget: CELESTIAL_ROUTE[this.#targetIndex]?.id ?? null,
      visited: [...this.#visited],
      route: CELESTIAL_ROUTE.map((stop) => {
        const position = this.#bodies.find((body) => body.stop.id === stop.id)?.position;
        return {
          id: stop.id,
          plannedSeconds: stop.plannedSeconds,
          routeDistance: Math.round(stop.routeDistance),
          position: position ? { x: position.x, y: position.y, z: position.z } : null
        };
      }),
      navigation: this.#lastNavigation
    };
  }

  begin(): void {
    this.#active = true;
    this.#visited.clear();
    this.#visited.add("earth");
    this.#targetIndex = 1;
    this.#insideTargetId = null;
    this.#lastNavigation = null;
  }

  cycleTarget(direction: 1 | -1): CelestialRouteStop {
    this.#targetIndex = (
      this.#targetIndex + direction + CELESTIAL_ROUTE.length
    ) % CELESTIAL_ROUTE.length;
    this.#insideTargetId = null;
    return CELESTIAL_ROUTE[this.#targetIndex];
  }

  selectTarget(id: string): CelestialRouteStop | null {
    const index = CELESTIAL_ROUTE.findIndex((stop) => stop.id === id);
    if (index < 0) return null;
    this.#targetIndex = index;
    this.#insideTargetId = null;
    return CELESTIAL_ROUTE[index];
  }

  update(
    playerPosition: Readonly<THREE.Vector3>,
    camera: THREE.Camera,
    telemetry: Readonly<RocketFlightTelemetry>,
    elapsedSeconds: number
  ): CelestialNavigation | null {
    if (!this.#active || this.#bodies.length === 0) return null;
    this.root.visible = telemetry.spaceFactor > 0.08;
    for (const body of this.#bodies) {
      body.mesh.visible = true;
      body.mesh.quaternion.copy(camera.quaternion);
    }

    let reached: CelestialRouteStop | null = null;
    const targetBody = this.#targetBody();
    if (targetBody) {
      const inside = playerPosition.distanceToSquared(targetBody.position) <=
        targetBody.stop.encounterRadius * targetBody.stop.encounterRadius;
      if (inside && this.#insideTargetId !== targetBody.stop.id) {
        reached = targetBody.stop;
        this.#visited.add(reached.id);
        this.#insideTargetId = targetBody.stop.id;
      } else if (!inside && this.#insideTargetId === targetBody.stop.id) {
        this.#insideTargetId = null;
      }
    }

    const next = targetBody;
    const route = this.#routeStatus();
    if (!next) {
      return null;
    }

    const overlaysVisible = telemetry.spaceFactor > 0.86;
    const bodyMarkers = this.#bodies.map((body) => {
      const projection = this.#projectBody(body, camera);
      return {
        id: body.stop.id,
        label: body.stop.label,
        distance: playerPosition.distanceTo(body.position),
        x: projection.x,
        y: projection.y,
        onScreen: projection.onScreen,
        selected: body.routeIndex === this.#targetIndex,
        visited: this.#visited.has(body.stop.id)
      };
    });

    const selectedProjection = this.#projectBody(next, camera);
    let x = selectedProjection.x;
    let y = selectedProjection.y;
    if (!selectedProjection.inFront) {
      x = -x;
      y = -y;
    }
    const onScreen = selectedProjection.onScreen;
    if (!onScreen) {
      const edgeScale = MARKER_EDGE / Math.max(Math.abs(x), Math.abs(y), 0.001);
      x *= edgeScale;
      y *= edgeScale;
    }

    this.#lastNavigation = {
      targetLabel: next.stop.label,
      targetDistance: playerPosition.distanceTo(next.position),
      targetPlannedSeconds: next.stop.plannedSeconds,
      elapsedSeconds,
      markerX: THREE.MathUtils.clamp(x, -MARKER_EDGE, MARKER_EDGE),
      markerY: THREE.MathUtils.clamp(y, -MARKER_EDGE, MARKER_EDGE),
      markerAngle: Math.atan2(x, y),
      markerOnScreen: onScreen,
      overlaysVisible,
      bodyMarkers,
      route,
      reached,
      complete: CELESTIAL_ROUTE.every((stop) => this.#visited.has(stop.id))
    };
    return this.#lastNavigation;
  }

  stop(): void {
    this.#active = false;
    this.#insideTargetId = null;
    this.root.visible = false;
    this.#lastNavigation = null;
  }

  dispose(): void {
    this.stop();
    const materials = new Set<THREE.Material>();
    for (const body of this.#bodies) {
      body.mesh.geometry.dispose();
      materials.add(body.mesh.material);
    }
    for (const material of materials) material.dispose();
    this.#bodies.length = 0;
    this.#texture?.dispose();
    this.#texture = null;
    this.root.removeFromParent();
  }

  async #load(): Promise<void> {
    const texture = await new THREE.TextureLoader().loadAsync(ATLAS_URL);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.#texture = texture;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.015,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });

    for (const stop of CELESTIAL_ROUTE) {
      const geometry = new THREE.PlaneGeometry(stop.displaySize * 0.8, stop.displaySize);
      setAtlasUv(geometry, stop.atlasColumn, stop.atlasRow);
      const mesh = new THREE.Mesh(geometry, material);
      const yaw = MARIN_ROCKET_SITE.heading + stop.yawOffset;
      const pitch = MARIN_ROCKET_FLIGHT.launchPitch + stop.pitchOffset;
      const pitchCos = Math.cos(pitch);
      this.#direction.set(
        -Math.sin(yaw) * pitchCos,
        Math.sin(pitch),
        -Math.cos(yaw) * pitchCos
      ).normalize();
      const position = this.#launch.clone().addScaledVector(this.#direction, stop.routeDistance);
      mesh.position.copy(position);
      mesh.name = `celestial_${stop.id}`;
      mesh.renderOrder = stop.id === "sun" ? 7 : 6;
      mesh.frustumCulled = true;
      mesh.layers.enable(MARIN_SPACE_LAYER);
      this.root.add(mesh);
      this.#bodies.push({
        stop,
        mesh,
        position,
        routeIndex: CELESTIAL_ROUTE.findIndex((target) => target.id === stop.id)
      });
    }
  }

  #targetBody(): CelestialBody | null {
    const target = CELESTIAL_ROUTE[this.#targetIndex];
    if (!target) return null;
    return this.#bodies.find((body) => body.stop.id === target.id) ?? null;
  }

  #routeStatus(): CelestialRouteStatus[] {
    const targetId = CELESTIAL_ROUTE[this.#targetIndex]?.id;
    return CELESTIAL_ROUTE.map((stop) => ({
      id: stop.id,
      label: stop.label,
      state: stop.id === targetId
        ? "target"
        : stop.home
          ? "home"
          : this.#visited.has(stop.id)
          ? "visited"
          : "ahead",
      plannedTime: stop.home ? "HOME" : formatMissionTime(stop.plannedSeconds)
    }));
  }

  #projectBody(body: CelestialBody, camera: THREE.Camera): {
    x: number;
    y: number;
    inFront: boolean;
    onScreen: boolean;
  } {
    this.#cameraSpace.copy(body.position).applyMatrix4(camera.matrixWorldInverse);
    const inFront = this.#cameraSpace.z < 0;
    this.#projected.copy(body.position).project(camera);
    const x = this.#projected.x;
    const y = this.#projected.y;
    return {
      x,
      y,
      inFront,
      onScreen: inFront && Math.abs(x) <= 0.92 && Math.abs(y) <= 0.86
    };
  }
}
