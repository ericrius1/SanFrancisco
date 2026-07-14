import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const DOG_PARK_SECONDS = 11;

const PLAYER_X = 350.5;
const PLAYER_Z = 2716;
const LAND_X = 372.5;
const LAND_Z = 2700.5;
const THROW_AT = 3.35;

/** Eleven seconds of real player throw → ball sim → dog fetch at golden hour. */
export const dogParkCinematic: Demo = {
  name: "dog-park",
  run(ctx) {
    const park = ctx.coronaHeights;
    const fetch = ctx.fetchBall;
    if (!ctx.map || !ctx.sky || !park || !fetch) {
      console.warn("[demo:dog-park] dog park services unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    ctx.sky.cycleEnabled = false;
    ctx.sky.setTimeOfDay(18.72);
    ctx.setExposure(1.14);
    ctx.setPostFx({ ink: false, dream: false, retro: false });
    ctx.setTool?.("ball");
    ctx.input.suspended = false;
    fetch.resetForCinematic();
    fetch.setActive(true);

    const ground = ctx.map.groundTop(PLAYER_X, PLAYER_Z);
    const desired = new THREE.Vector3(LAND_X - PLAYER_X, 0, LAND_Z - PLAYER_Z).normalize();
    const facing = Math.atan2(-desired.x, -desired.z);
    ctx.player.teleportTo({ x: PLAYER_X, y: ground, z: PLAYER_Z, facing, mode: "walk" });
    ctx.player.heading = facing - Math.PI;

    // The terrier is the authored partner. The other ambient actors stay in the
    // simulation but are hidden for a clean, readable one-player story.
    const hero = park.dogs[2];
    hero.controller = "park";
    hero.x = 365.5;
    hero.z = 2704;
    hero.group.position.set(hero.x, ctx.map.groundTop(hero.x, hero.z) + 0.08, hero.z);
    for (let i = 0; i < park.dogs.length; i++) park.dogs[i].group.visible = i === 2;
    for (const owner of park.owners) owner.rig.group.visible = false;

    const playerFocus = new THREE.Vector3();
    const dogFocus = new THREE.Vector3();
    const ballFocus = new THREE.Vector3();
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const throwVelocity = new THREE.Vector3();
    const hand = new THREE.Vector3();
    const playerLift = new THREE.Vector3(0, 0.72, 0);
    const trackingOffset = new THREE.Vector3();
    const landing = new THREE.Vector3(LAND_X, ctx.map.groundTop(LAND_X, LAND_Z) + 0.2, LAND_Z);

    const playerAt = (out: THREE.Vector3) => out.copy(ctx.player.renderPosition).add(playerLift);
    const dogAt = (out: THREE.Vector3) => {
      if (fetch.fetchDogWorld(out)) return out;
      return out.set(hero.x, hero.group.position.y + hero.style.scale * 0.62, hero.z);
    };
    const ballAt = (out: THREE.Vector3) => {
      if (fetch.activeBallWorld(out)) return out;
      return out.copy(landing);
    };

    const keepPlateClean = () => {
      for (const owner of park.owners) owner.rig.group.visible = false;
      for (let i = 0; i < park.dogs.length; i++) park.dogs[i].group.visible = i === 2;
      park.activity.traverse((object) => {
        if (object.name === "corona_tennis_ball" || object.name === "corona_frisbee") object.visible = false;
      });
    };

    armCinematic(ctx, {
      name: "dog-park-sunset",
      duration: DOG_PARK_SECONDS,
      letterbox: 0.052,
      shots: [
        {
          id: "park-crane",
          start: 0,
          end: 2.2,
          safety: { floorClearance: 0.9, auditOcclusion: true },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            eye.set(mix(327, 342.5, u), mix(ground + 10.8, ground + 4.6, u), mix(2732, 2724, u));
            playerAt(playerFocus);
            dogAt(dogFocus);
            target.lerpVectors(playerFocus, dogFocus, 0.42);
            setPose(out, eye, target, mix(29, 43, u), mix(-0.018, 0, u));
          }
        },
        {
          id: "throw-portrait",
          start: 2.2,
          end: 3.75,
          safety: { floorClearance: 0.85, auditOcclusion: true },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            playerAt(playerFocus);
            eye.set(mix(343.8, 346.2, u), mix(ground + 3.5, ground + 2.7, u), mix(2725.2, 2722.2, u));
            target.copy(playerFocus).addScaledVector(desired, mix(0.45, 1.05, u));
            target.y += 0.18;
            setPose(out, eye, target, mix(50, 58, u));
          }
        },
        {
          id: "ball-flight",
          start: 3.75,
          end: 5.8,
          safety: { floorClearance: 0.8 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            ballAt(ballFocus);
            // Continue from the clear throw-side axis and crane upward as the
            // ball travels. The former cross-field dolly intersected a park prop
            // halfway through the shot on cold deterministic replays.
            eye.set(mix(346.5, 349.5, u), mix(ground + 3.1, ground + 4.5, u), mix(2723, 2726, u));
            dogAt(dogFocus);
            target.lerpVectors(ballFocus, dogFocus, mix(0.18, 0.52, u));
            setPose(out, eye, target, mix(55, 68, u), Math.sin(u * Math.PI) * 0.01);
          }
        },
        {
          id: "terrier-tracking",
          start: 5.8,
          end: 9,
          safety: { floorClearance: 0.9 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            dogAt(dogFocus);
            ballAt(ballFocus);
            trackingOffset.set(mix(-7.8, -6.1, u), mix(2.7, 2.15, u), mix(5.6, 4.2, u));
            eye.copy(dogFocus).add(trackingOffset);
            target.lerpVectors(dogFocus, ballFocus, fetch.fetchPhase === "chasing" ? 0.26 : 0.06);
            target.y += 0.08;
            setPose(out, eye, target, mix(56, 48, u), mix(0.008, -0.006, u));
          }
        },
        {
          id: "golden-hour-wide",
          start: 9,
          end: 11,
          safety: { floorClearance: 0.8, auditOcclusion: true },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            playerAt(playerFocus);
            dogAt(dogFocus);
            target.lerpVectors(playerFocus, dogFocus, 0.56);
            eye.set(mix(332, 322, u), mix(ground + 8.5, ground + 13.2, u), mix(2728, 2735, u));
            setPose(out, eye, target, mix(42, 30, u));
          }
        }
      ],
      cues: [
        {
          id: "throw",
          at: THROW_AT,
          run: () => {
            ctx.player.handWorldPos(hand);
            const flight = 1.35;
            throwVelocity.set(
              (landing.x - hand.x) / flight,
              (landing.y - hand.y + 0.5 * 9.8 * flight * flight) / flight,
              (landing.z - hand.z) / flight
            );
            fetch.throwForCinematic(throwVelocity);
          }
        }
      ],
      frame: (time, dt) => {
        keepPlateClean();
        if (time < THROW_AT) {
          park.holdDog(hero, PLAYER_X, PLAYER_Z, time, Math.max(1 / 240, dt));
          const wind = smoothstep((time - 2.2) / (THROW_AT - 2.2));
          ctx.player.setBallHeld(time >= 2.2);
          ctx.player.setThrowAnim(wind * 0.44);
        } else if (time < 4.08) {
          const release = smoothstep((time - THROW_AT) / (4.08 - THROW_AT));
          ctx.player.setBallHeld(false);
          ctx.player.setThrowAnim(mix(0.44, 1, release));
        } else {
          ctx.player.setBallHeld(false);
          ctx.player.setThrowAnim(0);
        }
      },
      overlay: [
        {
          id: "intro",
          start: 0.18,
          end: 2.02,
          eyebrow: "CORONA HEIGHTS · 6:43 PM",
          title: "The city is your backyard.",
          detail: "one ball · one very ready terrier",
          accent: "#ffd78a"
        },
        {
          id: "release",
          start: 3.55,
          end: 4.72,
          eyebrow: "FETCH / 01",
          title: "Go get it!",
          accent: "#dfff72",
          align: "right",
          fade: 0.18
        },
        {
          id: "run",
          start: 5.95,
          end: 8.45,
          eyebrow: "TERRIER CAM",
          title: "Small dog. Big assignment.",
          detail: "tail velocity: excellent",
          accent: "#ffb97d",
          align: "right"
        },
        {
          id: "outro",
          start: 9.25,
          end: 10.88,
          eyebrow: "GOOD DOG · GOLDEN HOUR",
          title: "Again?",
          accent: "#ffd78a",
          align: "right"
        }
      ]
    });
  }
};
