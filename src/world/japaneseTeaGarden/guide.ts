import * as THREE from "three/webgpu";
import {
  NoopVoiceOutput,
  type DialogueProvider,
  type DialogueTurn,
  type VoiceOutput
} from "../../gameplay/agents/dialogue";
import { ProjectedDialogueUI } from "../../ui/projectedDialogue";
import {
  createScriptedTeaGardenDialogueSource,
  TEA_MASTER_SPEAKER,
  type TeaGardenDialogueChapter,
  type TeaGardenDialogueSource
} from "./dialogue";
import {
  GUIDE_HOME,
  TEA_GARDEN_TOUR_STOPS,
  type TeaGardenTerrain,
  type TeaGardenXZ
} from "./layout";
import {
  createTeaMasterVisual,
  type TeaMasterAction,
  type TeaMasterVisualDebugState
} from "./teaMaster";

export type TeaGardenPlayerPosition = { readonly x: number; readonly y: number; readonly z: number };

export type TeaGardenGuidePhase = "idle" | "speaking" | "walking" | "waiting" | "returning";

export type TeaGardenGuideDebugState = {
  phase: TeaGardenGuidePhase;
  chapter: TeaGardenDialogueChapter | null;
  stopIndex: number;
  routePoint: number;
  routeLength: number;
  playerDistance: number;
  busy: boolean;
  worldVisible: boolean;
  iroh: TeaMasterVisualDebugState;
};

export type TeaGardenGuide = {
  group: THREE.Group;
  setWorldVisible(visible: boolean): void;
  update(dt: number, time: number, player: TeaGardenPlayerPosition, camera: THREE.Camera): void;
  project(camera: THREE.Camera): void;
  interact(player: TeaGardenPlayerPosition, mode: string): boolean;
  debugState(): TeaGardenGuideDebugState;
  dispose(): void;
};

export type TeaGardenGuideOptions = {
  dialogueSource?: TeaGardenDialogueSource;
  voiceOutput?: VoiceOutput;
  dialogueParent?: HTMLElement;
};

const START_RANGE = 5.4;
const CARD_RANGE = 17;
const ACTIVE_RANGE = CARD_RANGE;
const WAIT_DISTANCE = 12.5;
const RESUME_DISTANCE = 8.25;
const WAIT_UI_RANGE = 25;
const WALK_SPEED = 1.65;
const TURN_RESPONSE = 7;

