// URL-driven autopilot for automated verification:
// /?demo=drive|plane|boat|drone|tower|rampage|reel|reel2
import type { Input } from "../core/input";
import type { Player } from "../player/player";
import type { PlayerMode } from "../player/types";
import type { Physics } from "../core/physics";
import type { ChaseCamera } from "../core/camera";
import type { WorldMap } from "../world/heightmap";
import {
  BOAT_SHOT_SECONDS,
  BOAT_FIRE_AT,
  boatPath,
  boatPos,
  applyBoatCamera,
  pinBoat
} from "../gameplay/boatShot";
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
  launchBoatFireworks?: (forward: THREE.Vector3) => void;
  flyover?: { preload: () => void; trigger: (origin: THREE.Vector3, fwd: THREE.Vector3) => void };
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

    case "undercity":
      // Temporary visual-regression route used while fixing suppressed city
      // geometry; raw tp() intentionally bypasses teleportTo's ground clamp.
      at(200, () => {
        tp(4000, -850, 0, 0);
        switchMode("board");
        chase.zoom = 1.2;
      });
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
        speedboat: { back: 12, up: 3.6, look: 0.7 },
        drone: { back: 8, up: 2.2, look: 0.4 },
        board: { back: 7.6, up: 2.7, look: 1.2 },
        bird: { back: 9, up: 2.4, look: 0.5 }
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
          sky.setTimeOfDay(16.4); // warm late-afternoon sun
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
        speedboat: { back: 12, up: 3.6, look: 0.7 },
        drone: { back: 8.5, up: 2.6, look: 0.5 },
        board: { back: 7.2, up: 2.6, look: 1.1 },
        bird: { back: 9, up: 2.4, look: 0.5 }
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
        const dusk = () => sky?.setTimeOfDay(18.5);
        const sunset = () => sky?.setTimeOfDay(16.8);
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
        speedboat: { back: 13, up: 3.4, look: 1.0 },
        drone: { back: 8.5, up: 2.6, look: 0.5 },
        board: { back: 7.6, up: 2.7, look: 1.2 },
        bird: { back: 9.5, up: 2.6, look: 0.6 }
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

      const golden = () => sky?.setTimeOfDay(16.4);
      const duskLo = () => sky?.setTimeOfDay(18.6);
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

    case "ggboat": {
      // 14-second twilight hero shot: the Freedom Boat sails the strait straight
      // *under* the Golden Gate main span while the guitarist jams on the
      // foredeck; the camera starts ahead facing the boat, orbits around to
      // behind it, then the cockpit rocket battery fires a red/white/blue
      // barrage forward over the water as it slips beneath the deck. Fully
      // on-rails via the cine hook — boat pose AND camera are a pure function of
      // virtual time, so the deterministic frame capture is glassy-smooth. The
      // sea twin of case "bridge", off shared math (gameplay/boatShot.ts).
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
      const fireGuns = ctx.launchBoatFireworks!;

      // clean plate — no HUD chrome
      const style = document.createElement("style");
      style.dataset.reelCapture = "true";
      style.textContent = `body.reel-capture #hud, body.reel-capture #loading { display:none !important; }`;
      document.head.appendChild(style);
      document.body.classList.add("started", "reel-capture");
      document.getElementById("loading")?.classList.add("done");
      hud?.setHidden(true);
      hud?.setFaded(true);

      // twilight — late dusk, sun just under the WNW horizon (ahead of the boat);
      // lift the night fill so the hull + guitarist read against the afterglow
      if (sky) {
        sky.cycleEnabled = false;
        sky.setTimeOfDay(18.85);
        sky.nightBrightness = 2.15;
      }
      ctx.setExposure?.(0.2);
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

      // shot math shared with any live version — one source of truth
      const path = boatPath(map);
      const camPos = new THREE.Vector3();
      const look = new THREE.Vector3();
      const pos = new THREE.Vector3();
      let fired = false;

      const step = (T: number) => {
        boatPos(T, path, map, pos);
        pinBoat(player, physics, pos, path, T); // boat on rails, seated on the swell
        applyBoatCamera(T, path, pos, chase.camera, camPos, look);
        if (!fired && T >= BOAT_FIRE_AT) {
          fired = true;
          fireGuns(path.dir.clone());
        }
      };

      // put the boat on the water at the start + into speedboat mode before the hook takes over
      boatPos(0, path, map, pos);
      tp(pos.x, pos.y, pos.z, path.heading);
      switchMode("speedboat");
      tp(pos.x, pos.y, pos.z, path.heading);
      step(0);

      win.__cineT = 0;
      win.__sfReelArmed = true;
      win.__sfReelDone = false;
      setCine((dt: number) => {
        if (!manual) win.__cineT = Math.min(BOAT_SHOT_SECONDS, (win.__cineT ?? 0) + dt);
        step(win.__cineT ?? 0);
        if ((win.__cineT ?? 0) >= BOAT_SHOT_SECONDS) win.__sfReelDone = true;
      });
      win.__sfReelStep = (sec: number) => {
        win.__cineT = sec;
      };
      break;
    }
  }
}
