import type { Player } from "../player/player";
import { savePlayerState } from "../core/persist";

/** Owns periodic and page-lifecycle session saves, including listener cleanup. */
export function createSessionPersistence(player: Player) {
  let elapsed = 0;

  const write = () => {
    try {
      savePlayerState({
        mode: player.mode,
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
        heading: player.heading
      });
    } catch {
      // Private browsing/storage policies must not interrupt a reload snapshot.
    }
  };
  const writeVisible = () => {
    if (document.visibilityState === "visible") write();
  };
  const saveOnHide = () => {
    if (document.visibilityState === "hidden") write();
  };

  window.addEventListener("pagehide", writeVisible);
  document.addEventListener("visibilitychange", saveOnHide);

  return {
    update(dt: number) {
      elapsed += dt;
      if (elapsed < 1) return;
      elapsed = 0;
      writeVisible();
    },
    write,
    writeVisible,
    dispose() {
      window.removeEventListener("pagehide", writeVisible);
      document.removeEventListener("visibilitychange", saveOnHide);
    }
  };
}
