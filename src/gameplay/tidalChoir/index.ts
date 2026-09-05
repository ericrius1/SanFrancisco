import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { audioEngine } from "../../audio/engine";
import type { WorldMap } from "../../world/heightmap";
import type { Player } from "../../player/player";
import type { RemotePlayers } from "../../net/remotes";
import type { Net } from "../../net/net";
import type { HUD } from "../../ui/hud";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseWalk, type Rig } from "../../player/rig";
import { choirPad, choirPadAt, TIDAL_CHOIR_CENTER, TIDAL_CHOIR_NOTES } from "./meta";
const COLORS = [0x4ce3ce, 0x65baf6, 0x9d8ff0, 0xee98c8, 0xffbb7a, 0xf7df93];
const BEAT = 0.6;
/** Six quiet spatial voices on the app's shared music bus. No audio files. */
class ChoirAudio {
    private channels: {
        osc: OscillatorNode;
        overtone: OscillatorNode;
        gain: GainNode;
        harmonic: GainNode;
        pan: PannerNode;
    }[] = [];
    private release: (() => void) | null = null;
    private master: GainNode | null = null;
    update(energies: readonly number[], positions: readonly THREE.Vector3[], nearby: boolean) {
        const sounding = nearby && energies.some(e => e > 0.01);
        if (!sounding) {
            this.release?.();
            this.release = null;
            if (this.master)
                this.master.gain.setTargetAtTime(0, this.master.context.currentTime, 0.2);
            return;
        }
        const bus = audioEngine.bus("music");
        if (!bus)
            return;
        if (!this.master) {
            this.master = bus.ctx.createGain();
            this.master.gain.value = 0;
            this.master.connect(bus.input);
            for (let i = 0; i < 6; i++) {
                const osc = bus.ctx.createOscillator();
                const overtone = bus.ctx.createOscillator();
                const harmonic = bus.ctx.createGain();
                const gain = bus.ctx.createGain();
                const pan = bus.ctx.createPanner();
                osc.type = "sine";
                osc.frequency.value = 440 * 2 ** ((TIDAL_CHOIR_NOTES[i] - 69) / 12);
                overtone.frequency.value = osc.frequency.value * 2.001;
                harmonic.gain.value = 0.16;
                gain.gain.value = 0;
                pan.panningModel = "equalpower";
                pan.distanceModel = "inverse";
                pan.refDistance = 8;
                pan.rolloffFactor = 1.6;
                pan.positionX.value = positions[i].x;
                pan.positionY.value = positions[i].y + 2;
                pan.positionZ.value = positions[i].z;
                osc.connect(gain);
                overtone.connect(harmonic).connect(gain);
                gain.connect(pan).connect(this.master);
                osc.start();
                overtone.start();
                this.channels.push({ osc, overtone, harmonic, gain, pan });
            }
        }
        this.release ??= audioEngine.acquireHold();
        this.master.gain.setTargetAtTime(0.42, bus.ctx.currentTime, 0.2);
        for (let i = 0; i < 6; i++)
            this.channels[i].gain.gain.setTargetAtTime(energies[i] * 0.075, bus.ctx.currentTime, 0.09);
        audioEngine.touch(1);
    }
    dispose() {
        this.release?.();
        this.release = null;
        for (const voice of this.channels) {
            voice.osc.stop();
            voice.overtone.stop();
            voice.osc.disconnect();
            voice.overtone.disconnect();
            voice.harmonic.disconnect();
            voice.gain.disconnect();
            voice.pan.disconnect();
        }
        this.channels = [];
        this.master?.disconnect();
        this.master = null;
    }
}
/** Walk onto the colored stones: bodies are the score. Existing replicated
 * walking positions provide participation; no new messages or seat claims. */
