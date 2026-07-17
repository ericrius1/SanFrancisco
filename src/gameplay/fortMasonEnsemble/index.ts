import * as THREE from "three/webgpu";
import { audioEngine } from "../../audio/engine";
import { interactKeyLabel, type Input } from "../../core/input";
import type { ChaseCamera } from "../../core/camera";
import type { Net, EnsembleSlot } from "../../net/net";
import { avatarFromSeed } from "../../player/avatar";
import type { Player } from "../../player/player";
import { buildRig, poseIdle, setRigClasp, type Rig } from "../../player/rig";
import type { PlayerMode } from "../../player/types";
import type { HUD } from "../../ui/hud";
import type { WorldMap } from "../../world/heightmap";
import { FORT_MASON_ENSEMBLE_CENTER } from "./meta";

/**
 * Fort Mason's collaborative waterfront ensemble.
 *
 * The code and all of its procedural geometry/audio stay behind the optional
 * world's first-approach import. Three deterministic NPCs play whenever the
 * act is awake. A player may claim any station; the relay arbitrates the seat
 * and forwards only a bounded scale step, never an arbitrary frequency. That
 * invariant keeps piano, steel pan and pan pipes in one C-major pentatonic
 * vocabulary even with several human performers.
 */

export const ENSEMBLE_LABELS = ["piano", "steel drum", "pan pipes"] as const;
const SCALE_MIDI = [60, 62, 64, 67, 69, 72, 74, 76] as const;
const STATION_X = [-2.75, 0, 2.75] as const;
const PLAYER_Z = 1.32;
const ROOT_YAW = -0.28;
const INTERACT_RADIUS = 3.15;
const SHOW_RADIUS = 260;
const HIDE_RADIUS = 320;
const AUDIO_RADIUS = 100;
const AUDIO_TAIL = 3; // seconds of engine hold slack when leaving earshot (note/reverb tails)
const BEAT_SECONDS = 60 / 96;
const NPC_PATTERNS: readonly (readonly number[])[] = [
  [0, 2, 4, 2, 1, 3, 5, 3],
  [0, 4, 2, 5, 1, 4, 3, 6, 2, 5, 0, 4, 3, 6, 1, 5],
  [4, 3, 2, 1, 4, 5, 3, 2]
];

type EntryPose = { x: number; y: number; z: number; heading: number };
type NetworkHandlers = Pick<
  Net,
  "onEnsembleSlots" | "onEnsembleClaim" | "onEnsembleRelease" | "onEnsembleNote"
>;

type Station = {
  slot: EnsembleSlot;
  group: THREE.Group;
  rig: Rig;
  toneMaterials: THREE.MeshStandardMaterial[];
  pulse: number;
  step: number;
  selectedStep: number;
  autoTick: number;
};

