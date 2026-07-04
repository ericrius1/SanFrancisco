// URL-driven autopilot for automated verification:
// /?demo=drive|plane|boat|drone|shoot|tower|rampage|reel|reel2
import type { Input } from "../core/input";
import type { Player } from "../player/player";
import type { PlayerMode } from "../player/types";
import type { Physics } from "../core/physics";
import type { ChaseCamera } from "../core/camera";
import type { WorldMap } from "../world/heightmap";
import * as THREE from "three/webgpu";

type Ctx = {
  input: Input;
  player: Player;
  physics: Physics;
  chase: ChaseCamera;
  hud?: {
    setHidden: (hidden: boolean) => void;
    setFaded: (faded: boolean) => void;
    message: (text: string, seconds?: number) => void;
  };
  sky?: {
    cycleEnabled: boolean;
    sunsetAzimuth: number;
    nightBrightness: number;
    setTimeOfDay: (time: number) => void;
  };
  setTool?: (tool: string) => void;
  minimap?: {
    focusLandmark: (name: string) => { x: number; z: number } | null;
    setExpanded: (on: boolean) => void;
  };
  map?: WorldMap;
  setCine?: (fn: ((dt: number) => void) | null) => void;
  setExposure?: (v: number) => void;
  setPostFx?: (values: Record<string, number | boolean>) => void;
  launchTruckFireworks?: (forward: THREE.Vector3) => void;
};