function distanceXZ(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function actionForTurn(turn: DialogueTurn): TeaMasterAction {
  const tag = turn.metadata?.tags?.find((value) => value.startsWith("action:"));
  const action = tag?.slice("action:".length);
  if (action === "welcome" || action === "serve" || action === "point" || action === "talk") return action;
  return "talk";
}

function returnRoute(): readonly TeaGardenXZ[] {
  const route: TeaGardenXZ[] = [];
  for (let stopIndex = TEA_GARDEN_TOUR_STOPS.length - 1; stopIndex >= 0; stopIndex--) {
    const stopRoute = TEA_GARDEN_TOUR_STOPS[stopIndex].route;
    for (let pointIndex = stopRoute.length - 1; pointIndex >= 0; pointIndex--) {
      const point = stopRoute[pointIndex];
      const previous = route[route.length - 1];
      if (!previous || distanceXZ({ x: previous[0], z: previous[1] }, { x: point[0], z: point[1] }) > 0.2) {
        route.push(point);
      }
    }
  }
  route.push([GUIDE_HOME.x, GUIDE_HOME.z]);
  return route;
}

export function createTeaGardenGuide(
  map: TeaGardenTerrain,
  options: TeaGardenGuideOptions = {}
): TeaGardenGuide {
  const visual = createTeaMasterVisual();
  visual.group.position.set(GUIDE_HOME.x, map.groundTop(GUIDE_HOME.x, GUIDE_HOME.z), GUIDE_HOME.z);
  visual.group.rotation.y = GUIDE_HOME.heading;

  const source = options.dialogueSource ?? createScriptedTeaGardenDialogueSource();
  const voice = options.voiceOutput ?? new NoopVoiceOutput();
  const ui = new ProjectedDialogueUI(visual.dialogueAnchor, {
    parent: options.dialogueParent,
    defaultTopic: "Japanese Tea Garden",
    defaultNextHint: "E · Continue",
    className: "projected-dialogue--tea-garden"
  });

  let phase: TeaGardenGuidePhase = "idle";
  let chapter: TeaGardenDialogueChapter | null = null;
  let provider: DialogueProvider | null = null;
  let currentTurn: DialogueTurn | null = null;
  let stopIndex = -1;
  let route: readonly TeaGardenXZ[] = [];
  let routePoint = 0;
  let worldVisible = true;
  let playerDistance = Number.POSITIVE_INFINITY;
  let busy = false;
  let disposed = false;
  let uiPresentation = "hidden";
  let requestSerial = 0;
  let requestAbort: AbortController | null = null;
  let voiceAbort: AbortController | null = null;
  let arrival: (() => void) | null = null;
  const history: DialogueTurn[] = [];
  const returnPath = returnRoute();

  const hideUi = () => {
    if (uiPresentation === "hidden") return;
    ui.hide();
    uiPresentation = "hidden";
  };

  const showIdlePrompt = () => {
    if (uiPresentation === "prompt:idle") return;
    ui.showPrompt({ speaker: TEA_MASTER_SPEAKER, key: "E", label: "Share tea with Iroh" });
    uiPresentation = "prompt:idle";
  };

  const showBusyPrompt = () => {
    if (uiPresentation === "prompt:busy") return;
    ui.showPrompt({ speaker: TEA_MASTER_SPEAKER, key: "", label: "Iroh listens to the kettle…" });
    uiPresentation = "prompt:busy";
  };

  const showWaitPrompt = () => {
    if (uiPresentation === "prompt:wait") return;
    ui.showPrompt({ speaker: TEA_MASTER_SPEAKER, key: "", label: "I’ll wait—follow the garden path" });
    uiPresentation = "prompt:wait";
  };

  const showCurrentTurn = () => {
    if (!currentTurn) return;
    const key = `turn:${currentTurn.id}`;
    if (uiPresentation === key) return;
    ui.showTurn(currentTurn);
    uiPresentation = key;
  };

  const stopVoice = () => {
    voiceAbort?.abort();
    voiceAbort = null;
    void voice.stop();
  };

  const startVoice = (turn: DialogueTurn) => {
    stopVoice();
    const controller = new AbortController();
    voiceAbort = controller;
    void voice.speak(turn, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn("[tea-garden] Voice output failed", error);
    });
  };

  const beginRoute = (nextRoute: readonly TeaGardenXZ[], nextPhase: "walking" | "returning", onArrival: () => void) => {
    stopVoice();
    currentTurn = null;
    provider = null;
    route = nextRoute;
    routePoint = 0;
    arrival = onArrival;
    phase = nextPhase;
    hideUi();
  };

  const finishChapter = () => {
    provider = null;
    currentTurn = null;
    hideUi();

    if (chapter === "welcome") {
      stopIndex = 0;
      const stop = TEA_GARDEN_TOUR_STOPS[stopIndex];
      beginRoute(stop.route, "walking", () => startChapter(stop.id));
      return;
    }

    if (chapter === "farewell") {
      chapter = null;
      beginRoute(returnPath, "returning", () => {
        phase = "idle";
        stopIndex = -1;
        route = [];
        routePoint = 0;
        visual.group.rotation.y = GUIDE_HOME.heading;
      });
      return;
    }

    if (stopIndex >= 0 && stopIndex < TEA_GARDEN_TOUR_STOPS.length - 1) {
      stopIndex += 1;
      const stop = TEA_GARDEN_TOUR_STOPS[stopIndex];
      beginRoute(stop.route, "walking", () => startChapter(stop.id));
      return;
    }

    startChapter("farewell");
  };

  const requestNextTurn = async () => {
    if (!provider || busy || disposed) return;
    busy = true;
    stopVoice();
    requestAbort?.abort();
    const controller = new AbortController();
    requestAbort = controller;
    const serial = ++requestSerial;
    if (playerDistance <= CARD_RANGE) showBusyPrompt();

    try {
      const next = await provider.nextTurn(
        {
          agentId: TEA_MASTER_SPEAKER.id,
          conversationId: "japanese-tea-garden-tour",
          history,
          context: {
            chapter,
            stopIndex,
            stop: stopIndex >= 0 ? TEA_GARDEN_TOUR_STOPS[stopIndex]?.id : null
          }
        },
        controller.signal
      );
      if (disposed || controller.signal.aborted || serial !== requestSerial) return;
      if (!next) {
        // `finishChapter` may immediately open the farewell provider. Release
        // the request guard first so that provider can deliver its first turn.
        busy = false;
        if (requestAbort === controller) requestAbort = null;
        finishChapter();
        return;
      }
      currentTurn = next;
      history.push(next);
      phase = "speaking";
      uiPresentation = "hidden";
      if (playerDistance <= CARD_RANGE) showCurrentTurn();
      startVoice(next);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn("[tea-garden] Dialogue provider failed", error);
        ui.showPrompt({ speaker: TEA_MASTER_SPEAKER, key: "E", label: "Ask Iroh again" });
        uiPresentation = "prompt:error";
      }
    } finally {
      if (serial === requestSerial) {
        busy = false;
        if (requestAbort === controller) requestAbort = null;
      }
    }
  };

  function startChapter(nextChapter: TeaGardenDialogueChapter): void {
    requestAbort?.abort();
    requestAbort = null;
    chapter = nextChapter;
    provider = source.providerFor(nextChapter);
    currentTurn = null;
    phase = "speaking";
    uiPresentation = "hidden";
    void requestNextTurn();
  }

  const faceDirection = (dx: number, dz: number, dt: number) => {
    if (Math.abs(dx) + Math.abs(dz) < 1e-5) return;
    const targetYaw = Math.atan2(-dx, -dz);
    const delta = Math.atan2(
      Math.sin(targetYaw - visual.group.rotation.y),
      Math.cos(targetYaw - visual.group.rotation.y)
    );
    visual.group.rotation.y += delta * (1 - Math.exp(-TURN_RESPONSE * Math.min(dt, 0.1)));
  };

  const updateWalking = (dt: number, player: TeaGardenPlayerPosition): number => {
    const returning = phase === "returning";
    if (!returning && playerDistance > WAIT_DISTANCE) phase = "waiting";
    if (phase === "waiting") {
      if (playerDistance <= RESUME_DISTANCE) phase = "walking";
      else return 0;
    }
    if (phase !== "walking" && phase !== "returning") return 0;

    const startX = visual.group.position.x;
    const startZ = visual.group.position.z;
    let remaining = Math.min(dt, 0.1) * WALK_SPEED;
    while (remaining > 0 && routePoint < route.length) {
      const [targetX, targetZ] = route[routePoint];
      const dx = targetX - visual.group.position.x;
      const dz = targetZ - visual.group.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= 0.035) {
        visual.group.position.x = targetX;
        visual.group.position.z = targetZ;
        routePoint += 1;
        continue;
      }
      const step = Math.min(distance, remaining);
      visual.group.position.x += (dx / distance) * step;
      visual.group.position.z += (dz / distance) * step;
      remaining -= step;
      if (step >= distance - 1e-5) routePoint += 1;
    }
    const movedX = visual.group.position.x - startX;
    const movedZ = visual.group.position.z - startZ;
    const movedDistance = Math.hypot(movedX, movedZ);
    if (movedDistance > 1e-5) faceDirection(movedX, movedZ, dt);
    if (routePoint >= route.length && arrival) {
      const callback = arrival;
      arrival = null;
      callback();
    }
    return movedDistance;
  };

  const syncPresentation = (camera: THREE.Camera) => {
    if (!worldVisible) {
      hideUi();
      return;
    }
    if (phase === "idle") {
      if (playerDistance <= START_RANGE) showIdlePrompt();
      else hideUi();
    } else if (phase === "speaking") {
      if (playerDistance > CARD_RANGE) hideUi();
      else if (busy && !currentTurn) showBusyPrompt();
      else showCurrentTurn();
    } else if (phase === "waiting") {
      if (playerDistance <= WAIT_UI_RANGE) showWaitPrompt();
      else hideUi();
    } else {
      hideUi();
    }
    ui.update(camera);
  };

  return {
    group: visual.group,
    setWorldVisible(visible: boolean) {
      worldVisible = visible;
      if (!visible) hideUi();
    },
    update(dt: number, time: number, player: TeaGardenPlayerPosition, _camera: THREE.Camera) {
      if (disposed) return;
      playerDistance = distanceXZ(visual.group.position, player);
      const travelDistance = updateWalking(dt, player);
      // Ground convergence belongs to the outer update, not locomotion: arrival
      // can switch to speaking on the same frame and waiting can last minutes.
      // Keeping this live in every phase prevents a partially converged slope
      // sample from freezing Iroh above or below the path.
      visual.group.position.y = THREE.MathUtils.damp(
        visual.group.position.y,
        map.groundTop(visual.group.position.x, visual.group.position.z),
        13,
        Math.min(dt, 0.1)
      );
      playerDistance = distanceXZ(visual.group.position, player);

      let action: TeaMasterAction = "idle";
      if (phase === "walking" || phase === "returning") action = "walk";
      else if (phase === "waiting") action = "welcome";
      else if (currentTurn) action = actionForTurn(currentTurn);
      visual.setAction(action);

      if (phase === "speaking" && playerDistance <= CARD_RANGE) {
        faceDirection(player.x - visual.group.position.x, player.z - visual.group.position.z, dt);
      }
      const lookTarget = playerDistance <= CARD_RANGE ? player : undefined;
      visual.update(dt, time, lookTarget, travelDistance);
    },
    project(camera: THREE.Camera) {
      if (disposed) return;
      syncPresentation(camera);
    },
    interact(player: TeaGardenPlayerPosition, mode: string): boolean {
      if (disposed || !worldVisible || mode !== "walk") return false;
      playerDistance = distanceXZ(visual.group.position, player);
      if (phase === "idle") {
        if (playerDistance > START_RANGE) return false;
        history.length = 0;
        stopIndex = -1;
        startChapter("welcome");
        return true;
      }
      if (phase !== "speaking" || playerDistance > ACTIVE_RANGE) return false;
      // Consume repeated E presses while a remote provider is still working,
      // so nearby doors/vehicles cannot accidentally receive the same intent.
      if (!busy) void requestNextTurn();
      return true;
    },
    debugState() {
      return {
        phase,
        chapter,
        stopIndex,
        routePoint,
        routeLength: route.length,
        playerDistance,
        busy,
        worldVisible,
        iroh: visual.debugState()
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      requestSerial += 1;
      requestAbort?.abort();
      stopVoice();
      void voice.dispose();
      ui.dispose();
      visual.dispose();
    }
  };
}
