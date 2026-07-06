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

const OUTPUT_FEATURES = [
  "cadence",
  "stride length",
  "knee lift",
  "front-left hip bias",
  "front-right hip bias",
  "hind-left hip bias",
  "hind-right hip bias",
  "front-left phase",
  "front-right phase",
  "hind-left phase",
  "hind-right phase",
  "steer",
  "pitch brace",
  "roll brace"
];

const OUTPUT_GROUPS = [
  { label: "Rhythm", detail: "cadence, gait phase" },
  { label: "Reach", detail: "stride length, knee lift" },
  { label: "Leg bias", detail: "four hip offsets" },
  { label: "Leg phase", detail: "four timing offsets" },
  { label: "Balance", detail: "steer, pitch brace, roll brace" }
];

const REWARD_ITEMS = [
  { label: "Forward progress", value: 92, tone: "good" },
  { label: "Target heading", value: 78, tone: "good" },
  { label: "Upright torso", value: 86, tone: "good" },
  { label: "Usable height", value: 64, tone: "good" },
  { label: "Spin penalty", value: 34, tone: "bad" },
  { label: "Energy penalty", value: 42, tone: "bad" }
];

const TRAINING_STEPS = [
  "Clone policy weights into a population",
  "Add random noise to each candidate",
  "Run horse episodes in private physics worlds",
  "Score each candidate with the reward function",
  "Weight the noise by fitness",
  "Move the policy weights toward the winners",
  "Send the current best policy back to the visible herd"
];

const STEP_TITLES = [
  "RL loop",
  "Observation frame",
  "Policy network",
  "Motor outputs",
  "Rollout simulation",
  "Reward shaping",
  "Evolution update",
  "Live hot swap"
];

const GUIDE_DISTANCE = 310;

function nodeDots(count: number): string {
  return Array.from({ length: count }, (_, i) => `<i style="--i:${i}"></i>`).join("");
}

