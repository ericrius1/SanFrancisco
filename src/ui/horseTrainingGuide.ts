import * as THREE from "three/webgpu";

const INPUT_FEATURES = [
  "torso up x",
  "torso up y",
  "torso up z",
  "goal facing",
  "turn error",
  "side speed",
  "forward speed",
  "stride speed",
  "roll rate",
  "pitch rate",
  "yaw rate",
  "stance height",
  "gait sine",
  "gait cosine",
  "front hip swing",
  "front hip return",
  "hind hip swing",
  "hind hip return",
  "front knee flex",
  "front knee return",
  "hind knee flex",
  "hind knee return"
];

const OUTPUT_GROUPS = [
  { label: "Cadence", detail: "step timing" },
  { label: "Stride", detail: "reach and knee lift" },
  { label: "Leg bias", detail: "per-leg hip offsets" },
  { label: "Leg phase", detail: "per-leg timing offsets" },
  { label: "Balance", detail: "steer, pitch, roll brace" }
];

const STEP_TITLES = [
  "Sensor frame",
  "Policy layers",
  "Motor categories",
  "Training loop"
];

const GUIDE_DISTANCE = 310;

function nodeDots(count: number): string {
  return Array.from({ length: count }, (_, i) => `<i style="--i:${i}"></i>`).join("");
}

function labelItems(labels: string[]): string {
  return labels.map((label) => `<li>${label}</li>`).join("");
}

function outputItems(): string {
  return OUTPUT_GROUPS.map((item) => `<li><b>${item.label}</b><span>${item.detail}</span></li>`).join("");
}

function wirePaths(x1: number, x2: number, fromCount: number, toCount: number, cls: string): string {
  const y = (i: number, n: number) => 12 + (i / Math.max(1, n - 1)) * 76;
  const lines: string[] = [];
  for (let a = 0; a < fromCount; a++) {
    for (let b = 0; b < toCount; b++) {
      const ya = y(a, fromCount);
      const yb = y(b, toCount);
      const mid = (x1 + x2) / 2;
      lines.push(`<path class="htr-wire ${cls}" d="M ${x1} ${ya} C ${mid} ${ya}, ${mid} ${yb}, ${x2} ${yb}"/>`);
    }
  }
  return lines.join("");
}

function diagramHtml(): string {
  const wires = [
    wirePaths(17, 39, 9, 10, "sensor"),
    wirePaths(41, 61, 10, 10, "hidden"),
    wirePaths(63, 85, 10, 7, "output"),
    `<path class="htr-wire reward" d="M 92 88 C 82 103, 22 103, 10 88"/>`
  ].join("");

  return `
    <div class="horse-training-diagram" data-step="0">
      <div class="htr-stage">
        <span class="htr-stage-k">Step <b>1</b>/4</span>
        <span class="htr-stage-title">${STEP_TITLES[0]}</span>
      </div>
      <div class="htr-network" aria-label="Horse neural network diagram">
        <svg class="htr-wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${wires}</svg>
        <div class="htr-layers">
          <div class="htr-layer input">
            <div class="htr-layer-title">Input</div>
            <div class="htr-layer-sub">22 signals</div>
            <div class="htr-nodes">${nodeDots(12)}</div>
          </div>
          <div class="htr-layer hidden h1">
            <div class="htr-layer-title">Hidden 1</div>
            <div class="htr-layer-sub">32 neurons</div>
            <div class="htr-nodes">${nodeDots(16)}</div>
          </div>
          <div class="htr-layer hidden h2">
            <div class="htr-layer-title">Hidden 2</div>
            <div class="htr-layer-sub">32 neurons</div>
            <div class="htr-nodes">${nodeDots(16)}</div>
          </div>
          <div class="htr-layer output">
            <div class="htr-layer-title">Output</div>
            <div class="htr-layer-sub">14 controls</div>
            <div class="htr-nodes">${nodeDots(8)}</div>
          </div>
        </div>
      </div>
      <div class="htr-detail">
        <div class="htr-detail-col htr-input-list">
          <div class="htr-detail-title">Selected input labels</div>
          <ol>${labelItems(INPUT_FEATURES)}</ol>
        </div>
        <div class="htr-detail-col htr-output-list">
          <div class="htr-detail-title">Output categories</div>
          <ol>${outputItems()}</ol>
        </div>
      </div>
      <div class="htr-reward">
        Reward favors forward movement, upright posture, target heading and useful stance height. It penalizes tumbling, spin and wasteful actuation.
      </div>
    </div>
  `;
}

const BODY = `
  <section class="horse-training-step active" data-step="0">
    <h3>What the horse observes</h3>
    <p>The floating network above each horse is the live policy running every frame. Its input vector is a compact body snapshot: torso-up direction, goal alignment, side and forward speed, angular rates, stance height, gait phase and joint angles from the legs.</p>
    <p>Those 22 values are enough for the policy to know whether the body is upright, whether it is moving toward its roaming target, and where each leg is in the stride cycle.</p>
  </section>
  <section class="horse-training-step" data-step="1">
    <h3>How the policy turns sensors into gait</h3>
    <p>The network is a small multilayer perceptron: <code>22 -> 32 -> 32 -> 14</code>. The hidden layers do not contain hand-authored walk rules. They learn useful intermediate signals like "recover balance", "extend this pair of legs" and "turn without tipping over".</p>
    <p>In the world view the same activations drive the color and brightness of the nodes and lines, so the diagram above the horse changes with its actual state.</p>
  </section>
  <section class="horse-training-step" data-step="2">
    <h3>What comes out</h3>
    <p>The 14 outputs are grouped into motor categories: cadence, stride length, knee lift, four hip biases, four phase offsets, steering and two brace signals. Those values feed the procedural quadruped controller that moves the box3d ragdoll.</p>
    <p>The outputs are continuous, so the horse can blend between walking, turning, recovering and slowing down instead of snapping between fixed animation clips.</p>
  </section>
  <section class="horse-training-step" data-step="3">
    <h3>How training improves it</h3>
    <p>Training runs in a worker using evolution strategies. Candidate policies are tested in the same box3d-style horse simulation, scored, then the best weights are nudged forward. Pressing <code>L</code> starts live training and the herd hot-swaps to better policies as they arrive.</p>
    <p>The reward gives credit for staying upright, moving forward, keeping heading, maintaining usable height and not wasting energy. Bad falls reset the ragdoll and push those candidates down the ranking.</p>
  </section>
`;

