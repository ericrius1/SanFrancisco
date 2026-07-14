import * as THREE from "three/webgpu";
import { armCinematic, mix, setPose, smoothstep } from "../../cinematic";
import { normalizeSurfboardConfig } from "../../vehicles/surf/config";
import type { SurfPhase } from "../../vehicles/surf/controller";
import { OCEAN_BEACH_SURF } from "../../world/oceanBeachWaves";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const SURF_AERIAL_SECONDS = 7;

// Release only after the board has visually closed the full turn. The earlier
// 5.7-radian threshold was mechanically a near-360, but its remaining ~32°
// made the final descent read tail-first in a frozen portrait frame.
const SPIN_RELEASE_RADIANS = 6.2;
const HIGH_LINE_START_SECONDS = 0.85;
const LANDING_CARVE_SECONDS = 1.35;
const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "KeyS", "ShiftLeft", "Space", "KeyX"] as const;

export type SurfAerialStage = "approach" | "spin" | "align" | "carve-down" | "resolve";

/** Frame-readable proof that the film came from the live surf controller. */
export type SurfAerialCaptureState = {
  time: number;
  stage: SurfAerialStage;
  phase: SurfPhase;
  launchAt: number | null;
  spinReleasedAt: number | null;
  landedAt: number | null;
  launchSerial: number;
  landingSerial: number;
  airSpin: number;
  landedSpin: number;
  maxAbsAirSpin: number;
  landingQuality: number;
  maxLandingCompression: number;
  clearance: number;
  hullClearance: number;
  minHullClearance: number;
  footClearanceLeft: number;
  footClearanceRight: number;
  minFootDeckClearance: number;
  maxFootDeckClearance: number;
  resetCount: number;
  complete: boolean;
  position: [number, number, number];
  controls: string[];
};

type SurfAerialWindow = Window &
  typeof globalThis & {
    __sfSurfAerialState?: SurfAerialCaptureState;
    __sfSurfAerialReport?: () => SurfAerialCaptureState;
    __sfReelReset?: () => void;
    __sfCinematicReport?: () => unknown;
  };

/**
 * One continuous, seven-second portrait-friendly surf take. The camera is the
 * only cinematic authority: board/rider motion is produced entirely by the
 * normal fixed-step SurfController and its real W/A/D inputs.
 */
