import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { WorldMap } from "../heightmap";
import type { RoadGraph } from "./roadGraph";
import { buildRig, poseWalk, type Rig } from "../../player/rig";
import { avatarFromSeed } from "../../player/avatar";
import { yieldToFrame } from "../../core/cooperativeWork";
import { laptopProfile } from "../../render/laptopProfiles";
import { governorEffects } from "../../render/adaptiveResolution";
const CAR_COUNT = 18, WALKER_COUNT = 12, RADIUS = 220;
type Agent = {
    seg: number;
    s: number;
    dir: 1 | -1;
    total: number;
    halfWidth: number;
    speed: number;
    active: boolean;
    pos: THREE.Vector3;
    target: THREE.Vector3;
    yaw: number;
    walker: boolean;
    side: 1 | -1;
    poseAt: number;
    routeChoice: number;
};
function carGeometry(kind: number) {
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, tint: number, x: number, y: number, z: number, rotate = false) => {
        if (rotate)
            g.rotateZ(Math.PI / 2);
        g.translate(x, y, z);
        const c = new THREE.Color(tint), values = new Float32Array(g.getAttribute("position").count * 3);
        for (let i = 0; i < values.length; i += 3) {
            values[i] = c.r;
            values[i + 1] = c.g;
            values[i + 2] = c.b;
        }
        g.setAttribute("color", new THREE.BufferAttribute(values, 3));
        parts.push(g);
    };
    const length = kind === 2 ? 5.1 : kind === 1 ? 4.4 : 3.8;
    const roofHeight = kind === 2 ? 1.35 : 0.7;
    add(new THREE.BoxGeometry(1.8, 0.55, length), 0xffffff, 0, 0.63, 0);
    add(new THREE.BoxGeometry(1.55, roofHeight, kind === 0 ? 1.95 : length * 0.7), 0xa7becb, 0, 0.96 + roofHeight / 2, kind === 0 ? 0.12 : 0.25);
    add(new THREE.BoxGeometry(1.64, 0.12, kind === 0 ? 2.05 : length * 0.72), 0xffffff, 0, 1.01 + roofHeight, kind === 0 ? 0.12 : 0.25);
    for (const x of [-0.89, 0.89])
        for (const z of [-length * 0.32, length * 0.32]) {
            add(new THREE.CylinderGeometry(0.36, 0.36, 0.2, 10), 0x20282e, x, 0.37, z, true);
            add(new THREE.CylinderGeometry(0.18, 0.18, 0.22, 8), 0xb5bdbd, x, 0.37, z, true);
        }
    for (const x of [-0.62, 0.62]) {
        add(new THREE.BoxGeometry(0.36, 0.15, 0.05), 0xffefb5, x, 0.73, -length / 2 - 0.03);
        add(new THREE.BoxGeometry(0.32, 0.14, 0.05), 0xba3932, x, 0.75, length / 2 + 0.03);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts)
        p.dispose();
    if (!merged)
        throw new Error("Ambient car geometry could not be batched");
    return merged;
}
/** Bounded street life: three instanced car draws and twelve shared avatar rigs.
 * No per-car textures/lights/physics, no citywide AI, no catalog downloads. */