type EnsembleOptions = {
  map: WorldMap;
  net: Net;
  player: Player;
  input: Input;
  hud: HUD;
  chase: ChaseCamera;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const midiHz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

class EnsembleAudio {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #comp: DynamicsCompressorNode | null = null;
  #channels: Array<GainNode | null> = [null, null, null];
  #panners: Array<PannerNode | null> = [null, null, null];
  #holdRelease: (() => void) | null = null; // engine hold while within earshot

  update(_camera: THREE.Camera, distance: number, positions: readonly THREE.Vector3[]) {
    if (distance < AUDIO_RADIUS && !this.#ctx) this.#ensure();
    const ctx = this.#ctx;
    if (!ctx) return;

    // Edge-triggered engine hold while inside earshot (radius 100 / +12
    // hysteresis, matching the play() gate in FortMasonEnsemble). The engine
    // owns the ctx.listener camera track, the HUD music volume/mute and idle
    // suspend, so this only manages the hold and the spatial panners.
    const inside = distance < AUDIO_RADIUS + 12;
    if (inside && !this.#holdRelease) {
      this.#holdRelease = audioEngine.acquireHold();
    } else if (!inside && this.#holdRelease) {
      audioEngine.touch(AUDIO_TAIL); // cover note/reverb tails past the release
      this.#holdRelease();
      this.#holdRelease = null;
    }
    if (!inside) return;

    for (let i = 0; i < 3; i++) this.#setPanner(i as EnsembleSlot, positions[i]);
  }

  play(slot: EnsembleSlot, step: number, velocity: number, duration: number) {
    this.#ensure();
    const ctx = this.#ctx;
    const channel = this.#channels[slot];
    if (!ctx || !channel) return;
    // Keep the shared engine ctx alive past this note's scheduled tail.
    audioEngine.touch(duration * 3 + 0.5);
    const midi = SCALE_MIDI[step] + (slot === 0 ? -12 : 0);
    const frequency = midiHz(midi);
    const now = ctx.currentTime + 0.01;
    if (slot === 0) this.#pianoVoice(channel, frequency, clamp01(velocity), now, duration);
    else if (slot === 1) this.#steelVoice(channel, frequency, clamp01(velocity), now, duration);
    else this.#pipeVoice(channel, frequency, clamp01(velocity), now, duration);
  }

  dispose() {
    // Disconnect our own nodes only; never close the shared engine context.
    this.#holdRelease?.();
    this.#holdRelease = null;
    for (const gain of this.#channels) gain?.disconnect();
    for (const panner of this.#panners) panner?.disconnect();
    this.#master?.disconnect();
    this.#comp?.disconnect();
    this.#ctx = null;
    this.#master = null;
    this.#comp = null;
    this.#channels = [null, null, null];
    this.#panners = [null, null, null];
  }

  #ensure() {
    if (this.#ctx) return;
    // The engine owns the context and the gesture gate: bus() is null until the
    // first user gesture unlocks it (callers tolerate that and retry). Master is
    // a constant unity trim — the engine music group applies musicAudioLevel(),
    // mute and visibility (no double attenuation).
    const bus = audioEngine.bus("music");
    if (!bus) return;
    const ctx = bus.ctx;
    const master = ctx.createGain();
    master.gain.value = 1;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.ratio.value = 4;
    master.connect(compressor).connect(bus.input);
    for (let i = 0; i < 3; i++) {
      const gain = ctx.createGain();
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 5;
      panner.rolloffFactor = 1.1;
      panner.maxDistance = 130;
      gain.connect(panner).connect(master);
      this.#channels[i] = gain;
      this.#panners[i] = panner;
    }
    this.#ctx = ctx;
    this.#master = master;
    this.#comp = compressor;
  }

  #setPanner(slot: EnsembleSlot, position: THREE.Vector3) {
    const panner = this.#panners[slot];
    if (!panner) return;
    if (panner.positionX) {
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
    } else panner.setPosition(position.x, position.y, position.z);
  }

  #voice(
    out: AudioNode,
    type: OscillatorType,
    frequency: number,
    gainAmount: number,
    start: number,
    attack: number,
    decay: number
  ) {
    const ctx = this.#ctx!;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainAmount), start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    oscillator.connect(gain).connect(out);
    oscillator.start(start);
    oscillator.stop(start + decay + 0.04);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }

  #pianoVoice(out: AudioNode, f: number, velocity: number, at: number, duration: number) {
    const tail = Math.max(0.7, duration * 1.8);
    this.#voice(out, "triangle", f, velocity * 0.34, at, 0.006, tail);
    this.#voice(out, "sine", f * 2.003, velocity * 0.11, at, 0.004, tail * 0.65);
    this.#voice(out, "sine", f * 3.997, velocity * 0.045, at, 0.003, tail * 0.42);
  }

  #steelVoice(out: AudioNode, f: number, velocity: number, at: number, duration: number) {
    const tail = Math.max(0.8, duration * 2.4);
    this.#voice(out, "sine", f, velocity * 0.4, at, 0.003, tail);
    this.#voice(out, "sine", f * 2.01, velocity * 0.22, at, 0.002, tail * 0.72);
    this.#voice(out, "triangle", f * 2.97, velocity * 0.09, at, 0.002, tail * 0.48);
  }

  #pipeVoice(out: AudioNode, f: number, velocity: number, at: number, duration: number) {
    const ctx = this.#ctx!;
    const oscillator = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    oscillator.type = "sine";
    harmonic.type = "sine";
    oscillator.frequency.value = f;
    harmonic.frequency.value = f * 2;
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.12;
    filter.type = "lowpass";
    filter.frequency.value = Math.min(6800, f * 7);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, velocity * 0.26), at + 0.08);
    gain.gain.setValueAtTime(Math.max(0.0002, velocity * 0.22), at + Math.max(0.1, duration - 0.12));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration + 0.12);
    oscillator.connect(filter);
    harmonic.connect(harmonicGain).connect(filter);
    filter.connect(gain).connect(out);
    oscillator.start(at);
    harmonic.start(at);
    oscillator.stop(at + duration + 0.16);
    harmonic.stop(at + duration + 0.16);
    oscillator.onended = () => {
      oscillator.disconnect();
      harmonic.disconnect();
      harmonicGain.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }
}

