import type * as THREE from 'three/webgpu';
import type { WorldMap } from '../../world/heightmap';
import type { Input } from '../../core/input';
import type { ListeningMemory } from './memory';
import type { CityStoriesRuntime } from './runtime';
import type { StoryJournal } from './journal';
import { STORY_PLACES } from './places';

interface Options {
  scene: THREE.Scene;
  map: WorldMap;
  input: Input;
  ready: Promise<void>;
  prepare: (root: THREE.Group) => Promise<unknown>;
  placeReady: (id: string) => boolean;
  blocked: (x: number, y: number, z: number) => boolean;
  visit: (x: number, z: number, name: string) => void;
}
/** Boot-safe facade: cheap place coordinates only, no resident scripts, rigs,
 * journal, or storage hydration until proximity/explicit notebook activation. */
export class CityStories {
  readonly #opts: Options;
  #runtime: CityStoriesRuntime | null = null;
  #memory: ListeningMemory | null = null;
  #memoryPromise: Promise<ListeningMemory> | null = null;
  #journal: StoryJournal | null = null;
  #journalOpen = false;
  #journalPending = false;
  #button: HTMLButtonElement | null = null;
  #ready = false;
  #pending = false;
  #disposed = false;
  #dwell = 0;
  #retry = 0;
  constructor(options: Options) {
    this.#opts = options;
    void options.ready.then(() => {
      if (this.#disposed) return;
      this.#ready = true;
      const button = document.createElement('button');
      button.className = 'share-btn city-stories-button';
      button.type = 'button';
      button.textContent = 'People';
      button.title = 'People of the city · stories and places to listen';
      button.setAttribute('aria-haspopup', 'dialog');
      button.style.marginRight = '8px';
      button.addEventListener('click', () => { void this.openJournal(); });
      // Share's existing responsive/fading HUD slot keeps the notebook in the
      // ordinary UI hierarchy rather than introducing another floating panel.
      document.querySelector('#hud .share-ui')?.prepend(button);
      this.#button = button;
    });
  }
  get active(): boolean { return this.#runtime?.active ?? false; }
  get choosing(): boolean { return this.#runtime?.choosing ?? false; }
  get debugState() { return { ready: this.#ready, runtimeLoaded: !!this.#runtime,
    journalOpen: this.#journalOpen, notes: this.#memory?.entries() ?? [],
    ...(this.#runtime?.debugState ?? { pending: null, loadedPlaces: [], residents: [], selected: null, active: false }) }; }
  get places() { return STORY_PLACES.map(({ id, label, x, z }) => ({ id, label, x, z })); }
  /** Exact notebook destinations use authored pedestrian anchors. This plugs
   * into the existing covered-arrival pipeline, including its collision gate. */
  arrivalForDestination(_x: number, _z: number, label?: string) {
    const place = STORY_PLACES.find(p => label === `People · ${p.label}`);
    if (!place) return null;
    // The restored hall already supplies an authored arrival/collision pose.
    // Defer to it rather than synthesizing a second interior entry height.
    if (place.id === 'sutro') return null;
    const first = place.spots[0];
    const x = place.id === 'golden-gate' ? place.x - 3
      : place.id === 'skate-plaza' ? first.x + 2 : place.x;
    const z = place.id === 'skate-plaza' ? first.z + 2 : place.z;
    // Outdoor ground may still be a coarse overview while travel resolves.
    // Let respawn sample the destination rather than freezing that coarse Y.
    return { x, z, heading: Math.atan2(x - first.x, z - first.z) };
  }
  tryInteract(player: THREE.Vector3Like, mode: string): boolean { return this.#runtime?.tryInteract(player, mode) ?? false; }
  navigate(dy: number): boolean { return this.#runtime?.navigate(dy) ?? false; }
  confirm(): boolean { return this.#runtime?.confirm() ?? false; }
  close(): boolean { return this.#journal?.close() || this.#runtime?.close() || false; }
  update(dt: number, player: THREE.Vector3Like, enabled: boolean, canTalk: boolean): void {
    if (this.#disposed || !this.#ready) return;
    canTalk = canTalk && enabled && !this.#journalOpen;
    this.#retry = Math.max(0, this.#retry - dt);
    if (!this.#runtime && !this.#pending && enabled && this.#retry === 0) {
      const near = STORY_PLACES.some(p => Math.hypot(player.x - p.x, player.z - p.z) < 90
        && Math.abs(player.y - (p.groundY ?? this.#opts.map.effectiveGround(p.x, p.z))) < 30);
      this.#dwell = near ? this.#dwell + dt : 0;
      if (this.#dwell >= 1) void this.#load();
    } else if (!enabled) this.#dwell = 0;
    this.#runtime?.update(dt, player, enabled, canTalk);
  }
  project(camera: THREE.Camera): void { this.#runtime?.project(camera); }
  async openJournal(): Promise<void> {
    if (this.#disposed || !this.#ready || this.#journalPending || this.#journalOpen) return;
    this.#journalPending = true;
    if (this.#button) this.#button.disabled = true;
    try {
      const [{ StoryJournal }, memory] = await Promise.all([import('./journal'), this.#ensureMemory()]);
      if (this.#disposed) return;
      this.#runtime?.close();
      this.#journal ??= new StoryJournal({
        entries: () => memory.entries(), places: this.places,
        onVisit: id => {
          const place = STORY_PLACES.find(p => p.id === id);
          if (place) {
            this.#journal?.close();
            // Arrive a few steps from the pair, not inside somebody's rig.
            this.#opts.visit(place.x, place.z, `People · ${place.label}`);
          }
        },
        onClose: () => {
          this.#journalOpen = false;
          this.#opts.input.setSuspensionHold('city-stories-journal', false);
        }
      });
      this.#opts.input.keys.clear();
      this.#opts.input.setSuspensionHold('city-stories-journal', true);
      document.exitPointerLock();
      this.#journalOpen = true;
      this.#journal.open();
    } catch (error) {
      this.#journalOpen = false;
      this.#opts.input.setSuspensionHold('city-stories-journal', false);
      console.warn('[city-stories] Notebook unavailable; please try again.', error);
      if (this.#button) this.#button.title = 'Notebook could not open. Click to try again.';
    } finally {
      this.#journalPending = false;
      if (this.#button) this.#button.disabled = false;
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#runtime?.dispose();
    this.#journal?.dispose();
    this.#button?.remove();
    this.#opts.input.setSuspensionHold('city-stories-journal', false);
  }
  #ensureMemory(): Promise<ListeningMemory> {
    return this.#memoryPromise ??= import('./memory').then(({ ListeningMemory }) => {
      let storage: Storage | undefined;
      try { storage = localStorage; } catch { /* Session-only memory. */ }
      return this.#memory = new ListeningMemory(storage);
    }).catch(error => { this.#memoryPromise = null; throw error; });
  }
  async #load(): Promise<void> {
    this.#pending = true;
    try {
      const [{ CityStoriesRuntime }, memory] = await Promise.all([import('./runtime'), this.#ensureMemory()]);
      if (this.#disposed) return;
      this.#runtime = new CityStoriesRuntime({ ...this.#opts, memory, places: STORY_PLACES });
    } catch (error) {
      this.#retry = 20;
      console.warn('[city-stories] Residents unavailable; will retry.', error);
    } finally { this.#pending = false; }
  }
}