export class AmbientCity {
    readonly root = new THREE.Group();
    private cars: THREE.InstancedMesh[] = [];
    private walkers: Rig[] = [];
    private agents: Agent[] = [];
    private scratch = new THREE.Object3D();
    private simAccumulator = 0;
    private nextSpawn = 0;
    private seed = 49217;
    private disposed = false;
    private junctions = 0;
    private poseUpdates = 0;
    private constructor(private roads: RoadGraph, private map: WorldMap) {
        this.root.name = "ambient_city_life";
        const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.2 });
        for (let kind = 0; kind < 3; kind++) {
            const mesh = new THREE.InstancedMesh(carGeometry(kind), material, CAR_COUNT / 3);
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.frustumCulled = false;
            mesh.count = 0;
            mesh.name = ["ambient_sedans", "ambient_wagons", "ambient_minibuses"][kind];
            for (let i = 0; i < CAR_COUNT / 3; i++)
                mesh.setColorAt(i, new THREE.Color().setHSL((i * 0.27 + kind * 0.16) % 1, 0.32, 0.57));
            this.cars.push(mesh);
            this.root.add(mesh);
        }
        for (let i = 0; i < CAR_COUNT + WALKER_COUNT; i++)
            this.agents.push({ seg: 0, s: 0, dir: 1, total: 0, halfWidth: 0, speed: i < CAR_COUNT ? 5 + (i % 4) : 0.85 + (i % 3) * 0.17, active: false, pos: new THREE.Vector3(), target: new THREE.Vector3(), yaw: 0, walker: i >= CAR_COUNT, side: i % 2 ? 1 : -1, poseAt: 0, routeChoice: i });
    }
    static async create(roads: RoadGraph, map: WorldMap) {
        const city = new AmbientCity(roads, map);
        try {
            for (let i = 0; i < WALKER_COUNT; i++) {
                const rig = buildRig(avatarFromSeed(`city-walker-${i}`));
                rig.group.visible = false;
                rig.group.traverse(o => { if (o instanceof THREE.Mesh) {
                    o.castShadow = false;
                    o.receiveShadow = false;
                } });
                city.walkers.push(rig);
                city.root.add(rig.group);
                await yieldToFrame();
            }
            return city;
        }
        catch (error) {
            city.dispose();
            throw error;
        }
    }
    private random() {
        this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
        return this.seed / 4294967296;
    }
    private spawn(agent: Agent, focus: THREE.Vector3) {
        // Fixed query budget, one candidate agent per frame. No allocating scan of
        // every road vertex in a 400 m disk for every replacement.
        for (let attempt = 0; attempt < 5; attempt++) {
            const angle = this.random() * Math.PI * 2, radius = 45 + this.random() * 105;
            const road = this.roads.nearestPoint(focus.x + Math.cos(angle) * radius, focus.z + Math.sin(angle) * radius, 25);
            if (!road)
                continue;
            const meta = this.roads.segmentMeta(road.segId);
            if (meta.total < 24 || meta.halfWidth < 3 || meta.halfWidth > 14)
                continue;
            const dir = meta.oneWayDir || (this.random() < 0.5 ? -1 : 1);
            if (!agent.walker && this.agents.some(a => a !== agent && a.active && !a.walker && a.seg === road.segId && a.dir === dir && Math.abs(a.s - road.s) < 15))
                continue;
            agent.seg = road.segId;
            agent.s = Math.max(3, Math.min(meta.total - 3, road.s));
            agent.dir = dir;
            agent.total = meta.total;
            agent.halfWidth = meta.halfWidth;
            if (!this.sample(agent))
                continue;
            if (Math.abs(agent.target.y - focus.y) > 25)
                continue;
            agent.active = true;
            agent.pos.copy(agent.target);
            return;
        }
    }
    private sample(agent: Agent): boolean {
        const p = this.roads.lookAhead(agent.seg, agent.s, agent.dir, 0);
        const x = p.x, z = p.z;
        const arc = Math.max(0, Math.min(agent.total, agent.s + agent.dir * 0.8));
        const reverse = Math.abs(arc - agent.s) < 0.01;
        const ahead = this.roads.lookAhead(agent.seg, reverse ? agent.s - agent.dir * 0.8 : arc, agent.dir, 0);
        let dx = (ahead.x - x) * (reverse ? -1 : 1), dz = (ahead.z - z) * (reverse ? -1 : 1);
        const len = Math.hypot(dx, dz);
        if (len < 0.001)
            return false;
        dx /= len;
        dz /= len;
        const offset = agent.walker ? (agent.halfWidth + 0.95) * agent.side : Math.min(2.5, agent.halfWidth * 0.48);
        // +right of the direction of travel; walkers use either sidewalk.
        const wx = x - dz * offset, wz = z + dx * offset;
        const ground = this.map.groundHeight(wx, wz), top = this.map.groundTop(wx, wz);
        if (this.map.isWater(wx, wz) || !Number.isFinite(top) || Math.abs(top - ground) > 1.25)
            return false;
        if (agent.active && Math.abs(top + (agent.walker ? 0.93 : 0) - agent.target.y) > 1.8)
            return false;
        agent.target.set(wx, top + (agent.walker ? 0.93 : 0.04), wz);
        agent.yaw = Math.atan2(-dx, -dz);
        return true;
    }
    update(dt: number, elapsed: number, focus: THREE.Vector3) {
        if (this.disposed)
            return;
        const economy = governorEffects().level >= 3 || laptopProfile().label === "Quiet";
        const carLimit = economy ? 9 : CAR_COUNT, walkerLimit = economy ? 6 : WALKER_COUNT;
        this.simAccumulator += Math.min(dt, 0.1);
        const simulate = this.simAccumulator >= 0.1;
        const simDt = Math.min(0.15, this.simAccumulator);
        if (simulate)
            this.simAccumulator = 0;
        const allowSpawn = elapsed >= this.nextSpawn;
        let spawned = false;
        const counts = [0, 0, 0];
        for (let i = 0; i < this.agents.length; i++) {
            const a = this.agents[i], eligible = a.walker ? i - CAR_COUNT < walkerLimit : i < carLimit;
            const distance = a.active ? Math.hypot(a.pos.x - focus.x, a.pos.z - focus.z) : Infinity;
            if (!eligible || distance > RADIUS)
                a.active = false;
            if (!a.active && eligible && allowSpawn && !spawned) {
                this.spawn(a, focus);
                spawned = true;
                this.nextSpawn = elapsed + 0.15;
            }
            if (a.active && simulate) {
                let advance = a.speed * simDt;
                if (!a.walker) {
                    const signal = this.roads.signals.query(a.seg, a.s, a.dir, performance.now() / 1000, 25);
                    if (signal.stopRequired)
                        advance = Math.min(advance, Math.max(0, signal.distance - 4));
                    for (const other of this.agents)
                        if (other !== a && other.active && !other.walker && other.seg === a.seg && other.dir === a.dir) {
                            const gap = (other.s - a.s) * a.dir;
                            if (gap > 0)
                                advance = Math.min(advance, Math.max(0, gap - 8));
                        }
                    if (Math.hypot(a.pos.x - focus.x, a.pos.z - focus.z) < 5)
                        advance = 0;
                }
                const next = a.s + a.dir * advance;
                if (next < 0 || next > a.total) {
                    const exit = this.roads.junctionExit(a.seg, a.dir, a.routeChoice++, a.walker);
                    if (exit) {
                        const overflow = next < 0 ? -next : next - a.total;
                        const meta = this.roads.segmentMeta(exit.seg);
                        a.seg = exit.seg; a.dir = exit.dir; a.total = meta.total; a.halfWidth = meta.halfWidth;
                        a.s = Math.max(0, Math.min(a.total, exit.s + exit.dir * overflow));
                        this.junctions++;
                    } else if (a.walker) {
                        a.dir = a.dir === 1 ? -1 : 1;
                        a.side = a.side === 1 ? -1 : 1;
                    } else if (distance > 60) a.active = false;
                    else a.s = Math.max(0.1, Math.min(a.total - 0.1, next));
                } else a.s = next;
                if (a.active && !this.sample(a))
                    a.active = false;
                if (a.walker && a.active && elapsed >= a.poseAt) {
                    poseWalk(this.walkers[i - CAR_COUNT], elapsed * a.speed * 1.8, 0);
                    a.poseAt = elapsed + (distance > 100 ? 0.5 : distance > 45 ? 0.2 : 0.09);
                    this.poseUpdates++;
                }
            }
            if (a.active)
                a.pos.lerp(a.target, 1 - Math.exp(-dt * 18));
            if (a.walker) {
                const rig = this.walkers[i - CAR_COUNT];
                rig.group.visible = a.active;
                if (a.active) {
                    rig.group.position.copy(a.pos);
                    rig.group.rotation.y = a.yaw;
                }
            }
            else if (a.active) {
                const kind = i % 3, slot = counts[kind]++;
                this.scratch.position.copy(a.pos);
                this.scratch.rotation.set(0, a.yaw, 0);
                this.scratch.updateMatrix();
                this.cars[kind].setMatrixAt(slot, this.scratch.matrix);
            }
        }
        this.cars.forEach((mesh, i) => { mesh.count = counts[i]; mesh.instanceMatrix.needsUpdate = counts[i] > 0; });
    }
    debugState() { return { junctions: this.junctions, poseUpdates: this.poseUpdates, cars: this.agents.filter(a => a.active && !a.walker).length, walkers: this.agents.filter(a => a.active && a.walker).length, carDraws: this.cars.filter(m => m.count > 0).length }; }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.root.removeFromParent();
        for (const car of this.cars) {
            car.geometry.dispose();
            car.dispose();
        }
        (this.cars[0]?.material as THREE.Material)?.dispose();
        for (const rig of this.walkers)
            rig.group.traverse(o => { if (o instanceof THREE.SkinnedMesh) {
                o.skeleton.dispose();
                (o.material as THREE.Material).dispose();
            } });
    }
}
