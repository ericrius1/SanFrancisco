import * as THREE from 'three/webgpu';
import { avatarFromSeed } from '../../player/avatar';
import { buildRig, poseIdle, type Rig } from '../../player/rig';
import { NpcConversation } from '../agents/conversation';
import { createResidentProvider } from './provider';
import type { ListeningMemory } from './memory';
import type { ResidentStory, StoryPlace } from './types';
import type { WorldMap } from '../../world/heightmap';

export interface CityStoriesRuntimeOptions {
  scene: THREE.Scene;
  map: WorldMap;
  places: readonly StoryPlace[];
  memory: ListeningMemory;
  prepare: (root: THREE.Group) => Promise<unknown>;
  placeReady: (id: string) => boolean;
  blocked: (x: number, y: number, z: number) => boolean;
}
type Resident = { story: ResidentStory; rig: Rig; talk: NpcConversation; homeYaw: number; phase: number };
type Patch = { place: StoryPlace; group: THREE.Group; residents: Resident[] };
const LOAD_RADIUS = 90;
const UNLOAD_RADIUS = 155;

/** Only nearby chapters and rigs are admitted. Neither world-sized actor arrays
 * nor dormant per-resident DOM cards are constructed from the place registry. */
export class CityStoriesRuntime {
  readonly #opts: CityStoriesRuntimeOptions;
  readonly #patches = new Map<string, Patch>();
  readonly #failures = new Map<string, number>();
  #pending: string | null = null;
  #disposed = false;
  #focus = { x: Infinity, y: Infinity, z: Infinity };
  #enabled = false;
  #loadEnabled = false;
  #selected: Resident | null = null;
  #time = 0;
  #scan = 0;
  #generation = 0;
  #camera: THREE.Camera | null = null;
  readonly #screen = new THREE.Vector3();
  constructor(options: CityStoriesRuntimeOptions) { this.#opts = options; }
  get active(): boolean { return this.#selected?.talk.active ?? false; }
  get choosing(): boolean { return this.#selected?.talk.choosing ?? false; }
  get debugState() {
    return { pending: this.#pending, loadedPlaces: [...this.#patches.keys()],
      residents: [...this.#patches.values()].flatMap(p => p.residents.map(r => ({
        id: r.story.id, name: r.story.speaker.name, place: p.place.id,
        x: r.rig.group.position.x, y: r.rig.group.position.y, z: r.rig.group.position.z
      }))), selected: this.#selected?.story.id ?? null, active: this.active };
  }
  tryInteract(player: THREE.Vector3Like, mode: string): boolean {
    return this.#enabled && (this.#selected?.talk.tryInteract(player, mode) ?? false);
  }
  navigate(dy: number): boolean { return this.#selected?.talk.navigate(dy) ?? false; }
  confirm(): boolean { return this.#selected?.talk.confirm() ?? false; }
  close(): boolean { return this.#selected?.talk.close() ?? false; }
  update(dt: number, player: THREE.Vector3Like, allowLoad: boolean, enabled: boolean): void {
    if (this.#disposed) return;
    this.#focus = { x: player.x, y: player.y, z: player.z };
    this.#enabled = enabled;
    this.#loadEnabled = allowLoad;
    this.#time += dt;
    this.#scan -= dt;
    if (!enabled) this.close();
    if (this.#scan <= 0) {
      this.#scan = 0.6;
      for (const [id, patch] of this.#patches) {
        if (Math.hypot(player.x - patch.place.x, player.z - patch.place.z) > UNLOAD_RADIUS || !this.#opts.placeReady(patch.place.id)) {
          this.#release(patch);
          this.#patches.delete(id);
        }
      }
      if (allowLoad && !this.#pending) {
        const place = this.#opts.places.filter(p => !this.#patches.has(p.id)
          && this.#opts.placeReady(p.id) && this.#opts.map.isTileRealAt(p.x, p.z)
          && (this.#failures.get(p.id) ?? 0) <= this.#time
          && Math.hypot(player.x - p.x, player.z - p.z) < LOAD_RADIUS
          && Math.abs(player.y - (p.groundY ?? this.#opts.map.effectiveGround(p.x, p.z))) < 30)
          .sort((a, b) => Math.hypot(player.x - a.x, player.z - a.z) - Math.hypot(player.x - b.x, player.z - b.z))[0];
        if (place && this.#patches.size < 4) void this.#load(place);
      }
    }
    // One prompt owns the interaction at a time; keep the current speaker
    // selected until they finish, even if a companion becomes slightly nearer.
    this.#selected?.talk.update(player);
    if (this.#selected && Math.abs(player.y - this.#selected.rig.group.position.y) > 4) this.close();
    if (!this.active) {
      this.#selected = null;
      let nearest = 8.5;
      if (enabled) for (const patch of this.#patches.values()) for (const resident of patch.residents) {
        const pos = resident.rig.group.position;
        const d = Math.hypot(player.x - pos.x, player.z - pos.z);
        // Do not let an unseen companion behind the camera steal the prompt
        // from the person the player is approaching (notably paired arrivals).
        if (this.#camera) {
          this.#screen.copy(pos);
          this.#screen.y += 1.15;
          this.#screen.project(this.#camera);
          if (this.#screen.z < -1 || this.#screen.z > 1
            || Math.abs(this.#screen.x) > 1.1 || Math.abs(this.#screen.y) > 1.1) continue;
        }
        if (d < nearest && Math.abs(player.y - pos.y) < 3) { nearest = d; this.#selected = resident; }
      }
    }
    for (const patch of this.#patches.values()) for (const resident of patch.residents) {
      const { rig, talk } = resident;
      const pos = rig.group.position;
      // Resample after streamed ground overlays arrive, including bridge decks.
      pos.y = (patch.place.groundY ?? this.#opts.map.effectiveGround(pos.x, pos.z)) + 0.92;
      talk.setWorldVisible(enabled && this.#selected === resident);
      if (this.#selected === resident) talk.update(player);
      const distance = Math.hypot(player.x - pos.x, player.z - pos.z);
      if (distance > 48) continue;
      const t = this.#time + resident.phase;
      poseIdle(rig, t);
      if (resident.story.activity === 'read' && !talk.active) {
        rig.head.rotation.x = 0.3;
        rig.armL.rotation.x = -0.4;
        rig.foreL.rotation.x = 1.1;
        rig.armR.rotation.x = -0.35;
        rig.foreR.rotation.x = 1.05;
      } else if (resident.story.activity === 'stretch' && !talk.active) {
        const lift = (Math.sin(t * 0.35) + 1) * 0.5;
        rig.armR.rotation.z = -lift * 1.6;
        rig.foreR.rotation.x = 0.45;
        rig.head.rotation.z = lift * 0.12;
      } else if (resident.story.activity === 'chat' || talk.active) {
        rig.armR.rotation.x = -0.2 - Math.max(0, Math.sin(t * 1.8)) * 0.26;
        rig.foreR.rotation.x = 0.65 + Math.sin(t * 0.8) * 0.16;
      }
      const want = enabled && this.#selected === resident && distance < 9
        ? Math.atan2(pos.x - player.x, pos.z - player.z) : resident.homeYaw;
      const delta = Math.atan2(Math.sin(want - rig.group.rotation.y), Math.cos(want - rig.group.rotation.y));
      rig.group.rotation.y += delta * Math.min(1, dt * 2);
    }
  }
  project(camera: THREE.Camera): void {
    this.#camera = camera;
    // Hidden cards never need camera projection/layout work.
    this.#selected?.talk.project(camera);
  }
  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    for (const patch of this.#patches.values()) this.#release(patch);
    this.#patches.clear();
  }
  async #load(place: StoryPlace): Promise<void> {
    this.#pending = place.id;
    const generation = this.#generation;
    let patch: Patch | null = null;
    try {
      const { default: chapter } = await place.load();
      if (!this.#wanted(place, generation)) return;
      const group = new THREE.Group();
      group.name = `city-stories:${place.id}`;
      patch = { place, group, residents: [] };
      for (let i = 0; i < chapter.residents.length; i++) {
        const story = chapter.residents[i];
        const authored = place.spots[i];
        if (!authored) continue;
        const spot = place.groundY !== undefined
          ? { x: authored.x, z: authored.z, y: place.groundY }
          : this.#safeSpot(authored.x, authored.z);
        if (!spot) continue;
        const rig = buildRig(avatarFromSeed(story.seed));
        rig.group.name = `resident:${story.id}`;
        // Match the shared ambient walkers' shadow policy: these small residents
        // do not expand the hero shadow pass or disappear into solid silhouettes.
        rig.group.traverse(object => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = false;
            object.receiveShadow = false;
          }
        });
        rig.group.position.set(spot.x, spot.y + 0.92, spot.z);
        rig.group.rotation.y = authored.yaw;
        poseIdle(rig, i * 2.7);
        if (story.activity === 'read') {
          // A small held book shares the same low-poly language as the rig.
          const book = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.22),
            new THREE.MeshLambertMaterial({ color: 0xb47851 }));
          book.name = 'resident-book';
          rig.handL.add(book);
        }
        group.add(rig.group);
        const talk = new NpcConversation({
          speaker: story.speaker, conversationId: `city:${story.id}`,
          anchor: rig.group, worldOffset: { x: 0, y: 1.15, z: 0 },
          promptLabel: () => this.#opts.memory.hasMet(story.id) ? `Check in with ${story.speaker.name}` : `Talk to ${story.speaker.name}`,
          available: () => this.#enabled,
          startRange: 8.5, cardRange: 14,
          createProvider: () => createResidentProvider(story, chapter, this.#opts.memory),
          ui: { defaultTopic: place.label, className: 'city-story-dialogue' },
          onAction: (action, turn) => {
            if (!action.startsWith('remember:') || !turn) return;
            const beat = action.slice('remember:'.length);
            this.#opts.memory.remember({ id: story.id, name: story.speaker.name, place: place.label,
              chapter: chapter.id, revision: chapter.revision,
              heardReflection: beat === 'reflection', lastText: turn.text }, beat);
          }
        });
        talk.setWorldVisible(false);
        patch.residents.push({ story, rig, talk, homeYaw: rig.group.rotation.y, phase: i * 3.7 });
      }
      if (!patch.residents.length) throw new Error('No safe resident positions yet');
      await this.#opts.prepare(group);
      if (!this.#wanted(place, generation)) return;
      this.#opts.scene.add(group);
      this.#patches.set(place.id, patch);
      patch = null; // ownership transferred to residency map
    } catch (error) {
      if (!this.#disposed) {
        this.#failures.set(place.id, this.#time + 20);
        console.warn(`[city-stories:${place.id}] Could not welcome residents; will retry.`, error);
      }
    } finally {
      if (patch) this.#release(patch);
      this.#pending = null;
    }
  }
  #wanted(place: StoryPlace, generation: number): boolean {
    return !this.#disposed && generation === this.#generation && this.#loadEnabled
      && this.#opts.placeReady(place.id)
      && Math.hypot(this.#focus.x - place.x, this.#focus.z - place.z) < LOAD_RADIUS;
  }
  #safeSpot(x: number, z: number): { x: number; y: number; z: number } | null {
    // Small local correction only. Never relocate a resident across a road or
    // onto a roof just to satisfy a distant generic spawn search.
    for (const [dx, dz] of [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
      const px = x + dx, pz = z + dz;
      const y = this.#opts.map.effectiveGround(px, pz);
      if (!Number.isFinite(y) || (this.#opts.map.isWater(px, pz) && this.#opts.map.bridgeDeck(px, pz) === -Infinity)) continue;
      if (this.#opts.blocked(px, y + 0.9, pz)) continue;
      if (Math.abs(this.#opts.map.effectiveGround(px + 0.4, pz) - y) > 0.5
        || Math.abs(this.#opts.map.effectiveGround(px, pz + 0.4) - y) > 0.5) continue;
      return { x: px, y, z: pz };
    }
    return null;
  }
  #release(patch: Patch): void {
    for (const resident of patch.residents) {
      if (this.#selected === resident) this.#selected = null;
      resident.talk.dispose();
    }
    // Rig geometry's shared cache has no-op disposal; per-rig palette materials
    // and skeletons are owned. Sets avoid duplicate dispose calls for joint meshes.
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const skeletons = new Set<THREE.Skeleton>();
    patch.group.traverse(object => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
      if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    });
    patch.group.removeFromParent();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
    patch.group.clear();
  }
}
