/** Player-local listening history. IDs survive content revisions; no simulated
 * reconciliation, messages delivered, or other residents' private knowledge. */
export interface ListeningEntry {
  id: string;
  name: string;
  place: string;
  chapter: string;
  revision: number;
  heardReflection: boolean;
  lastText: string;
  beats: string[];
}
export interface StoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const KEY = 'sf.city-stories.v1';
const MAX_ENTRIES = 256;
export class ListeningMemory {
  readonly #entries = new Map<string, ListeningEntry>();
  readonly #storage?: StoryStorage;
  constructor(storage?: StoryStorage) {
    this.#storage = storage;
    try {
      const raw = storage?.getItem(KEY);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1
        || !('entries' in saved) || !Array.isArray(saved.entries)) return;
      for (const item of saved.entries.slice(0, MAX_ENTRIES)) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string'
          || typeof item.name !== 'string' || typeof item.place !== 'string'
          || typeof item.chapter !== 'string' || !Number.isInteger(item.revision)
          || typeof item.lastText !== 'string' || typeof item.heardReflection !== 'boolean') continue;
        this.#entries.set(item.id, { id: item.id, name: item.name, place: item.place,
          chapter: item.chapter, revision: item.revision, heardReflection: item.heardReflection,
          lastText: item.lastText.slice(0, 2000),
          beats: Array.isArray(item.beats) ? item.beats.filter((v: unknown) => typeof v === 'string').slice(-64) : [] });
      }
    } catch { /* A blocked or corrupt save never prevents a conversation. */ }
  }
  hasMet(id: string): boolean { return this.#entries.has(id); }
  hasHeard(id: string): boolean { return this.#entries.get(id)?.heardReflection ?? false; }
  entries(): ListeningEntry[] {
    return [...this.#entries.values()].map(e => ({ ...e, beats: [...e.beats] }));
  }
  remember(entry: Omit<ListeningEntry, 'beats'>, beat: string): void {
    const before = this.#entries.get(entry.id);
    const beats = before?.beats ?? [];
    const key = `${entry.chapter}@${entry.revision}:${beat}`;
    if (beats.includes(key)) return;
    this.#entries.set(entry.id, { ...entry,
      heardReflection: entry.heardReflection || (before?.heardReflection ?? false),
      beats: [...beats, key].slice(-64) });
    if (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
    try { this.#storage?.setItem(KEY, JSON.stringify({ version: 1, entries: this.entries() })); }
    catch { /* Continue with session memory when storage is full/unavailable. */ }
  }
}