export class HorseTrainingGuide {
  #anchor: THREE.Vector3;
  #screen = new THREE.Vector3();
  #button: HTMLButtonElement;
  #overlay: HTMLDivElement;
  #body: HTMLElement;
  #diagram: HTMLElement;
  #stageIndex: HTMLElement;
  #stageTitle: HTMLElement;
  #steps: HTMLElement[];
  #open = false;
  #onToggle?: (open: boolean) => void;

  constructor(anchor: THREE.Vector3, onToggle?: (open: boolean) => void) {
    this.#anchor = anchor.clone();
    this.#onToggle = onToggle;
    const hud = document.getElementById("hud")!;

    this.#button = document.createElement("button");
    this.#button.className = "horse-training-ui horse-training-icon";
    this.#button.type = "button";
    this.#button.title = "Open the horse training guide";
    this.#button.setAttribute("aria-label", "Open the horse training guide");
    this.#button.innerHTML = `<span class="hti-mark">NN</span><span class="hti-label">Training</span>`;
    this.#button.hidden = true;
    this.#button.addEventListener("click", () => this.setOpen(true));
    hud.appendChild(this.#button);

    this.#overlay = document.createElement("div");
    this.#overlay.className = "horse-training-overlay";
    this.#overlay.innerHTML = `
      <div class="horse-training-modal" role="dialog" aria-modal="true" aria-label="Horse neural network training">
        <button class="horse-training-close" type="button" title="Close">x</button>
        <div class="horse-training-head">
          <div class="horse-training-title">Horse neural network training</div>
          <div class="horse-training-subtitle">Scroll the writeup to trace sensors, hidden layers, motor outputs and the reward loop.</div>
        </div>
        <div class="horse-training-body">
          ${diagramHtml()}
          <div class="horse-training-copy">${BODY}</div>
        </div>
      </div>
    `;
    this.#body = this.#overlay.querySelector<HTMLElement>(".horse-training-body")!;
    this.#diagram = this.#overlay.querySelector<HTMLElement>(".horse-training-diagram")!;
    this.#stageIndex = this.#overlay.querySelector<HTMLElement>(".htr-stage-k b")!;
    this.#stageTitle = this.#overlay.querySelector<HTMLElement>(".htr-stage-title")!;
    this.#steps = Array.from(this.#overlay.querySelectorAll<HTMLElement>(".horse-training-step"));

    this.#button.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.#overlay.addEventListener("click", (e) => {
      if (e.target === this.#overlay) this.setOpen(false);
    });
    this.#overlay.querySelector(".horse-training-close")!.addEventListener("click", () => this.setOpen(false));
    this.#body.addEventListener("scroll", () => this.#syncStep());
    document.addEventListener("keydown", (e) => {
      if (this.#open && e.key === "Escape") {
        e.stopPropagation();
        this.setOpen(false);
      }
    });

    hud.appendChild(this.#overlay);
  }

  update(camera: THREE.Camera, cameraPos: THREE.Vector3): void {
    if (this.#open) {
      this.#button.hidden = true;
      return;
    }
    const distSq = cameraPos.distanceToSquared(this.#anchor);
    this.#screen.copy(this.#anchor).project(camera);
    const margin = 72;
    const inDepth = this.#screen.z > -1 && this.#screen.z < 1;
    const projectedX = (this.#screen.x * 0.5 + 0.5) * window.innerWidth;
    const projectedY = (-this.#screen.y * 0.5 + 0.5) * window.innerHeight;
    let x = inDepth ? Math.min(window.innerWidth - margin, Math.max(margin, projectedX)) : window.innerWidth * 0.5;
    const y = inDepth ? Math.min(window.innerHeight - margin, Math.max(margin, projectedY)) : margin;
    if (x < 320 && y < 285) x = 320;
    this.#button.hidden = distSq > GUIDE_DISTANCE * GUIDE_DISTANCE;
    if (!this.#button.hidden) {
      this.#button.style.left = `${Math.round(x)}px`;
      this.#button.style.top = `${Math.round(y)}px`;
    }
  }

  setOpen(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    this.#overlay.classList.toggle("open", open);
    this.#button.hidden = open;
    if (open) {
      this.#body.scrollTop = 0;
      this.#syncStep();
    }
    this.#onToggle?.(open);
  }

  #syncStep(): void {
    const marker = this.#body.scrollTop + this.#body.clientHeight * 0.18;
    let active = 0;
    for (let i = 0; i < this.#steps.length; i++) {
      if (this.#steps[i].offsetTop <= marker) active = i;
    }
    this.#diagram.dataset.step = String(active);
    this.#stageIndex.textContent = String(active + 1);
    this.#stageTitle.textContent = STEP_TITLES[active] ?? STEP_TITLES[0];
    for (let i = 0; i < this.#steps.length; i++) this.#steps[i].classList.toggle("active", i === active);
  }
}