export const surfAerialCinematic: Demo = {
  name: "surf-aerial",
  run(ctx) {
    const { map, sky } = ctx;
    if (!map || !sky) {
      console.warn("[demo:surf-aerial] map or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    const style = document.createElement("style");
    style.dataset.surfAerial = "true";
    style.textContent = "body.reel-capture .surf-hud{display:none!important}";
    document.head.appendChild(style);

    // Bright afternoon sun makes this an honest daytime material test: the
    // emerald face must stay saturated without hiding behind dusk exposure.
    sky.cycleEnabled = false;
    sky.setTimeOfDay(13.85);
    ctx.setExposure(1);
    // The social master is rendered natively at 1080×1920. Keep this pass
    // single-sampled: Three's downstream depth consumers expect a resolvable
    // depth texture, while a multisampled depth attachment is not sampleable as
    // a regular texture in WebGPU. Native output resolution supplies the edge
    // detail without emitting GPU validation errors during deterministic capture.
    ctx.setPostFx({ sceneSamples: 0, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;

    // A fresh isolated capture profile otherwise receives a random first-run
    // avatar (or a multiplayer-id reseed) at nondeterministic boot time. Lock a
    // clean athletic hero so visual comparisons between review takes are real.
    ctx.player.setAvatar({
      skin: 2,
      hair: "short",
      hat: "none",
      outfit: "tee",
      color: 7,
      accent: 1
    });

    // Lock both handling and artwork. A fresh capture profile otherwise rolls
    // a board from boot-time identity state; asynchronous boot order can choose
    // a longboard in one resolution and a shortboard in another, materially
    // changing pop, air time, and spin completion in an allegedly fixed take.
    ctx.player.setSurfboardConfig(normalizeSurfboardConfig({
      shape: "shortboard",
      base: 0,
      rail: 7,
      accent: 1,
      surface: "tidepool-terrazzo",
      textureZoom: 46,
      textureRotation: 50,
      textureOffsetX: 50,
      textureOffsetY: 50,
      surfaceMotion: 20,
      surfaceShimmer: 34,
      decal: "none",
      decalScale: 44,
      decalRotation: 50,
      decalX: 50,
      decalY: 35
    }));

    const win = window as SurfAerialWindow;
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const focus = new THREE.Vector3();

    let baseLaunchSerial = 0;
    let baseLandingSerial = 0;
    let launchAt: number | null = null;
    let spinReleasedAt: number | null = null;
    let landedAt: number | null = null;
    let maxAbsAirSpin = 0;
    let maxLandingCompression = 0;
    let minHullClearance = 0;
    let minFootDeckClearance = Number.POSITIVE_INFINITY;
    let maxFootDeckClearance = Number.NEGATIVE_INFINITY;
    let resetCount = 0;
    let cameraAction = 0;

    const clearControls = () => {
      for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);
    };

    const hold = (...keys: (typeof DRIVEN_KEYS)[number][]) => {
      clearControls();
      for (const key of keys) ctx.input.keys.add(key);
    };

    const resetRun = () => {
      clearControls();
      // Surf rendering, collision and crest selection all read Player.time.
      // Reset it before spawning so controller and WebGPU wave phase agree at
      // frame zero, regardless of how long the page took to boot.
      ctx.player.time = 0;
      ctx.player.teleportTo({
        x: OCEAN_BEACH_SURF.maxX + 12,
        y: 0,
        z: OCEAN_BEACH_SURF.entryZ,
        facing: Math.PI / 2,
        mode: "surf"
      });
      ctx.player.snapRenderPose();

      const telemetry = ctx.player.surfTelemetry;
      baseLaunchSerial = telemetry.launchSerial;
      baseLandingSerial = telemetry.landingSerial;
      launchAt = null;
      spinReleasedAt = null;
      landedAt = null;
      maxAbsAirSpin = 0;
      maxLandingCompression = 0;
      minHullClearance = telemetry.hullClearance;
      minFootDeckClearance = Number.POSITIVE_INFINITY;
      maxFootDeckClearance = Number.NEGATIVE_INFINITY;
      cameraAction = 0;
      resetCount += 1;
      // Establish a readable pumped trim before committing the high line.
      hold("KeyW");
    };

    resetRun();

    const captureState: SurfAerialCaptureState = {
      time: 0,
      stage: "approach",
      phase: "ride",
      launchAt: null,
      spinReleasedAt: null,
      landedAt: null,
      launchSerial: baseLaunchSerial,
      landingSerial: baseLandingSerial,
      airSpin: 0,
      landedSpin: 0,
      maxAbsAirSpin: 0,
      landingQuality: 1,
      maxLandingCompression: 0,
      clearance: 0,
      hullClearance: 0,
      minHullClearance: 0,
      footClearanceLeft: 0,
      footClearanceRight: 0,
      minFootDeckClearance: 0,
      maxFootDeckClearance: 0,
      resetCount,
      complete: false,
      position: [ctx.player.position.x, ctx.player.position.y, ctx.player.position.z],
      controls: ["KeyW"]
    };
    win.__sfSurfAerialState = captureState;
    win.__sfSurfAerialReport = () => ({
      ...captureState,
      position: [...captureState.position] as [number, number, number],
      controls: [...captureState.controls]
    });
    // The capture harness invokes this only after it has stopped the wall-clock
    // animation loop and cleared the fixed-step accumulator. That gives every
    // output resolution the same controller/body/crest state at frame zero.
    win.__sfReelReset = () => {
      resetCount = 0;
      resetRun();
    };

    armCinematic(ctx, {
      name: "surf-aerial",
      duration: SURF_AERIAL_SECONDS,
      shots: [
        {
          id: "lip-air-land",
          start: 0,
          end: SURF_AERIAL_SECONDS,
          safety: { floorClearance: 0.8 },
          camera: (sample, out) => {
            const telemetry = ctx.player.surfTelemetry;
            const line = telemetry.lineDirection || 1;
            const action = smoothstep(cameraAction);
            const surfaceY = Number.isFinite(telemetry.surfaceY)
              ? telemetry.surfaceY
              : ctx.player.renderPosition.y;
            const airHeight = Math.max(0, ctx.player.renderPosition.y - surfaceY);
            // Follow most of the aerial rise so the rider stays centered rather
            // than shrinking into the top of a tall social frame.
            const rigY = surfaceY + airHeight * 0.82;
            focus.copy(ctx.player.renderPosition);

            // Anticipate the contact beat as soon as the full turn releases.
            // The landing lens stays shoreward but rises into a modest top-down
            // three-quarter angle. That keeps the contact patch against one
            // continuous emerald face instead of sighting along the crest seam.
            const landingIn = spinReleasedAt === null
              ? 0
              : smoothstep((sample.time - spinReleasedAt) / 0.42);
            const landingOut = landedAt === null
              ? 1
              : 1 - smoothstep((sample.time - landedAt) / 1.2);
            const contact = landingIn * landingOut;

            // The air endpoint is closer than the approach endpoint; jumping
            // toward camera should grow the hero, never make him smaller.
            eye.set(
              focus.x + mix(5.8, 6, action) + 0.65 * contact,
              rigY + mix(1.55, 1.95, action) + 0.7 * contact,
              focus.z + line * (mix(10.2, 10.3, action) - 1.0 * contact)
            );
            target.copy(focus);
            target.x -= mix(0.65, 0.8, action) + 0.25 * contact;
            target.y = focus.y + mix(0.58, 0.78, action) - 0.48 * contact;
            target.z += line * (-mix(0.65, 1.1, action) + 0.35 * contact);
            setPose(out, eye, target, mix(60, 62, contact), 0);
          }
        }
      ],
      frame: (time, dt) => {
        // ?manual is installed after page readiness. While its cinematic clock
        // is held at zero the normal rAF loop may run; re-seed any advanced surf
        // step here so the first captured nonzero frame always starts from the
        // same controller + crest state.
        if (time <= 1e-8 && (ctx.player.time > 1e-8 || ctx.player.mode !== "surf")) resetRun();

        const telemetry = ctx.player.surfTelemetry;
        const launched = telemetry.launchSerial > baseLaunchSerial || telemetry.phase === "air";
        if (launchAt === null && launched) launchAt = time;
        maxAbsAirSpin = Math.max(maxAbsAirSpin, Math.abs(telemetry.airSpin));
        maxLandingCompression = Math.max(maxLandingCompression, telemetry.landingCompression);
        minHullClearance = Math.min(minHullClearance, telemetry.hullClearance);
        const footClearance = ctx.player.surfFootDeckClearance;
        if (time > 1e-8) {
          minFootDeckClearance = Math.min(
            minFootDeckClearance,
            footClearance.left,
            footClearance.right
          );
          maxFootDeckClearance = Math.max(
            maxFootDeckClearance,
            footClearance.left,
            footClearance.right
          );
        }

        let stage: SurfAerialStage;
        if (launchAt === null) {
          // First establish a pumped line, then carve up the steep face until
          // the controller's own lip-energy telemetry commits takeoff.
          stage = "approach";
          if (time < HIGH_LINE_START_SECONDS) hold("KeyW");
          else hold("KeyW", "KeyD");
        } else if (telemetry.phase === "air") {
          if (spinReleasedAt === null && Math.abs(telemetry.airSpin) < SPIN_RELEASE_RADIANS) {
            stage = "spin";
            hold("KeyD");
          } else {
            if (spinReleasedAt === null) spinReleasedAt = time;
            stage = "align";
            hold();
          }
        } else {
          if (landedAt === null && telemetry.landingSerial > baseLandingSerial) landedAt = time;
          if (landedAt !== null && time - landedAt < LANDING_CARVE_SECONDS) {
            // Opposite rail: descend the face under power, then let the final
            // beat coast so the result reads as a completed surf line.
            stage = "carve-down";
            hold("KeyW", "KeyA");
          } else {
            stage = "resolve";
            hold();
          }
        }

        captureState.time = time;
        captureState.stage = stage;
        captureState.phase = telemetry.phase;
        captureState.launchAt = launchAt;
        captureState.spinReleasedAt = spinReleasedAt;
        captureState.landedAt = landedAt;
        captureState.launchSerial = telemetry.launchSerial;
        captureState.landingSerial = telemetry.landingSerial;
        captureState.airSpin = telemetry.airSpin;
        captureState.landedSpin = telemetry.landedSpin;
        captureState.maxAbsAirSpin = maxAbsAirSpin;
        captureState.landingQuality = telemetry.landingQuality;
        captureState.maxLandingCompression = maxLandingCompression;
        captureState.clearance = telemetry.clearance;
        captureState.hullClearance = telemetry.hullClearance;
        captureState.minHullClearance = minHullClearance;
        captureState.footClearanceLeft = footClearance.left;
        captureState.footClearanceRight = footClearance.right;
        captureState.minFootDeckClearance = Number.isFinite(minFootDeckClearance)
          ? minFootDeckClearance
          : Math.min(footClearance.left, footClearance.right);
        captureState.maxFootDeckClearance = Number.isFinite(maxFootDeckClearance)
          ? maxFootDeckClearance
          : Math.max(footClearance.left, footClearance.right);
        captureState.resetCount = resetCount;
        captureState.complete =
          landedAt !== null &&
          maxAbsAirSpin >= SPIN_RELEASE_RADIANS &&
          telemetry.landingSerial > baseLandingSerial;
        captureState.position[0] = ctx.player.position.x;
        captureState.position[1] = ctx.player.position.y;
        captureState.position[2] = ctx.player.position.z;
        captureState.controls = DRIVEN_KEYS.filter((key) => ctx.input.keys.has(key));

        const cameraTarget = telemetry.phase === "air"
          ? 1
          : landedAt !== null && time - landedAt < 0.75
            ? 0.55
            : 0;
        const cameraResponse = cameraTarget > cameraAction ? 3.8 : 5.5;
        cameraAction +=
          (cameraTarget - cameraAction) *
          (1 - Math.exp(-Math.max(0, dt) * cameraResponse));
      }
    });

    // The stock capture harness already persists __sfCinematicReport. Extend
    // that existing report instead of requiring a surf-specific recorder.
    const cinematicReport = win.__sfCinematicReport;
    win.__sfCinematicReport = () => {
      const base = cinematicReport?.();
      return {
        ...(base && typeof base === "object" ? base : {}),
        surfAerial: win.__sfSurfAerialReport?.() ?? null
      };
    };
  }
};
