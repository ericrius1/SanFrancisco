# Creature RL — teaching a horse to walk, in the browser's own physics engine

A little reinforcement-learning lab that trains four-legged creatures to walk and
roam, then drops them straight into the San Francisco world. Inspired by the
"RL creature with a neural-net voice" genre — but with a twist that makes the
whole thing cheaper, faster, and tighter than the usual JAX/MuJoCo/RunPod stack.

**The twist: we train against `box3d-wasm` — the exact same physics engine the
game already runs — headless in Node.** No GPU, no Python, no cloud. And because
train-time and run-time physics are byte-for-byte identical, a trained policy
drops into the browser with **zero sim-to-real gap**: the horse flies through the
same solver it learned in, lands on real world colliders, and its neural net runs
*live* over its head as a glowing "brain" bubble.

```
rl/
  core/
    es.ts            Evolution Strategies optimizer (gradient-free)
    box3dEnv.ts      the training environment (builds the ragdoll in box3d)
    rollout.ts       run one episode, optionally record it
  train.ts           CLI: ES training loop + checkpoints + recordings
  tools/             inspectors + stand-tests used while tuning
  viz/index.html     the training viewer (playback + reward curve + brain)
  runs/              logs, per-generation recordings, checkpoints
src/creatures/
  policy.ts          tiny MLP policy — SHARED by trainer and browser
  quadruped.ts       body spec + CPG gait + observation + torque decode — SHARED
```

## How a creature is built

A creature is an **active ragdoll**: real rigid bodies wired together with joints,
driven by "muscle" torques. For the horse:

- a **box torso** (unambiguous body axes) and four **two-segment legs** — a thigh
  and a shank capsule each, so the foot can *lift* during swing and *bear load*
  through stance. (Single-segment legs can't clear their own foot; they shuffle.)
- **spherical (ball) joints** at every hip and knee. box3d's shipped wrapper only
  exposes ball + distance joints — no motors — so we actuate a different way.

### Actuation: a quaternion PD servo on top of a CPG

box3d gives us `applyAngularImpulse`, so we make our own "motors":

1. A **Central Pattern Generator** (a set of phase oscillators, one per leg, a
   quarter-cycle apart — the lateral-sequence walk) produces a target pose each
   step: how far each hip should be swung, how much each knee should be flexed.
   The knee flexes during the forward swing and straightens to push through
   stance, so the cycle makes *net forward thrust*.
2. A **quaternion PD servo** drives each joint's full relative orientation toward
   that target and applies the resulting torque as an angular impulse (with the
   Newton's-third-law reaction on the parent link). Controlling the *whole*
   orientation — not one axis at a time — is what stops a free ball joint from
   splaying or twisting its way into a buckle.

The policy never micromanages joints. It **modulates the CPG**: gait frequency,
stride amplitude, per-leg bias, turn, and balance gains — 10 numbers. That
structure is why it trains in *minutes*: the walking rhythm is a given, so the
network only has to learn to shape it and stay upright while chasing a goal
heading.

## The learner: Evolution Strategies (no autodiff anywhere)

`core/es.ts` is OpenAI-style ES with antithetic sampling and rank normalization,
Adam on the estimated gradient. It only ever calls `fitness(params)` — which is a
rollout in box3d — so there is **no backprop, no ML framework, nothing to install**.
That's the whole reason training against a WASM engine is even practical.

box3d steps at **~220k physics steps/second on one core**, so an ES generation
(hundreds of rollouts) is a second or two. A useful walking policy shows up inside
a couple hundred generations — a few minutes on a laptop.

## The reward

Per step, summed over the episode (see `quadruped.ts`):

```
+ forward     velocity toward the goal heading   (dominant)
+ heading     facing the goal
+ upright     torso up-axis · world up
+ alive       small per-step bonus
- height      deviation from standing height
- energy      sum of squared actions
- spin        angular velocity
episode ends (with a small penalty) if it tips or sinks
```

The single most important dial: **forward has to out-weigh the standing bonuses**,
or ES discovers the "march in place forever" local optimum — perfectly upright,
going nowhere — and never leaves it.

## What it took to stand up (a debugging tour)

Worth recording, because the failure modes are instructive and every fix lives in
the code:

| symptom | cause | fix |
|---|---|---|
| critter frozen, torque did nothing | box3d **sleeps** resting bodies | `setBodyAwake(true)` every step |
| legs whip at 100 rad/s, body flips | open-loop torque on tiny leg inertia | PD control with velocity damping |
| feet drag, never lift | single-segment legs | **two segments + a knee** |
| collapses in 0.3s, folds like a Z | bent-knee stance **buckles** under load | straight legs bear weight; knee flexes only in swing |
| upright but *sinks* to 1/3 height | ball joints splay in the **uncontrolled DOFs** | **quaternion servo** on the full joint orientation |
| stands, but marches in place | standing out-rewards travelling | crank the forward reward; time the knee for thrust |

`tools/standtest.ts` and `tools/legconfig.ts` were the microscopes for all of it —
run them to watch a zero-policy creature just try to stand.

## Train it

```bash
# a quick run
node --experimental-strip-types rl/train.ts --gens 120 --pairs 96 --steps 500

# writes:
#   public/models/horse_policy.json      best policy (the browser loads this)
#   rl/runs/horse_log.jsonl              reward per generation
#   rl/runs/horse_gen<N>.frames.json     recorded rollouts (for the viewer/video)
```

## Watch it train

Open `rl/viz/index.html` through the dev server (e.g. `/rl/viz/`). It plays back
the recorded rollouts in 3D, draws the **reward-vs-generation** curve, and renders
the policy's hidden activations as a live grid — the same "brain" that becomes the
bubble over the horse's head in-world. Flip through generations to watch it go
from flailing to walking. That gallery of generations *is* the training video;
scrub it, or screen-capture the flip-through.

## Add another creature

The kit is spec-driven. To train, say, a `dog` or `lion` (assets already in the
library): add a `CreatureSpec` in `src/creatures/quadruped.ts` (body sizes,
gait, gains, reward), register it in the `CREATURES` map in `train.ts`, and run
`--creature dog`. Everything else — ES, env, viewer, the browser runtime — is
generic. That's the point: **do this again with more creatures** for the cost of
one spec.

## Into the world

`src/creatures/policy.ts` and `quadruped.ts` are deliberately dependency-free and
imported by the game too. In San Francisco the horse is a live box3d ragdoll
running the trained policy every frame: it roams Golden Gate Park on its own,
wears its neural activations as a bubble, and you can walk up and ride it. Same
brain, same body, same physics — just a nicer backdrop than a checkerboard floor.