export function runDemo(name: string, ctx: Ctx) {
  const { input, player, physics, chase, hud, sky, setTool, minimap } = ctx;
  const press = (code: string) => input.keys.add(code);
  const release = (code: string) => input.keys.delete(code);
  const switchMode = (m: PlayerMode) => player.trySwitch(m);
  const tp = (x: number, y: number, z: number, heading = 0) => {
    player.heading = heading + Math.PI; // storage convention: facing+π (raw yaw goes to the body below)
    // player.position feeds trySwitch's respawn point and only refreshes on the
    // next physics step — set it too, or a switchMode right after tp spawns the
    // new body back at the old spot
    player.position.set(x, y, z);
    physics.world.setBodyTransform(player.body, [x, y, z], [0, Math.sin(heading / 2), 0, Math.cos(heading / 2)]);
    physics.world.setBodyVelocity(player.body, [0, 0, 0], [0, 0, 0]);
    player.quaternion.set(0, Math.sin(heading / 2), 0, Math.cos(heading / 2));
    player.renderPosition.set(x, y, z);
    player.renderQuaternion.copy(player.quaternion);
    player.syncMesh(0);
  };
  const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
  const releaseAll = () => {
    input.keys.clear();
    input.mouseDX = 0;
    input.mouseDY = 0;
    input.wheel = 0;
    input.wheelX = 0;
    input.fireHeld = false;
    input.firePressed = false;
  };

  switch (name) {
    case "drive":
      // Embarcadero waterfront heading south (old Columbus coords predate the
      // terrain rebuild and now sit inside a Telegraph Hill block)
      at(200, () => {
        tp(4340, 4, -380, 1.8);
        switchMode("drive");
        chase.zoom = 1.1;
      });
      at(700, () => press("KeyW"));
      at(5200, () => press("KeyA"));
      at(6000, () => release("KeyA"));
      break;

    case "rampage":
      // plow into SOMA blocks
      at(200, () => {
        tp(4230, 8, 380, 0.9);
        switchMode("drive");
        chase.zoom = 1.3;
      });
      at(600, () => {
        press("KeyW");
        press("ShiftLeft");
      });
      break;

    case "plane":
    case "fly": // legacy demo URL
      at(200, () => {
        tp(2600, 260, -2000, 2.2);
        switchMode("plane");
        chase.zoom = 1.2;
      });
      at(600, () => press("ShiftLeft"));
      at(3500, () => press("KeyA"));
      at(4300, () => release("KeyA"));
      break;

    case "boat":
      at(200, () => {
        tp(3400, 2, -2400, 2.9);
        switchMode("boat");
        chase.zoom = 1.2;
      });
      at(800, () => {
        press("KeyW");
        press("ShiftLeft");
      });
      at(6000, () => press("KeyD"));
      at(7500, () => release("KeyD"));
      break;

    case "palace":
      at(200, () => {
        tp(-360, 4, -1426, Math.PI / 2);
        switchMode("walk");
        chase.yaw = Math.PI / 2;
        chase.pitch = 0.08;
        chase.zoom = 2.35;
      });
      break;

    case "drone":
      // lift off the Embarcadero, cruise forward, strafe, then Space-hover
      at(200, () => {
        tp(4340, 6, -380, 1.8);
        switchMode("drone");
        chase.zoom = 1.1;
      });
      at(700, () => press("KeyE"));
      at(2200, () => {
        release("KeyE");
        press("ArrowUp");
        press("ShiftLeft");
      });
      at(5200, () => press("KeyD"));
      at(6400, () => {
        release("KeyD");
        release("ArrowUp");
        release("ShiftLeft");
        press("Space");
      });
      break;

    case "shoot":
      at(200, () => {
        tp(4180, 6, 150, 0.4);
        chase.yaw = 2.4;
        chase.pitch = 0.18;
      });
      at(1200, () => {
        // fire straight at the block across the street
        const dir = new THREE.Vector3();
        chase.aimDir(dir);
        physics.fireProjectile(player.aimOrigin.clone().addScaledVector(dir, 3), dir);
      });
      at(2400, () => {
        const dir = new THREE.Vector3();
        chase.aimDir(dir);
        physics.fireProjectile(player.aimOrigin.clone().addScaledVector(dir, 3), dir);
      });
      break;

    case "tower": {
      const hold = () => {
        tp(4117, 273, 33, 0);
        chase.yaw = Math.PI / 2;
        chase.pitch = 0.08;
        chase.zoom = 2.6;
      };
      at(200, () => {
        switchMode("board");
        hold();
      });
      const id = setInterval(hold, 50);
      at(7000, () => clearInterval(id));
      break;
    }

    case "explode":
      at(400, () => {
        tp(4180, 6, 150, 0.4);
        chase.yaw = 2.0;
        chase.pitch = 0.35;
        chase.zoom = 1.6;
      });
      at(1500, () => physics.explode(new THREE.Vector3(4120, 12, 90), 16));
      break;

    case "reel": {
      // 25-second showcase reel: five 5-second clips, each a different vehicle
      // in a different part of the city. Every clip is a hard cut (teleport +
      // mode swap + camera snap). Deliberately grounded/low + horizontal — no
      // fast vertical climbs, which still trip tile-stream loading hitches.
      type ReelWindow = Window &
        typeof globalThis & {
          __sfReelArmed?: boolean;
          __sfReelDone?: boolean;
          __sfReelStartedAt?: number;
          __sfStartReel?: () => void;
        };
      const win = window as ReelWindow;
      const q = new URLSearchParams(location.search);
      const holdForCapture = q.has("hold");

      // Clean gameplay footage — no captions/branding, just hide the HUD chrome.
      const style = document.createElement("style");
      style.dataset.reelCapture = "true";
      style.textContent = `
        body.reel-capture #hud,
        body.reel-capture #loading {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
      document.body.classList.add("started", "reel-capture");
      document.getElementById("loading")?.classList.add("done");
      hud?.setHidden(true);
      hud?.setFaded(true);
      hud?.message("");

      // Per-mode chase framing (metres, scaled by chase.zoom).
      const cam: Record<PlayerMode, { back: number; up: number; look: number }> = {
        walk: { back: 6.5, up: 2.4, look: 1.4 },
        drive: { back: 9.5, up: 3.2, look: 1.2 },
        plane: { back: 18, up: 5.2, look: 0.6 },
        boat: { back: 13, up: 4.4, look: 0.8 },
        drone: { back: 8, up: 2.2, look: 0.4 },
        board: { back: 7.6, up: 2.7, look: 1.2 },
        bird: { back: 9, up: 2.4, look: 0.5 },
        truck: { back: 20, up: 8.5, look: 1.6 }
      };
      const snapCamera = (mode: PlayerMode) => {
        const o = cam[mode];
        const back = o.back * chase.zoom;
        const up = o.up * chase.zoom;
        const a = player.renderPosition;
        chase.camera.position.set(
          a.x + Math.sin(chase.yaw) * Math.cos(chase.pitch) * back,
          a.y + up + Math.sin(chase.pitch) * back,
          a.z + Math.cos(chase.yaw) * Math.cos(chase.pitch) * back
        );
        chase.camera.lookAt(new THREE.Vector3(a.x, a.y + o.look, a.z));
      };

      const jump = (mode: PlayerMode, x: number, y: number, z: number, heading: number, pitch = 0.18, zoom = 1.2) => {
        releaseAll();
        tp(x, y, z, heading);
        switchMode(mode);
        // Some enter hooks reposition the player (boat bay launch, aircraft roof
        // clearance). The reel owns the shot, so re-assert the authored pose.
        tp(x, y, z, heading);
        chase.yaw = heading;
        chase.pitch = pitch;
        chase.zoom = zoom;
        snapCamera(mode);
      };

      const start = () => {
        win.__sfReelStartedAt = performance.now();
        win.__sfReelDone = false;
        if (sky) {
          sky.cycleEnabled = false;
          sky.sunsetAzimuth = 232;
          sky.setTimeOfDay(16.4); // warm, low late-afternoon sun
        }

        // Clip 1 (0-5s) — the guu carves the open bay on his hoverboard.
        at(0, () => {
          jump("board", 4180, 2.6, -1560, 2.78, 0.16, 1.12);
          press("KeyW");
          press("ShiftLeft");
        });
        at(2600, () => press("KeyD"));
        at(4300, () => release("KeyD"));

        // Clip 2 (5-10s) — set sail across the open water.
        at(5000, () => {
          jump("boat", 3400, 2.1, -2400, 2.9, 0.15, 1.5);
          press("KeyW");
          press("ShiftLeft");
        });
        at(7500, () => press("KeyA"));
        at(9200, () => release("KeyA"));

        // Clip 3 (10-15s) — drone glides low past the piers.
        at(10000, () => {
          jump("drone", 4072, 42, -1368, 0.22, 0.1, 1.4);
          press("KeyW");
          press("ShiftLeft");
        });
        at(12600, () => press("KeyD"));
        at(14100, () => release("KeyD"));

        // Clip 4 (15-20s) — the solar plane cruises the waterfront (level flight,
        // fixed altitude over open water — no fast climb to trip loading hitches).
        at(15000, () => {
          jump("plane", 4380, 128, -1180, 2.52, 0.14, 1.28);
          press("KeyW");
        });
        at(16800, () => press("KeyA"));
        at(19000, () => release("KeyA"));

        // Clip 5 (20-25s) — phoenix soars the skyline (low + horizontal).
        at(20000, () => {
          jump("bird", 4020, 58, -1080, 2.64, 0.08, 1.22);
          press("KeyW");
        });
        at(22000, () => press("Space"));
        at(22900, () => release("Space"));
        at(23100, () => press("KeyD"));
        at(24500, () => release("KeyD"));

        at(25000, () => {
          releaseAll();
          win.__sfReelDone = true;
        });
      };

      win.__sfReelArmed = true;
      win.__sfStartReel = start;
      if (!holdForCapture) start();
      break;
    }

    case "reel2": {
      // 35-second interaction reel: five 7-second clips showing off the toys —
      // paint on a wall, drone fireworks, the Exploratorium fluid pool, city
      // chimes and bubbles. Mostly night/sunset with one bright daylight beat.
      // Reuses the __sfReel* capture hooks (capture-reel.mjs SF_CAPTURE_DEMO=reel2).
      type ReelWindow = Window &
        typeof globalThis & {
          __sfReelArmed?: boolean;
          __sfReelDone?: boolean;
          __sfReelStartedAt?: number;
          __sfStartReel?: () => void;
        };
      const win = window as ReelWindow;
      const q = new URLSearchParams(location.search);
      const holdForCapture = q.has("hold");

      const style = document.createElement("style");
      style.dataset.reelCapture = "true";
      style.textContent = `
        body.reel-capture #hud,
        body.reel-capture #loading { display: none !important; }
      `;
      document.head.appendChild(style);
      document.body.classList.add("started", "reel-capture");
      document.getElementById("loading")?.classList.add("done");
      hud?.setHidden(true);
      hud?.setFaded(true);
      hud?.message("");

      const cam: Record<PlayerMode, { back: number; up: number; look: number }> = {
        walk: { back: 5.6, up: 2.3, look: 1.3 },
        drive: { back: 9.5, up: 3.2, look: 1.2 },
        plane: { back: 18, up: 5.2, look: 0.6 },
        boat: { back: 13, up: 4.4, look: 0.8 },
        drone: { back: 8.5, up: 2.6, look: 0.5 },
        board: { back: 7.2, up: 2.6, look: 1.1 },
        bird: { back: 9, up: 2.4, look: 0.5 },
        truck: { back: 20, up: 8.5, look: 1.6 }
      };
      const snapCamera = (mode: PlayerMode) => {
        const o = cam[mode];
        const back = o.back * chase.zoom;
        const up = o.up * chase.zoom;
        const a = player.renderPosition;
        chase.camera.position.set(
          a.x + Math.sin(chase.yaw) * Math.cos(chase.pitch) * back,
          a.y + up + Math.sin(chase.pitch) * back,
          a.z + Math.cos(chase.yaw) * Math.cos(chase.pitch) * back
        );
        chase.camera.lookAt(new THREE.Vector3(a.x, a.y + o.look, a.z));
      };

      // Interaction plumbing. firePressed is edge-reset every frame, so a salvo
      // (drone fireworks) must be re-pulsed; firing/fireHeld is level, so paint,
      // chimes, bubbles and the museum pokes just hold it. A slow orbit keeps the
      // shot alive and sweeps paint/chimes across the surface.
      let pulse: number | null = null;
      let panner: number | null = null;
      const stopPan = () => {
        if (panner !== null) {
          clearInterval(panner);
          panner = null;
        }
      };
      const stopFire = () => {
        input.fireHeld = false;
        input.firePressed = false;
        if (pulse !== null) {
          clearInterval(pulse);
          pulse = null;
        }
      };
      const holdFire = (toolName: string) => {
        setTool?.(toolName);
        input.suspended = false;
        input.fireHeld = true;
      };
      const pulseFire = (ms: number) => {
        input.suspended = false;
        if (pulse !== null) clearInterval(pulse);
        pulse = window.setInterval(() => (input.firePressed = true), ms);
      };
      const pan = (rate: number) => {
        stopPan();
        panner = window.setInterval(() => (chase.yaw += rate), 33);
      };

      const jump = (mode: PlayerMode, x: number, y: number, z: number, heading: number, pitch = 0.18, zoom = 1.2) => {
        stopFire();
        stopPan();
        releaseAll();
        tp(x, y, z, heading);
        switchMode(mode);
        tp(x, y, z, heading);
        chase.yaw = heading;
        chase.pitch = pitch;
        chase.zoom = zoom;
        snapCamera(mode);
      };

      const start = () => {
        win.__sfReelStartedAt = performance.now();
        win.__sfReelDone = false;
        if (sky) sky.cycleEnabled = false;
        const night = () => sky?.setTimeOfDay(21.0);
        const dusk = () => {
          if (sky) {
            sky.sunsetAzimuth = 232;
            sky.setTimeOfDay(18.5);
          }
        };
        const sunset = () => {
          if (sky) {
            sky.sunsetAzimuth = 232;
            sky.setTimeOfDay(16.8);
          }
        };
        const day = () => sky?.setTimeOfDay(12.6);

        // Clip 1 (0-7s) — DUSK — sling paint at the wall across the street.
        at(0, () => {
          dusk();
          jump("walk", 4335, 4.2, -378, 1.8, 0.05, 1.05);
          holdFire("spray");
          pan(0.0011);
        });
        at(6600, () => {
          stopFire();
          stopPan();
        });

        // Clip 2 (7-14s) — NIGHT — fire fireworks from the drone over the bay.
        at(7000, () => {
          night();
          jump("drone", 4260, 92, -1450, 2.66, -0.02, 1.35);
          press("Space"); // dead hover so the salvos frame cleanly
          pulseFire(240);
        });
        at(13600, () => stopFire());

        // Clip 3 (14-21s) — INTERIOR — stir the Exploratorium water tank (the
        // SPH "wave tank" on the Water Works wall); the guu faces it head-on.
        at(14000, () => {
          dusk(); // let some daylight leak into the shed so the tank reads
          jump("walk", 4112.6, 4.6, -1266.8, -2.523, 0.08, 1.2);
          holdFire("grab"); // museum consumes the click; grab is a harmless miss
        });
        at(20600, () => stopFire());

        // Clip 4 (21-28s) — SUNSET — ring the city with chimes from the board.
        at(21000, () => {
          sunset();
          jump("board", 4340, 4, -380, 1.8, 0.32, 1.15);
          holdFire("chimes");
          pan(0.0018);
        });
        at(27600, () => {
          stopFire();
          stopPan();
        });

        // Clip 5 (28-35s) — DAYLIGHT — blow bubbles over the sunny bay.
        at(28000, () => {
          day();
          jump("board", 4180, 2.6, -1560, 2.78, 0.2, 1.15);
          holdFire("bubbles");
        });
        at(34600, () => stopFire());

        at(35000, () => {
          stopFire();
          stopPan();
          releaseAll();
          win.__sfReelDone = true;
        });
      };

      win.__sfReelArmed = true;
      win.__sfStartReel = start;
      if (!holdForCapture) start();
      break;
    }

    case "reel3": {
      // 25-second landmark reel: five 5-second clips — hoverboard on the bay,
      // the phoenix over the Palace of Fine Arts, dragging the museum fluid tank
      // (mouse-sweep), the plane over the Golden Gate Bridge from the Presidio,
      // and the boat at dusk beside the Bay Bridge lights. Reuses __sfReel* hooks.
      type ReelWindow = Window &
        typeof globalThis & {
          __sfReelArmed?: boolean;
          __sfReelDone?: boolean;
          __sfReelStartedAt?: number;
          __sfStartReel?: () => void;
        };
      const win = window as ReelWindow;
      const q = new URLSearchParams(location.search);
      const holdForCapture = q.has("hold");

      const style = document.createElement("style");
      style.dataset.reelCapture = "true";
      style.textContent = `
        body.reel-capture #hud,
        body.reel-capture #loading { display: none !important; }
      `;
      document.head.appendChild(style);
      document.body.classList.add("started", "reel-capture");
      document.getElementById("loading")?.classList.add("done");
      hud?.setHidden(true);
      hud?.setFaded(true);
      hud?.message("");

      const cam: Record<PlayerMode, { back: number; up: number; look: number }> = {
        walk: { back: 5.6, up: 2.3, look: 1.3 },
        drive: { back: 9.5, up: 3.2, look: 1.2 },
        plane: { back: 19, up: 5.4, look: 0.8 },
        boat: { back: 16, up: 3.2, look: 2.8 }, // sit well behind + tilt up at the tall bridge span
        drone: { back: 8.5, up: 2.6, look: 0.5 },
        board: { back: 7.6, up: 2.7, look: 1.2 },
        bird: { back: 9.5, up: 2.6, look: 0.6 },
        truck: { back: 21, up: 8.5, look: 1.6 }
      };
      const snapCamera = (mode: PlayerMode) => {
        const o = cam[mode];
        const back = o.back * chase.zoom;
        const up = o.up * chase.zoom;
        const a = player.renderPosition;
        chase.camera.position.set(
          a.x + Math.sin(chase.yaw) * Math.cos(chase.pitch) * back,
          a.y + up + Math.sin(chase.pitch) * back,
          a.z + Math.cos(chase.yaw) * Math.cos(chase.pitch) * back
        );
        chase.camera.lookAt(new THREE.Vector3(a.x, a.y + o.look, a.z));
      };

      const stopFire = () => {
        input.fireHeld = false;
        input.firePressed = false;
      };
      const holdFire = (toolName: string) => {
        setTool?.(toolName);
        input.suspended = false;
        input.fireHeld = true;
      };
      const jump = (mode: PlayerMode, x: number, y: number, z: number, heading: number, pitch = 0.18, zoom = 1.2) => {
        stopFire();
        releaseAll();
        tp(x, y, z, heading);
        switchMode(mode);
        tp(x, y, z, heading);
        chase.yaw = heading;
        chase.pitch = pitch;
        chase.zoom = zoom;
        snapCamera(mode);
      };

      const golden = () => {
        if (sky) {
          sky.sunsetAzimuth = 232;
          sky.setTimeOfDay(16.4);
        }
      };
      const duskLo = () => {
        if (sky) {
          sky.sunsetAzimuth = 232;
          sky.setTimeOfDay(18.6);
        }
      };
      const midday = () => sky?.setTimeOfDay(12.5); // bright ambient for the museum interior

      // Timeline as data so the real-time path and the deterministic
      // frame-by-frame capture (?manual) run off one clock.
      const events: { t: number; fn: () => void }[] = [
        // Clip 1 (0-5s) — hoverboard on the open bay.
        { t: 0, fn: () => { golden(); jump("board", 4180, 2.6, -1560, 2.78, 0.16, 1.12); press("KeyW"); press("ShiftLeft"); } },
        { t: 2600, fn: () => press("KeyD") },
        { t: 4300, fn: () => release("KeyD") },
        // Clip 2 (5-10s) — phoenix over the Palace of Fine Arts.
        { t: 5000, fn: () => { golden(); jump("bird", -620, 72, -1426, -1.571, 0.1, 1.25); press("KeyW"); } },
        { t: 7000, fn: () => press("Space") },
        { t: 7700, fn: () => release("Space") },
        // Clip 3 (10-18s, 8s) — pick the Exploratorium on the city map, teleport
        // in, then walk back and forth in front of the fluid tank so each pass
        // drags the SPH water as the aim sweeps across it.
        { t: 10000, fn: () => { midday(); releaseAll(); minimap?.focusLandmark("Exploratorium"); } },
        { t: 12800, fn: () => { minimap?.setExpanded(false); jump("walk", 4112.6, 4.6, -1266.8, -2.523, 0.05, 1.15); holdFire("grab"); } },
        { t: 13500, fn: () => press("KeyD") },
        { t: 14400, fn: () => { release("KeyD"); press("KeyA"); } },
        { t: 16200, fn: () => { release("KeyA"); press("KeyD"); } },
        { t: 17700, fn: () => { release("KeyD"); stopFire(); } },
        // Clip 4 (18-23s) — the plane crosses the Golden Gate Bridge from the Presidio.
        { t: 18000, fn: () => { golden(); jump("plane", -2780, 152, -1720, 0.55, 0.12, 1.3); press("KeyW"); press("ShiftLeft"); } },
        // Clip 5 (23-28s) — the boat heads straight at the lit Bay Bridge span at
        // dusk; the camera sits well behind, looking along the boat's course.
        { t: 23000, fn: () => { duskLo(); sky?.setTimeOfDay(18.9); jump("boat", 4960, 2.1, -740, 2.97, -0.02, 1.5); press("KeyW"); press("ShiftLeft"); } }
      ];

      win.__sfReelArmed = true;
      const DONE_MS = 28000;
      if (q.has("manual")) {
        // Deterministic capture: __sfReelStep(sec) fast-forwards the reel to a
        // virtual time; the capture then ticks one fixed dt and screenshots. No
        // timers, so wall-clock/GPU speed never affects the motion.
        if (sky) sky.cycleEnabled = false;
        win.__sfReelStartedAt = performance.now();
        win.__sfReelDone = false;
        let fired = 0;
        (win as unknown as { __sfReelStep: (sec: number) => void }).__sfReelStep = (sec: number) => {
          const vt = sec * 1000;
          while (fired < events.length && events[fired].t <= vt) events[fired++].fn();
        };
      } else {
        const start = () => {
          win.__sfReelStartedAt = performance.now();
          win.__sfReelDone = false;
          if (sky) sky.cycleEnabled = false;
          for (const e of events) at(e.t, e.fn);
          at(DONE_MS, () => {
            stopFire();
            releaseAll();
            win.__sfReelDone = true;
          });
        };
        win.__sfStartReel = start;
        if (!holdForCapture) start();
      }
      break;
    }

    case "bridge": {
      // 14-second twilight hero shot: the Freedom Truck crosses the Golden Gate
      // main span while the guitarist jams; the camera starts ahead facing the
      // truck, orbits around to behind it, then the rocket battery fires a
      // red/white/blue barrage down the deck. Fully on-rails via the cine hook
      // (main.ts) — truck pose AND camera are a pure function of virtual time, so
      // the deterministic frame capture is glassy-smooth.
      type CineWindow = Window &
        typeof globalThis & {
          __sfReelArmed?: boolean;
          __sfReelDone?: boolean;
          __sfReelStep?: (sec: number) => void;
          __cineT?: number;
        };
      const win = window as CineWindow;
      const q = new URLSearchParams(location.search);
      const manual = q.has("manual");
      const map = ctx.map!;
      const setCine = ctx.setCine!;
      const fireGuns = ctx.launchTruckFireworks!;

      // clean plate — no HUD chrome
      const style = document.createElement("style");
      style.dataset.reelCapture = "true";
      style.textContent = `body.reel-capture #hud, body.reel-capture #loading { display:none !important; }`;
      document.head.appendChild(style);
      document.body.classList.add("started", "reel-capture");
      document.getElementById("loading")?.classList.add("done");
      hud?.setHidden(true);
      hud?.setFaded(true);

      // twilight — late dusk, sun just under the WNW horizon; lift the night fill
      // hard so the truck + guitarist read against the afterglow (the fireworks
      // are HDR and still punch through)
      if (sky) {
        sky.cycleEnabled = false;
        sky.sunsetAzimuth = 250;
        sky.setTimeOfDay(18.85);
        sky.nightBrightness = 2.15;
      }
      ctx.setExposure?.(0.2); // lift the whole grade (default 0.13) so the dark
      // truck reads at twilight; the HDR fireworks still punch well past it

      // stylize the shot: ink & wash outlines + retro CRT (dream haze off)
      ctx.setPostFx?.({
        ink: true,
        inkStrength: 0.7,
        inkWidth: 1.5,
        dream: false,
        retro: true,
        retroPixel: 1,
        retroLevels: 6,
        retroScan: 0.35
      });

      // --- Golden Gate main-span path (bridge 0; drive [1]→[3], the high deck)
      const line = map.meta.bridges[0].line;
      const mid = new THREE.Vector3(line[2][0], 0, line[2][1]);
      const dir = new THREE.Vector3(line[3][0] - line[1][0], 0, line[3][1] - line[1][1]).normalize();
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      const heading = Math.atan2(-dir.x, -dir.z); // truck front (-Z) → dir
      const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
      const SPEED = 25; // m/s — a believable parade cruise (~350 m over the shot)
      const RIDE_H = 3.0; // chassis centre above the deck (wheels planted)
      // drive the clear span BETWEEN the two towers, ending ~150 m short of the
      // mid-span tower so it looms ahead the whole shot (and the orbit never
      // swings the camera into it). towers sit at sFromMid 0 and -1019.
      const START = mid.clone().addScaledVector(dir, -500);

      const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
      const smooth = (x: number) => {
        const c = clamp01(x);
        return c * c * (3 - 2 * c);
      };
      const mixf = (a: number, b: number, t: number) => a + (b - a) * t;

      const camPos = new THREE.Vector3();
      const look = new THREE.Vector3();
      const truckPos = new THREE.Vector3();
      let fired = false;

      const poseAt = (T: number) => {
        const s = SPEED * Math.max(0, T);
        const px = START.x + dir.x * s;
        const pz = START.z + dir.z * s;
        let deck = map.bridgeDeck(px, pz);
        if (!Number.isFinite(deck)) deck = 66;
        const py = deck + RIDE_H;
        truckPos.set(px, py, pz);

        // truck on rails: render pose (what the camera + mesh use), plus keep the
        // physics body pinned so it can't drift/tumble under us
        player.renderPosition.copy(truckPos);
        player.position.copy(truckPos);
        player.renderQuaternion.copy(yawQ);
        player.quaternion.copy(yawQ);
        player.velocity.set(dir.x * SPEED, 0, dir.z * SPEED);
        player.speed = SPEED;
        player.meshes.truck.position.copy(truckPos);
        player.meshes.truck.quaternion.copy(yawQ);
        physics.world.setBodyTransform(player.body, [px, py, pz], [yawQ.x, yawQ.y, yawQ.z, yawQ.w]);
        physics.world.setBodyVelocity(player.body, [dir.x * SPEED, 0, dir.z * SPEED], [0, 0, 0]);

        // camera: azimuth 0=ahead(front) → π=behind, orbiting past the bay side
        const orbit = smooth((T - 3.4) / 4.8); // the sweep happens 3.4s..8.2s
        const fin = smooth((T - 9.0) / 5.0); // finale drift as the shells go up
        const a = mixf(0.55, Math.PI, orbit); // front-right 3/4 → dead behind
        const R = mixf(23, 30, orbit) - fin * 4; // ease in a slow push toward the show
        const H = mixf(4.6, 9.2, orbit) + fin * 2.2; // and crane up over the barrage
        camPos
          .copy(truckPos)
          .addScaledVector(dir, Math.cos(a) * R)
          .addScaledVector(right, Math.sin(a) * R);
        camPos.y = truckPos.y + H;
        // once behind, tip the look forward+up so the launched shells frame cleanly
        const fwdLook = smooth((T - 8.0) / 2.6);
        look
          .copy(truckPos)
          .addScaledVector(dir, mixf(0, 42, fwdLook));
        look.y = truckPos.y + mixf(2.4, 6, fwdLook);
        chase.camera.position.copy(camPos);
        chase.camera.lookAt(look);
      };

      const step = (T: number) => {
        poseAt(T);
        if (!fired && T >= 9.4) {
          // launch late enough that the barrage is still peaking at the cut
          fired = true;
          fireGuns(dir.clone());
        }
      };

      // put the truck on the bridge + into truck mode before the hook takes over
      tp(START.x, map.bridgeDeck(START.x, START.z) + RIDE_H, START.z, heading);
      switchMode("truck");
      tp(START.x, map.bridgeDeck(START.x, START.z) + RIDE_H, START.z, heading);
      poseAt(0);

      win.__cineT = 0;
      win.__sfReelArmed = true;
      win.__sfReelDone = false;
      setCine((dt: number) => {
        if (!manual) win.__cineT = Math.min(14, (win.__cineT ?? 0) + dt);
        step(win.__cineT ?? 0);
        if ((win.__cineT ?? 0) >= 14) win.__sfReelDone = true;
      });
      // deterministic capture drives virtual time; the hook reads it each frame
      win.__sfReelStep = (sec: number) => {
        win.__cineT = sec;
      };
      break;
    }
  }
}