export class FortMasonEnsemble {
  readonly root = new THREE.Group();

  #net: Net;
  #player: Player;
  #input: Input;
  #hud: HUD;
  #chase: ChaseCamera;
  #audio = new EnsembleAudio();
  #stations: Station[] = [];
  #ownedGeometries = new Set<THREE.BufferGeometry>();
  #ownedMaterials = new Set<THREE.Material>();
  #stationWorld = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  #localSlot: EnsembleSlot | null = null;
  #pendingClaim: EnsembleSlot | null = null;
  #pendingRelease: EnsembleSlot | null = null;
  #entryPose: EntryPose | null = null;
  #promptSlot: EnsembleSlot | null = null;
  #networkHandlers: NetworkHandlers | null = null;
  #up = new THREE.Vector3(0, 1, 0);
  #poseQuaternion = new THREE.Quaternion();
  #audible = false;
  #disposed = false;

  constructor(options: EnsembleOptions) {
    this.#net = options.net;
    this.#player = options.player;
    this.#input = options.input;
    this.#hud = options.hud;
    this.#chase = options.chase;
    this.root.name = "fort-mason-linked-ensemble";
    this.root.position.set(
      FORT_MASON_ENSEMBLE_CENTER.x,
      options.map.groundTop(FORT_MASON_ENSEMBLE_CENTER.x, FORT_MASON_ENSEMBLE_CENTER.z) + 0.04,
      FORT_MASON_ENSEMBLE_CENTER.z
    );
    this.root.rotation.y = ROOT_YAW;
    this.#buildStage();
    this.#stations = [
      this.#buildStation(0, this.#buildPiano.bind(this), "fort-mason-pianist"),
      this.#buildStation(1, this.#buildSteelPan.bind(this), "fort-mason-steel-pan-player"),
      this.#buildStation(2, this.#buildPanPipes.bind(this), "fort-mason-pan-piper")
    ];
    this.root.updateMatrixWorld(true);
    this.#refreshStationWorld();
    this.#installNetworkHandlers();
    this.syncSlots();
  }

  get playing(): boolean {
    return this.#localSlot !== null;
  }

  update(dt: number, elapsed: number, playerPosition: THREE.Vector3, camera: THREE.Camera): boolean {
    if (this.#disposed) return false;
    dt = Math.min(dt, 0.1);
    const distance = Math.hypot(
      playerPosition.x - FORT_MASON_ENSEMBLE_CENTER.x,
      playerPosition.z - FORT_MASON_ENSEMBLE_CENTER.z
    );
    if (this.root.visible) {
      if (distance > HIDE_RADIUS && this.#localSlot === null) this.root.visible = false;
    } else if (distance < SHOW_RADIUS || this.#localSlot !== null) this.root.visible = true;
    if (!this.root.visible) {
      this.#audible = false;
      this.#promptSlot = null;
      return this.#localSlot !== null;
    }

    this.#refreshStationWorld();
    this.#audible = distance < AUDIO_RADIUS + 12;
    this.#audio.update(camera, distance, this.#stationWorld);
    this.#updateNpcTransport(elapsed, distance);
    this.#updateStations(dt, elapsed);
    this.#updatePrompt(playerPosition);

    if (this.#localSlot !== null) {
      this.#input.captureActivity();
      this.#handlePlayerNotes(this.#localSlot);
    }
    this.root.updateMatrixWorld(true);
    return this.#localSlot !== null;
  }

  tryInteract(playerPosition: THREE.Vector3, mode: PlayerMode): boolean {
    if (this.#localSlot !== null) {
      this.#requestRelease(this.#localSlot);
      return true;
    }
    if (this.#pendingClaim !== null) {
      this.#hud.message("That ensemble seat is still being claimed…", 1.5);
      return true;
    }
    if (mode !== "walk" || !this.root.visible) return false;
    const slot = this.#nearestStation(playerPosition, INTERACT_RADIUS);
    if (slot === null) return false;
    const owner = this.#net.ensembleSlots[slot];
    if (owner && owner !== this.#net.selfId) {
      this.#hud.message(`${this.#ownerName(owner)} is playing the ${ENSEMBLE_LABELS[slot]}`, 2.4);
      return true;
    }
    if (this.#net.status === "online" && this.#net.selfId) {
      this.#pendingClaim = slot;
      this.#net.claimEnsemble(slot);
      this.#hud.message(`Claiming the ${ENSEMBLE_LABELS[slot]}…`, 1.4);
    } else this.#enter(slot);
    return true;
  }

  applyPlayerPose() {
    const slot = this.#localSlot;
    if (slot === null) return;
    const station = this.#stationWorld[slot];
    const y = this.root.position.y + 0.58;
    this.#player.position.set(station.x, y, station.z);
    this.#player.renderPosition.copy(this.#player.position);
    this.#player.heading = ROOT_YAW + Math.PI;
    this.#player.velocity.set(0, 0, 0);
    this.#player.speed = 0;
    this.#poseQuaternion.setFromAxisAngle(this.#up, ROOT_YAW);
    this.#player.quaternion.copy(this.#poseQuaternion);
    this.#player.renderQuaternion.copy(this.#poseQuaternion);
    const mesh = this.#player.meshes.walk;
    mesh.position.copy(this.#player.renderPosition);
    mesh.quaternion.copy(this.#poseQuaternion);
  }

  syncSlots(slots: readonly [number, number, number] = this.#net.ensembleSlots) {
    for (const station of this.#stations) {
      const occupied = slots[station.slot] !== 0 || station.slot === this.#localSlot;
      station.rig.group.visible = !occupied;
    }
  }

  onWelcome() {
    this.syncSlots();
    if (this.#localSlot !== null) {
      this.#pendingClaim = this.#localSlot;
      this.#net.claimEnsemble(this.#localSlot);
    }
  }

  onOffline() {
    this.#pendingClaim = null;
    this.#pendingRelease = null;
    this.syncSlots();
  }

  releaseForNavigation(): boolean {
    if (this.#localSlot === null) return false;
    this.#requestRelease(this.#localSlot);
    return true;
  }

  debugState() {
    return {
      center: { ...FORT_MASON_ENSEMBLE_CENTER, y: this.root.position.y },
      visible: this.root.visible,
      localSlot: this.#localSlot,
      owners: [...this.#net.ensembleSlots],
      scale: [...SCALE_MIDI],
      labels: [...ENSEMBLE_LABELS],
      npcTicks: this.#stations.map((station) => station.autoTick),
      npcVisible: this.#stations.map((station) => station.rig.group.visible)
    };
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pendingClaim !== null && this.#net.status === "online") {
      this.#net.releaseEnsemble(this.#pendingClaim);
    }
    this.releaseForNavigation();
    this.#detachNetworkHandlers();
    this.#audio.dispose();
    for (const geometry of this.#ownedGeometries) geometry.dispose();
    for (const material of this.#ownedMaterials) material.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }

  #buildStage() {
    const deckMat = this.#material(new THREE.MeshStandardMaterial({ color: 0x916a46, roughness: 0.92 }));
    const edgeMat = this.#material(new THREE.MeshStandardMaterial({ color: 0x39555c, roughness: 0.78 }));
    const deck = new THREE.Mesh(this.#geometry(new THREE.CylinderGeometry(5.35, 5.55, 0.09, 32)), deckMat);
    deck.position.y = 0;
    // Nearby historic buildings cast a very broad cached shadow here. Let the
    // low platform keep its warm wood value while the performers/instruments
    // still receive and cast the detailed hero shadows that sell their contact.
    deck.receiveShadow = false;
    this.root.add(deck);
    const rim = new THREE.Mesh(this.#geometry(new THREE.TorusGeometry(5.42, 0.055, 6, 48)), edgeMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.065;
    this.root.add(rim);

    const stripeGeo = this.#geometry(new THREE.BoxGeometry(0.045, 0.012, 1));
    const stripeMat = this.#material(new THREE.MeshStandardMaterial({ color: 0xc7a978, roughness: 0.9 }));
    for (let x = -4.8; x <= 4.8; x += 0.34) {
      const stripe = new THREE.Mesh(stripeGeo, stripeMat);
      stripe.position.set(x, 0.055, 0);
      // Chord length of the circular deck: every board terminates inside the
      // rim instead of poking out as a rectangular comb at the east/west edge.
      stripe.scale.z = Math.sqrt(Math.max(0.1, 5.12 * 5.12 - x * x)) * 2;
      stripe.receiveShadow = false;
      this.root.add(stripe);
    }
  }

  #buildStation(
    slot: EnsembleSlot,
    buildInstrument: (station: Station) => void,
    seed: string
  ): Station {
    const group = new THREE.Group();
    group.name = `fort-mason-${ENSEMBLE_LABELS[slot].replaceAll(" ", "-")}`;
    group.position.x = STATION_X[slot];
    const rig = buildRig(avatarFromSeed(seed));
    rig.group.position.set(0, 0.93, 0.92);
    group.add(rig.group);
    this.#collectRigMaterials(rig);
    const station: Station = {
      slot,
      group,
      rig,
      toneMaterials: [],
      pulse: 0,
      step: 0,
      selectedStep: 0,
      autoTick: -1
    };
    buildInstrument(station);
    this.root.add(group);
    return station;
  }

  #buildPiano(station: Station) {
    const bodyMat = this.#material(new THREE.MeshStandardMaterial({ color: 0x17272c, roughness: 0.42, metalness: 0.15 }));
    const woodMat = this.#material(new THREE.MeshStandardMaterial({ color: 0x543421, roughness: 0.72 }));
    const goldMat = this.#material(new THREE.MeshStandardMaterial({ color: 0xc7a65a, roughness: 0.32, metalness: 0.72 }));
    const body = new THREE.Mesh(this.#geometry(new THREE.BoxGeometry(1.75, 1.28, 0.48)), bodyMat);
    body.position.set(0, 0.72, -0.48);
    body.castShadow = true;
    station.group.add(body);
    const top = new THREE.Mesh(this.#geometry(new THREE.BoxGeometry(1.9, 0.09, 0.62)), woodMat);
    top.position.set(0, 1.4, -0.48);
    top.rotation.x = -0.08;
    top.castShadow = true;
    station.group.add(top);
    const keyboard = new THREE.Group();
    keyboard.position.set(0, 0.82, -0.78);
    station.group.add(keyboard);
    const keyGeo = this.#geometry(new THREE.BoxGeometry(0.195, 0.055, 0.42));
    for (let i = 0; i < 8; i++) {
      const material = this.#toneMaterial(0xf2ead8, 0x4fbbff);
      const key = new THREE.Mesh(keyGeo, material);
      key.position.x = (i - 3.5) * 0.205;
      key.castShadow = false;
      keyboard.add(key);
      station.toneMaterials.push(material);
    }
    const blackGeo = this.#geometry(new THREE.BoxGeometry(0.12, 0.075, 0.26));
    for (const i of [0, 1, 3, 4, 5]) {
      const key = new THREE.Mesh(blackGeo, bodyMat);
      key.position.set((i - 2.5) * 0.205 + 0.102, 0.055, 0.07);
      keyboard.add(key);
    }
    const pedal = new THREE.Mesh(this.#geometry(new THREE.BoxGeometry(0.16, 0.035, 0.28)), goldMat);
    pedal.position.set(0, 0.12, -0.25);
    station.group.add(pedal);
    const bench = new THREE.Mesh(this.#geometry(new THREE.BoxGeometry(0.9, 0.11, 0.36)), woodMat);
    bench.position.set(0, 0.52, 0.34);
    bench.castShadow = true;
    station.group.add(bench);
  }

  #buildSteelPan(station: Station) {
    const chrome = this.#material(new THREE.MeshStandardMaterial({ color: 0x8fc3c7, roughness: 0.22, metalness: 0.82 }));
    const dark = this.#material(new THREE.MeshStandardMaterial({ color: 0x26383e, roughness: 0.55, metalness: 0.45 }));
    const shell = new THREE.Mesh(this.#geometry(new THREE.CylinderGeometry(0.48, 0.34, 0.22, 24)), chrome);
    shell.position.set(0, 0.86, -0.44);
    shell.castShadow = true;
    station.group.add(shell);
    const ring = new THREE.Mesh(this.#geometry(new THREE.TorusGeometry(0.46, 0.035, 8, 28)), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.985, -0.44);
    station.group.add(ring);
    const patchGeo = this.#geometry(new THREE.SphereGeometry(0.105, 12, 8));
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const material = this.#toneMaterial(0xb9d9d5, 0x66f2ff);
      const patch = new THREE.Mesh(patchGeo, material);
      patch.scale.set(1, 0.12, 0.82);
      patch.position.set(Math.sin(angle) * 0.28, 0.995, -0.44 + Math.cos(angle) * 0.28);
      station.group.add(patch);
      station.toneMaterials.push(material);
    }
    const legGeo = this.#geometry(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 8));
    for (const x of [-0.27, 0.27]) {
      const leg = new THREE.Mesh(legGeo, dark);
      leg.position.set(x, 0.44, -0.42);
      leg.rotation.z = x * 0.24;
      station.group.add(leg);
    }
    for (const side of [-1, 1]) {
      const mallet = new THREE.Mesh(this.#geometry(new THREE.CylinderGeometry(0.018, 0.018, 0.52, 8)), dark);
      mallet.position.set(side * 0.2, 1.14, -0.18);
      mallet.rotation.z = side * 0.3;
      station.group.add(mallet);
    }
  }

  #buildPanPipes(station: Station) {
    const bamboo = this.#material(new THREE.MeshStandardMaterial({ color: 0xd4a95d, roughness: 0.62, metalness: 0.03 }));
    const binding = this.#material(new THREE.MeshStandardMaterial({ color: 0x5b3522, roughness: 0.82 }));
    const pipeGeo = this.#geometry(new THREE.CylinderGeometry(0.07, 0.07, 1, 12));
    for (let i = 0; i < 8; i++) {
      const length = 0.98 - i * 0.075;
      const material = this.#toneMaterial(0xd4a95d, 0xffdc73);
      const pipe = new THREE.Mesh(pipeGeo, material);
      pipe.scale.y = length;
      pipe.position.set((i - 3.5) * 0.14, 0.83 + length * 0.5, -0.5);
      pipe.castShadow = true;
      station.group.add(pipe);
      station.toneMaterials.push(material);
    }
    for (const y of [0.78, 1.02]) {
      const rail = new THREE.Mesh(this.#geometry(new THREE.BoxGeometry(1.18, 0.08, 0.1)), binding);
      rail.position.set(0, y, -0.5);
      station.group.add(rail);
    }
    const stand = new THREE.Mesh(this.#geometry(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 8)), binding);
    stand.position.set(0, 0.38, -0.45);
    station.group.add(stand);
    const foot = new THREE.Mesh(this.#geometry(new THREE.CylinderGeometry(0.32, 0.36, 0.07, 16)), bamboo);
    foot.position.set(0, 0.08, -0.45);
    station.group.add(foot);
  }

  #updateNpcTransport(elapsed: number, distance: number) {
    if (distance > AUDIO_RADIUS + 30) return;
    for (const station of this.#stations) {
      const occupied = this.#net.ensembleSlots[station.slot] !== 0 || station.slot === this.#localSlot;
      if (occupied) {
        station.autoTick = this.#autoTick(station.slot, elapsed);
        continue;
      }
      const tick = this.#autoTick(station.slot, elapsed);
      if (tick === station.autoTick) continue;
      station.autoTick = tick;
      const pattern = NPC_PATTERNS[station.slot];
      const step = pattern[((tick % pattern.length) + pattern.length) % pattern.length];
      const duration = station.slot === 2 ? BEAT_SECONDS * 1.8 : station.slot === 0 ? 0.62 : 0.42;
      this.#trigger(station.slot, step, station.slot === 1 ? 0.58 : 0.48, duration);
    }
  }

  #autoTick(slot: EnsembleSlot, elapsed: number) {
    const seconds = slot === 1 ? BEAT_SECONDS * 0.5 : slot === 2 ? BEAT_SECONDS * 2 : BEAT_SECONDS;
    return Math.floor(elapsed / seconds);
  }

  #updateStations(dt: number, elapsed: number) {
    for (const station of this.#stations) {
      station.pulse = Math.max(0, station.pulse - dt * (station.slot === 2 ? 2.4 : 6.8));
      for (let i = 0; i < station.toneMaterials.length; i++) {
        const material = station.toneMaterials[i];
        const on = i === station.step ? station.pulse : 0;
        material.emissiveIntensity = on * 1.7 + (i === station.selectedStep && station.slot === this.#localSlot ? 0.16 : 0);
      }
      if (!station.rig.group.visible) continue;
      poseIdle(station.rig, elapsed + station.slot * 1.7);
      const pulse = station.pulse;
      if (station.slot === 0) {
        station.rig.torso.rotation.x = 0.12;
        station.rig.armL.rotation.set(-0.75 - pulse * 0.28, 0.08, 0.42);
        station.rig.armR.rotation.set(-0.75 - pulse * 0.28, -0.08, -0.42);
        station.rig.foreL.rotation.x = 1.14 + pulse * 0.35;
        station.rig.foreR.rotation.x = 1.14 + pulse * 0.35;
      } else if (station.slot === 1) {
        const right = station.step % 2 === 0;
        station.rig.torso.rotation.x = 0.08;
        station.rig.armL.rotation.set(-0.52 - (!right ? pulse * 0.65 : 0), 0.05, 0.28);
        station.rig.armR.rotation.set(-0.52 - (right ? pulse * 0.65 : 0), -0.05, -0.28);
        station.rig.foreL.rotation.x = 0.82;
        station.rig.foreR.rotation.x = 0.82;
      } else {
        station.rig.torso.rotation.x = 0.05;
        station.rig.head.rotation.x = -0.08 + Math.sin(elapsed * 1.4) * 0.025;
        station.rig.armL.rotation.set(-1.15, 0.05, 0.48);
        station.rig.armR.rotation.set(-1.15, -0.05, -0.48);
        station.rig.foreL.rotation.x = 1.42;
        station.rig.foreR.rotation.x = 1.42;
      }
    }
  }

  #handlePlayerNotes(slot: EnsembleSlot) {
    const station = this.#stations[slot];
    const delta = (this.#input.pressed("PadModeNext") ? 1 : 0) - (this.#input.pressed("PadModePrev") ? 1 : 0);
    if (delta) station.selectedStep = (station.selectedStep + delta + SCALE_MIDI.length) % SCALE_MIDI.length;
    let played = false;
    for (let i = 0; i < SCALE_MIDI.length; i++) {
      if (!this.#input.pressed(`Digit${i + 1}`) && !this.#input.pressed(`Numpad${i + 1}`)) continue;
      station.selectedStep = i;
      this.#playLocal(slot, i, 0.82);
      played = true;
    }
    if (!played && (this.#input.pressed("Space") || this.#input.firePressed)) {
      this.#playLocal(slot, station.selectedStep, 0.86);
    }
  }

  #playLocal(slot: EnsembleSlot, step: number, velocity: number) {
    const duration = slot === 2 ? 1.15 : slot === 0 ? 0.72 : 0.5;
    this.#trigger(slot, step, velocity, duration);
    if (this.#net.status === "online" && this.#net.selfId) this.#net.sendEnsembleNote(slot, step, velocity);
  }

  #trigger(slot: EnsembleSlot, step: number, velocity: number, duration: number) {
    if (!Number.isInteger(step) || step < 0 || step >= SCALE_MIDI.length) return;
    const station = this.#stations[slot];
    station.step = step;
    station.pulse = 1;
    if (this.#audible) this.#audio.play(slot, step, velocity, duration);
  }

  #updatePrompt(playerPosition: THREE.Vector3) {
    if (this.#localSlot !== null) {
      this.#promptSlot = null;
      return;
    }
    const slot = this.#nearestStation(playerPosition, INTERACT_RADIUS);
    if (slot === this.#promptSlot) return;
    this.#promptSlot = slot;
    if (slot === null) return;
    const owner = this.#net.ensembleSlots[slot];
    const action = owner && owner !== this.#net.selfId
      ? `${this.#ownerName(owner)} is on ${ENSEMBLE_LABELS[slot]}`
      : `${interactKeyLabel()} — play ${ENSEMBLE_LABELS[slot]} · shared C pentatonic`;
    this.#hud.message(action, 2.8);
  }

  #nearestStation(playerPosition: THREE.Vector3, radius: number): EnsembleSlot | null {
    let nearest: EnsembleSlot | null = null;
    let best = radius;
    for (let i = 0; i < this.#stationWorld.length; i++) {
      const p = this.#stationWorld[i];
      const distance = Math.hypot(playerPosition.x - p.x, playerPosition.z - p.z);
      if (distance >= best) continue;
      best = distance;
      nearest = i as EnsembleSlot;
    }
    return nearest;
  }

  #refreshStationWorld() {
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < 3; i++) {
      this.#stationWorld[i].set(STATION_X[i], 0, PLAYER_Z).applyMatrix4(this.root.matrixWorld);
    }
  }

  #enter(slot: EnsembleSlot) {
    if (this.#localSlot !== null) return;
    this.#entryPose = {
      x: this.#player.position.x,
      y: this.#player.position.y,
      z: this.#player.position.z,
      heading: this.#player.heading
    };
    this.#localSlot = slot;
    this.#player.restoreState({
      mode: "walk",
      x: this.#stationWorld[slot].x,
      y: this.root.position.y + 0.58,
      z: this.#stationWorld[slot].z,
      heading: ROOT_YAW + Math.PI
    });
    this.#chase.yaw = ROOT_YAW;
    this.syncSlots();
    this.applyPlayerPose();
    this.#hud.message(
      `${ENSEMBLE_LABELS[slot]} linked · 1–8 play · click/Space repeats · ${interactKeyLabel()} leaves`,
      4
    );
  }

  #requestRelease(slot: EnsembleSlot) {
    if (this.#net.status === "online" && this.#net.selfId && this.#net.ensembleSlots[slot] === this.#net.selfId) {
      if (this.#pendingRelease === null) {
        this.#pendingRelease = slot;
        this.#net.releaseEnsemble(slot);
      }
      return;
    }
    this.#finishExit(slot);
  }

  #finishExit(slot: EnsembleSlot) {
    if (this.#localSlot !== slot) return;
    this.#localSlot = null;
    const pose = this.#entryPose;
    this.#entryPose = null;
    if (pose) this.#player.restoreState({ mode: "walk", ...pose });
    this.syncSlots();
    this.#hud.message("The NPC has the part again", 1.8);
  }

  #ownerName(id: number) {
    if (id === this.#net.selfId) return this.#net.name;
    return this.#net.roster.get(id)?.name ?? `Player ${id}`;
  }

  #installNetworkHandlers() {
    const handlers: NetworkHandlers = {
      onEnsembleSlots: (slots) => this.syncSlots(slots),
      onEnsembleClaim: (slot, ownerId, ok) => {
        if (ok && ownerId === this.#net.selfId) {
          this.#pendingClaim = null;
          if (this.#localSlot === null) this.#enter(slot);
        } else if (!ok && this.#pendingClaim === slot) {
          this.#pendingClaim = null;
          this.#hud.message(`${this.#ownerName(ownerId)} already has the ${ENSEMBLE_LABELS[slot]}`, 2.6);
        }
      },
      onEnsembleRelease: (slot, ownerId, ok) => {
        if (ok && (ownerId === this.#net.selfId || this.#pendingRelease === slot)) {
          this.#pendingRelease = null;
          this.#finishExit(slot);
        } else if (!ok && this.#pendingRelease === slot) this.#pendingRelease = null;
      },
      onEnsembleNote: (slot, ownerId, step, velocity) => {
        if (ownerId !== this.#net.selfId) this.#trigger(slot, step, velocity, slot === 2 ? 1.15 : 0.58);
      }
    };
    this.#networkHandlers = handlers;
    this.#net.onEnsembleSlots = handlers.onEnsembleSlots;
    this.#net.onEnsembleClaim = handlers.onEnsembleClaim;
    this.#net.onEnsembleRelease = handlers.onEnsembleRelease;
    this.#net.onEnsembleNote = handlers.onEnsembleNote;
  }

  #detachNetworkHandlers() {
    const handlers = this.#networkHandlers;
    if (!handlers) return;
    if (this.#net.onEnsembleSlots === handlers.onEnsembleSlots) this.#net.onEnsembleSlots = () => {};
    if (this.#net.onEnsembleClaim === handlers.onEnsembleClaim) this.#net.onEnsembleClaim = () => {};
    if (this.#net.onEnsembleRelease === handlers.onEnsembleRelease) this.#net.onEnsembleRelease = () => {};
    if (this.#net.onEnsembleNote === handlers.onEnsembleNote) this.#net.onEnsembleNote = () => {};
    this.#networkHandlers = null;
  }

  #geometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.#ownedGeometries.add(geometry);
    return geometry;
  }

  #material<T extends THREE.Material>(material: T): T {
    this.#ownedMaterials.add(material);
    return material;
  }

  #toneMaterial(color: number, emissive: number) {
    return this.#material(new THREE.MeshStandardMaterial({
      color,
      roughness: 0.48,
      metalness: 0.08,
      emissive,
      emissiveIntensity: 0
    }));
  }

  #collectRigMaterials(rig: Rig) {
    rig.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) this.#ownedMaterials.add(material);
    });
    setRigClasp(rig, "L", 0.4);
    setRigClasp(rig, "R", 0.4);
  }
}

export function createFortMasonEnsemble(options: EnsembleOptions) {
  return new FortMasonEnsemble(options);
}