export class TidalChoir {
    readonly root = new THREE.Group();
    readonly pads: THREE.Vector3[] = [];
    private rings: THREE.Mesh[] = [];
    private ribbons: THREE.Mesh[] = [];
    private tones: THREE.MeshStandardMaterial[] = [];
    private energies = Array<number>(6).fill(0);
    private occupied = Array<boolean>(6).fill(false);
    private geometries = new Set<THREE.BufferGeometry>();
    private materials = new Set<THREE.Material>();
    private visitors: Rig[] = [];
    private audio = new ChoirAudio();
    private label: HTMLDivElement;
    private welcomed = false;
    private disposed = false;
    private lastAudio = -Infinity;
    private lastPose = -Infinity;
    private localPad = -1;
    private activeCount = 0;
    constructor(private map: WorldMap, private net: Net) {
        this.root.name = "tidal_choir";
        this.root.position.set(TIDAL_CHOIR_CENTER.x, 0, TIDAL_CHOIR_CENTER.z);
        const stone = this.material(new THREE.MeshStandardMaterial({ color: 0x79898b, roughness: 0.85 }));
        const bronze = this.material(new THREE.MeshStandardMaterial({ color: 0x807064, metalness: 0.72, roughness: 0.34 }));
        const cylinder = this.geometry(new THREE.CylinderGeometry(1, 1.08, 0.12, 40));
        const ring = this.geometry(new THREE.TorusGeometry(1.65, 0.075, 6, 48));
        const pipe = this.geometry(new THREE.CylinderGeometry(0.1, 0.13, 1, 8));
        const sphere = this.geometry(new THREE.IcosahedronGeometry(0.3, 1));
        for (let i = 0; i < 6; i++) {
            const p = choirPad(i);
            const y = map.groundTop(TIDAL_CHOIR_CENTER.x + p.x, TIDAL_CHOIR_CENTER.z + p.z);
            this.pads.push(new THREE.Vector3(TIDAL_CHOIR_CENTER.x + p.x, y, TIDAL_CHOIR_CENTER.z + p.z));
            const tone = this.material(new THREE.MeshStandardMaterial({ color: COLORS[i], emissive: COLORS[i], emissiveIntensity: 0.2, metalness: 0.35, roughness: 0.3 }));
            this.tones.push(tone);
            const plinth = new THREE.Mesh(cylinder, stone);
            plinth.position.set(p.x, y + 0.02, p.z);
            plinth.scale.set(2, 1, 2);
            this.root.add(plinth);
            const halo = new THREE.Mesh(ring, tone);
            halo.rotation.x = Math.PI / 2;
            halo.position.set(p.x, y + 0.14, p.z);
            this.root.add(halo);
            this.rings.push(halo);
            // A curved tuning fork frames each station, open to the inward path.
            const outward = new THREE.Vector3(p.x, 0, p.z).normalize();
            const tangent = new THREE.Vector3(outward.z, 0, -outward.x);
            for (const side of [-1, 1]) {
                const points = [
                    new THREE.Vector3(p.x + tangent.x * side * 2.25, y, p.z + tangent.z * side * 2.25),
                    new THREE.Vector3(p.x + tangent.x * side * 2.5 + outward.x, y + 3, p.z + tangent.z * side * 2.5 + outward.z),
                    new THREE.Vector3(p.x + tangent.x * side * 1.5 + outward.x, y + 6.2, p.z + tangent.z * side * 1.5 + outward.z),
                    new THREE.Vector3(p.x + outward.x, y + 7, p.z + outward.z),
                ];
                const arch = new THREE.Mesh(this.geometry(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 20, 0.095, 6, false)), bronze);
                this.root.add(arch);
            }
            for (let j = 0; j < 5; j++) {
                const chime = new THREE.Mesh(pipe, tone);
                const offset = (j - 2) * 0.48;
                const height = 1.8 + ((j + i) % 4) * 0.42;
                chime.scale.y = height;
                chime.position.set(p.x + tangent.x * offset + outward.x, y + 5.5 - height * 0.5, p.z + tangent.z * offset + outward.z);
                this.root.add(chime);
            }
            const mote = new THREE.Mesh(sphere, tone);
            mote.position.set(p.x, y + 2.5, p.z);
            this.root.add(mote);
        }
        const centerY = map.groundTop(TIDAL_CHOIR_CENTER.x, TIDAL_CHOIR_CENTER.z);
        // Six open helical ribbons describe a breathing vessel, leaving its core hollow.
        for (let i = 0; i < 6; i++) {
            const points = Array.from({ length: 49 }, (_, j) => {
                const t = j / 48;
                const angle = i * Math.PI / 3 + t * Math.PI * 2;
                const radius = 0.8 + Math.sin(t * Math.PI) * 2.6;
                return new THREE.Vector3(Math.cos(angle) * radius, t * 8, Math.sin(angle) * radius);
            });
            const ribbon = new THREE.Mesh(this.geometry(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 48, 0.09, 5, false)), this.tones[i]);
            ribbon.position.y = centerY + 1;
            this.root.add(ribbon);
            this.ribbons.push(ribbon);
        }
        // All stationary chimes/arches share seven draws; only the interactive
        // circles and breathing ribbons remain separate.
        const animated = new Set<THREE.Object3D>([...this.rings, ...this.ribbons]);
        const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
        for (const object of [...this.root.children]) {
            if (!(object instanceof THREE.Mesh) || animated.has(object))
                continue;
            object.updateMatrix();
            const mat = object.material as THREE.Material;
            const list = batches.get(mat) ?? [];
            const piece = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
            list.push(piece.applyMatrix4(object.matrix));
            batches.set(mat, list);
            this.root.remove(object);
        }
        for (const [mat, pieces] of batches) {
            const merged = mergeGeometries(pieces, false);
            if (!merged)
                throw new Error("Tidal Choir geometry could not be batched");
            const mesh = new THREE.Mesh(this.geometry(merged), mat);
            mesh.name = "tidal_choir_static";
            this.root.add(mesh);
            for (const piece of pieces)
                piece.dispose();
        }
        // Two visitors circle the outer promenade; they demonstrate without
        // occupying pads or simulating remote players.
        for (let i = 0; i < 2; i++) {
            const rig = buildRig(avatarFromSeed(`tidal-choir-visitor-${i}`));
            rig.group.traverse(o => { if (o instanceof THREE.Mesh) {
                o.castShadow = false;
                o.receiveShadow = false;
            } });
            this.visitors.push(rig);
            this.root.add(rig.group);
        }
        this.label = document.createElement("div");
        this.label.style.cssText = "position:fixed;bottom:108px;left:50%;transform:translateX(-50%);padding:12px 20px;border:1px solid #b0e8e544;border-radius:16px;background:#092124d9;color:#e2fcf4;font:14px system-ui;text-align:center;pointer-events:none;z-index:20;display:none;max-width:80vw";
        document.body.append(this.label);
    }
    update(dt: number, elapsed: number, player: Player, remotes: RemotePlayers, hud: HUD) {
        if (this.disposed)
            return;
        const distance = Math.hypot(player.position.x - TIDAL_CHOIR_CENTER.x, player.position.z - TIDAL_CHOIR_CENTER.z);
        this.root.visible = distance < 230;
        this.label.style.display = distance < 24 ? "block" : "none";
        if (!this.root.visible) {
            this.audio.update(this.energies, this.pads, false);
            this.welcomed = false;
            return;
        }
        if (distance < 28 && !this.welcomed) {
            this.welcomed = true;
            hud.message("Tidal Choir · Walk onto a colored circle. Bring friends to awaken the sculpture.", 7);
        }
        this.occupied.fill(false);
        const occupy = (p: THREE.Vector3, walking: boolean) => {
            if (!walking)
                return -1;
            const pad = choirPadAt(p.x - TIDAL_CHOIR_CENTER.x, p.z - TIDAL_CHOIR_CENTER.z);
            if (pad < 0 || Math.abs(p.y - this.pads[pad].y) >= 3) return -1;
            this.occupied[pad] = true;
            return pad;
        };
        this.localPad = occupy(player.position, player.mode === "walk");
        for (const avatar of remotes.avatars.values())
            if (avatar.placed)
                occupy(avatar.root.position, avatar.mode === "walk");
        this.activeCount = this.occupied.filter(Boolean).length;
        const clock = this.net.synchronizedTimeMs() * 0.001;
        const beatPhase = clock / BEAT;
        const blend = 1 - Math.exp(-Math.min(dt, 0.1) * 6);
        for (let i = 0; i < 6; i++) {
            const pulse = 0.7 + 0.3 * Math.cos((beatPhase - i / 3) * Math.PI * 2);
            this.energies[i] += ((this.occupied[i] ? pulse : 0) - this.energies[i]) * blend;
            this.tones[i].emissiveIntensity = 0.18 + this.energies[i] * 2.6;
            this.rings[i].scale.setScalar(1 + this.energies[i] * 0.06);
            this.ribbons[i].rotation.y = elapsed * (0.03 + this.activeCount * 0.025);
            this.ribbons[i].scale.y = 1 + Math.sin(beatPhase * Math.PI / 4) * this.activeCount * 0.014;
        }
        if (elapsed - this.lastPose > 0.05) {
            this.lastPose = elapsed;
            this.visitors.forEach((rig, i) => {
                const angle = elapsed * 0.028 + i * Math.PI;
                const x = Math.cos(angle) * 15, z = Math.sin(angle) * 15;
                rig.group.position.set(x, this.map.groundTop(x + TIDAL_CHOIR_CENTER.x, z + TIDAL_CHOIR_CENTER.z) + 0.93, z);
                rig.group.rotation.y = Math.PI - angle;
                poseWalk(rig, elapsed * 1.3, 0);
            });
        }
        if (elapsed - this.lastAudio > 0.05) {
            this.lastAudio = elapsed;
            this.audio.update(this.energies, this.pads, distance < 70);
        }
        if (distance < 24) {
            const state = this.activeCount >= 3 ? "The choir is awake" : this.activeCount ? "Add another voice" : "Step into a circle";
            this.label.textContent = `TIDAL CHOIR  ·  ${this.activeCount} / 6 voices  ·  ${state}`;
        }
    }
    suspend() {
        this.root.visible = false;
        this.label.style.display = "none";
        this.audio.update([], this.pads, false);
    }
    debugState() { return { activePads: this.activeCount, localPad: this.localPad, occupied: [...this.occupied], positions: this.pads.map(p => p.toArray()) }; }
    private geometry<T extends THREE.BufferGeometry>(g: T): T { this.geometries.add(g); return g; }
    private material<T extends THREE.Material>(m: T): T { this.materials.add(m); return m; }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.audio.dispose();
        this.label.remove();
        this.root.removeFromParent();
        for (const rig of this.visitors)
            rig.group.traverse(o => {
                if (o instanceof THREE.SkinnedMesh) {
                    o.skeleton.dispose();
                    (o.material as THREE.Material).dispose();
                }
            });
        for (const g of this.geometries)
            g.dispose();
        for (const m of this.materials)
            m.dispose();
    }
}