function listItems(labels: string[]): string {
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

function rewardBars(): string {
  return REWARD_ITEMS.map((item) => (
    `<div class="htr-bar ${item.tone}"><span>${item.label}</span><i><b style="width:${item.value}%"></b></i><em>${item.value}</em></div>`
  )).join("");
}

function timelineItems(): string {
  return TRAINING_STEPS.map((label, i) => `<li><b>${i + 1}</b><span>${label}</span></li>`).join("");
}

function stepButtons(): string {
  return STEP_TITLES.map((label, i) => `<button type="button" data-htr-jump="${i}">${label}</button>`).join("");
}

function networkHtml(): string {
  const wires = [
    wirePaths(17, 39, 9, 10, "sensor"),
    wirePaths(41, 61, 10, 10, "hidden"),
    wirePaths(63, 85, 10, 7, "output"),
    `<path class="htr-wire reward" d="M 92 88 C 82 103, 22 103, 10 88"/>`
  ].join("");

  return `
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
  `;
}

function diagramHtml(): string {
  return `
    <div class="horse-training-diagram" data-step="0">
      <div class="htr-stage">
        <span class="htr-stage-k">Stage <b>1</b>/${STEP_TITLES.length}</span>
        <span class="htr-stage-title">${STEP_TITLES[0]}</span>
      </div>
      <div class="htr-step-nav" aria-label="Diagram stages">${stepButtons()}</div>
      <div class="htr-diagram-scroll" tabindex="0" aria-label="Scrollable horse reinforcement learning diagram">
        <div class="htr-network-shell">${networkHtml()}</div>
        <section class="htr-diagram-panel active" data-step="0">
          <h4>Closed-loop reinforcement learning</h4>
          <div class="htr-loop">
            <div><b>Policy</b><span>neural network weights</span></div>
            <i>action</i>
            <div><b>Horse body</b><span>box3d ragdoll step</span></div>
            <i>observation</i>
            <div><b>Reward</b><span>score for this behavior</span></div>
            <i>update</i>
          </div>
          <p>Nothing is animated by keyframes here. The policy repeatedly reads body state, emits controls, watches physics respond, and gets scored.</p>
        </section>
        <section class="htr-diagram-panel" data-step="1">
          <h4>Observation groups</h4>
          <div class="htr-chip-grid">
            <b>Balance</b><span>torso up, roll, pitch, yaw</span>
            <b>Goal</b><span>target heading and turn error</span>
            <b>Velocity</b><span>side, forward and stride speed</span>
            <b>Gait phase</b><span>sine, cosine and stance height</span>
            <b>Joints</b><span>hip swing and knee flex for front and hind legs</span>
          </div>
          <div class="htr-detail-col htr-input-list">
            <div class="htr-detail-title">Full 22-value input vector</div>
            <ol>${listItems(INPUT_FEATURES)}</ol>
          </div>
        </section>
        <section class="htr-diagram-panel" data-step="2">
          <h4>Policy as a tiny brain</h4>
          <div class="htr-equation"><span>22 sensors</span><b>-></b><span>32</span><b>-></b><span>32</span><b>-></b><span>14 controls</span></div>
          <p>The hidden neurons are learned features. They are not named rules, but the useful combinations tend to track balance recovery, stride timing, turning pressure and leg extension.</p>
        </section>
        <section class="htr-diagram-panel" data-step="3">
          <h4>Output categories</h4>
          <div class="htr-detail-col htr-output-list">
            <div class="htr-detail-title">Grouped controls</div>
            <ol>${outputItems()}</ol>
          </div>
          <div class="htr-detail-col htr-output-list htr-all-output-list">
            <div class="htr-detail-title">All 14 outputs</div>
            <ol>${listItems(OUTPUT_FEATURES)}</ol>
          </div>
        </section>
        <section class="htr-diagram-panel" data-step="4">
          <h4>Rollout simulation</h4>
          <ol class="htr-timeline">
            <li><b>1</b><span>Reset a private horse world.</span></li>
            <li><b>2</b><span>Run the policy for many physics ticks.</span></li>
            <li><b>3</b><span>Accumulate reward while the body walks, turns, wobbles or falls.</span></li>
            <li><b>4</b><span>Return a single fitness number for that candidate.</span></li>
          </ol>
        </section>
        <section class="htr-diagram-panel" data-step="5">
          <h4>Reward shaping</h4>
          <div class="htr-bars">${rewardBars()}</div>
          <p>The score is intentionally mixed. Forward motion alone would teach face-planting if it were not balanced by upright posture, heading and energy penalties.</p>
        </section>
        <section class="htr-diagram-panel" data-step="6">
          <h4>Evolution strategies update</h4>
          <ol class="htr-timeline">${timelineItems()}</ol>
          <div class="htr-equation"><span>policy weights</span><b>+</b><span>noise</span><b>-></b><span>rollout reward</span><b>-></b><span>weighted update</span></div>
        </section>
        <section class="htr-diagram-panel" data-step="7">
          <h4>Live hot swap</h4>
          <div class="htr-live-stack">
            <span>Worker trains candidates</span>
            <span>Best policy arrives</span>
            <span>Visible herd switches weights</span>
            <span>Overhead NN colors update from live activations</span>
          </div>
          <p>When live training is running, you are watching the visible herd use newer policy weights as the worker finds them.</p>
        </section>
      </div>
    </div>
  `;
}

const BODY = `
  <section class="horse-training-step active" data-step="0">
    <h3>Big picture: RL as a feedback loop</h3>
    <p>Reinforcement learning means the horse is not told a step-by-step recipe for walking. It gets a state, chooses an action, sees what physics does next, and receives a reward score. Over many trials, training searches for network weights that produce better scores.</p>
    <p>In this scene the agent is the neural policy above each horse. The environment is a simulated box3d quadruped body. The action is a bundle of gait controls. The reward is a numeric judgement of whether the body moved like a useful horse instead of collapsing or spinning in place.</p>
    <p>The world overlay stays label-free because it needs to be readable while moving. This panel is the labeled version: it shows the same policy at a scale where the concepts can actually be read.</p>
  </section>
  <section class="horse-training-step" data-step="1">
    <h3>Observations: what the policy can feel</h3>
    <p>The policy never sees a rendered horse image. It sees numbers. Those numbers summarize the body: torso orientation, velocity, turning error, gait phase, stance height, and leg joint angles. That compact vector is enough to describe whether the horse is upright, drifting, turning, stepping, or falling.</p>
    <p>The most important idea is that the observation is partial but useful. If the torso-up vector tilts and the roll rate spikes, the policy can learn to brace. If target heading is off, it can learn to bias the step pattern toward turning. If a knee is flexed too late in the gait cycle, it can learn a timing correction.</p>
    <p>The input layer has 22 values. The diagram uses representative dots for readability, while the label list in the diagram pane shows the full vector.</p>
  </section>
  <section class="horse-training-step" data-step="2">
    <h3>The policy network</h3>
    <p>The network is a small multilayer perceptron: <code>22 -> 32 -> 32 -> 14</code>. Each hidden neuron computes a weighted blend of the previous layer, passes it through a nonlinear activation, and sends that result onward.</p>
    <p>The hidden layers are where training discovers internal features. A hidden unit might become useful for balance recovery, another for stride timing, another for turning pressure. We do not hand-label those neurons during training; we inspect them afterward by watching activations change while the horse moves.</p>
    <p>The floating NN above each horse is using these live activations. Brighter nodes and wires mean stronger current activity for that layer/node.</p>
  </section>
  <section class="horse-training-step" data-step="3">
    <h3>Actions: what comes out</h3>
    <p>The output layer has 14 continuous controls. These are not direct motor torques in the visual mesh. They feed a procedural quadruped controller that turns them into desired gait timing, stride reach, knee lift, leg phase offsets, steering and body bracing.</p>
    <p>Continuous outputs matter because the horse needs blended behavior. A clean walk, a recovery step, a turn, and a slowdown are not separate animation clips. They are different regions of the same control space.</p>
  </section>
  <section class="horse-training-step" data-step="4">
    <h3>Rollouts: how a candidate is tested</h3>
    <p>Training evaluates candidates in private physics worlds, separate from the visible city. A candidate policy gets inserted into a simulated horse, runs for an episode, and receives a final fitness score from the rewards and penalties accumulated during that rollout.</p>
    <p>That isolation is important. It lets the worker test lots of noisy candidate policies without throwing the visible herd around the map. The visible horses only receive a policy when the worker reports progress.</p>
  </section>
  <section class="horse-training-step" data-step="5">
    <h3>Reward shaping: what counts as better</h3>
    <p>Reward design is the steering wheel for RL. If the reward only says "go forward", the agent may discover ugly hacks: falling forward, spinning, hopping, or using too much control effort. The score has to describe the behavior we actually want.</p>
    <p>Here the positive parts favor forward progress, upright posture, target heading and usable stance height. Penalties push against tumbling, excessive spin and wasteful actuation. The result is not magic; it is a negotiated objective that makes walking more valuable than cheap shortcuts.</p>
  </section>
  <section class="horse-training-step" data-step="6">
    <h3>Evolution strategies: why there is no backprop through physics</h3>
    <p>The training path uses evolution strategies instead of backpropagating through the physics solver. It perturbs the policy weights with random noise, runs each noisy candidate, scores them, then shifts the base weights toward noise directions that produced better reward.</p>
    <p>That makes it simple and robust for a messy physics body. The worker only needs rollout scores. It does not need differentiable contacts, differentiable joints, or gradients through collisions.</p>
    <p>The tradeoff is sample efficiency: ES usually needs many rollouts. The upside is that it is straightforward, parallel-friendly, and easy to hot-swap into the browser simulation.</p>
  </section>
  <section class="horse-training-step" data-step="7">
    <h3>Live training in the scene</h3>
    <p>Pressing <code>L</code> starts or stops live horse training. While it runs, a worker evaluates candidate policies and sends progress messages with generation, fitness and best policy data. The herd can adopt the newest policy without reloading the world.</p>
    <p>The overhead network is therefore both decoration and instrumentation. It shows the policy architecture and the current activations while the horse is walking. This panel explains what those signals mean; the world view shows them happening in real time.</p>
    <p>When a horse falls, that is also useful information. A fall is a bad rollout outcome, but it tells the optimizer which weight directions to avoid. Learning locomotion is mostly learning how not to exploit the wrong part of the reward.</p>
  </section>
`;

export class HorseTrainingGuide {
  #anchor: THREE.Vector3;
  #screen = new THREE.Vector3();
  #button: HTMLButtonElement;
  #overlay: HTMLDivElement;
  #body: HTMLElement;
  #diagram: HTMLElement;
  #diagramScroll: HTMLElement;
  #stageIndex: HTMLElement;
  #stageTitle: HTMLElement;
  #steps: HTMLElement[];
  #diagramPanels: HTMLElement[];
  #jumpButtons: HTMLButtonElement[];
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
          <div class="horse-training-subtitle">A readable map of the reinforcement-learning loop behind the walking horses.</div>
        </div>
        <div class="horse-training-body">
          ${diagramHtml()}
          <div class="horse-training-copy">${BODY}</div>
        </div>
      </div>
    `;
    this.#body = this.#overlay.querySelector<HTMLElement>(".horse-training-body")!;
    this.#diagram = this.#overlay.querySelector<HTMLElement>(".horse-training-diagram")!;
    this.#diagramScroll = this.#overlay.querySelector<HTMLElement>(".htr-diagram-scroll")!;
    this.#stageIndex = this.#overlay.querySelector<HTMLElement>(".htr-stage-k b")!;
    this.#stageTitle = this.#overlay.querySelector<HTMLElement>(".htr-stage-title")!;
    this.#steps = Array.from(this.#overlay.querySelectorAll<HTMLElement>(".horse-training-step"));
    this.#diagramPanels = Array.from(this.#overlay.querySelectorAll<HTMLElement>(".htr-diagram-panel"));
    this.#jumpButtons = Array.from(this.#overlay.querySelectorAll<HTMLButtonElement>("[data-htr-jump]"));

    this.#button.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.#overlay.addEventListener("click", (e) => {
      if (e.target === this.#overlay) this.setOpen(false);
    });
    this.#overlay.querySelector(".horse-training-close")!.addEventListener("click", () => this.setOpen(false));
    this.#body.addEventListener("scroll", () => this.#syncArticleStep());
    this.#diagramScroll.addEventListener("scroll", () => this.#syncDiagramStep());
    for (const btn of this.#jumpButtons) {
      btn.addEventListener("click", () => this.#jumpToStep(Number(btn.dataset.htrJump ?? 0)));
    }
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
      this.#diagramScroll.scrollTop = 0;
      this.#setStep(0);
    }
    this.#onToggle?.(open);
  }

  #jumpToStep(step: number): void {
    const panel = this.#diagramPanels[Math.max(0, Math.min(this.#diagramPanels.length - 1, step))];
    if (panel) this.#diagramScroll.scrollTo({ top: panel.offsetTop - 10, behavior: "smooth" });
    this.#setStep(step);
  }

  #syncArticleStep(): void {
    const marker = this.#body.scrollTop + this.#body.clientHeight * 0.18;
    let active = 0;
    for (let i = 0; i < this.#steps.length; i++) {
      if (this.#steps[i].offsetTop <= marker) active = i;
    }
    this.#setStep(active);
  }

  #syncDiagramStep(): void {
    const marker = this.#diagramScroll.scrollTop + this.#diagramScroll.clientHeight - 84;
    let active = 0;
    for (let i = 0; i < this.#diagramPanels.length; i++) {
      if (this.#diagramPanels[i].offsetTop <= marker) active = i;
    }
    this.#setStep(active);
  }

  #setStep(step: number): void {
    const active = Math.max(0, Math.min(STEP_TITLES.length - 1, step));
    this.#diagram.dataset.step = String(active);
    this.#stageIndex.textContent = String(active + 1);
    this.#stageTitle.textContent = STEP_TITLES[active] ?? STEP_TITLES[0];
    for (let i = 0; i < this.#steps.length; i++) this.#steps[i].classList.toggle("active", i === active);
    for (let i = 0; i < this.#diagramPanels.length; i++) this.#diagramPanels[i].classList.toggle("active", i === active);
    for (let i = 0; i < this.#jumpButtons.length; i++) this.#jumpButtons[i].classList.toggle("active", i === active);
  }
}
