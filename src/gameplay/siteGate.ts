/**
 * Universal minigame site gating: every located game (golf, pickleball,
 * archery, …) registers a footprint + wake/sleep pads and the gate flips it
 * awake only while the player is nearby. Asleep games render nothing and do
 * ~zero per-frame work — the per-site cost here is one contains() test.
 *
 * Hysteresis: a sleeping site wakes inside `activatePad`, a woken site sleeps
 * only beyond `deactivatePad` (> activatePad), so pacing the boundary never
 * thrashes setAwake.
 */

export type GameSite = {
  id: string;
  /** Footprint test, padded outward by `pad` metres. */
  contains(x: number, z: number, pad: number): boolean;
  /** Wake within this pad of the footprint. */
  activatePad: number;
  /** Sleep beyond this pad (> activatePad, hysteresis). */
  deactivatePad: number;
  /** Hold the site awake regardless of distance — e.g. a live round / claimed seat. */
  keepAwake?(): boolean;
  /** Called on transitions only (false→true and true→false). */
  setAwake(on: boolean): void;
  /** Called on false→true transitions, after setAwake — e.g. net.replayPickleball. */
  onWake?(): void;
};

export type GameSiteRegistration = {
  replace(site: GameSite): void;
  dispose(): void;
};

export function createSiteGate(): {
  register(site: GameSite): GameSiteRegistration;
  update(x: number, z: number): void;
  awake(id: string): boolean;
} {
  type Entry = { site: GameSite; awake: boolean };
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();

  return {
    /** Sites register asleep; the next update() wakes any the player is already in. */
    register(site: GameSite) {
      const entry: Entry = { site, awake: false };
      entries.push(entry);
      byId.set(site.id, entry);
      let disposed = false;
      return {
        replace(next) {
          if (disposed) return;
          const wasAwake = entry.awake;
          if (wasAwake) entry.site.setAwake(false);
          if (byId.get(entry.site.id) === entry) byId.delete(entry.site.id);
          entry.site = next;
          byId.set(next.id, entry);
          if (wasAwake) {
            next.setAwake(true);
            next.onWake?.();
          }
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          if (entry.awake) entry.site.setAwake(false);
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
          if (byId.get(entry.site.id) === entry) byId.delete(entry.site.id);
        }
      };
    },

    update(x: number, z: number) {
      for (const entry of entries) {
        const s = entry.site;
        const next =
          (s.keepAwake?.() ?? false) ||
          s.contains(x, z, entry.awake ? s.deactivatePad : s.activatePad);
        if (next === entry.awake) continue;
        entry.awake = next;
        s.setAwake(next);
        if (next) s.onWake?.();
      }
    },

    awake(id: string): boolean {
      return byId.get(id)?.awake ?? false;
    }
  };
}
